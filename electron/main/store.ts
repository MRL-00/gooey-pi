import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
    telemetry: false,
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
    telemetry: typeof value.telemetry === 'boolean' ? value.telemetry : defaults.telemetry,
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

export class JsonStateStore {
  private state: DesktopState
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    try {
      this.state = parseState(JSON.parse(readFileSync(filePath, 'utf8')))
    } catch (error) {
      this.state = defaultState()
      try {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') renameSync(filePath, `${filePath}.corrupt-${Date.now()}`)
      } catch { /* The valid in-memory fallback remains usable. */ }
      this.persist(this.state)
    }
  }

  snapshot(): DesktopState {
    return structuredClone(this.state)
  }

  async update<T>(mutator: (draft: DesktopState) => T): Promise<T> {
    const operation = this.queue.then(() => {
      const draft = structuredClone(this.state)
      const result = mutator(draft)
      this.persist(draft)
      this.state = draft
      return result
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }

  private persist(state: DesktopState): void {
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    const fd = openSync(temp, 'w', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, this.filePath)
    try {
      const directoryFd = openSync(dirname(this.filePath), 'r')
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    } catch { /* Some filesystems do not allow fsync on a directory. */ }
  }
}
