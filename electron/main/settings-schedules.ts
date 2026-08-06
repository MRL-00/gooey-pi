import { session } from 'electron'
import type { AppSettings, ScheduleRecord } from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import { runProcess } from './process-utils'
import type { JsonStateStore } from './store'
import { isRecord, rejectUnknownKeys, requireBoolean, requireString, requireWebUrl } from './validation'

export class SettingsService {
  constructor(private readonly store: JsonStateStore, private readonly validateShell: (shell: unknown) => string) {}

  get(): AppSettings { return this.store.snapshot().settings }

  async update(raw: unknown): Promise<AppSettings> {
    if (!isRecord(raw)) throw new TypeError('settings patch must be an object')
    const keys: Array<keyof AppSettings> = ['theme', 'sidebarOpen', 'inspectorOpen', 'terminalOpen', 'defaultInspectorTab', 'browserHome', 'browserAskForDownloads', 'terminalShell', 'reduceMotion', 'telemetry']
    rejectUnknownKeys(raw, keys, 'settings patch')
    const patch: Partial<AppSettings> = {}
    if (raw.theme !== undefined) {
      if (raw.theme !== 'system' && raw.theme !== 'light' && raw.theme !== 'dark') throw new TypeError('Invalid theme')
      patch.theme = raw.theme
    }
    for (const key of ['sidebarOpen', 'inspectorOpen', 'terminalOpen', 'browserAskForDownloads', 'reduceMotion', 'telemetry'] as const) {
      if (raw[key] !== undefined) patch[key] = requireBoolean(raw[key], key)
    }
    if (raw.defaultInspectorTab !== undefined) {
      if (raw.defaultInspectorTab !== 'summary' && raw.defaultInspectorTab !== 'changes' && raw.defaultInspectorTab !== 'browser' && raw.defaultInspectorTab !== 'files') throw new TypeError('Invalid inspector tab')
      patch.defaultInspectorTab = raw.defaultInspectorTab
    }
    if (raw.browserHome !== undefined) patch.browserHome = requireWebUrl(raw.browserHome)
    if (raw.terminalShell !== undefined) patch.terminalShell = this.validateShell(raw.terminalShell)
    return this.store.update((state) => Object.assign(state.settings, patch))
  }

  async resetBrowserData(): Promise<boolean> {
    try {
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
  let status: ScheduleRecord['status']
  if (primeStatus === 'active' || primeStatus === 'paused' || primeStatus === 'completed') status = primeStatus
  else if (typeof raw.lastError === 'string' && raw.lastError) status = 'failed'
  else status = 'completed'
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

export class ScheduleService {
  constructor(private readonly agents: AgentRpcManager, private readonly primeAgentPath: string | null) {}

  async list(runtimeIdValue?: unknown): Promise<ScheduleRecord[]> {
    const runtimeId = runtimeIdValue === undefined ? undefined : requireString(runtimeIdValue, 'runtimeId', { min: 1, max: 256 })
    const jobs: ScheduleRecord[] = []
    if (runtimeId) {
      const response = await this.agents.command(runtimeId, { type: 'list_schedules', includeInactive: true })
      this.appendResponseJobs(response, runtimeId, jobs)
    } else {
      const runtimes = this.agents.list()
      await Promise.all(runtimes.map(async (runtime) => {
        try {
          const response = await this.agents.command(runtime.runtimeId, { type: 'list_schedules', includeInactive: true })
          this.appendResponseJobs(response, runtime.runtimeId, jobs)
        } catch { /* another runtime or CLI fallback may still return the jobs */ }
      }))
      if (!jobs.length && this.primeAgentPath) {
        const result = await runProcess(this.primeAgentPath, ['schedule', 'list', '--all', '--json'], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
        if (result.code === 0) {
          try {
            const parsed: unknown = JSON.parse(result.stdout)
            if (isRecord(parsed) && Array.isArray(parsed.jobs)) {
              for (const raw of parsed.jobs) { const job = normalizeJob(raw); if (job) jobs.push(job) }
            }
          } catch { /* return empty on an incompatible CLI output */ }
        }
      }
    }
    return [...new Map(jobs.map((job) => [job.id, job])).values()].sort((a, b) => (a.nextRun ?? '').localeCompare(b.nextRun ?? ''))
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
