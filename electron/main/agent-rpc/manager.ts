import { resolve } from 'node:path'
import type { PrimeEventEnvelope, PrimeThinkingLevel, RuntimeInfo } from '../../../src/types/api'
import { isPathWithin, rejectUnknownKeys, requireId, requireRecord, requireString } from '../validation'
import { isThinkingLevel, validateRpcCommand } from './command-schema'
import { RpcRuntime } from './runtime'
import type { RpcObject } from './types'
import type { PrimeProviderService } from '../providers'

export class AgentRpcManager {
  private readonly runtimes = new Map<string, RpcRuntime>()
  private eventSink: (envelope: PrimeEventEnvelope) => void = () => undefined
  private closed = false

  constructor(
    private readonly executable: string | null,
    private readonly authorizeCwd: (cwd: string) => Promise<string>,
    private readonly validateSessionPath: (path: string) => Promise<string>,
    private readonly providers?: PrimeProviderService,
    private readonly disabledProviders: () => ReadonlySet<string> = () => new Set(),
  ) {}

  setEventSink(sink: (envelope: PrimeEventEnvelope) => void): void { this.eventSink = sink }

  beginShutdown(): void { this.closed = true }

  async start(raw: unknown): Promise<RuntimeInfo> {
    this.requireOpen()
    if (!this.executable) throw new Error('Prime Agent executable was not found')
    const options = requireRecord(raw, 'options')
    rejectUnknownKeys(options, ['cwd', 'sessionPath', 'model', 'thinking', 'fast'], 'options')
    const cwd = await this.authorizeCwd(requireString(options.cwd, 'cwd', { min: 1, max: 4096 }))
    this.requireOpen()
    const args = ['--mode', 'rpc', '--cwd', cwd]
    if (options.sessionPath !== undefined) args.push('--resume', await this.validateSessionPath(requireString(options.sessionPath, 'sessionPath', { max: 4096 })))
    let selectedModel
    if (options.model !== undefined) {
      selectedModel = this.providers
        ? await this.providers.requireAvailableModel(options.model, this.disabledProviders())
        : undefined
      const model = selectedModel?.id ?? requireString(options.model, 'model', { min: 1, max: 256, trim: true })
      if (model.startsWith('-') || /[\r\n]/.test(model)) throw new TypeError('Invalid model')
      if (selectedModel) args.push('--provider', selectedModel.provider)
      args.push('--model', model)
    }
    if (options.thinking !== undefined) {
      const thinking = requireString(options.thinking, 'thinking', { min: 1, max: 16, trim: true })
      if (!isThinkingLevel(thinking)) throw new TypeError('Invalid thinking level')
      if (selectedModel && !selectedModel.availableThinkingLevels.includes(thinking as PrimeThinkingLevel)) throw new TypeError(`${selectedModel.name} does not support ${thinking} reasoning`)
      args.push('--thinking', thinking)
    }
    if (options.fast !== undefined && typeof options.fast !== 'boolean') throw new TypeError('fast must be a boolean')
    this.requireOpen()
    if (this.runtimes.size >= 4) throw new Error('Prime Work supports at most four concurrent agent runtimes')
    const runtime = new RpcRuntime(this.executable, args, cwd, (event) => this.eventSink(event), (closed) => this.runtimes.delete(closed.runtimeId))
    this.runtimes.set(runtime.runtimeId, runtime)
    try {
      await runtime.handshake()
      await this.decorate(runtime)
      if (runtime.snapshot().fastModeSupported && options.fast === true) await runtime.setServiceTier('priority', true)
      return runtime.snapshot()
    } catch (error) { await runtime.stop(); throw error }
  }

  async command(runtimeId: unknown, rawCommand: unknown): Promise<RpcObject> {
    this.requireOpen()
    const runtime = this.requireRuntime(runtimeId)
    const command = await validateRpcCommand(rawCommand, this.validateSessionPath)
    this.requireOpen()
    if (command.type === 'set_model' && this.providers) {
      await this.providers.requireAvailableModel(`${String(command.provider)}/${String(command.modelId)}`, this.disabledProviders())
    }
    if (command.type === 'set_service_tier') {
      const serviceTier = command.serviceTier === 'priority' ? 'priority' : 'default'
      const supported = await runtime.setServiceTier(serviceTier)
      if (!supported) throw new Error('Fast mode is not supported by the selected model')
      return { type: 'response', command: 'set_service_tier', success: true }
    }
    if (Array.isArray(command.images) && command.images.length > 0 && runtime.snapshot().imageInputSupported === false) {
      throw new Error('The active model does not accept images. Choose a vision model and try again.')
    }
    const response = await runtime.command(command)
    if (command.type === 'set_model' || command.type === 'cycle_model') {
      const preference = runtime.serviceTierPreference()
      await this.decorate(runtime)
      if (runtime.snapshot().fastModeSupported) await runtime.setServiceTier(preference, true)
    } else if (command.type === 'set_thinking_level' || command.type === 'cycle_thinking_level') await this.decorate(runtime)
    return response
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

  async stopForProjectRoots(roots: string[]): Promise<void> {
    const matches = [...this.runtimes.values()].filter((runtime) => roots.some((root) => isPathWithin(root, runtime.snapshot().cwd)))
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

  private async decorate(runtime: RpcRuntime): Promise<void> {
    if (!this.providers) return
    const snapshot = runtime.snapshot()
    runtime.applyCapabilities(await this.providers.capabilities(snapshot.model?.provider, snapshot.model?.id))
  }

  private requireRuntime(value: unknown): RpcRuntime {
    const id = requireId(value, 'runtimeId')
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('Runtime was not found')
    return runtime
  }
}
