import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { PrimeContextUsage, PrimeEventEnvelope, PrimeModelDescriptor, PrimeServiceTier, RuntimeInfo } from '../../../src/types/api'
import { emptySessionActionSnapshot, parseSessionActionSnapshot } from '../../../src/lib/session-actions'
import { killProcessTree, safeChildEnvironment, waitForProcessExit } from '../process-utils'
import { canonicalSessionPath } from '../session-paths'
import { errorMessage, isRecord } from '../validation'
import { AgentEventForwarder } from './events'
import { FramedRpcTransport, type QueuedRpcWrite } from './transport'
import type { RpcObject } from './types'

interface PendingRequest {
  resolve(value: RpcObject): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  bytes: number
  command: string
}

export interface CompactionWatchdogTimings {
  /** How often to poll get_state for the compacting flag while the runtime is active. */
  pollIntervalMs: number
  /** How long to wait for the agent's own compaction_end after a poll reports the compaction over. */
  endGraceMs: number
  /** How long after the last agent activity polling keeps running on an idle runtime. */
  idleWindowMs: number
}

const DEFAULT_COMPACTION_WATCHDOG_TIMINGS: CompactionWatchdogTimings = {
  pollIntervalMs: 2_000,
  endGraceMs: 4_000,
  idleWindowMs: 30_000,
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
  private readonly uncertainDeliveries = new Set<string>()
  private pendingBytes = 0
  private transportFailed = false
  private readonly child: ChildProcessWithoutNullStreams
  private readonly transport: FramedRpcTransport
  private stopPromise: Promise<boolean> | null = null
  private readonly eventForwarder: AgentEventForwarder
  private stopped = false
  private info: RuntimeInfo
  private requestedServiceTier: PrimeServiceTier = 'default'
  private contextUsageRefresh: Promise<void> | null = null
  private continuationPending = false
  // Provider auto-retry backoff: agent_end has fired but the agent will
  // continue the same turn, so the runtime must keep reporting busy. Kept
  // outside info so get_state refreshes (which report isStreaming false
  // during the backoff) cannot clear it.
  private retryPending = false
  // Compaction watchdog: some Prime Agent event paths buffer compaction_start
  // until the surrounding RPC command settles, so the desktop would learn
  // about a compaction only after it finished. get_state responses are never
  // buffered, so polling the compacting flag while the runtime is active lets
  // the desktop synthesize the missing lifecycle events; real events take
  // precedence and duplicates are swallowed.
  private readonly watchdogTimings: CompactionWatchdogTimings
  private compactionEpisode: 'none' | 'real' | 'synthetic' = 'none'
  private compactionEndFallback: NodeJS.Timeout | null = null
  private compactionPollTimer: NodeJS.Timeout | null = null
  private compactionPollInFlight = false
  private watchdogDisposed = false
  private lastActivityAt = Date.now()
  private lastRealCompactionEventAt = 0

  constructor(
    executable: string,
    args: string[],
    cwd: string,
    onEvent: (envelope: PrimeEventEnvelope) => void,
    private readonly onExit: (runtime: RpcRuntime) => void,
    extraEnvironment: NodeJS.ProcessEnv = {},
    watchdogTimings: Partial<CompactionWatchdogTimings> = {},
  ) {
    this.watchdogTimings = { ...DEFAULT_COMPACTION_WATCHDOG_TIMINGS, ...watchdogTimings }
    this.info = { runtimeId: this.runtimeId, cwd, isStreaming: false, isCompacting: false, sessionActions: emptySessionActionSnapshot() }
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
      this.disposeCompactionWatchdog()
      this.fail(new Error(`Prime Agent RPC exited (${code ?? signal ?? 'unknown'})`))
      this.emit({ type: 'runtime_exit', code, signal, expected: this.stopped })
      this.onExit(this)
    })
    this.scheduleCompactionPoll()
  }

  /** Frozen shallow copy: nested state is replaced wholesale on update, and the IPC boundary clones for the renderer. */
  snapshot(): RuntimeInfo {
    return Object.freeze(this.continuationPending || this.retryPending ? { ...this.info, isStreaming: true } : { ...this.info })
  }

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
    this.lastActivityAt = Date.now()
    if (command.type === 'extension_ui_response') {
      await this.transport.enqueue(`${JSON.stringify(command)}\n`).done
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
    this.disposeCompactionWatchdog()
    if (this.info.isStreaming || this.info.isCompacting || this.retryPending) {
      try { await this.request({ type: 'abort' }, 5_000) } catch { /* close stdin and escalate below */ }
    }
    this.stopped = true
    this.transport.endInput()
    if (await this.waitForExit(750)) return true
    return this.killTree()
  }

  private killTree(): Promise<boolean> {
    if (!this.child.pid) return this.waitForExit(3_500)
    return killProcessTree(this.child.pid, {
      ladder: [{ signal: 'SIGTERM', waitMs: 2_000 }, { signal: 'SIGKILL', waitMs: 1_500 }],
      hasExited: () => this.child.exitCode !== null || this.child.signalCode !== null,
      waitForExit: (timeoutMs) => this.waitForExit(timeoutMs),
      signalDirect: (signal) => this.child.kill(signal),
    })
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return waitForProcessExit(this.child, timeoutMs)
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

  private performTransportStop(): Promise<boolean> {
    this.disposeCompactionWatchdog()
    this.stopped = true
    this.transport.destroyInput()
    return this.killTree()
  }

  private scheduleCompactionPoll(): void {
    if (this.watchdogDisposed || this.compactionPollTimer) return
    this.compactionPollTimer = setTimeout(() => {
      this.compactionPollTimer = null
      void this.pollCompactionState().finally(() => this.scheduleCompactionPoll())
    }, this.watchdogTimings.pollIntervalMs)
    this.compactionPollTimer.unref()
  }

  private async pollCompactionState(): Promise<void> {
    if (this.watchdogDisposed || this.compactionPollInFlight || !this.shouldPollCompaction()) return
    this.compactionPollInFlight = true
    const requestedAt = Date.now()
    try {
      const response = await this.request({ type: 'get_state' }, 5_000)
      const raw = isRecord(response.data) ? response.data : null
      // A poll issued before the latest real compaction event answers with
      // stale state; only responses newer than that event are trusted.
      if (!this.watchdogDisposed && raw && typeof raw.isCompacting === 'boolean' && requestedAt > this.lastRealCompactionEventAt) {
        this.observePolledCompaction(raw.isCompacting)
      }
    } catch { /* transient poll failures are ignored; the next tick retries */ }
    finally { this.compactionPollInFlight = false }
  }

  private shouldPollCompaction(): boolean {
    if (!this.transport.writable()) return false
    if (this.info.isStreaming || this.info.isCompacting || this.retryPending || this.continuationPending) return true
    return Date.now() - this.lastActivityAt < this.watchdogTimings.idleWindowMs
  }

  private observePolledCompaction(isCompacting: boolean): void {
    if (isCompacting) {
      this.info.isCompacting = true
      this.clearCompactionEndFallback()
      if (this.compactionEpisode === 'none') {
        this.compactionEpisode = 'synthetic'
        this.emit({ type: 'compaction_start', synthetic: true })
      }
      return
    }
    this.info.isCompacting = false
    if (this.compactionEpisode === 'none' || this.compactionEndFallback) return
    // The agent stopped compacting but its own compaction_end has not arrived;
    // give the real event a grace window before closing the row ourselves.
    this.compactionEndFallback = setTimeout(() => {
      this.compactionEndFallback = null
      if (this.watchdogDisposed || this.compactionEpisode === 'none') return
      this.compactionEpisode = 'none'
      this.emit({ type: 'compaction_end', synthetic: true, aborted: false, willRetry: false })
      void this.refreshContextUsage()
    }, this.watchdogTimings.endGraceMs)
    this.compactionEndFallback.unref()
  }

  private clearCompactionEndFallback(): void {
    if (!this.compactionEndFallback) return
    clearTimeout(this.compactionEndFallback)
    this.compactionEndFallback = null
  }

  private disposeCompactionWatchdog(): void {
    this.watchdogDisposed = true
    if (this.compactionPollTimer) {
      clearTimeout(this.compactionPollTimer)
      this.compactionPollTimer = null
    }
    this.clearCompactionEndFallback()
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
      let write: QueuedRpcWrite | null = null
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pendingBytes -= pending.bytes
        this.pending.delete(id)
        if (write?.cancel() !== 'flushed') {
          // The line never reached the child: the command cannot execute, so
          // a retry is safe.
          pending.reject(new Error(`RPC command ${commandType} timed out before it was sent`))
          return
        }
        // The line reached the child, which may still execute the command. A
        // late response must be consumed silently rather than reported as an
        // orphan, and the caller must not retry automatically.
        this.rememberUncertainDelivery(id)
        pending.reject(new Error(`RPC command ${commandType} timed out after delivery; the agent may still run it — do not retry automatically`))
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
      write = this.transport.enqueue(line)
      void write.done.catch(failWrite)
    })
  }

  private handleLine(line: string): void {
    let value: unknown
    try { value = JSON.parse(line) } catch {
      this.emit({ type: 'transport_error', error: 'Prime Agent emitted malformed JSON' })
      return
    }
    if (!isRecord(value) || typeof value.type !== 'string') return
    if (value.type !== 'response') this.lastActivityAt = Date.now()
    if (value.type === 'response' && typeof value.id === 'string') {
      const pending = this.pending.get(value.id)
      if (!pending) {
        // A late answer to a request that timed out after its write flushed
        // is consumed, not surfaced as an orphan.
        if (this.uncertainDeliveries.delete(value.id)) return
        this.emit({ type: 'orphan_response', command: value.command })
        return
      }
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
    if (value.type === 'session_action_update') {
      const actions = parseSessionActionSnapshot(value.actions)
      if (actions) this.info.sessionActions = actions
    }
    if (value.type === 'agent_start') {
      this.continuationPending = false
      this.retryPending = false
      this.info.isStreaming = true
      this.info.isCompacting = false
      if (this.compactionEpisode !== 'none') {
        // The compaction's end event never arrived (or was lost); close the
        // renderer's running row before the new turn opens.
        this.compactionEpisode = 'none'
        this.clearCompactionEndFallback()
        this.emit({ type: 'compaction_end', synthetic: true, aborted: false, willRetry: true })
      }
    } else if (value.type === 'agent_end') {
      // retryPending is cleared only by agent_start or auto_retry_end, never
      // by agent_end: a failed run's agent_end is followed by auto_retry_start
      // when the agent will continue the turn after backoff.
      this.continuationPending = false
      this.info.isStreaming = false
      this.info.isCompacting = false
    } else if (value.type === 'compaction_start') {
      this.info.isCompacting = true
      this.lastRealCompactionEventAt = Date.now()
      this.clearCompactionEndFallback()
      // A late real start after the watchdog already announced this compaction
      // would open a duplicate row in the renderer; the real end still flows.
      if (this.compactionEpisode === 'synthetic') return
      this.compactionEpisode = 'real'
    } else if (value.type === 'compaction_end') {
      this.continuationPending = value.willRetry === true
      this.info.isCompacting = false
      this.lastRealCompactionEventAt = Date.now()
      this.clearCompactionEndFallback()
      this.compactionEpisode = 'none'
    } else if (value.type === 'auto_retry_start') this.retryPending = true
    else if (value.type === 'auto_retry_end') this.retryPending = false
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
    // Canonicalize once at the boundary (cached): every later comparison
    // against catalog and validator paths uses the canonical form.
    if (typeof raw.sessionFile === 'string') this.info.sessionFile = canonicalSessionPath(raw.sessionFile)
    if (typeof raw.isStreaming === 'boolean') this.info.isStreaming = raw.isStreaming
    if (typeof raw.isCompacting === 'boolean') this.info.isCompacting = raw.isCompacting
    if (typeof raw.thinkingLevel === 'string') this.info.thinkingLevel = raw.thinkingLevel
    if (raw.serviceTier === 'default' || raw.serviceTier === 'priority') {
      this.info.serviceTier = raw.serviceTier
      this.info.fastModeAvailable = true
      this.requestedServiceTier = raw.serviceTier
    }
    const sessionActions = parseSessionActionSnapshot(raw.sessionActions)
    if (sessionActions) this.info.sessionActions = sessionActions
    if (isRecord(raw.model)) {
      this.info.model = {
        provider: typeof raw.model.provider === 'string' ? raw.model.provider : undefined,
        id: typeof raw.model.id === 'string' ? raw.model.id : undefined,
        name: typeof raw.model.name === 'string' ? raw.model.name : undefined,
      }
    } else if (raw.model === null) this.info.model = null
  }

  private emit(event: RpcObject): void { this.eventForwarder.emit(event) }

  private rememberUncertainDelivery(id: string): void {
    this.uncertainDeliveries.add(id)
    if (this.uncertainDeliveries.size <= 64) return
    const oldest = this.uncertainDeliveries.values().next().value
    if (oldest !== undefined) this.uncertainDeliveries.delete(oldest)
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.uncertainDeliveries.clear()
    this.pendingBytes = 0
  }
}
