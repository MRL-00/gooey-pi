import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import type { PrimeEventEnvelope, RuntimeInfo } from '../../src/types/api'
import { StrictJsonlDecoder } from './jsonl'
import { safeChildEnvironment } from './process-utils'
import { errorMessage, isRecord, rejectUnknownKeys, requireBoolean, requireId, requireRecord, requireString } from './validation'

type RpcObject = Record<string, unknown>
interface PendingRequest {
  resolve(value: RpcObject): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  bytes: number
  command: string
}

const SIMPLE_COMMANDS = new Set([
  'abort', 'new_session', 'get_state', 'cycle_model', 'get_available_models', 'cycle_thinking_level',
  'abort_retry', 'get_session_stats', 'clone', 'get_fork_messages', 'get_last_assistant_text',
  'get_messages', 'agent_messages_status', 'agent_messages_pause', 'agent_messages_resume',
  'agent_messages_clear', 'list_heartbeats', 'get_heartbeat', 'get_commands',
])
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function validateImages(value: unknown): Array<{ type: 'image'; data: string; mimeType: string }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('images must be an array with at most 8 items')
  return value.map((raw, index) => {
    const image = requireRecord(raw, `images[${index}]`)
    rejectUnknownKeys(image, ['type', 'data', 'mimeType'], `images[${index}]`)
    if (image.type !== 'image') throw new TypeError(`images[${index}].type must be image`)
    const mimeType = requireString(image.mimeType, `images[${index}].mimeType`, { min: 1, max: 100 })
    if (!/^image\/(png|jpeg|gif|webp)$/i.test(mimeType)) throw new TypeError('Unsupported image type')
    return { type: 'image' as const, data: requireString(image.data, `images[${index}].data`, { min: 1, max: 16 * 1024 * 1024 }), mimeType }
  })
}

