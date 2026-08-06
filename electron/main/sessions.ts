import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { MessagePart, SessionRecord, SessionStatus, TranscriptMessage } from '../../src/types/api'
import { strictJsonLines } from './jsonl'
import { runProcess } from './process-utils'
import type { JsonStateStore } from './store'
import { isPathWithin, isRecord, requireString } from './validation'

type JsonRecord = Record<string, unknown>

interface RuntimeSessionState { isStreaming: boolean }
interface SessionMetadata extends SessionRecord { sessionName?: string }

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (!isRecord(part)) return ''
    if (part.type === 'text' && typeof part.text === 'string') return part.text
    if (part.type === 'thinking' && typeof part.thinking === 'string') return part.thinking
    return ''
  }).filter(Boolean).join('\n')
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

function partsFromMessage(message: JsonRecord): MessagePart[] {
  const content = message.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  const parts: MessagePart[] = []
  if (Array.isArray(content)) {
    for (const raw of content) {
      if (!isRecord(raw) || typeof raw.type !== 'string') continue
      if (raw.type === 'text' && typeof raw.text === 'string') parts.push({ type: 'text', text: raw.text })
      else if (raw.type === 'thinking' && typeof raw.thinking === 'string') parts.push({ type: 'thinking', text: raw.thinking })
      else if ((raw.type === 'toolCall' || raw.type === 'tool_call') && typeof raw.name === 'string') {
        parts.push({ type: 'toolCall', id: typeof raw.id === 'string' ? raw.id : undefined, name: raw.name, args: raw.arguments ?? raw.args })
      } else if (raw.type === 'image') {
        parts.push({
          type: 'image',
          mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
          data: typeof raw.data === 'string' && raw.data.length <= 16 * 1024 * 1024 ? raw.data : undefined,
        })
      }
    }
  }
  if (message.role === 'toolResult' || message.role === 'tool') {
    const text = parts.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text').map((part) => part.text).join('\n')
    return [{ type: 'toolResult', name: typeof message.toolName === 'string' ? message.toolName : undefined, text, isError: message.isError === true }]
  }
  if (message.role === 'bashExecution') {
    return [{ type: 'toolResult', name: 'bash', text: typeof message.output === 'string' ? message.output : '', isError: typeof message.exitCode === 'number' && message.exitCode !== 0 }]
  }
  return parts.length ? parts : [{ type: 'text', text: '' }]
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

  constructor(private readonly store: JsonStateStore, private readonly primeAgentPath: string | null) {}

  bindRuntimeHooks(hooks: {
    get(filePath: string): RuntimeSessionState | undefined
    stop(filePath: string): Promise<void>
    rename(filePath: string, title: string): Promise<boolean>
  }): void {
    this.runtimeForSession = hooks.get
    this.stopRuntimeForSession = hooks.stop
    this.renameRuntimeSession = hooks.rename
  }

  async list(projectPath?: string): Promise<SessionRecord[]> {
    let names: string[]
    try { names = (await readdir(this.sessionRoot)).filter((name) => name.endsWith('.jsonl') && !name.startsWith('.')).slice(0, 5_000) } catch { return [] }
    const archived = new Set(this.store.snapshot().archivedSessions.map((path) => resolve(path)))
    const project = projectPath ? resolve(requireString(projectPath, 'projectPath', { min: 1, max: 4096 })) : undefined
    const catalog = await this.liveCatalog()
    const sessions = await mapLimit(names, 6, async (name) => {
      const filePath = join(this.sessionRoot, name)
      if (archived.has(resolve(filePath))) return null
      try {
        const metadata = await this.readMetadata(filePath)
        if (project && resolve(metadata.projectPath) !== project) return null
        const live = catalog.get(resolve(filePath))
        if (live) this.applyLiveMetadata(metadata, live)
        const runtime = this.runtimeForSession(filePath)
        if (runtime) metadata.status = runtime.isStreaming ? 'running' : 'idle'
        const { sessionName: _sessionName, ...record } = metadata
        return record
      } catch { return null }
    })
    return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }

  async projectPaths(): Promise<string[]> {
    const sessions = await this.list()
    return [...new Set(sessions.map((session) => session.projectPath).filter((path) => path.startsWith('/')))]
  }

  async read(filePath: string): Promise<TranscriptMessage[]> {
    const safePath = await this.requireSessionPath(filePath)
    if ((await stat(safePath)).size > 256 * 1024 * 1024) throw new Error('Session transcript is too large to display')
    const entries = new Map<string, { id: string; parentId: string | null; entry: JsonRecord }>()
    let leafId: string | null = null
    let recordCount = 0
    for await (const line of strictJsonLines(createReadStream(safePath))) {
      if (!line) continue
      if (++recordCount > 200_000) throw new Error('Session transcript has too many records')
      let entry: unknown
      try { entry = JSON.parse(line) } catch { continue }
      if (!isRecord(entry) || entry.type === 'session' || typeof entry.id !== 'string') continue
      const parentId = typeof entry.parentId === 'string' ? entry.parentId : null
      entries.set(entry.id, { id: entry.id, parentId, entry })
      leafId = entry.id
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
      if (entry.type === 'custom_message') {
        const text = textFromContent(entry.content)
        transcript.push({ id, role: 'system', timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : undefined, parts: [{ type: 'text', text }] })
        activeAssistant = undefined
        continue
      }
      const message = isRecord(entry.message) ? entry.message : {}
      const role = roleOf(message)
      const timestamp = typeof message.timestamp === 'string' || typeof message.timestamp === 'number' ? message.timestamp : typeof entry.timestamp === 'string' ? entry.timestamp : undefined
      const parts = partsFromMessage(message)
      if (role === 'tool' && activeAssistant) {
        const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
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
          activeAssistant = { id, role, timestamp, parts }
          transcript.push(activeAssistant)
        }
        continue
      }
      const item: TranscriptMessage = { id, role, timestamp, parts }
      transcript.push(item)
      activeAssistant = undefined
    }
    if (this.runtimeForSession(safePath)?.isStreaming && activeAssistant) activeAssistant.streaming = true
    return transcript
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

  async archive(filePath: string): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    await this.stopRuntimeForSession(safePath)
    await this.store.update((state) => {
      if (!state.archivedSessions.includes(safePath)) state.archivedSessions.push(safePath)
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

  private async readMetadata(filePath: string): Promise<SessionMetadata> {
    const fileStat = await stat(filePath)
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
        const text = textFromContent(message.content)
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
