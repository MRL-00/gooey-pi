import { supportsFastMode } from 'prime-agent-ai'
import { PRIME_THINKING_LEVELS, type PrimeModelCatalog, type PrimeModelDescriptor, type PrimeProviderDescriptor, type PrimeThinkingLevel } from '../../src/types/api'
import type { ModelCatalogProvider } from './model-catalog'
import { runProcess, safeChildEnvironment } from './process-utils'
import { requireString } from './validation'

const CATALOG_TTL_MS = 30_000
const MAX_CATALOG_MODELS = 5_000
export const MAX_CATALOG_PROVIDERS = 256
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const VERSION_MAX_OUTPUT_BYTES = 4_096
export const OMP_NOT_INSTALLED_WARNING = 'OMP is not installed. Install the omp CLI to load its model catalog.'

function modelKey(provider: string, id: string): string { return `${provider}/${id}` }

function safeModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[a-zA-Z0-9._:/+-]+$/.test(value)
}

function safeProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
}

function boundedInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * OMP reports the per-model thinking vocabulary as `thinking: string[] | null`
 * using the same level names as Prime, except `off` is implicit (never listed
 * by `omp models --json`). Mirror Prime's `getSupportedThinkingLevels`
 * convention: non-reasoning models expose exactly `['off']`, and reasoning
 * models expose `off` plus the reported levels in canonical order. Unknown or
 * non-string reported levels are dropped.
 */
function toThinkingLevels(reasoning: boolean, thinking: unknown): PrimeThinkingLevel[] {
  if (!reasoning) return ['off']
  const reported = new Set(Array.isArray(thinking) ? thinking.filter((level): level is string => typeof level === 'string') : [])
  return PRIME_THINKING_LEVELS.filter((level) => level === 'off' || reported.has(level))
}

/**
 * OMP carries no per-model fast-mode metadata: its `set_fast_mode` command is
 * a session-level toggle. Advertising support on every model would surface
 * the Fast toggle across the UI for models where the flag does nothing, so
 * this delegates to the same `supportsFastMode` predicate Prime uses — the
 * model family can then never drift between harnesses. OMP's catalog JSON
 * does not report the API variant, but the openai-codex provider maps 1:1
 * onto the openai-codex-responses API the predicate requires, and every other
 * provider fails its provider check regardless of the API value.
 */
function toFastModeSupported(provider: string, id: string): boolean {
  return supportsFastMode({ provider, id, api: 'openai-codex-responses' } as Parameters<typeof supportsFastMode>[0])
}

/** Validates one untrusted CLI model entry; returns null when any field is hostile or malformed. */
function toModelDescriptor(value: unknown): PrimeModelDescriptor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!safeProviderId(record.provider) || !safeModelId(record.id)) return null
  if (typeof record.name !== 'string' || record.name.length === 0) return null
  if (record.reasoning !== undefined && typeof record.reasoning !== 'boolean') return null
  if (record.thinking !== undefined && record.thinking !== null && !Array.isArray(record.thinking)) return null
  const reasoning = record.reasoning === true
  const input = Array.isArray(record.input)
    ? record.input.filter((entry): entry is 'text' | 'image' => entry === 'text' || entry === 'image')
    : []
  return {
    key: modelKey(record.provider, record.id),
    provider: record.provider,
    id: record.id,
    name: record.name.slice(0, 500),
    reasoning,
    input,
    contextWindow: boundedInteger(record.contextWindow),
    maxTokens: boundedInteger(record.maxTokens),
    availableThinkingLevels: toThinkingLevels(reasoning, record.thinking),
    fastModeSupported: toFastModeSupported(record.provider, record.id),
    // OMP does not report per-model auth state and its credentials live in the
    // CLI's own store, so every catalog model is treated as selectable.
    available: true,
  }
}

export interface OmpModelCatalogOptions {
  /** Subprocess wall-clock limit for one `omp models --json` run. */
  timeoutMs?: number
  /** Combined stdout/stderr byte cap for one `omp models --json` run. */
  maxOutputBytes?: number
}

/**
 * Model catalog service for the OMP harness, backed by the `omp models --json`
 * CLI instead of in-process npm modules. Satisfies the same
 * `ModelCatalogProvider` surface as `PrimeProviderService`, so
 * `AgentRpcManager` and the `providers:catalog` IPC path can consume either.
 *
 * The CLI output is untrusted: it is byte-bounded, time-bounded, spawned with
 * an argv array and a sanitized environment, and every field is validated
 * before use. A null executable means OMP is not installed; the catalog is
 * then empty with a clear warning.
 */
export class OmpModelCatalogService implements ModelCatalogProvider {
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private cachedCatalog: PrimeModelCatalog | null = null
  private cachedAt = 0
  private catalogRefresh: Promise<PrimeModelCatalog> | null = null
  private version: string | null = null

