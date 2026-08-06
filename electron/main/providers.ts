import { randomUUID } from 'node:crypto'
import { AuthStorage, ModelRegistry, VERSION } from 'prime-agent'
import { getSupportedThinkingLevels, supportsFastMode } from 'prime-agent-ai'
import type { Api, Model } from 'prime-agent-ai'
import type { PrimeModelCatalog, PrimeModelDescriptor, PrimeProviderDescriptor, ProviderAuthEvent, ProviderAuthMethod, ProviderAuthSource } from '../../src/types/api'
import { requireString, requireWebUrl } from './validation'

const CATALOG_TTL_MS = 30_000
const MAX_CATALOG_MODELS = 5_000
const MAX_CATALOG_PROVIDERS = 256
const EXTERNAL_AUTH_PROVIDERS = new Set(['amazon-bedrock', 'google-vertex'])
const OAUTH_TIMEOUT_MS = 10 * 60_000

interface PendingOAuthPrompt {
  id: string
  options?: Set<string>
  allowEmpty: boolean
  resolve(value: string | undefined): void
  reject(error: Error): void
}

interface OAuthFlow {
  id: string
  providerId: string
  abort: AbortController
  timer: NodeJS.Timeout
  pending?: PendingOAuthPrompt
}

type WithoutFlow<T> = T extends ProviderAuthEvent ? Omit<T, 'flowId' | 'providerId'> : never
type ProviderAuthEventPayload = WithoutFlow<ProviderAuthEvent>

function modelKey(provider: string, id: string): string { return `${provider}/${id}` }

