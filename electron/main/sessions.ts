import { createReadStream, type Stats } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { MessagePart, SessionRecord, SessionStatus, TranscriptMessage } from '../../src/types/api'
import { strictJsonLines } from './jsonl'
import { runProcess } from './process-utils'
import type { JsonStateStore } from './store'
import { isPathWithin, isRecord, requireBoolean, requireString } from './validation'

type JsonRecord = Record<string, unknown>

interface RuntimeSessionState { isStreaming: boolean }
interface SessionMetadata extends SessionRecord { sessionName?: string }
interface SessionFileCandidate { filePath: string; fileStat: Stats; fingerprint: string }

const MAX_SESSION_FILES = 5_000
const MAX_TRANSCRIPT_RECORD_BYTES = 8 * 1024 * 1024
const MAX_TRANSCRIPT_GRAPH_BYTES = 16 * 1024 * 1024
const MAX_TRANSCRIPT_GRAPH_RECORDS = 10_000
const MAX_TRANSCRIPT_MESSAGES = 400
const MAX_TRANSCRIPT_PARTS = 2_000
const MAX_TRANSCRIPT_TEXT_CHARS = 1024 * 1024
const MAX_TRANSCRIPT_TOOL_CHARS = 512 * 1024
const MAX_TRANSCRIPT_ARGS_CHARS = 256 * 1024
const MAX_TRANSCRIPT_IMAGE_CHARS = 512 * 1024
const MAX_PART_TEXT_CHARS = 256 * 1024
const MAX_PART_TOOL_CHARS = 128 * 1024
const MAX_PART_ARGS_CHARS = 128 * 1024
const MAX_PART_IMAGE_CHARS = 256 * 1024
const MAX_PARTS_PER_RECORD = 200
const TRUNCATION_MARKER = '\n… [truncated] …\n'

function boundedString(value: string, max: number): string {
  if (max <= 0) return ''
  if (value.length <= max) return value
  if (max <= TRUNCATION_MARKER.length) return value.slice(-max)
  const available = max - TRUNCATION_MARKER.length
  const head = Math.floor(available / 3)
  return `${value.slice(0, head)}${TRUNCATION_MARKER}${value.slice(-(available - head))}`
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function textFromContent(content: unknown, max = MAX_PART_TEXT_CHARS): string {
  if (typeof content === 'string') return boundedString(content, max)
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (!isRecord(part)) continue
    const addition = part.type === 'text' && typeof part.text === 'string' ? part.text
      : part.type === 'thinking' && typeof part.thinking === 'string' ? part.thinking : ''
    if (!addition) continue
    text += `${text ? '\n' : ''}${addition}`
    if (text.length > max) return boundedString(text, max)
  }
  return text
}

function compactText(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function validTimestamp(value: unknown, fallback: string): string {
  if ((typeof value === 'string' || typeof value === 'number') && Number.isFinite(Date.parse(String(value)))) return new Date(value).toISOString()
  return fallback
}

function roleOf(message: JsonRecord): TranscriptMessage['role'] {
  switch (message.role) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'system': return 'system'
    default: return 'tool'
  }
}

function boundedArgs(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    return serialized.length <= MAX_PART_ARGS_CHARS ? value : boundedString(serialized, MAX_PART_ARGS_CHARS)
  } catch { return '[unserializable arguments]' }
}

function partsFromMessage(message: JsonRecord): MessagePart[] {
  const content = message.content
  const parts: MessagePart[] = []
  if (typeof content === 'string') parts.push({ type: 'text', text: boundedString(content, MAX_PART_TEXT_CHARS) })
  else if (Array.isArray(content)) {
    const selected = content.length <= MAX_PARTS_PER_RECORD ? content : [...content.slice(0, 20), ...content.slice(-(MAX_PARTS_PER_RECORD - 20))]
    for (const raw of selected) {
      if (!isRecord(raw) || typeof raw.type !== 'string') continue
      if (raw.type === 'text' && typeof raw.text === 'string') parts.push({ type: 'text', text: boundedString(raw.text, MAX_PART_TEXT_CHARS) })
      else if (raw.type === 'thinking' && typeof raw.thinking === 'string') parts.push({ type: 'thinking', text: boundedString(raw.thinking, MAX_PART_TEXT_CHARS) })
      else if ((raw.type === 'toolCall' || raw.type === 'tool_call') && typeof raw.name === 'string') {
        parts.push({
          type: 'toolCall',
          id: typeof raw.id === 'string' ? boundedString(raw.id, 1_024) : undefined,
          name: boundedString(raw.name, 512),
          args: boundedArgs(raw.arguments ?? raw.args),
        })
      } else if (raw.type === 'image') {
        parts.push({
          type: 'image',
          mimeType: typeof raw.mimeType === 'string' ? boundedString(raw.mimeType, 128) : undefined,
          data: typeof raw.data === 'string' ? boundedString(raw.data, MAX_PART_IMAGE_CHARS) : undefined,
        })
      }
    }
  }
  if (message.role === 'toolResult' || message.role === 'tool') {
    const text = parts.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text').map((part) => part.text).join('\n')
    return [{
      type: 'toolResult',
      name: typeof message.toolName === 'string' ? boundedString(message.toolName, 512) : undefined,
      text: boundedString(text, MAX_PART_TOOL_CHARS),
      isError: message.isError === true,
    }]
  }
  if (message.role === 'bashExecution') {
    return [{
      type: 'toolResult',
      name: 'bash',
      text: typeof message.output === 'string' ? boundedString(message.output, MAX_PART_TOOL_CHARS) : '',
      isError: typeof message.exitCode === 'number' && message.exitCode !== 0,
    }]
  }
  return parts.length ? parts : [{ type: 'text', text: '' }]
}

