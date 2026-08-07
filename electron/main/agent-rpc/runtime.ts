import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { PrimeContextUsage, PrimeEventEnvelope, PrimeModelDescriptor, PrimeServiceTier, RuntimeInfo } from '../../../src/types/api'
import { safeChildEnvironment } from '../process-utils'
import { errorMessage, isRecord } from '../validation'
import { AgentEventForwarder } from './events'
import { FramedRpcTransport } from './transport'
import type { RpcObject } from './types'

interface PendingRequest {
  resolve(value: RpcObject): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  bytes: number
  command: string
}

function parseContextUsage(raw: unknown): PrimeContextUsage | null {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.contextWindow) || Number(raw.contextWindow) <= 0) return null
  const tokens = raw.tokens === null ? null : Number.isSafeInteger(raw.tokens) && Number(raw.tokens) >= 0 ? Number(raw.tokens) : undefined
  const percent = raw.percent === null ? null : typeof raw.percent === 'number' && Number.isFinite(raw.percent) && raw.percent >= 0 ? raw.percent : undefined
  if (tokens === undefined || percent === undefined) return null
  return { tokens, contextWindow: Number(raw.contextWindow), percent }
}

export class RpcRuntime {
  readonly runtimeId = randomUUID()
  private readonly pending = new Map<string, PendingRequest>()
  private pendingBytes = 0
  private transportFailed = false
  private readonly child: ChildProcessWithoutNullStreams
  private readonly transport: FramedRpcTransport
  private readonly exited: Promise<void>
  private resolveExited!: () => void
  private stopPromise: Promise<boolean> | null = null
  private readonly eventForwarder: AgentEventForwarder
  private stopped = false
  private info: RuntimeInfo
  private requestedServiceTier: PrimeServiceTier = 'default'
  private contextUsageRefresh: Promise<void> | null = null