async function validateRpcCommand(raw: unknown, validateSessionPath: (path: string) => Promise<string>): Promise<RpcObject> {
  const command = requireRecord(raw, 'command')
  const serializedSize = Buffer.byteLength(JSON.stringify(command), 'utf8')
  if (serializedSize > 20 * 1024 * 1024) throw new TypeError('command is too large')
  const type = requireString(command.type, 'command.type', { min: 1, max: 64 })
  if (SIMPLE_COMMANDS.has(type)) {
    rejectUnknownKeys(command, type === 'new_session' ? ['type', 'parentSession'] : ['type'], 'command')
    if (type === 'new_session' && command.parentSession !== undefined) {
      return { type, parentSession: await validateSessionPath(requireString(command.parentSession, 'parentSession', { max: 4096 })) }
    }
    return { type }
  }
  if (type === 'prompt' || type === 'steer' || type === 'follow_up') {
    rejectUnknownKeys(command, ['type', 'message', 'images', 'streamingBehavior'], 'command')
    const result: RpcObject = { type, message: requireString(command.message, 'message', { min: 1, max: 1024 * 1024 }) }
    const images = validateImages(command.images)
    if (images) result.images = images
    if (type === 'prompt' && command.streamingBehavior !== undefined) {
      if (command.streamingBehavior !== 'steer' && command.streamingBehavior !== 'followUp') throw new TypeError('Invalid streamingBehavior')
      result.streamingBehavior = command.streamingBehavior
    } else if (command.streamingBehavior !== undefined) throw new TypeError('streamingBehavior is only valid for prompt')
    return result
  }
  if (type === 'set_model') {
    rejectUnknownKeys(command, ['type', 'provider', 'modelId'], 'command')
    return { type, provider: requireString(command.provider, 'provider', { min: 1, max: 128 }), modelId: requireString(command.modelId, 'modelId', { min: 1, max: 256 }) }
  }
  if (type === 'set_thinking_level') {
    rejectUnknownKeys(command, ['type', 'level'], 'command')
    const level = requireString(command.level, 'level', { max: 16 })
    if (!THINKING_LEVELS.has(level)) throw new TypeError('Invalid thinking level')
    return { type, level }
  }
  if (type === 'set_steering_mode' || type === 'set_follow_up_mode') {
    rejectUnknownKeys(command, ['type', 'mode'], 'command')
    if (command.mode !== 'all' && command.mode !== 'one-at-a-time') throw new TypeError('Invalid queue mode')
    return { type, mode: command.mode }
  }
  if (type === 'compact') {
    rejectUnknownKeys(command, ['type', 'customInstructions'], 'command')
    return command.customInstructions === undefined ? { type } : { type, customInstructions: requireString(command.customInstructions, 'customInstructions', { max: 32_000 }) }
  }
  if (type === 'set_auto_compaction' || type === 'set_auto_retry') {
    rejectUnknownKeys(command, ['type', 'enabled'], 'command')
    return { type, enabled: requireBoolean(command.enabled, 'enabled') }
  }
  if (type === 'switch_session') {
    rejectUnknownKeys(command, ['type', 'sessionPath'], 'command')
    return { type, sessionPath: await validateSessionPath(requireString(command.sessionPath, 'sessionPath', { max: 4096 })) }
  }
  if (type === 'fork') {
    rejectUnknownKeys(command, ['type', 'entryId'], 'command')
    return { type, entryId: requireId(command.entryId, 'entryId') }
  }
  if (type === 'set_session_name') {
    rejectUnknownKeys(command, ['type', 'name'], 'command')
    return { type, name: requireString(command.name, 'name', { min: 1, max: 200, trim: true }) }
  }
  if (type === 'send_message') {
    rejectUnknownKeys(command, ['type', 'targetActiveSessionId', 'message'], 'command')
    return { type, targetActiveSessionId: requireId(command.targetActiveSessionId, 'targetActiveSessionId'), message: requireString(command.message, 'message', { min: 1, max: 1024 * 1024 }) }
  }
  if (type === 'list_schedules') {
    rejectUnknownKeys(command, ['type', 'includeInactive'], 'command')
    return command.includeInactive === undefined ? { type } : { type, includeInactive: requireBoolean(command.includeInactive, 'includeInactive') }
  }
  if (type === 'add_schedule') {
    rejectUnknownKeys(command, ['type', 'schedule', 'prompt'], 'command')
    return { type, schedule: requireString(command.schedule, 'schedule', { min: 1, max: 500, trim: true }), prompt: requireString(command.prompt, 'prompt', { min: 1, max: 1024 * 1024 }) }
  }
  if (type === 'cancel_schedule') {
    rejectUnknownKeys(command, ['type', 'jobId'], 'command')
    return { type, jobId: requireId(command.jobId, 'jobId') }
  }
  if (type === 'set_heartbeat') {
    rejectUnknownKeys(command, ['type', 'schedule', 'prompt', 'deliveryMode'], 'command')
    const result: RpcObject = { type, schedule: requireString(command.schedule, 'schedule', { min: 1, max: 500, trim: true }), prompt: requireString(command.prompt, 'prompt', { min: 1, max: 1024 * 1024 }) }
    if (command.deliveryMode !== undefined) {
      if (command.deliveryMode !== 'steer' && command.deliveryMode !== 'follow_up') throw new TypeError('Invalid deliveryMode')
      result.deliveryMode = command.deliveryMode
    }
    return result
  }
  if (type === 'update_heartbeat') {
    rejectUnknownKeys(command, ['type', 'action'], 'command')
    if (command.action !== 'pause' && command.action !== 'resume' && command.action !== 'clear') throw new TypeError('Invalid heartbeat action')
    return { type, action: command.action }
  }
  if (type === 'manage_heartbeat') {
    rejectUnknownKeys(command, ['type', 'activeSessionId', 'jobId', 'action'], 'command')
    if (command.action !== 'pause' && command.action !== 'resume' && command.action !== 'stop') throw new TypeError('Invalid heartbeat management action')
    return { type, activeSessionId: requireId(command.activeSessionId, 'activeSessionId'), jobId: requireId(command.jobId, 'jobId'), action: command.action }
  }
  if (type === 'observe' || type === 'unobserve') {
    rejectUnknownKeys(command, ['type', 'activeSessionId'], 'command')
    return { type, activeSessionId: requireId(command.activeSessionId, 'activeSessionId') }
  }
  if (type === 'extension_ui_response') {
    const id = requireId(command.id, 'id')
    if (command.cancelled === true) { rejectUnknownKeys(command, ['type', 'id', 'cancelled'], 'command'); return { type, id, cancelled: true } }
    if (typeof command.confirmed === 'boolean') { rejectUnknownKeys(command, ['type', 'id', 'confirmed'], 'command'); return { type, id, confirmed: command.confirmed } }
    rejectUnknownKeys(command, ['type', 'id', 'value'], 'command')
    return { type, id, value: requireString(command.value, 'value', { max: 1024 * 1024 }) }
  }
  throw new TypeError(`RPC command ${type} is not exposed to the renderer`)
}

