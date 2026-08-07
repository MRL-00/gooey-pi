import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/prime-work'),
    isPackaged: false,
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => false),
  },
  BrowserWindow: class {},
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: {},
}))

vi.mock('electron', () => electron)

import { hardenRenderer, loadInitialRenderer } from '../../electron/main/index'
import type { BrowserWindow } from 'electron'

type Handler = (...args: never[]) => void

function hardenedWindow(currentUrl = 'prime-work://app/index.html') {
  const handlers = new Map<string, Handler>()
  const webContents = {
    on: (name: string, listener: Handler) => { handlers.set(name, listener) },
    once: (name: string, listener: Handler) => { handlers.set(name, listener) },
    setWindowOpenHandler: vi.fn(),
    getURL: () => currentUrl,
  }
  hardenRenderer({ webContents } as unknown as BrowserWindow)
  const handler = (name: string): Handler => {
    const listener = handlers.get(name)
    if (!listener) throw new Error(`No ${name} handler was registered`)
    return listener
  }
  return { handler }
}

describe('renderer hardening', () => {
  it('forces webviewTag off and locks down every attached webview preference', () => {
    const { handler } = hardenedWindow()
    const preferences: Record<string, unknown> = { preload: '/tmp/evil.js', nodeIntegration: true, webviewTag: true, sandbox: false }
    const event = { preventDefault: vi.fn() }
    handler('will-attach-webview')(...[event, preferences, { partition: 'persist:prime-work-browser', src: 'https://example.test/' }] as never[])

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(preferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    })
    expect('preload' in preferences).toBe(false)
  })

  it('rejects webviews outside the browser partition or with unsafe sources', () => {
    const { handler } = hardenedWindow()
    for (const params of [
      { partition: 'persist:other', src: 'https://example.test/' },
      { partition: 'persist:prime-work-browser', src: 'file:///etc/passwd' },
    ]) {
      const event = { preventDefault: vi.fn() }
      handler('will-attach-webview')(...[event, {}, params] as never[])
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
  })
})

describe('initial renderer window lifecycle', () => {
  it('does not settle the initial load before navigation settles', async () => {
    let resolveLoad!: () => void
    const loadURL = vi.fn(() => new Promise<void>((resolve) => { resolveLoad = resolve }))
    const destroy = vi.fn()
    const loading = loadInitialRenderer({ loadURL, isDestroyed: () => false, destroy }, 'prime-work://app/index.html')
    let settled = false
    void loading.then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(destroy).not.toHaveBeenCalled()

    resolveLoad()
    await loading
    expect(settled).toBe(true)
    expect(loadURL).toHaveBeenCalledWith('prime-work://app/index.html')
    expect(destroy).not.toHaveBeenCalled()
  })

  it('destroys the hidden window and preserves the load rejection', async () => {
    const failure = new Error('renderer unavailable')
    const destroy = vi.fn()

    await expect(loadInitialRenderer({
      loadURL: vi.fn(async () => { throw failure }),
      isDestroyed: () => false,
      destroy,
    }, 'prime-work://app/index.html')).rejects.toBe(failure)

    expect(destroy).toHaveBeenCalledOnce()
  })

  it('does not destroy a window that a concurrent shutdown already destroyed', async () => {
    const destroy = vi.fn()

    await expect(loadInitialRenderer({
      loadURL: vi.fn(async () => { throw new Error('ERR_ABORTED') }),
      isDestroyed: () => true,
      destroy,
    }, 'prime-work://app/index.html')).rejects.toThrow('ERR_ABORTED')

    expect(destroy).not.toHaveBeenCalled()
  })
})
