import { resolve } from 'node:path'
import type { PrimeEventEnvelope, RuntimeInfo } from '../../../src/types/api'
import { rejectUnknownKeys, requireId, requireRecord, requireString } from '../validation'
import { isThinkingLevel, validateRpcCommand } from './command-schema'
import { RpcRuntime } from './runtime'
import type { RpcObject } from './types'

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
      if (!isThinkingLevel(thinking)) throw new TypeError('Invalid thinking level')
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