function boundedTranscript(transcript: TranscriptMessage[]): TranscriptMessage[] {
  let textBudget = MAX_TRANSCRIPT_TEXT_CHARS
  let toolBudget = MAX_TRANSCRIPT_TOOL_CHARS
  let argsBudget = MAX_TRANSCRIPT_ARGS_CHARS
  let imageBudget = MAX_TRANSCRIPT_IMAGE_CHARS
  let partBudget = MAX_TRANSCRIPT_PARTS
  const bounded: TranscriptMessage[] = []

  for (const message of transcript.slice(-MAX_TRANSCRIPT_MESSAGES).reverse()) {
    const parts: MessagePart[] = []
    for (const part of [...message.parts].reverse()) {
      if (partBudget <= 0) break
      let next: MessagePart | undefined
      if (part.type === 'text' || part.type === 'thinking') {
        if (textBudget > 0) {
          const text = boundedString(part.text, textBudget)
          textBudget -= text.length
          next = { ...part, text }
        }
      } else if (part.type === 'toolResult') {
        if (toolBudget > 0) {
          const text = boundedString(part.text, toolBudget)
          toolBudget -= text.length
          next = { ...part, text }
        }
      } else if (part.type === 'toolCall') {
        let args: unknown
        if (part.args !== undefined && argsBudget > 0) {
          const serialized = typeof part.args === 'string' ? part.args : JSON.stringify(part.args)
          if (serialized.length <= argsBudget) args = part.args
          else args = boundedString(serialized, argsBudget)
          argsBudget -= Math.min(serialized.length, argsBudget)
        }
        next = { ...part, args }
      } else {
        let data: string | undefined
        if (part.data && imageBudget > 0) {
          data = boundedString(part.data, imageBudget)
          imageBudget -= data.length
        }
        next = { ...part, data }
      }
      if (next) {
        parts.push(next)
        partBudget -= 1
      }
    }
    if (parts.length) bounded.push({ ...message, parts: parts.reverse() })
  }
  return bounded.reverse()
}

function statusFrom(taskState: string | undefined, lifecycle: string | undefined, lastRole: string | undefined, stopReason: string | undefined): SessionStatus {
  if (lifecycle === 'crash') return 'failed'
  if (lifecycle === 'archived') return 'complete'
  if (taskState === 'completed') return 'complete'
  if (taskState === 'needs_input') return 'waiting'
  if (stopReason === 'error') return 'failed'
  if (lastRole === 'assistant' || lastRole === 'toolResult') return 'complete'
  if (lastRole === 'user') return 'idle'
  return 'unknown'
}

async function mapLimit<T, U>(values: readonly T[], limit: number, mapper: (value: T) => Promise<U | null>): Promise<U[]> {
  const result: U[] = []
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index++]
      const mapped = await mapper(current)
      if (mapped !== null) result.push(mapped)
    }
  }))
  return result
}

export class SessionService {
  readonly sessionRoot = join(homedir(), '.prime', 'agent', 'sessions')
  private runtimeForSession: (filePath: string) => RuntimeSessionState | undefined = () => undefined
  private stopRuntimeForSession: (filePath: string) => Promise<void> = async () => undefined
  private renameRuntimeSession: (filePath: string, title: string) => Promise<boolean> = async () => false
  private catalogCache: { expiresAt: number; sessions: Map<string, JsonRecord> } | null = null
  private catalogRequest: Promise<Map<string, JsonRecord>> | null = null
  private sessionScanRequest: Promise<SessionMetadata[]> | null = null
  private readonly metadataCache = new Map<string, SessionMetadata>()
  private readonly metadataRequests = new Map<string, Promise<SessionMetadata>>()