export interface AgentEventLimits {
  maxEvents: number
  maxEnvelopeBytes: number
  maxWindowBytes: number
  windowMs: number
}

const DEFAULT_AGENT_EVENT_LIMITS: AgentEventLimits = {
  maxEvents: 500,
  maxEnvelopeBytes: 8 * 1024 * 1024,
  maxWindowBytes: 32 * 1024 * 1024,
  windowMs: 1_000,
}

/** Applies the same byte accounting to real and synthetic events before they reach Electron IPC. */
export class AgentEventForwarder {
  private readonly limits: AgentEventLimits
  private windowStarted = Date.now()
  private eventCount = 0
  private windowBytes = 0
  private readonly reportedLimits = new Set<string>()

  constructor(
    private readonly runtimeId: string,
    private readonly onEvent: (envelope: PrimeEventEnvelope) => void,
    limits: Partial<AgentEventLimits> = {},
  ) {
    this.limits = { ...DEFAULT_AGENT_EVENT_LIMITS, ...limits }
  }

  emit(event: RpcObject): void {
    this.resetWindowIfNeeded()
    this.eventCount += 1
    if (this.eventCount > this.limits.maxEvents && event.type !== 'runtime_exit') {
      this.reportLimit('count', 'Prime Agent event rate exceeded the desktop limit')
      return
    }

    const envelope: PrimeEventEnvelope = { runtimeId: this.runtimeId, event }
    const bytes = this.serializedBytes(envelope)
    if (bytes === null || bytes > this.limits.maxEnvelopeBytes) {
      this.reportLimit('envelope', 'Prime Agent event exceeded the desktop envelope byte limit')
      return
    }
    const critical = event.type === 'runtime_exit'
    if (!critical && this.windowBytes + bytes > this.limits.maxWindowBytes) {
      this.reportLimit('bytes', 'Prime Agent event byte rate exceeded the desktop limit')
      return
    }
    if (!critical) this.windowBytes += bytes
    this.onEvent(envelope)
  }

  private resetWindowIfNeeded(): void {
    const now = Date.now()
    if (now - this.windowStarted < this.limits.windowMs) return
    this.windowStarted = now
    this.eventCount = 0
    this.windowBytes = 0
    this.reportedLimits.clear()
  }

  private reportLimit(kind: string, error: string): void {
    if (this.reportedLimits.has(kind)) return
    this.reportedLimits.add(kind)
    const envelope: PrimeEventEnvelope = { runtimeId: this.runtimeId, event: { type: 'transport_error', error } }
    const bytes = this.serializedBytes(envelope)
    if (bytes === null || bytes > this.limits.maxEnvelopeBytes || this.windowBytes + bytes > this.limits.maxWindowBytes) return
    this.windowBytes += bytes
    this.onEvent(envelope)
  }

  private serializedBytes(envelope: PrimeEventEnvelope): number | null {
    try { return Buffer.byteLength(JSON.stringify(envelope), 'utf8') } catch { return null }
  }
}

