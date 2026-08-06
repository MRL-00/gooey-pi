import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AppSettings, ProjectRecord } from '../../src/types/api'
import { isRecord } from './validation'

export interface FolderIdentity { dev: string; ino: string }

export interface PersistedProject extends Omit<ProjectRecord, 'sessionCount' | 'gitBranch' | 'inferred'> {
  folderIdentities?: Record<string, FolderIdentity>
}

export interface DesktopState {
  version: 1
  projects: PersistedProject[]
  settings: AppSettings
  archivedSessions: string[]
  dismissedProjectPaths: string[]
}

export function defaultSettings(): AppSettings {
  return {
    theme: 'system',
    sidebarOpen: true,
    inspectorOpen: true,
    terminalOpen: false,
    defaultInspectorTab: 'summary',
    browserHome: 'https://www.google.com/',
    browserAskForDownloads: true,
    terminalShell: process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh',
    reduceMotion: false,
    showReasoningSummaries: true,
    showToolCalls: true,
    telemetry: false,
    disabledProviders: [],
  }
}

function defaultState(): DesktopState {
  return { version: 1, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [] }
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
    telemetry: typeof value.telemetry === 'boolean' ? value.telemetry : defaults.telemetry,
    disabledProviders: Array.isArray(value.disabledProviders)
      ? [...new Set(value.disabledProviders.filter((item): item is string => typeof item === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item)))].slice(0, 128)
      : defaults.disabledProviders,
  }
}

function parseState(value: unknown): DesktopState {
  if (!isRecord(value)) return defaultState()
  return {
    version: 1,
    projects: Array.isArray(value.projects) ? value.projects.map(parseProject).filter((item): item is PersistedProject => item !== null) : [],
    settings: parseSettings(value.settings),
    archivedSessions: Array.isArray(value.archivedSessions) ? value.archivedSessions.filter((item): item is string => typeof item === 'string') : [],
    dismissedProjectPaths: Array.isArray(value.dismissedProjectPaths) ? value.dismissedProjectPaths.filter((item): item is string => typeof item === 'string') : [],
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
