import type { Stats } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionRecord, TranscriptMessage } from '../../src/types/api'
import { runProcess } from './process-utils'
import { SessionMetadataCatalog } from './sessions/catalog'
import { readSessionMetadata, type SessionMetadata } from './sessions/metadata'
import { readTranscript } from './sessions/transcript'
import type { JsonStateStore } from './store'
import { isPathWithin, requireBoolean, requireExistingDirectory, requireString } from './validation'

interface RuntimeSessionState { isStreaming: boolean }

const MAX_SESSION_FILES = 5_000
const MAX_CONCURRENT_TRANSCRIPT_READS = 3
const MAX_PENDING_TRANSCRIPT_READS = 32

interface TranscriptReadOptions {
  maxConcurrent?: number
  maxPending?: number
  reader?: typeof readTranscript
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export class SessionService {
  readonly sessionRoot = join(homedir(), '.prime', 'agent', 'sessions')
  private runtimeForSession: (filePath: string) => RuntimeSessionState | undefined = () => undefined
  private stopRuntimeForSession: (filePath: string) => Promise<void> = async () => undefined
  private renameRuntimeSession: (filePath: string, title: string) => Promise<boolean> = async () => false
  private readonly catalog: SessionMetadataCatalog
  private readonly transcriptReadsByRequest = new Map<string, Promise<TranscriptMessage[]>>()
  private readonly transcriptReadsByCanonicalPath = new Map<string, Promise<TranscriptMessage[]>>()
  private readonly transcriptReadQueue: Array<() => void> = []
  private activeTranscriptReads = 0
  private readonly maxConcurrentTranscriptReads: number
  private readonly maxPendingTranscriptReads: number
  private readonly transcriptReader: typeof readTranscript

  constructor(
    private readonly store: JsonStateStore,
    private readonly primeAgentPath: string | null,
    maxSessionFiles = MAX_SESSION_FILES,
    transcriptOptions: TranscriptReadOptions = {},
  ) {
    this.maxConcurrentTranscriptReads = transcriptOptions.maxConcurrent ?? MAX_CONCURRENT_TRANSCRIPT_READS
    this.maxPendingTranscriptReads = transcriptOptions.maxPending ?? MAX_PENDING_TRANSCRIPT_READS
    this.transcriptReader = transcriptOptions.reader ?? readTranscript
    this.catalog = new SessionMetadataCatalog(
      () => this.sessionRoot,
      primeAgentPath,
      maxSessionFiles,
      (filePath, knownStat) => this.readMetadata(filePath, knownStat),
    )
  }

  bindRuntimeHooks(hooks: {
    get(filePath: string): RuntimeSessionState | undefined
    stop(filePath: string): Promise<void>
    rename(filePath: string, title: string): Promise<boolean>
  }): void {
    this.runtimeForSession = hooks.get
    this.stopRuntimeForSession = hooks.stop
    this.renameRuntimeSession = hooks.rename
  }

  async list(projectPath?: string, includeArchivedValue: unknown = false): Promise<SessionRecord[]> {
    const includeArchived = requireBoolean(includeArchivedValue, 'includeArchived')
    const requestedProject = projectPath ? requireString(projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
    let project = requestedProject ? resolve(requestedProject) : undefined
    if (requestedProject) {
      try { project = await requireExistingDirectory(requestedProject, 'projectPath') } catch { /* Preserve stale lexical filtering. */ }
    }
    const sessions = await this.catalog.all()
    const archived = new Set(this.store.snapshot().archivedSessions.map((path) => resolve(path)))
    const records: SessionRecord[] = []
    for (const original of sessions) {
      const metadata = { ...original }
      const isArchived = archived.has(resolve(metadata.filePath))
      if ((isArchived && !includeArchived) || (project && resolve(metadata.projectPath) !== project)) continue
      const runtime = this.runtimeForSession(metadata.filePath)
      if (runtime) metadata.status = runtime.isStreaming ? 'running' : 'idle'
      const { sessionName: _sessionName, ...record } = metadata
      records.push({ ...record, archived: isArchived })
    }
    return records.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || comparePaths(a.filePath, b.filePath))
  }

  async projectPaths(): Promise<string[]> {
    const sessions = await this.list()
    return [...new Set(sessions.map((session) => session.projectPath).filter((path) => path.startsWith('/')))]
  }

  read(filePath: string): Promise<TranscriptMessage[]> {
    const requested = requireString(filePath, 'filePath', { min: 1, max: 4096 })
    const requestKey = resolve(requested)
    const existing = this.transcriptReadsByRequest.get(requestKey)
    if (existing) return existing

    const operation = this.admitTranscriptRead(async () => {
      const safePath = await this.requireSessionPath(requested)
      const canonicalRead = this.transcriptReadsByCanonicalPath.get(safePath)
      if (canonicalRead) return canonicalRead
      const read = this.transcriptReader(safePath, this.runtimeForSession(safePath)?.isStreaming === true)
      this.transcriptReadsByCanonicalPath.set(safePath, read)
      read.then(
        () => { if (this.transcriptReadsByCanonicalPath.get(safePath) === read) this.transcriptReadsByCanonicalPath.delete(safePath) },
        () => { if (this.transcriptReadsByCanonicalPath.get(safePath) === read) this.transcriptReadsByCanonicalPath.delete(safePath) },
      )
      return read
    })
    this.transcriptReadsByRequest.set(requestKey, operation)
    operation.then(
      () => { if (this.transcriptReadsByRequest.get(requestKey) === operation) this.transcriptReadsByRequest.delete(requestKey) },
      () => { if (this.transcriptReadsByRequest.get(requestKey) === operation) this.transcriptReadsByRequest.delete(requestKey) },
    )
    return operation
  }

  private admitTranscriptRead(task: () => Promise<TranscriptMessage[]>): Promise<TranscriptMessage[]> {
    if (this.activeTranscriptReads < this.maxConcurrentTranscriptReads) return this.runTranscriptRead(task)
    if (this.transcriptReadQueue.length >= this.maxPendingTranscriptReads) {
      return Promise.reject(new Error('Too many transcript reads are pending'))
    }
    return new Promise<TranscriptMessage[]>((resolveRead, rejectRead) => {
      this.transcriptReadQueue.push(() => { void this.runTranscriptRead(task).then(resolveRead, rejectRead) })
    })
  }

  private runTranscriptRead(task: () => Promise<TranscriptMessage[]>): Promise<TranscriptMessage[]> {
    this.activeTranscriptReads += 1
    const operation = task()
    operation.then(
      () => this.finishTranscriptRead(),
      () => this.finishTranscriptRead(),
    )
    return operation
  }

  private finishTranscriptRead(): void {
    this.activeTranscriptReads -= 1
    this.transcriptReadQueue.shift()?.()
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

  private async readMetadata(filePath: string, knownStat?: Stats): Promise<SessionMetadata> {
    const metadata = await readSessionMetadata(filePath, knownStat)
    if (metadata.projectPath) {
      try { metadata.projectPath = await requireExistingDirectory(metadata.projectPath, 'session project path') }
      catch { if (metadata.projectPath.startsWith('/')) metadata.projectPath = resolve(metadata.projectPath) }
    }
    return metadata
  }
}