  constructor(
    executable: string,
    args: string[],
    cwd: string,
    private readonly onEvent: (envelope: PrimeEventEnvelope) => void,
    private readonly onExit: (runtime: RpcRuntime) => void,
    extraEnvironment: NodeJS.ProcessEnv = {},
  ) {
    this.info = { runtimeId: this.runtimeId, cwd, isStreaming: false, isCompacting: false }
    this.exited = new Promise((resolveExit) => { this.resolveExited = resolveExit })
    this.eventForwarder = new AgentEventForwarder(this.runtimeId, onEvent)
    this.child = spawn(executable, args, { cwd, env: safeChildEnvironment(extraEnvironment), shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    this.transport = new FramedRpcTransport(
      this.child,
      (line) => this.handleLine(line),
      (error) => this.failTransport(error),
      () => !this.stopped,
    )
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
    const contextDeadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250)
      timer.unref()
    })
    await Promise.race([this.refreshContextUsage(), contextDeadline])
    return this.snapshot()
  }

  applyCapabilities(model: PrimeModelDescriptor | undefined): void {
    this.info.availableThinkingLevels = model?.availableThinkingLevels ?? ['off']
    this.info.fastModeSupported = model?.fastModeSupported ?? false
    this.info.imageInputSupported = model ? model.input.includes('image') : undefined
    if (!this.info.fastModeSupported) {
      this.requestedServiceTier = 'default'
      this.info.serviceTier = 'default'
    }
  }

  async setServiceTier(serviceTier: 'default' | 'priority', probe = false): Promise<boolean> {
    if (serviceTier === 'priority' && !this.info.fastModeSupported) {
      this.requestedServiceTier = 'default'
      this.info.serviceTier = 'default'
      return false
    }
    try {
      await this.request({ type: 'set_service_tier', serviceTier }, 10_000)
      this.requestedServiceTier = serviceTier
      this.info.serviceTier = serviceTier
      this.info.fastModeAvailable = true
      return true
    } catch (error) {
      this.info.fastModeAvailable = false
      this.info.serviceTier = 'default'
      if (!probe) throw error
      return false
    }
  }

  serviceTierPreference(): 'default' | 'priority' { return this.requestedServiceTier === 'priority' ? 'priority' : 'default' }

  async command(command: RpcObject): Promise<RpcObject> {
    if (command.type === 'extension_ui_response') {
      await this.transport.enqueue(`${JSON.stringify(command)}\n`)
      return { type: 'response', command: 'extension_ui_response', success: true }
    }
    const timeout = command.type === 'compact' ? 10 * 60_000 : 60_000
    const response = await this.request(command, timeout)
    if (command.type === 'get_state') this.updateFromState(response.data)
    if (response.success === true && ['set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level'].includes(String(command.type))) {
      const state = await this.request({ type: 'get_state' }, 60_000)
      this.updateFromState(state.data)
      void this.refreshContextUsage()
    } else if (response.success === true && ['prompt', 'new_session', 'switch_session', 'clone', 'fork'].includes(String(command.type))) {
      void this.request({ type: 'get_state' }, 60_000).then((state) => {
        this.updateFromState(state.data)
        return this.refreshContextUsage()
      }).catch(() => undefined)
    }
    return response
  }

  stop(): Promise<boolean> {
    this.stopPromise ??= this.performStop()
    return this.stopPromise
  }

  private async performStop(): Promise<boolean> {
    if (this.info.isStreaming || this.info.isCompacting) {
      try { await this.request({ type: 'abort' }, 5_000) } catch { /* close stdin and escalate below */ }
    }
    this.stopped = true
    this.transport.endInput()
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

  private failTransport(reason: unknown): void {
    if (this.transportFailed) return
    this.transportFailed = true
    const error = reason instanceof Error ? reason : new Error(errorMessage(reason))
    this.emit({ type: 'transport_error', error: errorMessage(error) })
    this.transport.pauseOutput()
    this.fail(error)
    this.stopPromise ??= this.performTransportStop()
  }

  private async performTransportStop(): Promise<boolean> {
    this.stopped = true
    this.transport.destroyInput()
    this.terminate('SIGTERM')
    if (await this.waitForExit(2_000)) return true
    this.terminate('SIGKILL')
    return this.waitForExit(1_500)
  }

  private request(command: RpcObject, timeoutMs: number): Promise<RpcObject> {
    if (!this.transport.writable()) return Promise.reject(new Error('Runtime is not available'))
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
      void this.transport.enqueue(line).catch(failWrite)
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
    if (value.type === 'agent_start') {
      this.info.isStreaming = true
      this.info.isCompacting = false
    } else if (value.type === 'agent_end') {
      this.info.isStreaming = false
      this.info.isCompacting = false
    } else if (value.type === 'compaction_start') this.info.isCompacting = true
    else if (value.type === 'compaction_end') this.info.isCompacting = false
    this.emit(value)
    if (value.type === 'agent_end' || value.type === 'compaction_end') void this.refreshContextUsage()
  }

  private refreshContextUsage(): Promise<void> {
    this.contextUsageRefresh ??= this.performContextUsageRefresh().finally(() => { this.contextUsageRefresh = null })
    return this.contextUsageRefresh
  }

  private async performContextUsageRefresh(): Promise<void> {
    try {
      const response = await this.request({ type: 'get_session_stats' }, 10_000)
      const usage = isRecord(response.data) ? parseContextUsage(response.data.contextUsage) : null
      if (!usage) return
      this.info.contextUsage = usage
      this.emit({ type: 'context_usage', contextUsage: usage })
    } catch { /* older Prime Agent versions may not expose session stats */ }
  }

  private updateFromState(raw: unknown): void {
    if (!isRecord(raw)) return
    if (typeof raw.sessionId === 'string') this.info.sessionId = raw.sessionId
    if (typeof raw.sessionFile === 'string') this.info.sessionFile = raw.sessionFile
    if (typeof raw.isStreaming === 'boolean') this.info.isStreaming = raw.isStreaming
    if (typeof raw.isCompacting === 'boolean') this.info.isCompacting = raw.isCompacting
    if (typeof raw.thinkingLevel === 'string') this.info.thinkingLevel = raw.thinkingLevel
    if (raw.serviceTier === 'default' || raw.serviceTier === 'priority') {
      this.info.serviceTier = raw.serviceTier
      this.info.fastModeAvailable = true
      this.requestedServiceTier = raw.serviceTier
    }
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
