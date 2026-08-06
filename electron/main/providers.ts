import { AuthStorage, ModelRegistry, VERSION } from 'prime-agent'
import { getSupportedThinkingLevels, supportsFastMode } from 'prime-agent-ai'
import type { Api, Model } from 'prime-agent-ai'
import type { PrimeModelCatalog, PrimeModelDescriptor, PrimeProviderDescriptor, ProviderAuthMethod, ProviderAuthSource } from '../../src/types/api'
import { requireString } from './validation'

const CATALOG_TTL_MS = 30_000
const EXTERNAL_AUTH_PROVIDERS = new Set(['amazon-bedrock', 'google-vertex'])

function modelKey(provider: string, id: string): string { return `${provider}/${id}` }

function boundedInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function toModelDescriptor(model: Model<Api>, available: Set<string>): PrimeModelDescriptor {
  return {
    key: modelKey(model.provider, model.id),
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input.filter((input): input is 'text' | 'image' => input === 'text' || input === 'image'),
    contextWindow: boundedInteger(model.contextWindow),
    maxTokens: boundedInteger(model.maxTokens),
    availableThinkingLevels: getSupportedThinkingLevels(model),
    fastModeSupported: supportsFastMode(model),
    available: available.has(modelKey(model.provider, model.id)),
  }
}

export class PrimeProviderService {
  private readonly authStorage: AuthStorage
  private readonly registry: ModelRegistry
  private cachedCatalog: PrimeModelCatalog | null = null
  private cachedAt = 0

  constructor(options: { authPath?: string; modelsPath?: string } = {}) {
    this.authStorage = AuthStorage.create(options.authPath, options.authPath ? { usePrimeCliConfig: false } : undefined)
    this.registry = ModelRegistry.create(this.authStorage, options.modelsPath)
  }

  async catalog(force = false, disabledProviders: ReadonlySet<string> = new Set()): Promise<PrimeModelCatalog> {
    if (!force && this.cachedCatalog && Date.now() - this.cachedAt < CATALOG_TTL_MS) {
      return this.withEnabledState(this.cachedCatalog, disabledProviders)
    }

    const snapshot = await this.registry.refreshModelCatalog()
    const executableModels = await this.registry.getExecutableModels()
    const available = new Set(executableModels.map((model) => modelKey(model.provider, model.id)))
    const oauthProviders = new Map(this.authStorage.getOAuthProviders().map((provider) => [provider.id, provider.name]))
    const models = snapshot.models.map((model) => toModelDescriptor(model, available))
    const providerIds = new Set([...models.map((model) => model.provider), ...oauthProviders.keys()])
    const providers = [...providerIds].map((id): PrimeProviderDescriptor => {
      const authStatus = this.authStorage.getAuthStatus(id)
      const providerModels = models.filter((model) => model.provider === id)
      const authMethod: ProviderAuthMethod = oauthProviders.has(id) ? 'oauth' : EXTERNAL_AUTH_PROVIDERS.has(id) ? 'external' : 'api_key'
      return {
        id,
        name: oauthProviders.get(id) ?? this.registry.getProviderDisplayName(id),
        authMethod,
        configured: authStatus.configured,
        authSource: authStatus.source as ProviderAuthSource | undefined,
        authLabel: authStatus.label?.slice(0, 200),
        modelCount: providerModels.length,
        availableModelCount: providerModels.filter((model) => model.available).length,
        enabled: true,
      }
    }).sort((a, b) => a.name.localeCompare(b.name))

    this.cachedCatalog = {
      primeVersion: VERSION,
      refreshedAt: new Date().toISOString(),
      models,
      providers,
      warning: this.registry.getError()?.slice(0, 4_000),
    }
    this.cachedAt = Date.now()
    return this.withEnabledState(this.cachedCatalog, disabledProviders)
  }

  async saveApiKey(rawProviderId: unknown, rawKey: unknown): Promise<void> {
    const providerId = requireString(rawProviderId, 'providerId', { min: 1, max: 128, trim: true })
    const key = requireString(rawKey, 'apiKey', { min: 1, max: 16_384, trim: true })
    await this.requireProvider(providerId, 'api_key')
    this.authStorage.set(providerId, { type: 'api_key', key })
    this.invalidate()
  }

  async logout(rawProviderId: unknown): Promise<void> {
    const providerId = requireString(rawProviderId, 'providerId', { min: 1, max: 128, trim: true })
    await this.requireProvider(providerId)
    this.authStorage.logout(providerId)
    this.invalidate()
  }

  invalidate(): void {
    this.cachedCatalog = null
    this.cachedAt = 0
  }

  private async requireProvider(providerId: string, expectedMethod?: ProviderAuthMethod): Promise<PrimeProviderDescriptor> {
    const provider = (await this.catalog()).providers.find((candidate) => candidate.id === providerId)
    if (!provider) throw new Error('Provider was not found')
    if (expectedMethod && provider.authMethod !== expectedMethod) throw new Error(`Provider requires ${provider.authMethod} authentication`)
    return provider
  }

  private withEnabledState(catalog: PrimeModelCatalog, disabledProviders: ReadonlySet<string>): PrimeModelCatalog {
    return {
      ...catalog,
      models: catalog.models.map((model) => ({ ...model })),
      providers: catalog.providers.map((provider) => ({ ...provider, enabled: !disabledProviders.has(provider.id) })),
    }
  }
}