class RpcRuntime {
  readonly runtimeId = randomUUID()
  private readonly pending = new Map<string, PendingRequest>()
  private pendingBytes = 0
  private readonly child: ChildProcessWithoutNullStreams
  private readonly decoder: StrictJsonlDecoder
  private readonly exited: Promise<void>
  private resolveExited!: () => void
  private stopPromise: Promise<boolean> | null = null
  private readonly eventForwarder: AgentEventForwarder
  private stopped = false
  private info: RuntimeInfo

  constructor(
    executable: string,
    args: string[],
    cwd: string,
    private readonly onEvent: (envelope: PrimeEventEnvelope) => void,
    private readonly onExit: (runtime: RpcRuntime) => void,
  ) {
    this.info = { runtimeId: this.runtimeId, cwd, isStreaming: false }
    this.exited = new Promise((resolveExit) => { this.resolveExited = resolveExit })
    this.eventForwarder = new AgentEventForwarder(this.runtimeId, onEvent)
    this.child = spawn(executable, args, { cwd, env: safeChildEnvironment(), shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    this.decoder = new StrictJsonlDecoder((line) => this.handleLine(line), 16 * 1024 * 1024)
    this.child.stdout.on('data', (chunk: Buffer) => {
      try { this.decoder.push(chunk) } catch (error) {
        this.emit({ type: 'transport_error', error: errorMessage(error) })
        this.child.kill('SIGTERM')
      }
    })
    this.child.stdout.on('end', () => { try { this.decoder.end() } catch { /* exit cleanup reports failure */ } })
    this.child.stderr.on('data', () => { /* stderr can contain secrets; never forward it to the renderer */ })
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.once('error', (error) => this.fail(error))
    this.child.once('close', (code, signal) => {
      this.fail(new Error(`Prime Agent RPC exited (${code ?? signal ?? 'unknown'})`))
      this.emit({ type: 'runtime_exit', code, signal, expected: this.stopped })
      this.resolveExited()
      this.onExit(this)
    })
  }

  snapshot(): RuntimeInfo { return structuredClone(this.info) }

  async handshake(): Promise<RuntimeInfo> {
    const response = await this.request({ type: 'get_state' }, 60_000)
    this.updateFromState(response.data)
    return this.snapshot()
  }

  async command(command: RpcObject): Promise<RpcObject> {
    if (command.type === 'extension_ui_response') {
      if (this.stopped || !this.child.stdin.writable) throw new Error('Runtime is not available')
      this.child.stdin.write(`${JSON.stringify(command)}\n`)
      return { type: 'response', command: 'extension_ui_response', success: true }
    }
    const timeout = command.type === 'compact' ? 10 * 60_000 : 60_000
    const response = await this.request(command, timeout)
    if (command.type === 'get_state') this.updateFromState(response.data)
    if (response.success === true && [
      'prompt', 'new_session', 'switch_session', 'clone', 'fork', 'set_model', 'cycle_model',
      'set_thinking_level', 'cycle_thinking_level',
    ].includes(String(command.type))) {
      void this.request({ type: 'get_state' }, 60_000).then((state) => this.updateFromState(state.data)).catch(() => undefined)
    }
    return response
  }

  stop(): Promise<boolean> {
    this.stopPromise ??= this.performStop()
    return this.stopPromise
  }

  private async performStop(): Promise<boolean> {
    if (this.info.isStreaming) {
      try { await this.request({ type: 'abort' }, 5_000) } catch { /* close stdin and escalate below */ }
    }
    this.stopped = true
    this.child.stdin.end()
    if (await this.waitForExit(750)) return true
    this.terminate('SIGTERM')
    if (await this.waitForExit(2_000)) return true
    this.terminate('SIGKILL')
    return this.waitForExit(1_500)
  }

  private terminate(signal: NodeJS.Signals): void {
    if (this.child.pid && process.platform !== 'win32') {
      try { process.kill(-this.child.pid, signal); return } catch { /* fall back to the direct child */ }
    }
    try { this.child.kill(signal) } catch { /* the process already exited */ }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve(true)
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => resolveWait(false), timeoutMs)
      void this.exited.then(() => { clearTimeout(timer); resolveWait(true) })
    })
  }

  private request(command: RpcObject, timeoutMs: number): Promise<RpcObject> {
    if (this.stopped || !this.child.stdin.writable) return Promise.reject(new Error('Runtime is not available'))
    if (this.pending.size >= 32) return Promise.reject(new Error('Too many pending RPC requests'))
    const commandType = String(command.type)
    const id = randomUUID()
    const line = `${JSON.stringify({ ...command, id })}\n`
    const bytes = Buffer.byteLength(line)
    if (this.pendingBytes + bytes > 32 * 1024 * 1024) return Promise.reject(new Error('RPC in-flight byte budget exceeded'))
    this.pendingBytes += bytes
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pendingBytes -= pending.bytes
        this.pending.delete(id)
        pending.reject(new Error(`RPC command ${commandType} timed out`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve: resolveRequest, reject, timer, bytes, command: commandType })
      const failWrite = (error: unknown) => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingBytes -= pending.bytes
        this.pending.delete(id)
        pending.reject(error instanceof Error ? error : new Error(errorMessage(error)))
      }
      try { this.child.stdin.write(line, (error) => { if (error) failWrite(error) }) } catch (error) { failWrite(error) }
    })
  }

  private handleLine(line: string): void {
    let value: unknown
    try { value = JSON.parse(line) } catch {
      this.emit({ type: 'transport_error', error: 'Prime Agent emitted malformed JSON' })
      return
    }
    if (!isRecord(value) || typeof value.type !== 'string') return
    if (value.type === 'response' && typeof value.id === 'string') {
      const pending = this.pending.get(value.id)
      if (!pending) { this.emit({ type: 'orphan_response', command: value.command }); return }
      clearTimeout(pending.timer)
      this.pendingBytes -= pending.bytes
      this.pending.delete(value.id)
      if (value.command !== pending.command) {
        pending.reject(new Error(`Prime Agent returned a mismatched response for ${pending.command}`))
        this.emit({ type: 'transport_error', error: 'Prime Agent returned a mismatched RPC response' })
        return
      }
      if (value.success !== true) {
        const detail = typeof value.error === 'string' && value.error.trim() ? value.error.trim().slice(0, 4_000) : `RPC command ${pending.command} failed`
        pending.reject(new Error(detail))
        return
      }
      pending.resolve(value)
      return
    }
    if (value.type === 'agent_start') this.info.isStreaming = true
    else if (value.type === 'agent_end') this.info.isStreaming = false
    this.emit(value)
  }

  private updateFromState(raw: unknown): void {
    if (!isRecord(raw)) return
    if (typeof raw.sessionId === 'string') this.info.sessionId = raw.sessionId
    if (typeof raw.sessionFile === 'string') this.info.sessionFile = raw.sessionFile
    if (typeof raw.isStreaming === 'boolean') this.info.isStreaming = raw.isStreaming
    if (typeof raw.thinkingLevel === 'string') this.info.thinkingLevel = raw.thinkingLevel
    if (isRecord(raw.model)) {
      this.info.model = {
        provider: typeof raw.model.provider === 'string' ? raw.model.provider : undefined,
        id: typeof raw.model.id === 'string' ? raw.model.id : undefined,
        name: typeof raw.model.name === 'string' ? raw.model.name : undefined,
      }
    } else if (raw.model === null) this.info.model = null
  }

  private emit(event: RpcObject): void { this.eventForwarder.emit(event) }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.pendingBytes = 0
  }
}

