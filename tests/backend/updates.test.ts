import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CHECK_INTERVAL_MS, manualUpdateNotification, UpdateService, type UpdateAdapter } from '../../electron/main/updates'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = vi.fn(async () => undefined)
  downloadUpdate = vi.fn(async (): Promise<void> => undefined)
  quitAndInstall = vi.fn()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('automatic update service', () => {
  it('uses explicit system messages for manual update checks', () => {
    expect(manualUpdateNotification({ phase: 'not-available' })).toMatchObject({ type: 'info', message: 'No GooeyPi Update Available' })
    expect(manualUpdateNotification({ phase: 'available', version: '0.2.0' })).toMatchObject({ type: 'info', message: 'GooeyPi Update Available' })
    expect(manualUpdateNotification({ phase: 'downloaded', version: '0.2.0' })).toMatchObject({ type: 'info', message: 'GooeyPi Update Available' })
  })

  it('automatically checks installed builds without downloading or installing on quit', async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true, initialCheckDelayMs: 25, checkIntervalMs: 100 })
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)

    service.start()
    await vi.advanceTimersByTimeAsync(25)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('checks for a new release every three hours by default', async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })

    service.start()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS - 8_001)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('does not download or restart until the available update is explicitly accepted', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })
    const changed = vi.fn()
    service.setEventSink(changed)

    updater.emit('update-available', { version: '0.2.0' })
    expect(service.getState()).toEqual({ phase: 'available', version: '0.2.0' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    let finishDownload!: () => void
    updater.downloadUpdate.mockImplementation(() => new Promise<void>((resolve) => { finishDownload = resolve }))
    const accepted = service.downloadAndInstall()
    expect(service.getState()).toEqual({ phase: 'downloading', version: '0.2.0', percent: 0 })
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()

    updater.emit('download-progress', { percent: 48.6 })
    expect(service.getState()).toEqual({ phase: 'downloading', version: '0.2.0', percent: 49 })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    updater.emit('update-downloaded', { version: '0.2.0' })
    expect(service.getState()).toEqual({ phase: 'downloaded', version: '0.2.0' })
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    finishDownload()
    await expect(accepted).resolves.toBe(true)
    expect(changed).toHaveBeenCalled()
  })

  it('does not restart for a downloaded event that was not user-approved', () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })

    updater.emit('update-downloaded', { version: '0.2.0' })
    expect(service.getState()).toEqual({ phase: 'downloaded', version: '0.2.0' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('keeps an active release state while a manual check is requested', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })

    updater.emit('update-available', { version: '0.2.0' })
    await expect(service.check()).resolves.toEqual({ phase: 'available', version: '0.2.0' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('keeps development builds offline and explains why updates are unavailable', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: false })
    service.start()
    await expect(service.check()).resolves.toMatchObject({ phase: 'unsupported' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    await expect(service.downloadAndInstall()).resolves.toBe(false)
  })
})
