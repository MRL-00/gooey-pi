import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('defaults and validates the configurable message Enter action', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const settings = { ...defaultSettings(), messageEnterAction: 'steer' }
    writeFileSync(path, JSON.stringify({ version: 1, projects: [], settings, archivedSessions: [], dismissedProjectPaths: [] }))
    expect(new JsonStateStore(path).snapshot().settings.messageEnterAction).toBe('steer')

    settings.messageEnterAction = 'invalid' as typeof settings.messageEnterAction
    writeFileSync(path, JSON.stringify({ version: 1, projects: [], settings, archivedSessions: [], dismissedProjectPaths: [] }))
    expect(new JsonStateStore(path).snapshot().settings.messageEnterAction).toBe('queue')
  })

  it('keeps supported interface font scales and resets values outside the bounded choices', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const settings = { ...defaultSettings(), interfaceFontScale: 110 }
    writeFileSync(path, JSON.stringify({ version: 3, projects: [], settings, archivedSessions: [], dismissedProjectPaths: [], schedules: [] }))
    expect(new JsonStateStore(path).snapshot().settings.interfaceFontScale).toBe(110)

    settings.interfaceFontScale = 125 as typeof settings.interfaceFontScale
    writeFileSync(path, JSON.stringify({ version: 3, projects: [], settings, archivedSessions: [], dismissedProjectPaths: [], schedules: [] }))
    expect(new JsonStateStore(path).snapshot().settings.interfaceFontScale).toBe(100)
  })

  it('stops update admission and drains a write when shutdown starts immediately', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeValidState(path)
    let releaseWrite!: () => void
    let markWriteStarted!: () => void
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve })
    const file: JsonStateStoreFileHandle = {
      writeFile: async () => { markWriteStarted(); await writeGate },
      sync: async () => undefined,
      close: async () => undefined,
    }
    const directory: JsonStateStoreFileHandle = {
      writeFile: async () => { throw new Error('unexpected directory write') },
      sync: async () => undefined,
      close: async () => undefined,
    }
    const store = new JsonStateStore(path, {
      open: async (_openedPath, flags) => flags === 'w' ? file : directory,
      rename: async () => undefined,
      unlink: async () => undefined,
    })

    const update = store.update((state) => { state.archivedSessions.push('before-quit') })
    const drain = store.beginShutdown()
    await writeStarted
    await expect(store.update((state) => { state.archivedSessions.push('after-quit') })).rejects.toThrow(/shutting down/)
    let drained = false
    void drain.then(() => { drained = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(drained).toBe(false)

    releaseWrite()
    await Promise.all([update, drain])
    expect(store.snapshot().archivedSessions).toEqual(['before-quit'])
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

  it('caps archived sessions and dismissed project paths on load and write', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify({
      version: 2,
      projects: [],
      settings: defaultSettings(),
      archivedSessions: Array.from({ length: 5_200 }, (_, index) => `/sessions/${index}.jsonl`),
      dismissedProjectPaths: Array.from({ length: 1_500 }, (_, index) => `/projects/${index}`),
    }))
    const store = new JsonStateStore(path)
    const loaded = store.snapshot()
    expect(loaded.archivedSessions).toHaveLength(5_000)
    expect(loaded.archivedSessions[0]).toBe('/sessions/200.jsonl')
    expect(loaded.archivedSessions.at(-1)).toBe('/sessions/5199.jsonl')
    expect(loaded.dismissedProjectPaths).toHaveLength(1_024)
    expect(loaded.dismissedProjectPaths.at(-1)).toBe('/projects/1499')

    await store.update((state) => {
      state.archivedSessions.push('/sessions/newest.jsonl')
      state.dismissedProjectPaths.push('/projects/newest')
    })
    const written = JSON.parse(readFileSync(path, 'utf8')) as { archivedSessions: string[]; dismissedProjectPaths: string[] }
    expect(written.archivedSessions).toHaveLength(5_000)
    expect(written.archivedSessions.at(-1)).toBe('/sessions/newest.jsonl')
    expect(written.dismissedProjectPaths).toHaveLength(1_024)
    expect(written.dismissedProjectPaths.at(-1)).toBe('/projects/newest')
  })

  it('exposes narrow slice accessors that clone only their slice', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify({
      version: 2,
      projects: [{ id: 'p1', name: 'One', path: '/one', folders: ['/one'], primaryFolder: '/one' }],
      settings: { ...defaultSettings(), terminalShell: '/bin/bash' },
      archivedSessions: ['/sessions/kept.jsonl'],
      dismissedProjectPaths: [],
    }))
    const store = new JsonStateStore(path)

    const settings = store.getSettings()
    expect(settings.terminalShell).toBe('/bin/bash')
    settings.terminalShell = '/bin/tampered'
    expect(store.getSettings().terminalShell).toBe('/bin/bash')

    const projects = store.getProjects()
    expect(projects.map((project) => project.id)).toEqual(['p1'])
    projects[0].name = 'tampered'
    expect(store.getProjects()[0].name).toBe('One')

    const archived = store.getArchivedSessions()
    expect(archived).toEqual(['/sessions/kept.jsonl'])
    archived.push('/sessions/tampered.jsonl')
    expect(store.getArchivedSessions()).toEqual(['/sessions/kept.jsonl'])
  })

  it('migrates version 2 state: projects gain the prime harness and settings gain harness defaults', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const { activeHarness: _activeHarness, ompApprovalMode: _ompApprovalMode, ...legacySettings } = defaultSettings()
    writeFileSync(path, JSON.stringify({
      version: 2,
      projects: [{ id: 'legacy', name: 'Legacy', path: '/legacy', folders: ['/legacy'], primaryFolder: '/legacy' }],
      settings: legacySettings,
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    const state = new JsonStateStore(path).snapshot()
    expect(state.version).toBe(3)
    expect(state.projects.map((project) => project.harness)).toEqual(['prime'])
    expect(state.settings.activeHarness).toBe('prime')
    expect(state.settings.ompApprovalMode).toBe('inherit')
  })

  it('keeps valid harness fields and resets hostile ones to defaults', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [
        { id: 'omp-project', harness: 'omp', name: 'OMP', path: '/omp', folders: ['/omp'], primaryFolder: '/omp' },
        { id: 'hostile', harness: { toString: 'omp' }, name: 'Hostile', path: '/hostile', folders: ['/hostile'], primaryFolder: '/hostile' },
      ],
      settings: { ...defaultSettings(), activeHarness: 'omp', ompApprovalMode: 'yolo' },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    const kept = new JsonStateStore(path).snapshot()
    expect(kept.projects.map((project) => project.harness)).toEqual(['omp', 'prime'])
    expect(kept.settings.activeHarness).toBe('omp')
    expect(kept.settings.ompApprovalMode).toBe('yolo')

    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [],
      settings: { ...defaultSettings(), activeHarness: 'prime' },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    expect(new JsonStateStore(path).snapshot().settings.activeHarness).toBe('prime')

    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [],
      settings: { ...defaultSettings(), activeHarness: 'codex', ompApprovalMode: 'sudo' },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    const reset = new JsonStateStore(path).snapshot()
    expect(reset.settings.activeHarness).toBe('omp')
    expect(reset.settings.ompApprovalMode).toBe('inherit')
  })

  it('refuses to parse an oversized state file and backs it up instead', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, `{"version":2,"padding":"${'x'.repeat(64 * 1024 * 1024)}"}`)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const store = new JsonStateStore(path)
      expect(store.snapshot().projects).toEqual([])
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('refusing to parse'))
      await store.update((state) => { state.archivedSessions.push('after-oversize') })
      expect(readdirSync(dir).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true)
      expect(JSON.parse(readFileSync(path, 'utf8')).archivedSessions).toEqual(['after-oversize'])
    } finally { errorSpy.mockRestore() }
  })

  it('backs up corrupt state, returns defaults, and serializes recovery before later updates', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, '{broken')
    const store = new JsonStateStore(path)
    expect(store.snapshot().version).toBe(3)
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
