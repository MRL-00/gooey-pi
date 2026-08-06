import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'
import type { SessionRecord } from '../../src/types/api'

const dirs: string[] = []
const identities = (...paths: string[]) => Object.fromEntries(paths.map((path) => { const info = lstatSync(path, { bigint: true }); return [realpathSync(path), { dev: info.dev.toString(), ino: info.ino.toString() }] }))
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-project-removal-'))
  dirs.push(dir)
  const folder = join(dir, 'project')
  mkdirSync(folder)
  const marker = join(folder, 'keep.txt')
  writeFileSync(marker, 'keep')
  const store = new JsonStateStore(join(dir, 'state.json'))
  const session: SessionRecord = {
    id: 'session', filePath: join(dir, 'session.jsonl'), projectPath: folder, title: 'Session',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', depth: 0,
  }
  const service = new ProjectService(store, () => null)
  service.bindProviders({ sessions: async () => [session], branch: async () => undefined })
  return { folder, marker, store, session, service }
}

describe('project removal', () => {
  it('keeps a removed persisted project dismissed instead of immediately re-inferring it', async () => {
    const { folder, marker, store, service } = fixture()
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'project-1', name: 'Project', path: folder, folders: [folder], primaryFolder: folder,
      pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(folder),
    }) })

    expect(await service.remove('project-1')).toBe(true)
    expect(await service.list()).toEqual([])
    expect(store.snapshot().dismissedProjectPaths).toContain(realpathSync(folder))
    expect(existsSync(marker)).toBe(true)
  })

  it('can dismiss an inferred project and explicitly add it back later', async () => {
    const { folder, store, service } = fixture()
    const [inferred] = await service.list()
    expect(inferred.inferred).toBe(true)

    expect(await service.remove(inferred.id)).toBe(true)
    expect(await service.list()).toEqual([])

    const granted = await service.grantInferred(folder)
    expect(granted.inferred).not.toBe(true)
    expect(store.snapshot().dismissedProjectPaths).not.toContain(realpathSync(folder))
    expect(await service.list()).toHaveLength(1)
  })

  it('does not reauthorize a removed project when an older list finishes later', async () => {
    const { folder, store, service } = fixture()
    const second = join(folder, '..', 'second-project')
    mkdirSync(second)
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push(
      { id: 'project-1', name: 'First', path: folder, folders: [folder], primaryFolder: folder, pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(folder) },
      { id: 'project-2', name: 'Second', path: second, folders: [second], primaryFolder: second, pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(second) },
    ) })
    let releaseBranch!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const release = new Promise<void>((resolve) => { releaseBranch = resolve })
    service.bindProviders({ sessions: async () => [], branch: async (cwd) => {
      if (cwd === folder) { markEntered(); await release }
      return undefined
    } })

    const staleList = service.list()
    await entered
    expect(await service.remove('project-2')).toBe(true)
    releaseBranch()
    await staleList

    await expect(service.authorizeCwd(second)).rejects.toThrow(/being removed/)
  })

  it('does not duplicate a persisted multi-folder project as an inferred project', async () => {
    const { folder, store, session, service } = fixture()
    const primary = join(folder, 'primary')
    const secondary = join(folder, 'secondary')
    mkdirSync(primary); mkdirSync(secondary)
    session.projectPath = secondary
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'project-1', name: 'Project', path: primary, folders: [primary, secondary], primaryFolder: primary,
      pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(folder),
    }) })

    const projects = await service.list()
    expect(projects).toHaveLength(1)
    expect(projects[0].id).toBe('project-1')
    expect(projects[0].sessionCount).toBe(1)
  })
  it('does not complete an authorization whose grant is removed during identity verification', async () => {
    const { folder, store, service } = fixture()
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'project-1', name: 'Project', path: folder, folders: [folder], primaryFolder: folder,
      pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(folder),
    }) })
    await service.list()

    const internal = service as unknown as { verifyFolderIdentity(path: string, expected?: { dev: string; ino: string }): Promise<string | undefined> }
    const original = internal.verifyFolderIdentity.bind(service)
    let releaseVerification!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const release = new Promise<void>((resolve) => { releaseVerification = resolve })
    internal.verifyFolderIdentity = async (path, expected) => { markEntered(); await release; return original(path, expected) }

    const pendingAuthorization = service.authorizeCwd(folder)
    await entered
    expect(await service.remove('project-1')).toBe(true)
    releaseVerification()
    await expect(pendingAuthorization).rejects.toThrow(/authorization changed/)
  })


  it('revokes admission and waits for matching project processes before removal completes', async () => {
    const { folder, store, service } = fixture()
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'project-1', name: 'Project', path: folder, folders: [folder], primaryFolder: folder,
      pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(folder),
    }) })
    await service.list()
    let releaseStop!: () => void
    let markStopStarted!: () => void
    const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve })
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve })
    let stoppedRoots: string[] = []
    service.bindProviders({
      sessions: async () => [],
      branch: async () => undefined,
      stopProjectProcesses: async (roots) => { stoppedRoots = roots; markStopStarted(); await stopGate },
    })

    const removal = service.remove('project-1')
    await stopStarted
    expect(stoppedRoots).toContain(realpathSync(folder))
    expect(store.snapshot().projects).toHaveLength(1)
    await expect(service.authorizeCwd(folder)).rejects.toThrow(/being removed/)

    releaseStop()
    await expect(removal).resolves.toBe(true)
    expect(store.snapshot().projects).toEqual([])
  })

})
