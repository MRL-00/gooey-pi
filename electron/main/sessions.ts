import type { Stats } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionRecord, TranscriptMessage } from '../../src/types/api'
import { runProcess } from './process-utils'
import { SessionMetadataCatalog, type SessionCatalogIo } from './sessions/catalog'
import { readSessionMetadata, type SessionMetadata } from './sessions/metadata'
import { readTranscript } from './sessions/transcript'
import type { JsonStateStore } from './store'
import { isPathWithin, requireBoolean, requireString } from './validation'

interface RuntimeSessionState { isStreaming: boolean }

const MAX_SESSION_FILES = 5_000
const MAX_CONCURRENT_TRANSCRIPT_READS = 2

type TranscriptReader = (filePath: string, isStreaming: boolean) => Promise<TranscriptMessage[]>

export interface SessionServiceOptions {
  catalogIo?: SessionCatalogIo
  transcriptReader?: TranscriptReader
  maxConcurrentTranscriptReads?: number
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
  private readonly transcriptReader: TranscriptReader
  private readonly maxConcurrentTranscriptReads: number
  private readonly transcriptRequests = new Map<string, Promise<TranscriptMessage[]>>()
  private readonly transcriptWaiters: Array<() => void> = []
  private activeTranscriptReads = 0

  constructor(
    private readonly store: JsonStateStore,
    private readonly primeAgentPath: string | null,
    maxSessionFiles = MAX_SESSION_FILES,
    options: SessionServiceOptions = {},
  ) {
    const transcriptLimit = options.maxConcurrentTranscriptReads ?? MAX_CONCURRENT_TRANSCRIPT_READS
    if (!Number.isInteger(transcriptLimit) || transcriptLimit < 1) throw new RangeError('maxConcurrentTranscriptReads must be a positive integer')
    this.maxConcurrentTranscriptReads = transcriptLimit
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
    stop(filePath: string): Promise<void>
    rename(filePath: string, title: string): Promise<boolean>
  }): void {
    this.runtimeForSession = hooks.get
    this.stopRuntimeForSession = hooks.stop
    this.renameRuntimeSession = hooks.rename
  }

  async list(projectPath?: string, includeArchivedValue: unknown = false): Promise<SessionRecord[]> {
    const includeArchived = requireBoolean(includeArchivedValue, 'includeArchived')
    const project = projectPath ? resolve(requireString(projectPath, 'projectPath', { min: 1, max: 4096 })) : undefined
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

  async read(filePath: string): Promise<TranscriptMessage[]> {
    const safePath = await this.requireSessionPath(filePath)
    const existing = this.transcriptRequests.get(safePath)
    if (existing) return structuredClone(await existing)

    const request = this.runTranscriptRead(safePath)
    this.transcriptRequests.set(safePath, request)
    try {
      return structuredClone(await request)
    } finally {
      if (this.transcriptRequests.get(safePath) === request) this.transcriptRequests.delete(safePath)
    }
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

  private async runTranscriptRead(filePath: string): Promise<TranscriptMessage[]> {
    await this.acquireTranscriptRead()
    try {
      return await this.transcriptReader(filePath, this.runtimeForSession(filePath)?.isStreaming === true)
    } finally {
      this.releaseTranscriptRead()
    }
  }

  private async acquireTranscriptRead(): Promise<void> {
    if (this.activeTranscriptReads < this.maxConcurrentTranscriptReads) {
      this.activeTranscriptReads += 1
      return
    }
    await new Promise<void>((resolveAdmission) => this.transcriptWaiters.push(resolveAdmission))
  }

  private releaseTranscriptRead(): void {
    const next = this.transcriptWaiters.shift()
    if (next) next()
    else this.activeTranscriptReads -= 1
  }

  private async readMetadata(filePath: string, knownStat?: Stats): Promise<SessionMetadata> {
    return readSessionMetadata(filePath, knownStat)
  }
}
