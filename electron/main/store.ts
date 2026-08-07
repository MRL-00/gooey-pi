import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { AppSettings, ProjectRecord, ScheduleExecution, AutomationScheduleRecord, ScheduleRunRecord, ScheduleTarget, ScheduleTiming } from '../../src/types/api'
import { isRecord } from './validation'

export interface FolderIdentity { dev: string; ino: string }

export interface PersistedProject extends Omit<ProjectRecord, 'sessionCount' | 'gitBranch' | 'inferred'> {
  folderIdentities?: Record<string, FolderIdentity>
}

export interface DesktopState {
  version: 2
  projects: PersistedProject[]
  settings: AppSettings
  archivedSessions: string[]
  dismissedProjectPaths: string[]
  schedules: AutomationScheduleRecord[]
}

export function defaultSettings(): AppSettings {
  const defaultShell = process.platform === 'win32'
    ? (process.env.ComSpec && isAbsolute(process.env.ComSpec) ? process.env.ComSpec : 'C:\\Windows\\System32\\cmd.exe')
    : (process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh')
  return {
    theme: 'system',
    sidebarOpen: true,
    inspectorOpen: true,
    terminalOpen: false,
    defaultInspectorTab: 'summary',
    browserHome: 'https://www.google.com/',
    browserAskForDownloads: true,
    terminalShell: defaultShell,
    reduceMotion: false,
    showReasoningSummaries: true,
    showToolCalls: true,
    messageEnterAction: 'queue',
    telemetry: false,
    disabledProviders: [],
  }
}

function defaultState(): DesktopState {
  return { version: 2, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] }
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function parseProject(value: unknown): PersistedProject | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.path !== 'string') return null
  const folders = Array.isArray(value.folders) ? value.folders.filter((item): item is string => typeof item === 'string') : [value.path]
  if (!folders.length || typeof value.primaryFolder !== 'string') return null
  const now = new Date().toISOString()
  const folderIdentities: Record<string, FolderIdentity> = {}
  if (isRecord(value.folderIdentities)) {
    for (const [path, identity] of Object.entries(value.folderIdentities)) {
      if (isRecord(identity) && typeof identity.dev === 'string' && typeof identity.ino === 'string') folderIdentities[path] = { dev: identity.dev, ino: identity.ino }
    }
  }
  return {
    id: value.id || randomUUID(),
    name: value.name,
    path: value.path,
    folders,
    primaryFolder: value.primaryFolder,
    pinned: typeof value.pinned === 'boolean' ? value.pinned : false,
    createdAt: validDate(value.createdAt) ? value.createdAt : now,
    lastOpenedAt: validDate(value.lastOpenedAt) ? value.lastOpenedAt : now,
    folderIdentities: Object.keys(folderIdentities).length ? folderIdentities : undefined,
  }
}

function parseSettings(value: unknown): AppSettings {
  const defaults = defaultSettings()
  if (!isRecord(value)) return defaults
  return {
    theme: value.theme === 'light' || value.theme === 'dark' || value.theme === 'system' ? value.theme : defaults.theme,
    sidebarOpen: typeof value.sidebarOpen === 'boolean' ? value.sidebarOpen : defaults.sidebarOpen,
    inspectorOpen: typeof value.inspectorOpen === 'boolean' ? value.inspectorOpen : defaults.inspectorOpen,
    terminalOpen: typeof value.terminalOpen === 'boolean' ? value.terminalOpen : defaults.terminalOpen,
    defaultInspectorTab: value.defaultInspectorTab === 'changes' || value.defaultInspectorTab === 'browser' || value.defaultInspectorTab === 'files' || value.defaultInspectorTab === 'summary' ? value.defaultInspectorTab : defaults.defaultInspectorTab,
    browserHome: typeof value.browserHome === 'string' ? value.browserHome : defaults.browserHome,
    browserAskForDownloads: typeof value.browserAskForDownloads === 'boolean' ? value.browserAskForDownloads : defaults.browserAskForDownloads,
    terminalShell: typeof value.terminalShell === 'string' ? value.terminalShell : defaults.terminalShell,
    reduceMotion: typeof value.reduceMotion === 'boolean' ? value.reduceMotion : defaults.reduceMotion,
    showReasoningSummaries: typeof value.showReasoningSummaries === 'boolean' ? value.showReasoningSummaries : defaults.showReasoningSummaries,
    showToolCalls: typeof value.showToolCalls === 'boolean' ? value.showToolCalls : defaults.showToolCalls,
    messageEnterAction: value.messageEnterAction === 'queue' || value.messageEnterAction === 'steer' ? value.messageEnterAction : defaults.messageEnterAction,
    telemetry: typeof value.telemetry === 'boolean' ? value.telemetry : defaults.telemetry,
    disabledProviders: Array.isArray(value.disabledProviders)
      ? [...new Set(value.disabledProviders.filter((item): item is string => typeof item === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item)))].slice(0, 128)
      : defaults.disabledProviders,
  }
}