  constructor(
    private readonly store: JsonStateStore,
    private readonly primeAgentPath: string | null,
    private readonly maxSessionFiles = MAX_SESSION_FILES,
  ) {}

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
    const sessions = await this.allSessionMetadata()
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

  private async allSessionMetadata(): Promise<SessionMetadata[]> {
    if (this.sessionScanRequest) return this.sessionScanRequest
    const request = this.scanSessionMetadata()
    this.sessionScanRequest = request
    try { return await request } finally {
      if (this.sessionScanRequest === request) this.sessionScanRequest = null
    }
  }

  private async scanSessionMetadata(): Promise<SessionMetadata[]> {
    let names: string[]
    let root: string
    try {
      [names, root] = await Promise.all([
        readdir(this.sessionRoot).then((items) => items.filter((name) => name.endsWith('.jsonl') && !name.startsWith('.'))),
        realpath(this.sessionRoot),
      ])
    } catch { return [] }

    const discovered = await mapLimit(names, 32, async (name): Promise<SessionFileCandidate | null> => {
      try {
        const filePath = await realpath(join(root, name))
        if (!isPathWithin(root, filePath)) return null
        const fileStat = await stat(filePath)
        if (!fileStat.isFile()) return null
        return { filePath, fileStat, fingerprint: `${filePath}\0${fileStat.mtimeMs}\0${fileStat.size}` }
      } catch { return null }
    })
    const byCanonicalPath = new Map<string, SessionFileCandidate>()
    for (const candidate of discovered) byCanonicalPath.set(candidate.filePath, candidate)
    const selected = [...byCanonicalPath.values()]
      .sort((a, b) => b.fileStat.mtimeMs - a.fileStat.mtimeMs || comparePaths(a.filePath, b.filePath))
      .slice(0, this.maxSessionFiles)
    const activeFingerprints = new Set(selected.map((candidate) => candidate.fingerprint))
    for (const fingerprint of this.metadataCache.keys()) {
      if (!activeFingerprints.has(fingerprint)) this.metadataCache.delete(fingerprint)
    }

    const catalogPromise = this.liveCatalog()
    const metadata = await mapLimit(selected, 6, async (candidate) => {
      try { return await this.cachedMetadata(candidate) } catch { return null }
    })
    const catalog = await catalogPromise
    return metadata.map((original) => {
      const item = { ...original }
      const live = catalog.get(resolve(item.filePath))
      if (live) this.applyLiveMetadata(item, live)
      return item
    })
  }

  private async cachedMetadata(candidate: SessionFileCandidate): Promise<SessionMetadata> {
    const cached = this.metadataCache.get(candidate.fingerprint)
    if (cached) return { ...cached }
    const inFlight = this.metadataRequests.get(candidate.fingerprint)
    if (inFlight) return { ...await inFlight }
    const request = this.readMetadata(candidate.filePath, candidate.fileStat)
    this.metadataRequests.set(candidate.fingerprint, request)
    try {
      const metadata = await request
      const current = await stat(candidate.filePath)
      if (current.mtimeMs === candidate.fileStat.mtimeMs && current.size === candidate.fileStat.size) {
        this.metadataCache.set(candidate.fingerprint, metadata)
      }
      return { ...metadata }
    } finally {
      if (this.metadataRequests.get(candidate.fingerprint) === request) this.metadataRequests.delete(candidate.fingerprint)
    }
  }

  async projectPaths(): Promise<string[]> {
    const sessions = await this.list()
    return [...new Set(sessions.map((session) => session.projectPath).filter((path) => path.startsWith('/')))]
  }

