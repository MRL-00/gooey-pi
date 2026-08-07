import { session } from 'electron'
import type { AppSettings, ScheduleRecord } from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import { processFailureReason, runProcess, type ProcessResult } from './process-utils'
import type { JsonStateStore } from './store'
import { isRecord, rejectUnknownKeys, requireBoolean, requireString, requireWebUrl } from './validation'

export class SettingsService {
  constructor(private readonly store: JsonStateStore, private readonly validateShell: (shell: unknown) => string, private readonly cancelBrowserDownloads: () => void = () => undefined) {}

  get(): AppSettings { return this.store.getSettings() }

  async update(raw: unknown): Promise<AppSettings> {
    if (!isRecord(raw)) throw new TypeError('settings patch must be an object')
    const keys: Array<keyof AppSettings> = ['theme', 'sidebarOpen', 'inspectorOpen', 'terminalOpen', 'defaultInspectorTab', 'browserHome', 'browserAskForDownloads', 'terminalShell', 'reduceMotion', 'showReasoningSummaries', 'showToolCalls', 'messageEnterAction', 'telemetry', 'disabledProviders']
    rejectUnknownKeys(raw, keys, 'settings patch')
    const patch: Partial<AppSettings> = {}
    if (raw.theme !== undefined) {
      if (raw.theme !== 'system' && raw.theme !== 'light' && raw.theme !== 'dark') throw new TypeError('Invalid theme')
      patch.theme = raw.theme
    }
    for (const key of ['sidebarOpen', 'inspectorOpen', 'terminalOpen', 'browserAskForDownloads', 'reduceMotion', 'showReasoningSummaries', 'showToolCalls', 'telemetry'] as const) {
      if (raw[key] !== undefined) patch[key] = requireBoolean(raw[key], key)
    }
    if (raw.defaultInspectorTab !== undefined) {
      if (raw.defaultInspectorTab !== 'summary' && raw.defaultInspectorTab !== 'changes' && raw.defaultInspectorTab !== 'browser' && raw.defaultInspectorTab !== 'files') throw new TypeError('Invalid inspector tab')
      patch.defaultInspectorTab = raw.defaultInspectorTab
    }
    if (raw.messageEnterAction !== undefined) {
      if (raw.messageEnterAction !== 'queue' && raw.messageEnterAction !== 'steer') throw new TypeError('Invalid message Enter action')
      patch.messageEnterAction = raw.messageEnterAction
    }
    if (raw.browserHome !== undefined) patch.browserHome = requireWebUrl(raw.browserHome)
    if (raw.terminalShell !== undefined) patch.terminalShell = this.validateShell(raw.terminalShell)
    if (raw.disabledProviders !== undefined) {
      if (!Array.isArray(raw.disabledProviders) || raw.disabledProviders.length > 128) throw new TypeError('disabledProviders must be a bounded array')
      patch.disabledProviders = [...new Set(raw.disabledProviders.map((value, index) => {
        const id = requireString(value, `disabledProviders[${index}]`, { min: 1, max: 128, trim: true })
        if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) throw new TypeError(`disabledProviders[${index}] is not a valid provider ID`)
        return id
      }))]
    }
    return this.store.update((state) => Object.assign(state.settings, patch))
  }

  async resetBrowserData(): Promise<boolean> {
    try {
      this.cancelBrowserDownloads()
      const browserSession = session.fromPartition('persist:prime-work-browser')
      await Promise.all([
        browserSession.clearStorageData(), browserSession.clearCache(), browserSession.clearAuthCache(),
        session.defaultSession.clearStorageData(), session.defaultSession.clearCache(), session.defaultSession.clearAuthCache(),
      ])
      return true
    } catch { return false }
  }
}

function scheduleText(raw: Record<string, unknown>): string {
  if (isRecord(raw.schedule)) {
    if (typeof raw.schedule.expression === 'string') return raw.schedule.expression
    if (typeof raw.schedule.kind === 'string') return raw.schedule.kind
  }
  return typeof raw.schedule === 'string' ? raw.schedule : ''
}

function normalizeJob(raw: unknown, desktopRuntimeId?: string): ScheduleRecord | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.prompt !== 'string') return null
  const primeStatus = typeof raw.status === 'string' ? raw.status : 'active'
  // A raw 'failed' is always surfaced as failed (even without lastError), and a
  // status this app does not recognize must never be presented as completed.
  const status: ScheduleRecord['status'] = primeStatus === 'active' || primeStatus === 'paused' || primeStatus === 'completed' || primeStatus === 'failed'
    ? primeStatus
    : 'unknown'
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : raw.prompt.replace(/\s+/g, ' ').trim().slice(0, 80)
  return {
    id: raw.id,
    title: label || 'Scheduled prompt',
    schedule: scheduleText(raw),
    prompt: raw.prompt,
    status,
    nextRun: typeof raw.nextRunAt === 'string' ? raw.nextRunAt : undefined,
    lastRun: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : undefined,
    runtimeId: desktopRuntimeId,
  }
}