const THINKING_LEVELS = new Set(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'skipped', 'interrupted'])
const SCHEDULE_STATUSES = new Set(['active', 'paused', 'completed', 'blocked'])

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0)
}

function parseScheduleTarget(value: unknown): ScheduleTarget | null {
  if (!isRecord(value) || !boundedString(value.projectId, 256)) return null
  if (value.kind === 'project') return { kind: 'project', projectId: value.projectId }
  if (value.kind === 'session' && boundedString(value.sessionId, 256)) return { kind: 'session', projectId: value.projectId, sessionId: value.sessionId }
  return null
}

function parseScheduleTiming(value: unknown): ScheduleTiming | null {
  if (!isRecord(value)) return null
  if (value.kind === 'once' && validDate(value.at)) return { kind: 'once', at: value.at }
  if (value.kind === 'rrule' && boundedString(value.dtstartLocal, 64) && boundedString(value.timeZone, 128) && boundedString(value.rrule, 2_048)) {
    return { kind: 'rrule', dtstartLocal: value.dtstartLocal, timeZone: value.timeZone, rrule: value.rrule }
  }
  return null
}

function parseScheduleExecution(value: unknown): ScheduleExecution | null {
  if (!isRecord(value) || !boundedString(value.model, 512) || !THINKING_LEVELS.has(String(value.thinking))) return null
  if (value.speed !== 'normal' && value.speed !== 'fast') return null
  return { model: value.model, thinking: value.thinking as ScheduleExecution['thinking'], speed: value.speed }
}

function parseScheduleRun(value: unknown): ScheduleRunRecord | null {
  if (!isRecord(value) || !boundedString(value.id, 256) || !boundedString(value.taskId, 256)) return null
  if (!Number.isSafeInteger(value.taskRevision) || Number(value.taskRevision) < 1 || !RUN_STATUSES.has(String(value.status))) return null
  if ((value.trigger !== 'scheduled' && value.trigger !== 'manual') || !validDate(value.scheduledFor) || !validDate(value.queuedAt)) return null
  const execution = parseScheduleExecution(value.execution)
  if (!execution) return null
  return {
    id: value.id,
    taskId: value.taskId,
    taskRevision: Number(value.taskRevision),
    trigger: value.trigger,
    scheduledFor: value.scheduledFor,
    queuedAt: value.queuedAt,
    startedAt: validDate(value.startedAt) ? value.startedAt : undefined,
    finishedAt: validDate(value.finishedAt) ? value.finishedAt : undefined,
    status: value.status as ScheduleRunRecord['status'],
    execution,
    sessionId: boundedString(value.sessionId, 256) ? value.sessionId : undefined,
    sessionFile: boundedString(value.sessionFile, 4_096) ? value.sessionFile : undefined,
    error: boundedString(value.error, 4_000, true) ? value.error : undefined,
    skippedCount: Number.isSafeInteger(value.skippedCount) && Number(value.skippedCount) > 0 ? Number(value.skippedCount) : undefined,
  }
}

