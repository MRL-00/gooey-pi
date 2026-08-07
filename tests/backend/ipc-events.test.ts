import { describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  app: {},
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))

vi.mock('electron', () => electronMocks)

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerIpc } from '../../electron/main/ipc'

function serviceStub(): Record<string, unknown> {
  return new Proxy({}, { get: () => vi.fn(async () => undefined) })
}

describe('app:reveal-path authorization', () => {
  const expectedUrl = 'prime-work://app/'

  function revealHarness(overrides: { projects?: unknown; sessions?: unknown; plugins?: unknown }) {
    const services = {
      meta: {},
      projects: overrides.projects ?? serviceStub(),
      sessions: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()), ...(overrides.sessions as object | undefined) },
      agents: serviceStub(),
      terminals: serviceStub(),
      git: serviceStub(),
      plugins: overrides.plugins ?? serviceStub(),
      settings: serviceStub(),
      heartbeats: serviceStub(),
      schedules: { ...serviceStub(), onDidChange: vi.fn(() => vi.fn()) },
    }
    electronMocks.ipcMain.handle.mockClear()
    electronMocks.shell.showItemInFolder.mockClear()
    const registration = registerIpc(services as never, expectedUrl)
    const sender = {
      id: 11,
      getURL: () => expectedUrl,
      mainFrame: { url: expectedUrl },
      isDestroyed: () => false,
    }
    registration.authorize(sender as never)
    const handler = electronMocks.ipcMain.handle.mock.calls.find(([channel]) => channel === 'app:reveal-path')?.[1] as
      (event: unknown, path: unknown) => Promise<boolean>
    const invoke = (path: unknown) => handler({ sender, senderFrame: sender.mainFrame }, path)
    return { invoke, registration }
  }

  it('reveals a path through the first authorization domain that accepts it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-reveal-'))
    try {
      const deny = async () => { throw new Error('not a project path') }
      const { invoke, registration } = revealHarness({
        projects: { ...serviceStub(), authorizePath: vi.fn(deny) },
        sessions: { requireSessionPath: vi.fn(async () => dir) },
      })
      await expect(invoke(dir)).resolves.toBe(true)
      expect(electronMocks.shell.showItemInFolder).toHaveBeenCalledWith(dir)
      registration.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('returns false without revealing when every authorization domain denies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-reveal-denied-'))
    try {
      const deny = () => { throw new Error('denied') }
      const { invoke, registration } = revealHarness({
        projects: { ...serviceStub(), authorizePath: vi.fn(async () => deny()) },
        sessions: { requireSessionPath: vi.fn(async () => deny()) },
        plugins: { ...serviceStub(), authorizeReveal: vi.fn(deny) },
      })
      await expect(invoke(dir)).resolves.toBe(false)
      await expect(invoke(join(dir, 'missing.txt'))).resolves.toBe(false)
      expect(electronMocks.shell.showItemInFolder).not.toHaveBeenCalled()
      registration.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('warns instead of swallowing an unexpected reveal failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-reveal-error-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { invoke, registration } = revealHarness({
        projects: { ...serviceStub(), authorizePath: vi.fn(async () => dir) },
      })
      electronMocks.shell.showItemInFolder.mockImplementationOnce(() => { throw new Error('shell unavailable') })
      await expect(invoke(dir)).resolves.toBe(false)
      expect(warn).toHaveBeenCalledWith('Rejected app:reveal-path:', 'shell unavailable')
      registration.dispose()
    } finally {
      warn.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('session change IPC', () => {
  it('broadcasts only to still-trusted authorized renderers and unsubscribes on disposal', () => {
    let notify: ((event: { filePath?: string }) => void) | undefined
    const unsubscribe = vi.fn()
    const sessions = {
      ...serviceStub(),
      onDidChange: vi.fn((listener: (event: { filePath?: string }) => void) => {
        notify = listener
        return unsubscribe
      }),
    }
    const services = {
      meta: {},
      projects: serviceStub(),
      sessions,
      agents: serviceStub(),
      terminals: serviceStub(),
      git: serviceStub(),
      plugins: serviceStub(),
      settings: serviceStub(),
      schedules: serviceStub(),
    }
    const expectedUrl = 'prime-work://app/'
    const trusted = {
      id: 1,
      getURL: () => expectedUrl,
      mainFrame: { url: expectedUrl },
      isDestroyed: () => false,
      send: vi.fn(),
    }
    let navigatedUrl = expectedUrl
    const navigated = {
      id: 2,
      getURL: () => navigatedUrl,
      mainFrame: { get url() { return navigatedUrl } },
      isDestroyed: () => false,
      send: vi.fn(),
    }
    const unauthorized = {
      id: 3,
      getURL: () => expectedUrl,
      mainFrame: { url: expectedUrl },
      isDestroyed: () => false,
      send: vi.fn(),
    }

    const registration = registerIpc(services as never, expectedUrl)
    registration.authorize(trusted as never)
    registration.authorize(navigated as never)
    navigatedUrl = 'https://example.com/'
    notify?.({ filePath: '/tmp/session.jsonl' })

    expect(trusted.send).toHaveBeenCalledWith('sessions:changed', { filePath: '/tmp/session.jsonl' })
    expect(navigated.send).not.toHaveBeenCalled()
    expect(unauthorized.send).not.toHaveBeenCalled()

    registration.revoke(trusted.id)
    notify?.({})
    expect(trusted.send).toHaveBeenCalledTimes(1)

    registration.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    notify?.({ filePath: '/tmp/later.jsonl' })
    expect(trusted.send).toHaveBeenCalledTimes(1)
  })
})
