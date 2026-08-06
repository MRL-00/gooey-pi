import type { DownloadItem, Event, WebContents } from 'electron'

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const MAX_CONCURRENT_DOWNLOADS = 3
const MAX_WINDOW_BYTES = 1024 * 1024 * 1024
const WINDOW_MS = 60 * 60 * 1000

interface ActiveDownload { item: DownloadItem; ownerId: number; accountedBytes: number }

export class BrowserDownloadGuard {
  private readonly active = new Map<DownloadItem, ActiveDownload>()
  private windowStartedAt = Date.now()
  private windowBytes = 0

  constructor(private readonly isAllowedUrl: (value: string) => boolean) {}

  handle(event: Event, item: DownloadItem, owner: WebContents | undefined, askForDownloads: boolean): void {
    this.refreshWindow()
    const chain = item.getURLChain()
    const declared = item.getTotalBytes()
    const safe = Boolean(owner && !owner.isDestroyed()) && chain.length > 0 && chain.every(this.isAllowedUrl) && this.isAllowedUrl(item.getURL())
    const fitsSingle = declared < 0 || declared <= MAX_DOWNLOAD_BYTES
    const fitsWindow = declared < 0 || this.windowBytes + declared <= MAX_WINDOW_BYTES
    if (!askForDownloads || !item.hasUserGesture() || !safe || !fitsSingle || !fitsWindow || this.active.size >= MAX_CONCURRENT_DOWNLOADS) {
      event.preventDefault()
      return
    }

    const active: ActiveDownload = { item, ownerId: owner!.id, accountedBytes: 0 }
    this.active.set(item, active)
    item.setSaveDialogOptions({ title: 'Save browser download', defaultPath: item.getFilename() })
    item.on('updated', () => {
      this.refreshWindow()
      const received = Math.max(0, item.getReceivedBytes())
      const delta = Math.max(0, received - active.accountedBytes)
      active.accountedBytes = received
      this.windowBytes += delta
      if (received > MAX_DOWNLOAD_BYTES || this.windowBytes > MAX_WINDOW_BYTES) item.cancel()
    })
    item.once('done', () => this.active.delete(item))
  }

  cancelOwner(ownerId: number): void {
    for (const active of this.active.values()) if (active.ownerId === ownerId) active.item.cancel()
  }

  cancelAll(resetBudget = false): void {
    for (const active of this.active.values()) active.item.cancel()
    this.active.clear()
    if (resetBudget) { this.windowStartedAt = Date.now(); this.windowBytes = 0 }
  }

  get activeCount(): number { return this.active.size }

  private refreshWindow(): void {
    if (Date.now() - this.windowStartedAt < WINDOW_MS) return
    this.windowStartedAt = Date.now()
    this.windowBytes = 0
  }
}
