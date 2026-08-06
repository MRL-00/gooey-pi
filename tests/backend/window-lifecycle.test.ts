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

import { loadInitialRenderer } from '../../electron/main/index'

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