export class AgentRpcManager {
  private readonly runtimes = new Map<string, RpcRuntime>()
  private eventSink: (envelope: PrimeEventEnvelope) => void = () => undefined
  private closed = false

  constructor(
    private readonly executable: string | null,
    private readonly authorizeCwd: (cwd: string) => Promise<string>,
    private readonly validateSessionPath: (path: string) => Promise<string>,
  ) {}

  setEventSink(sink: (envelope: PrimeEventEnvelope) => void): void { this.eventSink = sink }

  beginShutdown(): void { this.closed = true }

  async start(raw: unknown): Promise<RuntimeInfo> {
    this.requireOpen()
    if (!this.executable) throw new Error('Prime Agent executable was not found')
    const options = requireRecord(raw, 'options')
    rejectUnknownKeys(options, ['cwd', 'sessionPath', 'model', 'thinking'], 'options')
    const cwd = await this.authorizeCwd(requireString(options.cwd, 'cwd', { min: 1, max: 4096 }))
    this.requireOpen()
    const args = ['--mode', 'rpc', '--cwd', cwd]
    if (options.sessionPath !== undefined) args.push('--resume', await this.validateSessionPath(requireString(options.sessionPath, 'sessionPath', { max: 4096 })))
    if (options.model !== undefined) {
      const model = requireString(options.model, 'model', { min: 1, max: 256, trim: true })
      if (model.startsWith('-') || /[\r\n]/.test(model)) throw new TypeError('Invalid model')
      args.push('--model', model)
    }
    if (options.thinking !== undefined) {
      const thinking = requireString(options.thinking, 'thinking', { min: 1, max: 16, trim: true })
      if (!THINKING_LEVELS.has(thinking)) throw new TypeError('Invalid thinking level')
      args.push('--thinking', thinking)
    }
    this.requireOpen()
    if (this.runtimes.size >= 4) throw new Error('Prime Work supports at most four concurrent agent runtimes')
    const runtime = new RpcRuntime(this.executable, args, cwd, (event) => this.eventSink(event), (closed) => this.runtimes.delete(closed.runtimeId))
    this.runtimes.set(runtime.runtimeId, runtime)
    try { return await runtime.handshake() } catch (error) { await runtime.stop(); throw error }
  }

