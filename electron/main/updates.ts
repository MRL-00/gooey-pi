import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import type { AppUpdateState } from '../../src/types/api'

export const DEFAULT_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000
const INITIAL_CHECK_DELAY_MS = 8_000

export interface UpdateAdapter {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update', listener: () => void): this
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfo) => void): this
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateServiceOptions {
  enabled: boolean
  checkIntervalMs?: number
  initialCheckDelayMs?: number
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
  setTimeout?: typeof globalThis.setTimeout
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 240) || 'Update check failed'
}

export interface ManualUpdateNotification {
  type: 'info' | 'error'
  message: string
  detail?: string
}

export function manualUpdateNotification(state: AppUpdateState): ManualUpdateNotification {
  if (state.phase === 'error') return {
    type: 'error',
    message: 'GooeyPi Update Check Failed',
    detail: state.message,
  }
  const available = state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded'
  return {
    type: 'info',
    message: available ? 'GooeyPi Update Available' : 'No GooeyPi Update Available',
  }
}

export function getAutoUpdater(): AppUpdater {
  // electron-updater is CommonJS; accessing through its default export keeps
  // the bundled Electron ESM output compatible with both Node module modes.
  return electronUpdater.autoUpdater
}

export class UpdateService {
  private state: AppUpdateState
  private sink: ((state: AppUpdateState) => void) | null = null
  private checkPromise: Promise<AppUpdateState> | null = null
  private interval: ReturnType<typeof globalThis.setInterval> | null = null
  private initialTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private readonly setIntervalFn: typeof globalThis.setInterval
  private readonly clearIntervalFn: typeof globalThis.clearInterval
  private readonly setTimeoutFn: typeof globalThis.setTimeout

  constructor(private readonly updater: UpdateAdapter, private readonly options: UpdateServiceOptions) {
    this.state = options.enabled ? { phase: 'idle' } : { phase: 'unsupported', message: 'Automatic updates are available in installed builds.' }
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout
    if (!options.enabled) return

    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.on('checking-for-update', () => this.publish({ phase: 'checking' }))
    updater.on('update-available', (info) => this.publish({ phase: 'available', version: info.version }))
    updater.on('download-progress', (progress) => this.publish({
      phase: 'downloading',
      version: this.state.version,
      percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    }))
    updater.on('update-downloaded', (info) => this.publish({ phase: 'downloaded', version: info.version }))
    updater.on('update-not-available', (info) => this.publish({ phase: 'not-available', version: info.version }))
    updater.on('error', (error) => this.publish({ phase: 'error', message: errorMessage(error) }))
  }

  start(): void {
    if (!this.options.enabled || this.interval || this.initialTimer) return
    this.initialTimer = this.setTimeoutFn(() => {
      this.initialTimer = null
      void this.check()
    }, this.options.initialCheckDelayMs ?? INITIAL_CHECK_DELAY_MS)
    this.initialTimer.unref?.()
    this.interval = this.setIntervalFn(() => { void this.check() }, this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS)
    this.interval.unref?.()
  }

  dispose(): void {
    if (this.interval) this.clearIntervalFn(this.interval)
    if (this.initialTimer) clearTimeout(this.initialTimer)
    this.interval = null
    this.initialTimer = null
    this.sink = null
  }

  getState(): AppUpdateState {
    return structuredClone(this.state)
  }

  setEventSink(sink: ((state: AppUpdateState) => void) | null): void {
    this.sink = sink
  }

  check(): Promise<AppUpdateState> {
    if (!this.options.enabled) return Promise.resolve(this.getState())
    if (this.state.phase === 'available' || this.state.phase === 'downloading' || this.state.phase === 'downloaded') return Promise.resolve(this.getState())
    if (this.checkPromise) return this.checkPromise
    this.checkPromise = this.updater.checkForUpdates()
      .then(() => this.getState())
      .catch((error) => {
        this.publish({ phase: 'error', message: errorMessage(error) })
        return this.getState()
      })
      .finally(() => { this.checkPromise = null })
    return this.checkPromise
  }

  install(): boolean {
    if (!this.options.enabled || this.state.phase !== 'downloaded') return false
    this.updater.quitAndInstall(false, true)
    return true
  }

  private publish(state: AppUpdateState): void {
    this.state = state
    this.sink?.(this.getState())
  }
}