function safeCatalogId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[a-zA-Z0-9._:/+-]+$/.test(value)
}

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
  private readonly flows = new Map<string, OAuthFlow>()
  private eventSink: (event: ProviderAuthEvent) => void = () => undefined
  private readonly openExternal: (url: string) => Promise<void>

  constructor(options: { authPath?: string; modelsPath?: string; openExternal?: (url: string) => Promise<void> } = {}) {
    this.authStorage = AuthStorage.create(options.authPath, options.authPath ? { usePrimeCliConfig: false } : undefined)
    this.registry = ModelRegistry.create(this.authStorage, options.modelsPath)
    this.openExternal = options.openExternal ?? (async () => undefined)
  }

  setEventSink(sink: (event: ProviderAuthEvent) => void): void { this.eventSink = sink }

  async catalog(force = false, disabledProviders: ReadonlySet<string> = new Set()): Promise<PrimeModelCatalog> {
    if (!force && this.cachedCatalog && Date.now() - this.cachedAt < CATALOG_TTL_MS) {
      return this.withEnabledState(this.cachedCatalog, disabledProviders)
    }

    const snapshot = await this.registry.refreshModelCatalog()
    const executableModels = await this.registry.getExecutableModels()
    const available = new Set(executableModels.map((model) => modelKey(model.provider, model.id)))
    const oauthProviders = new Map(this.authStorage.getOAuthProviders().map((provider) => [provider.id, provider.name]))
    const eligibleModels = snapshot.models.filter((model) => safeCatalogId(model.provider) && safeCatalogId(model.id))
    const models = eligibleModels.slice(0, MAX_CATALOG_MODELS).map((model) => toModelDescriptor(model, available))
    const providerIds = new Set([...models.map((model) => model.provider), ...oauthProviders.keys()])
    const providers = [...providerIds].filter(safeCatalogId).slice(0, MAX_CATALOG_PROVIDERS).map((id): PrimeProviderDescriptor => {
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
      warning: snapshot.models.length > models.length
        ? `Prime Agent returned ${snapshot.models.length.toLocaleString()} models; Prime Work loaded the first ${models.length.toLocaleString()} valid entries.`
        : this.registry.getError()?.slice(0, 4_000),
    }
    this.cachedAt = Date.now()
    return this.withEnabledState(this.cachedCatalog, disabledProviders)
  }

  async requireAvailableModel(rawKey: unknown, disabledProviders: ReadonlySet<string> = new Set()): Promise<PrimeModelDescriptor> {
    const key = requireString(rawKey, 'model', { min: 3, max: 512, trim: true })
    const catalog = await this.catalog(false, disabledProviders)
    const model = catalog.models.find((candidate) => candidate.key === key)
    if (!model) throw new Error('Model was not found in the Prime Agent catalog')
    const provider = catalog.providers.find((candidate) => candidate.id === model.provider)
    if (!provider?.enabled) throw new Error(`Provider ${model.provider} is disabled in Prime Work`)
    if (!model.available) throw new Error(`Provider ${model.provider} is not configured for ${model.name}`)
    return model
  }

  async capabilities(provider: string | undefined, modelId: string | undefined): Promise<PrimeModelDescriptor | undefined> {
    if (!provider || !modelId) return undefined
    return (await this.catalog()).models.find((model) => model.provider === provider && model.id === modelId)
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

  async startOAuth(rawProviderId: unknown): Promise<{ flowId: string }> {
    const providerId = requireString(rawProviderId, 'providerId', { min: 1, max: 128, trim: true })
    await this.requireProvider(providerId, 'oauth')
    if (this.flows.size >= 2) throw new Error('Too many provider login flows are active')
    if ([...this.flows.values()].some((flow) => flow.providerId === providerId)) throw new Error('This provider login is already active')
    const id = randomUUID()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(new Error('Provider login timed out')), OAUTH_TIMEOUT_MS)
    timer.unref()
    const flow: OAuthFlow = { id, providerId, abort, timer }
    this.flows.set(id, flow)
    void this.runOAuth(flow)
    return { flowId: id }
  }

  respondOAuth(rawFlowId: unknown, rawPromptId: unknown, rawValue: unknown): boolean {
    const flowId = requireString(rawFlowId, 'flowId', { min: 1, max: 128 })
    const promptId = requireString(rawPromptId, 'promptId', { min: 1, max: 128 })
    const flow = this.flows.get(flowId)
    const pending = flow?.pending
    if (!flow || !pending || pending.id !== promptId) return false
    const value = rawValue === undefined ? undefined : requireString(rawValue, 'value', { max: 16_384 })
    if (!pending.allowEmpty && !value?.trim()) throw new TypeError('A response is required')
    if (pending.options && (!value || !pending.options.has(value))) throw new TypeError('Invalid provider login selection')
    flow.pending = undefined
    pending.resolve(value)
    return true
  }

  cancelOAuth(rawFlowId: unknown): boolean {
    const flowId = requireString(rawFlowId, 'flowId', { min: 1, max: 128 })
    const flow = this.flows.get(flowId)
    if (!flow) return false
    flow.abort.abort(new Error('Provider login cancelled'))
    flow.pending?.reject(new Error('Provider login cancelled'))
    flow.pending = undefined
    return true
  }

  cancelAll(): void { for (const flow of this.flows.values()) this.cancelOAuth(flow.id) }

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

  private async runOAuth(flow: OAuthFlow): Promise<void> {
    try {
      await this.authStorage.login(flow.providerId, {
        signal: flow.abort.signal,
        onAuth: (info) => {
          const url = requireWebUrl(info.url)
          this.emit(flow, { type: 'auth', url, instructions: info.instructions?.slice(0, 4_000) })
          void this.openExternal(url).catch((error) => this.emit(flow, { type: 'error', error: this.errorMessage(error) }))
        },
        onProgress: (message) => this.emit(flow, { type: 'progress', message: message.slice(0, 4_000) }),
        onPrompt: (prompt) => this.requestOAuthValue(flow, {
          type: 'prompt',
          message: prompt.message.slice(0, 4_000),
          placeholder: prompt.placeholder?.slice(0, 500),
          allowEmpty: prompt.allowEmpty === true,
        }).then((value) => value ?? ''),
        onManualCodeInput: () => this.requestOAuthValue(flow, {
          type: 'prompt',
          message: 'Paste the authorization code from your browser.',
          placeholder: 'Authorization code',
          allowEmpty: false,
        }).then((value) => value ?? ''),
        onSelect: (prompt) => this.requestOAuthValue(flow, {
          type: 'select',
          message: prompt.message.slice(0, 4_000),
          options: prompt.options.slice(0, 100).map((option) => ({ id: option.id.slice(0, 500), label: option.label.slice(0, 500) })),
        }),
      })
      this.invalidate()
      this.emit(flow, { type: 'complete' })
    } catch (error) {
      this.emit(flow, flow.abort.signal.aborted ? { type: 'cancelled' } : { type: 'error', error: this.errorMessage(error) })
    } finally {
      clearTimeout(flow.timer)
      flow.pending?.reject(new Error('Provider login ended'))
      this.flows.delete(flow.id)
    }
  }

  private requestOAuthValue(
    flow: OAuthFlow,
    request: { type: 'prompt'; message: string; placeholder?: string; allowEmpty: boolean }
      | { type: 'select'; message: string; options: Array<{ id: string; label: string }> },
  ): Promise<string | undefined> {
    if (flow.abort.signal.aborted) return Promise.reject(new Error('Provider login cancelled'))
    if (flow.pending) return Promise.reject(new Error('Provider login requested overlapping input'))
    const promptId = randomUUID()
    return new Promise((resolve, reject) => {
      flow.pending = {
        id: promptId,
        allowEmpty: request.type === 'prompt' && request.allowEmpty,
        options: request.type === 'select' ? new Set(request.options.map((option) => option.id)) : undefined,
        resolve,
        reject,
      }
      this.emit(flow, { ...request, promptId })
    })
  }

  private emit(flow: OAuthFlow, event: ProviderAuthEventPayload): void {
    this.eventSink({ flowId: flow.id, providerId: flow.providerId, ...event } as ProviderAuthEvent)
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, ' ').slice(0, 4_000) || 'Provider login failed'
  }
}