function isUnknownCommandOutput(output: string): boolean {
  return /\b(?:unknown|unrecognized|invalid)\s+(?:sub)?command\b/i.test(output)
}

export class ScheduleService {
  /** Session-scoped negative cache: the CLI does not support `schedule list`. */
  private cliUnavailable = false

  constructor(
    private readonly agents: AgentRpcManager,
    private readonly primeAgentPath: string | null,
    private readonly warn: (message: string) => void = (message) => console.warn(message),
  ) {}

  private markCliScheduleSupportUnavailable(reason: string): void {
    if (this.cliUnavailable) return
    this.cliUnavailable = true
    this.warn(`Prime Agent CLI schedule listing is unavailable (${reason}); treating the CLI catalog as empty for this session`)
  }

  async list(runtimeIdValue?: unknown): Promise<ScheduleRecord[]> {
    const runtimeId = runtimeIdValue === undefined ? undefined : requireString(runtimeIdValue, 'runtimeId', { min: 1, max: 256 })
    const jobsById = new Map<string, ScheduleRecord>()
    if (runtimeId) {
      const response = await this.agents.command(runtimeId, { type: 'list_schedules', includeInactive: true })
      const runtimeJobs: ScheduleRecord[] = []
      this.appendResponseJobs(response, runtimeId, runtimeJobs)
      for (const job of runtimeJobs) { if (!jobsById.has(job.id)) jobsById.set(job.id, job) }
    } else {
      const runtimes = this.agents.list()
      const runtimeCatalogs = await Promise.all(runtimes.map(async (runtime) => {
        const jobs: ScheduleRecord[] = []
        try {
          const response = await this.agents.command(runtime.runtimeId, { type: 'list_schedules', includeInactive: true })
          this.appendResponseJobs(response, runtime.runtimeId, jobs)
          return { failed: false, jobs }
        } catch { return { failed: true, jobs } }
      }))
      const runtimeFailure = runtimeCatalogs.some((catalog) => catalog.failed)
      // Promise.all preserves runtime list order; the first successful owner wins duplicate IDs.
      for (const catalog of runtimeCatalogs) {
        for (const job of catalog.jobs) { if (!jobsById.has(job.id)) jobsById.set(job.id, job) }
      }

      let fallbackComplete = false
      if ((runtimes.length === 0 || runtimeFailure) && this.primeAgentPath) {
        if (this.cliUnavailable) {
          // The negative result is cached for the session: the CLI has no
          // schedule catalog, so its contribution is a complete empty list.
          fallbackComplete = true
        } else {
          let result: ProcessResult | undefined
          try {
            result = await runProcess(this.primeAgentPath, ['schedule', 'list', '--all', '--json'], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
          } catch (error) {
            const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
            if (code !== 'ENOENT') throw error
            this.markCliScheduleSupportUnavailable('executable not found')
          }
          if (result) {
            const failure = processFailureReason(result)
            if (failure === 'exit' && isUnknownCommandOutput(`${result.stderr}\n${result.stdout}`)) {
              this.markCliScheduleSupportUnavailable('schedule commands are not supported by this CLI')
            } else if (failure) {
              throw new Error(`Prime Agent could not return a complete schedule catalog (${failure})`)
            } else {
              let parsed: unknown
              try { parsed = JSON.parse(result.stdout) } catch { throw new Error('Prime Agent returned an incompatible schedule catalog') }
              if (!isRecord(parsed) || !Array.isArray(parsed.jobs)) throw new Error('Prime Agent returned an incompatible schedule catalog')
              for (const raw of parsed.jobs) {
                const job = normalizeJob(raw)
                if (job && !jobsById.has(job.id)) jobsById.set(job.id, job)
              }
            }
          }
          fallbackComplete = true
        }
      }
      if (runtimeFailure && !fallbackComplete) throw new Error('One or more runtimes could not return schedules; the catalog would be incomplete')
    }
    return [...jobsById.values()].sort((a, b) => (a.nextRun ?? '').localeCompare(b.nextRun ?? ''))
  }

  add(runtimeId: unknown, schedule: unknown, prompt: unknown): Promise<Record<string, unknown>> {
    return this.agents.command(runtimeId, {
      type: 'add_schedule',
      schedule: requireString(schedule, 'schedule', { min: 1, max: 500, trim: true }),
      prompt: requireString(prompt, 'prompt', { min: 1, max: 1024 * 1024 }),
    })
  }

  cancel(runtimeId: unknown, jobId: unknown): Promise<Record<string, unknown>> {
    return this.agents.command(runtimeId, { type: 'cancel_schedule', jobId: requireString(jobId, 'jobId', { min: 1, max: 256 }) })
  }

  private appendResponseJobs(response: Record<string, unknown>, runtimeId: string, output: ScheduleRecord[]): void {
    if (!isRecord(response.data) || !Array.isArray(response.data.jobs)) return
    for (const raw of response.data.jobs) { const job = normalizeJob(raw, runtimeId); if (job) output.push(job) }
  }
}