  async command(runtimeId: unknown, rawCommand: unknown): Promise<RpcObject> {
    this.requireOpen()
    const runtime = this.requireRuntime(runtimeId)
    const command = await validateRpcCommand(rawCommand, this.validateSessionPath)
    this.requireOpen()
    return runtime.command(command)
  }

  async stop(runtimeId: unknown): Promise<boolean> {
    const id = requireId(runtimeId, 'runtimeId')
    const runtime = this.runtimes.get(id)
    if (!runtime) return false
    return runtime.stop()
  }

  list(): RuntimeInfo[] { return [...this.runtimes.values()].map((runtime) => runtime.snapshot()) }

  getForSession(filePath: string): RuntimeInfo | undefined {
    const wanted = resolve(filePath)
    return this.list().find((runtime) => runtime.sessionFile && resolve(runtime.sessionFile) === wanted)
  }

  async stopForSession(filePath: string): Promise<void> {
    const wanted = resolve(filePath)
    const matches = [...this.runtimes.values()].filter((runtime) => {
      const path = runtime.snapshot().sessionFile
      return path !== undefined && resolve(path) === wanted
    })
    await Promise.all(matches.map((runtime) => runtime.stop()))
  }

  async renameForSession(filePath: string, title: string): Promise<boolean> {
    this.requireOpen()
    const wanted = resolve(filePath)
    const runtime = [...this.runtimes.values()].find((candidate) => {
      const path = candidate.snapshot().sessionFile
      return path !== undefined && resolve(path) === wanted
    })
    if (!runtime) return false
    const response = await runtime.command({ type: 'set_session_name', name: title })
    return response.success === true
  }

  async stopAll(): Promise<void> {
    this.beginShutdown()
    const runtimes = [...this.runtimes.values()]
    await Promise.all(runtimes.map((runtime) => runtime.stop()))
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('Prime Agent manager is shutting down')
  }

  private requireRuntime(value: unknown): RpcRuntime {
    const id = requireId(value, 'runtimeId')
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('Runtime was not found')
    return runtime
  }
}