  constructor(private readonly executable: string | null, options: OmpModelCatalogOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  async catalog(force = false, disabledProviders: ReadonlySet<string> = new Set()): Promise<PrimeModelCatalog> {
    if (!this.executable) {
      return { primeVersion: 'unknown', refreshedAt: new Date().toISOString(), models: [], providers: [], warning: OMP_NOT_INSTALLED_WARNING }
    }
    if (!force && this.cachedCatalog && Date.now() - this.cachedAt < CATALOG_TTL_MS) {
      return this.withEnabledState(this.cachedCatalog, disabledProviders)
    }
    // Single-flight: concurrent callers share one CLI run instead of spawning
    // duplicate subprocesses; the in-flight promise is cleared in finally.
    if (!this.catalogRefresh) {
      this.catalogRefresh = this.refreshCatalog().finally(() => { this.catalogRefresh = null })
    }
    try {
      return this.withEnabledState(await this.catalogRefresh, disabledProviders)
    } catch (error) {
      // A failed refresh degrades to the last good catalog instead of an
      // error; first-ever loads still surface the failure.
      if (!this.cachedCatalog) throw error
      const reason = error instanceof Error ? error.message : String(error)
      const staleWarning = `The OMP model catalog could not be refreshed (${reason}); showing the last loaded catalog.`
      return this.withEnabledState({
        ...this.cachedCatalog,
        warning: this.cachedCatalog.warning ? `${this.cachedCatalog.warning} ${staleWarning}` : staleWarning,
      }, disabledProviders)
    }
  }

  async requireAvailableModel(rawKey: unknown, disabledProviders: ReadonlySet<string> = new Set()): Promise<PrimeModelDescriptor> {
    const key = requireString(rawKey, 'model', { min: 3, max: 512, trim: true })
    const catalog = await this.catalog(false, disabledProviders)
    const model = catalog.models.find((candidate) => candidate.key === key)
    if (!model) throw new Error('Model was not found in the OMP catalog')
    const provider = catalog.providers.find((candidate) => candidate.id === model.provider)
    if (!provider?.enabled) throw new Error(`Provider ${model.provider} is disabled`)
    if (!model.available) throw new Error(`Provider ${model.provider} is not configured for ${model.name}`)
    return model
  }

  async capabilities(provider: string | undefined, modelId: string | undefined): Promise<PrimeModelDescriptor | undefined> {
    if (!provider || !modelId) return undefined
    return (await this.catalog()).models.find((model) => model.provider === provider && model.id === modelId)
  }

  private async refreshCatalog(): Promise<PrimeModelCatalog> {
    const result = await runProcess(this.executable!, ['models', '--json'], {
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxOutputBytes,
      env: safeChildEnvironment(),
    })
    if (result.outputExceeded) throw new Error(`OMP model catalog output exceeded ${this.maxOutputBytes.toLocaleString()} bytes`)
    if (result.timedOut) throw new Error('The OMP model catalog request timed out')
    if (result.code !== 0) throw new Error(`omp models exited with status ${result.code}`)
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch { throw new Error('OMP returned malformed model catalog JSON') }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Array.isArray((parsed as Record<string, unknown>).models)) {
      throw new Error('OMP returned an unexpected model catalog shape')
    }
    const rawModels = (parsed as Record<string, unknown>).models as unknown[]

    const models: PrimeModelDescriptor[] = []
    const seenKeys = new Set<string>()
    let invalidEntries = 0
    for (const entry of rawModels) {
      const model = toModelDescriptor(entry)
      if (!model) { invalidEntries += 1; continue }
      if (seenKeys.has(model.key)) continue
      seenKeys.add(model.key)
      if (models.length < MAX_CATALOG_MODELS) models.push(model)
    }

    const providerIds = [...new Set(models.map((model) => model.provider))]
    const providers = providerIds.map((id): PrimeProviderDescriptor => {
      const providerModels = models.filter((model) => model.provider === id)
      return {
        id,
        name: id.slice(0, 200),
        authMethod: 'external',
        configured: true,
        authLabel: 'Managed by the omp CLI',
        modelCount: providerModels.length,
        availableModelCount: providerModels.filter((model) => model.available).length,
        enabled: true,
      }
    }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_CATALOG_PROVIDERS)

    const warnings = [
      seenKeys.size > models.length
        ? `OMP returned ${seenKeys.size.toLocaleString()} models; Prime Work loaded the first ${models.length.toLocaleString()}.`
        : undefined,
      providerIds.length > providers.length
        ? `OMP returned ${providerIds.length.toLocaleString()} providers; Prime Work loaded the first ${providers.length.toLocaleString()} sorted by name.`
        : undefined,
      invalidEntries > 0
        ? `OMP returned ${invalidEntries.toLocaleString()} model entries Prime Work could not validate; they were skipped.`
        : undefined,
    ].filter((warning): warning is string => Boolean(warning))

    this.cachedCatalog = {
      primeVersion: await this.resolveVersion(),
      refreshedAt: new Date().toISOString(),
      models,
      providers,
      warning: warnings.length ? warnings.join(' ') : undefined,
    }
    this.cachedAt = Date.now()
    return this.cachedCatalog
  }

  /**
   * Probes `omp --version` (the CLI prints `omp/<semver>`). Only a successful
   * probe is cached: a transient failure answers 'unknown' for this call and
   * retries on the next catalog refresh.
   */
  private async resolveVersion(): Promise<string> {
    if (this.version) return this.version
    try {
      const result = await runProcess(this.executable!, ['--version'], {
        timeoutMs: this.timeoutMs,
        maxBytes: VERSION_MAX_OUTPUT_BYTES,
        env: safeChildEnvironment(),
      })
      const match = result.code === 0 && !result.timedOut && !result.outputExceeded
        ? result.stdout.trim().match(/^omp\/([0-9A-Za-z.+-]{1,64})$/)
        : null
      this.version = match?.[1] ?? null
    } catch {
      this.version = null
    }
    return this.version ?? 'unknown'
  }

  private withEnabledState(catalog: PrimeModelCatalog, disabledProviders: ReadonlySet<string>): PrimeModelCatalog {
    return {
      ...catalog,
      models: catalog.models.map((model) => ({ ...model })),
      providers: catalog.providers.map((provider) => ({ ...provider, enabled: !disabledProviders.has(provider.id) })),
    }
  }
}
