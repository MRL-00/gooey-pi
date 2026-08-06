import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { DownloadItem, Event, WebContents } from 'electron'
import { BrowserDownloadGuard } from '../../electron/main/browser-downloads'

class FakeDownload extends EventEmitter {
  received = 0
  cancelled = false
  saveOptions: unknown
  constructor(readonly url: string, readonly total = 1024, readonly gesture = true) { super() }
  getURLChain() { return [this.url] }
  getURL() { return this.url }
  getTotalBytes() { return this.total }
  hasUserGesture() { return this.gesture }
  getFilename() { return 'download.bin' }
  setSaveDialogOptions(options: unknown) { this.saveOptions = options }
  getReceivedBytes() { return this.received }
  cancel() { this.cancelled = true }
}

const allowed = (value: string) => /^https?:\/\//.test(value)
const owner = { id: 7, isDestroyed: () => false } as WebContents
const event = () => ({ preventDefault: vi.fn() }) as unknown as Event & { preventDefault: ReturnType<typeof vi.fn> }

describe('BrowserDownloadGuard', () => {
  it('denies unsafe, gestureless, disabled, and oversized downloads', () => {
    const guard = new BrowserDownloadGuard(allowed)
    for (const item of [new FakeDownload('file:///etc/passwd'), new FakeDownload('https://example.test/a', 10, false), new FakeDownload('https://example.test/a', 513 * 1024 * 1024)]) {
      const requested = event(); guard.handle(requested, item as unknown as DownloadItem, owner, true); expect(requested.preventDefault).toHaveBeenCalledOnce()
    }
    const disabled = event(); guard.handle(disabled, new FakeDownload('https://example.test/a') as unknown as DownloadItem, owner, false); expect(disabled.preventDefault).toHaveBeenCalledOnce()
  })

  it('caps concurrent downloads and cancels every item owned by a destroyed guest', () => {
    const guard = new BrowserDownloadGuard(allowed)
    const items = Array.from({ length: 4 }, (_, index) => new FakeDownload(`https://example.test/${index}`))
    for (const item of items.slice(0, 3)) guard.handle(event(), item as unknown as DownloadItem, owner, true)
    const fourth = event(); guard.handle(fourth, items[3] as unknown as DownloadItem, owner, true)
    expect(fourth.preventDefault).toHaveBeenCalledOnce(); expect(guard.activeCount).toBe(3)
    guard.cancelOwner(owner.id); expect(items.slice(0, 3).every((item) => item.cancelled)).toBe(true)
  })

  it('cancels a streaming download that crosses the per-item byte cap', () => {
    const guard = new BrowserDownloadGuard(allowed)
    const item = new FakeDownload('https://example.test/chunked', -1)
    guard.handle(event(), item as unknown as DownloadItem, owner, true)
    item.received = 512 * 1024 * 1024 + 1; item.emit('updated')
    expect(item.cancelled).toBe(true)
  })
})
