import { watch, type FSWatcher, type Stats } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { SessionChangeEvent, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { queueDaemonFollowUp } from './agent-daemon'
import { comparePaths, createAdmissionQueue, createSingleFlight, type AdmissionQueue } from './lib/async'
import { runProcess } from './process-utils'
import { SessionMetadataCatalog, type SessionCatalogIo } from './sessions/catalog'
import { createSessionMetadataReader, type SessionMetadata } from './sessions/metadata'
import { readTranscript } from './sessions/transcript'
import type { JsonStateStore } from './store'
import { isPathWithin, isRecord, requireBoolean, requireExistingDirectory, requireId, requireString } from './validation'

interface RuntimeSessionState { isStreaming: boolean; isCompacting?: boolean }

interface RuntimeSessionSnapshot extends RuntimeSessionState { sessionFile?: string }

const MAX_SESSION_FILES = 5_000
const MAX_CONCURRENT_TRANSCRIPT_READS = 2
const MAX_PENDING_TRANSCRIPT_READS = 32

type TranscriptReader = (filePath: string, isStreaming: boolean) => Promise<TranscriptMessage[]>

export interface SessionServiceOptions {
  catalogIo?: SessionCatalogIo
  transcriptReader?: TranscriptReader
  maxConcurrentTranscriptReads?: number
  maxPendingTranscriptReads?: number
}

export class SessionService {
  readonly sessionRoot = join(homedir(), '.prime', 'agent', 'sessions')
  private runtimeForSession: (filePath: string) => RuntimeSessionState | undefined = () => undefined
  private listRuntimeSessions: (() => readonly RuntimeSessionSnapshot[]) | null = null
  private stopRuntimeForSession: (filePath: string) => Promise<void> = async () => undefined
  private renameRuntimeSession: (filePath: string, title: string) => Promise<boolean> = async () => false
  private readonly catalog: SessionMetadataCatalog
  private readonly metadataReader = createSessionMetadataReader()
  private readonly transcriptReads = createSingleFlight<string, TranscriptMessage[]>()
  private readonly transcriptAdmission: AdmissionQueue
  private readonly transcriptReader: TranscriptReader
  private readonly changeListeners = new Set<(event: SessionChangeEvent) => void>()
  private sessionWatcher: FSWatcher | null = null
  private watcherRetry: NodeJS.Timeout | null = null
  private changeTimer: NodeJS.Timeout | null = null
  private readonly changedNames = new Set<string>()
  private catalogOnlyChange = false
  private followUpsInFlight = 0

  constructor(
    private readonly store: JsonStateStore,
    private readonly primeAgentPath: string | null,
    maxSessionFiles = MAX_SESSION_FILES,
    options: SessionServiceOptions = {},
  ) {
    const transcriptLimit = options.maxConcurrentTranscriptReads ?? MAX_CONCURRENT_TRANSCRIPT_READS
    const pendingLimit = options.maxPendingTranscriptReads ?? MAX_PENDING_TRANSCRIPT_READS
    if (!Number.isInteger(transcriptLimit) || transcriptLimit < 1) throw new RangeError('maxConcurrentTranscriptReads must be a positive integer')
    if (!Number.isInteger(pendingLimit) || pendingLimit < 0) throw new RangeError('maxPendingTranscriptReads must be a non-negative integer')
    this.transcriptAdmission = createAdmissionQueue({
      maxConcurrent: transcriptLimit,
      maxPending: pendingLimit,
      pendingLimitError: () => new Error('Too many transcript reads are pending'),
      closedError: () => new Error('Too many transcript reads are pending'),
    })
    this.transcriptReader = options.transcriptReader ?? readTranscript
    this.catalog = new SessionMetadataCatalog(
      () => this.sessionRoot,
      primeAgentPath,
      maxSessionFiles,
      (filePath, knownStat) => this.readMetadata(filePath, knownStat),
      options.catalogIo,
    )
  }

  bindRuntimeHooks(hooks: {
    get(filePath: string): RuntimeSessionState | undefined
    all?(): readonly RuntimeSessionSnapshot[]
    stop(filePath: string): Promise<void>
    rename(filePath: string, title: string): Promise<boolean>
  }): void {
    this.runtimeForSession = hooks.get
    this.listRuntimeSessions = hooks.all ?? null
    this.stopRuntimeForSession = hooks.stop
    this.renameRuntimeSession = hooks.rename
  }

  onDidChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.changeListeners.add(listener)
    this.startWatcher()
    return () => {
      this.changeListeners.delete(listener)
      if (!this.changeListeners.size) this.stopWatcher()
    }
  }

  async list(projectPath?: string, includeArchivedValue: unknown = false): Promise<SessionRecord[]> {
    const includeArchived = requireBoolean(includeArchivedValue, 'includeArchived')
    const requestedProject = projectPath ? requireString(projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
    let project = requestedProject ? resolve(requestedProject) : undefined
    if (requestedProject) {
      try { project = await requireExistingDirectory(requestedProject, 'projectPath') } catch { /* Preserve stale lexical filtering. */ }
    }
    const sessions = await this.catalog.all()
    const archived = new Set(this.store.getArchivedSessions().map((path) => resolve(path)))
    // One runtime snapshot per list call; each session then resolves in O(1).
    const runtimeBySession = this.snapshotRuntimeSessions()
    const records: SessionRecord[] = []
    for (const original of sessions) {
      const metadata = { ...original }
      const isArchived = archived.has(resolve(metadata.filePath))
      if ((isArchived && !includeArchived) || (project && resolve(metadata.projectPath) !== project)) continue
      const runtime = runtimeBySession
        ? runtimeBySession.get(resolve(metadata.filePath))
        : this.runtimeForSession(metadata.filePath)
      if (runtime) metadata.status = runtime.isStreaming || runtime.isCompacting ? 'running' : 'idle'
      const { sessionName: _sessionName, ...record } = metadata
      records.push({ ...record, archived: isArchived })
    }
    return records.sort((a, b) => Date.parse(b.lastUserMessageAt ?? b.createdAt) - Date.parse(a.lastUserMessageAt ?? a.createdAt) || comparePaths(a.filePath, b.filePath))
  }

  private snapshotRuntimeSessions(): Map<string, RuntimeSessionState> | null {
    if (!this.listRuntimeSessions) return null
    const bySession = new Map<string, RuntimeSessionState>()
    for (const runtime of this.listRuntimeSessions()) {
      if (!runtime.sessionFile) continue
      const key = resolve(runtime.sessionFile)
      if (!bySession.has(key)) bySession.set(key, runtime)
    }
    return bySession
  }

  async projectPaths(): Promise<string[]> {
    const sessions = await this.list()
    return [...new Set(sessions.map((session) => session.projectPath).filter((path) => path.startsWith('/')))]
  }

  async read(filePath: string): Promise<TranscriptMessage[]> {
    const requested = requireString(filePath, 'filePath', { min: 1, max: 4096 })
    const safePath = await this.requireSessionPath(requested)
    // Coalesced callers share one immutable result; the IPC boundary clones it
    // for the renderer, so a pre-IPC structuredClone would be a second copy.
    return this.transcriptReads.run(safePath, () => this.transcriptAdmission.run(async () => {
      const runtime = this.runtimeForSession(safePath)
      return this.transcriptReader(safePath, runtime?.isStreaming === true || runtime?.isCompacting === true)
    }))
  }

  async followUp(filePath: unknown, message: unknown, intent: unknown = 'queue'): Promise<boolean> {
    if (intent !== 'queue' && intent !== 'steer') throw new TypeError('Invalid active-session message intent')
    if (this.followUpsInFlight >= 4) throw new Error('Too many active-session replies are in flight')
    this.followUpsInFlight += 1
    try { return await this.queueActiveFollowUp(filePath, message, intent) }
    finally { this.followUpsInFlight -= 1 }
  }

  private async queueActiveFollowUp(filePath: unknown, message: unknown, intent: 'queue' | 'steer'): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const safeMessage = requireString(message, 'message', { min: 1, max: 64 * 1024 })
    if (!this.primeAgentPath) throw new Error('Prime Agent executable was not found')

    // The catalog canonicalizes candidate session files with bounded
    // parallelism and caches the result; reuse it instead of re-listing with
    // up to MAX_SESSION_FILES * 4 serial realpath calls.
    const active = (await this.catalog.liveSessions()).get(safePath)
    if (active?.lifecycle !== 'live' || active.isSessionActive !== true) return false
    const activeSessionId = requireId(active.activeSessionId ?? active.id, 'activeSessionId')
    if (activeSessionId.startsWith('-')) throw new Error('Prime Agent returned an invalid active session identifier')

    const status = await runProcess(this.primeAgentPath, ['status', '--json'], { timeoutMs: 15_000, maxBytes: 1024 * 1024 })
    if (status.code !== 0 || status.timedOut || status.outputExceeded) throw new Error('Prime Work could not inspect the Prime Agent daemon')
    let statuses: unknown
    try { statuses = JSON.parse(status.stdout) } catch { throw new Error('Prime Agent returned an invalid daemon status') }
    if (!Array.isArray(statuses) || statuses.length > 64) throw new Error('Prime Agent returned an invalid daemon status')
    const current = statuses.find((value) => isRecord(value) && value.status === 'current' && value.isDefault === true)
    if (!isRecord(current) || typeof current.socketPath !== 'string') throw new Error('Prime Agent did not report its active daemon socket')
    await queueDaemonFollowUp(current.socketPath, activeSessionId, safeMessage, intent === 'steer' ? 'steer' : 'follow_up')
    return true
  }

  async rename(filePath: string, title: string): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const safeTitle = requireString(title, 'title', { min: 1, max: 200, trim: true })
    if (safeTitle.startsWith('-') || /[\r\n]/.test(safeTitle)) throw new TypeError('title contains invalid characters')
    if (await this.renameRuntimeSession(safePath, safeTitle)) return true
    if (!this.primeAgentPath) return false
    const metadata = await this.readMetadata(safePath)
    const result = await runProcess(this.primeAgentPath, ['rename', metadata.id, safeTitle, '--json'], { timeoutMs: 30_000 })
    return result.code === 0
  }

  async archive(filePath: string, archivedValue: unknown = true): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const archived = requireBoolean(archivedValue, 'archived')
    if (archived) await this.stopRuntimeForSession(safePath)
    await this.store.update((state) => {
      state.archivedSessions = state.archivedSessions.filter((path) => resolve(path) !== resolve(safePath))
      if (archived) state.archivedSessions.push(safePath)
    })
    return true
  }

  async requireSessionPath(value: unknown): Promise<string> {
    const requested = requireString(value, 'filePath', { min: 1, max: 4096 })
    const root = await realpath(this.sessionRoot)
    const path = await realpath(requested)
    if (!isPathWithin(root, path) || !path.endsWith('.jsonl')) throw new TypeError('Session path is outside the Prime session directory')
    return path
  }

  private startWatcher(): void {
    if (this.sessionWatcher || this.watcherRetry || !this.changeListeners.size) return
    try {
      const watcher = watch(this.sessionRoot, { persistent: false }, (_eventType, filename) => {
        this.queueSessionChange(filename)
      })
      this.sessionWatcher = watcher
      watcher.on('error', () => {
        if (this.sessionWatcher !== watcher) return
        watcher.close()
        this.sessionWatcher = null
        this.queueSessionChange(null)
        this.scheduleWatcherRetry()
      })
    } catch {
      this.scheduleWatcherRetry()
    }
  }

  private scheduleWatcherRetry(): void {
    if (this.watcherRetry || !this.changeListeners.size) return
    this.watcherRetry = setTimeout(() => {
      this.watcherRetry = null
      this.startWatcher()
    }, 1_000)
    this.watcherRetry.unref()
  }

  private stopWatcher(): void {
    this.sessionWatcher?.close()
    this.sessionWatcher = null
    if (this.watcherRetry) clearTimeout(this.watcherRetry)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.watcherRetry = null
    this.changeTimer = null
    this.changedNames.clear()
    this.catalogOnlyChange = false
  }

  private queueSessionChange(filename: string | Buffer | null): void {
    const name = typeof filename === 'string' ? filename : Buffer.isBuffer(filename) ? filename.toString('utf8') : ''
    if (!name || basename(name) !== name || name.startsWith('.') || !name.endsWith('.jsonl')) {
      this.catalogOnlyChange = true
    } else if (this.changedNames.size < 256) {
      this.changedNames.add(name)
    } else {
      this.catalogOnlyChange = true
    }
    if (!this.changeTimer) {
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null
        void this.flushSessionChanges()
      }, 120)
      this.changeTimer.unref()
    }
  }

  private async flushSessionChanges(): Promise<void> {
    const names = [...this.changedNames]
    let catalogOnly = this.catalogOnlyChange
    this.changedNames.clear()
    this.catalogOnlyChange = false
    this.catalog.invalidateLiveCatalog()
    const paths = (await Promise.all(names.map(async (name) => {
      try { return await this.requireSessionPath(join(this.sessionRoot, name)) } catch { return null }
    }))).filter((path): path is string => path !== null)
    if (paths.length !== names.length) catalogOnly = true
    if (!this.changeListeners.size) return
    for (const filePath of paths) this.emitChange({ filePath })
    if (catalogOnly) this.emitChange({})
  }

  private emitChange(event: SessionChangeEvent): void {
    for (const listener of this.changeListeners) {
      try { listener(event) } catch { /* A renderer listener cannot break session watching. */ }
    }
  }

  private async readMetadata(filePath: string, knownStat?: Stats): Promise<SessionMetadata> {
    const metadata = await this.metadataReader(filePath, knownStat)
    if (metadata.projectPath) {
      try { metadata.projectPath = await requireExistingDirectory(metadata.projectPath, 'session project path') }
      catch { if (metadata.projectPath.startsWith('/')) metadata.projectPath = resolve(metadata.projectPath) }
    }
    return metadata
  }
}
