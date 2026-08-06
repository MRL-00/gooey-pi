import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSettings, JsonStateStore } from '../../electron/main/store'
import type { JsonStateStoreFileHandle, JsonStateStoreFileSystem } from '../../electron/main/store'
import { SessionService } from '../../electron/main/sessions'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function makeDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-store-'))
  dirs.push(dir)
  return dir
}

function writeValidState(path: string): void {
  writeFileSync(path, JSON.stringify({
    version: 1,
    projects: [],
    settings: defaultSettings(),
    archivedSessions: [],
    dismissedProjectPaths: [],
  }))
}

const realFileSystem: JsonStateStoreFileSystem = {
  open: (path, flags, mode) => open(path, flags, mode),
  rename,
  unlink,
}

describe('JsonStateStore', () => {
  it('serializes concurrent updates without losing data', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const store = new JsonStateStore(path)
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update((state) => { state.archivedSessions.push(String(index)) })))
    expect(store.snapshot().archivedSessions).toHaveLength(20)
    expect(JSON.parse(readFileSync(path, 'utf8')).archivedSessions).toHaveLength(20)
  })

  it('publishes a snapshot only after the file and containing directory are durable', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeValidState(path)
    const events: string[] = []
    let releaseDirectorySync!: () => void
    let markDirectorySyncStarted!: () => void
    const directorySyncGate = new Promise<void>((resolve) => { releaseDirectorySync = resolve })
    const directorySyncStarted = new Promise<void>((resolve) => { markDirectorySyncStarted = resolve })
    const file: JsonStateStoreFileHandle = {
      writeFile: async () => { events.push('file-write') },
      sync: async () => { events.push('file-sync') },
      close: async () => { events.push('file-close') },
    }
    const directory: JsonStateStoreFileHandle = {
      writeFile: async () => { throw new Error('unexpected directory write') },
      sync: async () => {
        events.push('directory-sync')
        markDirectorySyncStarted()
        await directorySyncGate
      },
      close: async () => { events.push('directory-close') },
    }
    const fileSystem: JsonStateStoreFileSystem = {
      open: async (_openedPath, flags) => {
        events.push(flags === 'w' ? 'file-open' : 'directory-open')
        return flags === 'w' ? file : directory
      },
      rename: async () => { events.push('rename') },
      unlink: async () => { events.push('unlink') },
    }
    const store = new JsonStateStore(path, fileSystem)

    const operation = store.update((state) => {
      state.archivedSessions.push('durable')
      return 42
    })
    await directorySyncStarted

    expect(store.snapshot().archivedSessions).toEqual([])
    expect(events).toEqual([
      'file-open',
      'file-write',
      'file-sync',
      'file-close',
      'rename',
      'directory-open',
      'directory-sync',
    ])

    releaseDirectorySync()
    await expect(operation).resolves.toBe(42)
    expect(events).toEqual([
      'file-open',
      'file-write',
      'file-sync',
      'file-close',
      'rename',
      'directory-open',
      'directory-sync',
      'directory-close',
      'unlink',
    ])
    expect(store.snapshot().archivedSessions).toEqual(['durable'])
  })

  for (const stage of ['open', 'write', 'file-sync', 'file-close', 'rename'] as const) {
    it(`does not publish state and attempts temp cleanup when ${stage} fails`, async () => {
      const dir = makeDirectory()
      const path = join(dir, 'state.json')
      writeValidState(path)
      const events: string[] = []
      const file: JsonStateStoreFileHandle = {
        writeFile: async () => {
          events.push('write')
          if (stage === 'write') throw new Error('injected write failure')
        },
        sync: async () => {
          events.push('file-sync')
          if (stage === 'file-sync') throw new Error('injected file sync failure')
        },
        close: async () => {
          events.push('file-close')
          if (stage === 'file-close') throw new Error('injected close failure')
        },
      }
      const fileSystem: JsonStateStoreFileSystem = {
        open: async () => {
          events.push('open')
          if (stage === 'open') throw new Error('injected open failure')
          return file
        },
        rename: async () => {
          events.push('rename')
          if (stage === 'rename') throw new Error('injected rename failure')
        },
        unlink: async () => { events.push('unlink') },
      }
      const store = new JsonStateStore(path, fileSystem)

      await expect(store.update((state) => { state.archivedSessions.push('lost') })).rejects.toThrow('injected')
      expect(events.at(-1)).toBe('unlink')
      expect(store.snapshot().archivedSessions).toEqual([])
    })
  }

  it('removes a real temp file after a failed write and continues with the next queued update', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeValidState(path)
    let failNextWrite = true
    const fileSystem: JsonStateStoreFileSystem = {
      ...realFileSystem,
      open: async (openedPath, flags, mode) => {
        const handle = await open(openedPath, flags, mode)
        if (flags !== 'w' || !failNextWrite) return handle
        failNextWrite = false
        return {
          writeFile: async (data, options) => {
            await handle.writeFile(data, options)
            throw new Error('injected write failure')
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        }
      },
    }
    const store = new JsonStateStore(path, fileSystem)

    await expect(store.update((state) => { state.archivedSessions.push('failed') })).rejects.toThrow('injected write failure')
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(store.snapshot().archivedSessions).toEqual([])
    expect(JSON.parse(readFileSync(path, 'utf8')).archivedSessions).toEqual([])

    await store.update((state) => { state.archivedSessions.push('succeeded') })
    expect(store.snapshot().archivedSessions).toEqual(['succeeded'])
    expect(JSON.parse(readFileSync(path, 'utf8')).archivedSessions).toEqual(['succeeded'])
  })

  it('creates private state files and directories', async () => {
    const dir = makeDirectory()
    const stateDirectory = join(dir, 'nested')
    const path = join(stateDirectory, 'state.json')
    const store = new JsonStateStore(path)
    await store.update((state) => { state.archivedSessions.push('saved') })

    expect(statSync(stateDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('backs up corrupt state, returns defaults, and serializes recovery before later updates', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, '{broken')
    const store = new JsonStateStore(path)
    expect(store.snapshot().version).toBe(1)
    expect(store.snapshot().projects).toEqual([])

    await store.update((state) => { state.archivedSessions.push('after-recovery') })
    expect(readdirSync(dir).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).archivedSessions).toEqual(['after-recovery'])
  })
  it('archives and restores session visibility metadata without touching the transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-session-')); dirs.push(dir)
    const sessionRoot = join(dir, 'sessions')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(sessionRoot)
    const transcript = join(sessionRoot, 'session.jsonl')
    writeFileSync(transcript, '{"type":"session"}\n')
    const store = new JsonStateStore(join(dir, 'state.json'))
    const sessions = new SessionService(store, null)
    Object.defineProperty(sessions, 'sessionRoot', { value: sessionRoot })
    await sessions.archive(transcript, true)
    expect(store.snapshot().archivedSessions).toContain(realpathSync(transcript))
    expect(await sessions.list()).toHaveLength(0)
    expect((await sessions.list(undefined, true))[0]?.archived).toBe(true)
    await sessions.archive(transcript, false)
    expect(store.snapshot().archivedSessions).not.toContain(realpathSync(transcript))
    expect((await sessions.list())[0]?.archived).toBe(false)
    expect(readFileSync(transcript, 'utf8')).toBe('{"type":"session"}\n')
  })

})