  async read(filePath: string): Promise<TranscriptMessage[]> {
    const safePath = await this.requireSessionPath(filePath)
    if ((await stat(safePath)).size > 256 * 1024 * 1024) throw new Error('Session transcript is too large to display')
    const entries = new Map<string, { id: string; parentId: string | null; entry: JsonRecord; bytes: number }>()
    let graphBytes = 0
    let leafId: string | null = null
    let recordCount = 0
    for await (const line of strictJsonLines(createReadStream(safePath), MAX_TRANSCRIPT_RECORD_BYTES)) {
      if (!line) continue
      if (++recordCount > 200_000) throw new Error('Session transcript has too many records')
      let entry: unknown
      try { entry = JSON.parse(line) } catch { continue }
      if (!isRecord(entry) || entry.type === 'session' || typeof entry.id !== 'string') continue
      const parentId = typeof entry.parentId === 'string' ? entry.parentId : null
      const existing = entries.get(entry.id)
      if (existing) {
        graphBytes -= existing.bytes
        entries.delete(entry.id)
      }
      const bytes = Buffer.byteLength(line, 'utf8')
      entries.set(entry.id, { id: entry.id, parentId, entry, bytes })
      graphBytes += bytes
      leafId = entry.id
      while (entries.size > MAX_TRANSCRIPT_GRAPH_RECORDS || graphBytes > MAX_TRANSCRIPT_GRAPH_BYTES) {
        const oldestId = entries.keys().next().value as string | undefined
        if (oldestId === undefined) break
        graphBytes -= entries.get(oldestId)?.bytes ?? 0
        entries.delete(oldestId)
      }
    }
    const branch: Array<{ id: string; entry: JsonRecord }> = []
    const visited = new Set<string>()
    while (leafId && !visited.has(leafId)) {
      visited.add(leafId)
      const node = entries.get(leafId)
      if (!node) break
      if (node.entry.type === 'message' || (node.entry.type === 'custom_message' && node.entry.display === true)) branch.push(node)
      leafId = node.parentId
    }
    branch.reverse()
    const transcript: TranscriptMessage[] = []
    let activeAssistant: TranscriptMessage | undefined
    for (const { id, entry } of branch) {
      const safeId = boundedString(id, 1_024)
      if (entry.type === 'custom_message') {
        const text = textFromContent(entry.content)
        transcript.push({
          id: safeId,
          role: 'system',
          timestamp: typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined,
          parts: [{ type: 'text', text }],
        })
        activeAssistant = undefined
        continue
      }
      const message = isRecord(entry.message) ? entry.message : {}
      const role = roleOf(message)
      const rawTimestamp = typeof message.timestamp === 'string' || typeof message.timestamp === 'number' ? message.timestamp
        : typeof entry.timestamp === 'string' ? entry.timestamp : undefined
      const timestamp = typeof rawTimestamp === 'string' ? boundedString(rawTimestamp, 128) : rawTimestamp
      const parts = partsFromMessage(message)
      if (role === 'tool' && activeAssistant) {
        const toolCallId = typeof message.toolCallId === 'string' ? boundedString(message.toolCallId, 1_024) : undefined
        const callIndex = toolCallId ? activeAssistant.parts.findIndex((part) => part.type === 'toolCall' && part.id === toolCallId) : -1
        if (callIndex >= 0) activeAssistant.parts.splice(callIndex + 1, 0, ...parts)
        else activeAssistant.parts.push(...parts)
        activeAssistant.timestamp = timestamp ?? activeAssistant.timestamp
        continue
      }
      if (role === 'assistant') {
        if (activeAssistant) {
          activeAssistant.parts.push(...parts)
          activeAssistant.timestamp = timestamp ?? activeAssistant.timestamp
        } else {
          activeAssistant = { id: safeId, role, timestamp, parts }
          transcript.push(activeAssistant)
        }
        continue
      }
      const item: TranscriptMessage = { id: safeId, role, timestamp, parts }
      transcript.push(item)
      activeAssistant = undefined
    }
    if (this.runtimeForSession(safePath)?.isStreaming && activeAssistant) activeAssistant.streaming = true
    return boundedTranscript(transcript)
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

  private async liveCatalog(): Promise<Map<string, JsonRecord>> {
    if (!this.primeAgentPath) return new Map()
    if (this.catalogCache && this.catalogCache.expiresAt > Date.now()) return this.catalogCache.sessions
    if (this.catalogRequest) return this.catalogRequest
    this.catalogRequest = (async () => {
      const sessions = new Map<string, JsonRecord>()
      try {
        const result = await runProcess(this.primeAgentPath!, ['list', '--all', '--json'], { timeoutMs: 15_000, maxBytes: 16 * 1024 * 1024 })
        if (result.code === 0) {
          const parsed: unknown = JSON.parse(result.stdout)
          if (isRecord(parsed) && Array.isArray(parsed.sessions)) {
            for (const raw of parsed.sessions) {
              if (isRecord(raw) && typeof raw.sessionFile === 'string') sessions.set(resolve(raw.sessionFile), raw)
            }
          }
        }
      } catch { /* JSONL remains authoritative when the live catalog is unavailable. */ }
      this.catalogCache = { expiresAt: Date.now() + 2_000, sessions }
      return sessions
    })()
    try { return await this.catalogRequest } finally { this.catalogRequest = null }
  }

  private applyLiveMetadata(metadata: SessionMetadata, live: JsonRecord): void {
    if (live.workerState === 'failed') metadata.status = 'failed'
    else if (live.isStreaming === true || live.activity === 'working' || live.isCompacting === true) metadata.status = 'running'
    else if (live.lifecycle === 'archived') metadata.status = 'complete'
    else if (live.taskState === 'completed') metadata.status = 'complete'
    else if (live.taskState === 'needs_input') metadata.status = 'waiting'
    else metadata.status = 'idle'
    if (typeof live.sessionName === 'string' && live.sessionName.trim()) metadata.title = compactText(live.sessionName, 100)
    if (typeof live.thinkingLevel === 'string') metadata.thinkingLevel = live.thinkingLevel
    if (typeof live.rlmDepth === 'number' && Number.isInteger(live.rlmDepth) && live.rlmDepth >= 0) metadata.depth = live.rlmDepth
    if (typeof live.modified === 'string' && Number.isFinite(Date.parse(live.modified))) metadata.updatedAt = new Date(live.modified).toISOString()
    if (isRecord(live.model)) {
      if (typeof live.model.id === 'string') metadata.model = live.model.id
      if (typeof live.model.provider === 'string') metadata.provider = live.model.provider
    }
  }

  private async readMetadata(filePath: string, knownStat?: Stats): Promise<SessionMetadata> {
    const fileStat = knownStat ?? await stat(filePath)
    if (fileStat.size > 256 * 1024 * 1024) throw new Error('Session file is too large')
    const fallbackCreated = fileStat.birthtime.toISOString()
    const fallbackUpdated = fileStat.mtime.toISOString()
    let id = basename(filePath, '.jsonl')
    let projectPath = ''
    let createdAt = fallbackCreated
    let updatedAt = fallbackUpdated
    let depth = 0
    let model: string | undefined
    let provider: string | undefined
    let thinkingLevel: string | undefined
    let sessionName: string | undefined
    let firstUser = ''
    let preview = ''
    let lifecycle: string | undefined
    let taskState: string | undefined
    let lastRole: string | undefined
    let stopReason: string | undefined

    let metadataRecords = 0
    for await (const line of strictJsonLines(createReadStream(filePath))) {
      if (!line) continue
      if (++metadataRecords > 200_000) throw new Error('Session file has too many records')
      let value: unknown
      try { value = JSON.parse(line) } catch { continue }
      if (!isRecord(value)) continue
      updatedAt = validTimestamp(value.timestamp, updatedAt)
      if (value.type === 'session') {
        if (typeof value.id === 'string') id = value.id
        if (typeof value.cwd === 'string') projectPath = value.cwd
        createdAt = validTimestamp(value.timestamp, createdAt)
        if (typeof value.rlmDepth === 'number' && Number.isInteger(value.rlmDepth) && value.rlmDepth >= 0) depth = value.rlmDepth
        else if (typeof value.parentSession === 'string') depth = 1
      } else if (value.type === 'model_change') {
        if (typeof value.modelId === 'string') model = value.modelId
        if (typeof value.provider === 'string') provider = value.provider
      } else if (value.type === 'thinking_level_change' && typeof value.thinkingLevel === 'string') thinkingLevel = value.thinkingLevel
      else if (value.type === 'session_info' && typeof value.name === 'string') sessionName = value.name
      else if (value.type === 'session_state' && isRecord(value.state) && typeof value.state.status === 'string') lifecycle = value.state.status
      else if (value.type === 'agent_status' && isRecord(value.status) && typeof value.status.taskState === 'string') taskState = value.status.taskState
      else if (value.type === 'message' && isRecord(value.message)) {
        const message = value.message
        if (typeof message.role === 'string') lastRole = message.role
        if (typeof message.stopReason === 'string') stopReason = message.stopReason
        const text = textFromContent(message.content, 4_096)
        if (message.role === 'user' && !firstUser && text) firstUser = text
        if ((message.role === 'assistant' || message.role === 'user') && text) preview = text
      }
    }
    const title = compactText(sessionName || firstUser, 100) || 'Untitled session'
    return {
      id,
      filePath,
      projectPath,
      title,
      createdAt,
      updatedAt,
      status: statusFrom(taskState, lifecycle, lastRole, stopReason),
      model,
      provider,
      thinkingLevel,
      depth,
      pinned: false,
      unread: false,
      preview: compactText(preview || firstUser),
      sessionName,
    }
  }
}
