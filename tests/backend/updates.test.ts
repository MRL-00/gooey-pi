import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateService, type UpdateAdapter } from '../../electron/main/updates'

class FakeUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = false
  checkForUpdates = vi.fn(async () => undefined)
  quitAndInstall = vi.fn()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('automatic update service', () => {
  it('automatically checks installed builds and configures download-on-discovery', async () => {
    vi.useFakeTimers()
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true, initialCheckDelayMs: 25, checkIntervalMs: 100 })
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)

    service.start()
    await vi.advanceTimersByTimeAsync(25)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('reports discovery, progress, completion, and installs only a downloaded update', () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: true })
    const changed = vi.fn()
    service.setEventSink(changed)

    updater.emit('update-available', { version: '0.2.0' })
    updater.emit('download-progress', { percent: 48.6 })
    expect(service.getState()).toEqual({ phase: 'downloading', version: '0.2.0', percent: 49 })
    expect(service.install()).toBe(false)

    updater.emit('update-downloaded', { version: '0.2.0' })
    expect(service.getState()).toEqual({ phase: 'downloaded', version: '0.2.0' })
    expect(service.install()).toBe(true)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(changed).toHaveBeenCalled()
  })

  it('keeps development builds offline and explains why updates are unavailable', async () => {
    const updater = new FakeUpdater()
    const service = new UpdateService(updater as unknown as UpdateAdapter, { enabled: false })
    service.start()
    await expect(service.check()).resolves.toMatchObject({ phase: 'unsupported' })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(service.install()).toBe(false)
  })
})