function parseSchedule(value: unknown): AutomationScheduleRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !boundedString(value.id, 256)) return null
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !boundedString(value.title, 200) || !boundedString(value.prompt, 1024 * 1024)) return null
  const target = parseScheduleTarget(value.target)
  const timing = parseScheduleTiming(value.timing)
  const execution = parseScheduleExecution(value.execution)
  if (!target || !timing || !execution || !SCHEDULE_STATUSES.has(String(value.status))) return null
  if ((value.createdBy !== 'user' && value.createdBy !== 'agent') || !validDate(value.createdAt) || !validDate(value.updatedAt)) return null
  const runs = Array.isArray(value.runs) ? value.runs.map(parseScheduleRun).filter((run): run is ScheduleRunRecord => run !== null).slice(-50) : []
  return {
    schemaVersion: 1,
    id: value.id,
    revision: Number(value.revision),
    title: value.title,
    prompt: value.prompt,
    target,
    timing,
    execution,
    status: value.status as AutomationScheduleRecord['status'],
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    nextRunAt: validDate(value.nextRunAt) ? value.nextRunAt : undefined,
    blockedReason: boundedString(value.blockedReason, 4_000, true) ? value.blockedReason : undefined,
    runs,
  }
}

function parseState(value: unknown): DesktopState {
  if (!isRecord(value)) return defaultState()
  return {
    version: 2,
    projects: Array.isArray(value.projects) ? value.projects.map(parseProject).filter((item): item is PersistedProject => item !== null) : [],
    settings: parseSettings(value.settings),
    archivedSessions: Array.isArray(value.archivedSessions) ? value.archivedSessions.filter((item): item is string => typeof item === 'string') : [],
    dismissedProjectPaths: Array.isArray(value.dismissedProjectPaths) ? value.dismissedProjectPaths.filter((item): item is string => typeof item === 'string') : [],
    schedules: Array.isArray(value.schedules) ? value.schedules.map(parseSchedule).filter((item): item is AutomationScheduleRecord => item !== null).slice(0, 500) : [],
  }
}

export interface JsonStateStoreFileHandle {
  writeFile(data: string, options: { encoding: 'utf8' }): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface JsonStateStoreFileSystem {
  open(path: string, flags: string, mode?: number): Promise<JsonStateStoreFileHandle>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

const nodeFileSystem: JsonStateStoreFileSystem = {
  open: (path, flags, mode) => open(path, flags, mode) as Promise<FileHandle>,
  rename,
  unlink,
}

export class JsonStateStore {
  private state: DesktopState
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly filePath: string,
    private readonly fileSystem: JsonStateStoreFileSystem = nodeFileSystem,
  ) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    try {
      this.state = parseState(JSON.parse(readFileSync(filePath, 'utf8')))
    } catch (error) {
      this.state = defaultState()
      try {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
      } catch { /* The valid in-memory fallback remains usable. */ }
      this.queue = this.persist(this.state).catch(() => undefined)
    }
  }

  snapshot(): DesktopState {
    return structuredClone(this.state)
  }

  async update<T>(mutator: (draft: DesktopState) => T): Promise<T> {
    if (this.closed) throw new Error('Desktop state store is shutting down')
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state)
      const result = mutator(draft)
      await this.persist(draft)
      this.state = draft
      return result
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async beginShutdown(): Promise<void> {
    this.closed = true
    await this.queue
  }

  private async persist(state: DesktopState): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      const file = await this.fileSystem.open(temp, 'w', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8' })
        await file.sync()
      } finally {
        await file.close()
      }

      await this.fileSystem.rename(temp, this.filePath)

      try {
        const directory = await this.fileSystem.open(dirname(this.filePath), 'r')
        try { await directory.sync() } finally { await directory.close() }
      } catch { /* Some filesystems do not allow fsync on a directory. */ }
    } finally {
      try {
        await this.fileSystem.unlink(temp)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
}
