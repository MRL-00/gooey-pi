import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
const identities = (...paths: string[]) => Object.fromEntries(paths.map((path) => { const info = lstatSync(path, { bigint: true }); return [realpathSync(path), { dev: info.dev.toString(), ino: info.ino.toString() }] }))
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup(): { root: string; service: ProjectService; store: JsonStateStore } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-files-')); dirs.push(dir)
  const root = join(dir, 'project'); mkdirSync(root)
  const store = new JsonStateStore(join(dir, 'state.json'))
  const service = new ProjectService(store, () => null)
  return { root, service, store }
}

describe('ProjectService file listing', () => {
  it('lists project files while excluding generated trees and symlinks', async () => {
    const { root, service, store } = setup()
    mkdirSync(join(root, 'src')); mkdirSync(join(root, '.git')); mkdirSync(join(root, 'node_modules')); mkdirSync(join(root, 'release'))
    writeFileSync(join(root, 'README.md'), 'read me')
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}')
    writeFileSync(join(root, '.git', 'config'), 'private metadata')
    writeFileSync(join(root, 'node_modules', 'dependency.js'), 'generated')
    writeFileSync(join(root, 'release', 'Prime Work.dmg'), 'generated')
    symlinkSync('/etc/hosts', join(root, 'hosts-link'))
    await store.update((state) => { state.projects.push({ id: 'project', name: 'Project', path: root, folders: [root], primaryFolder: root, pinned: false, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: identities(root) }) })

    await service.list()
    expect(await service.listFiles(root)).toEqual([
      { path: 'src', type: 'directory' },
      { path: 'src/index.ts', type: 'file' },
      { path: 'README.md', type: 'file' },
    ])
  })

  it('rejects paths that have not been added as projects', async () => {
    const { root, service } = setup()
    await expect(service.listFiles(root)).rejects.toThrow(/not inside an added Prime Work project/)
  })

  it('migrates explicit project grants created before folder identities were persisted', async () => {
    const { root, service, store } = setup()
    writeFileSync(join(root, 'README.md'), 'read me')
    await store.update((state) => { state.projects.push({
      id: 'legacy-project', name: 'Legacy project', path: root, folders: [root], primaryFolder: root, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
    }) })

    expect(await service.listFiles(root)).toEqual([{ path: 'README.md', type: 'file' }])
    expect(store.snapshot().projects[0].folderIdentities).toEqual(identities(root))
  })

  it('revokes a grant when its directory is replaced by a symlink, including after restart', async () => {
    const { root, service, store } = setup()
    const original = `${root}-original`
    const unrelated = `${root}-unrelated`
    mkdirSync(unrelated)
    await store.update((state) => { state.projects.push({
      id: 'project', name: 'Project', path: root, folders: [root], primaryFolder: root, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: identities(root),
    }) })
    await service.list()
    expect(await service.authorizeCwd(root)).toBe(realpathSync(root))

    renameSync(root, original)
    symlinkSync(unrelated, root, 'dir')
    await expect(service.authorizeCwd(root)).rejects.toThrow(/identity changed/)
    await expect(service.listFiles(root)).rejects.toThrow(/identity changed/)

    const restarted = new ProjectService(new JsonStateStore(resolve(root, '..', 'state.json')), () => null)
    restarted.bindProviders({ sessions: async () => [], branch: async () => undefined })
    await restarted.list()
    await expect(restarted.authorizeCwd(root)).rejects.toThrow(/identity changed/)
  })

  it('revokes a grant when a different directory is recreated at the same path', async () => {
    const { root, service, store } = setup()
    await store.update((state) => { state.projects.push({
      id: 'project', name: 'Project', path: root, folders: [root], primaryFolder: root, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: identities(root),
    }) })
    await service.list()
    rmSync(root, { recursive: true })
    mkdirSync(root)
    await expect(service.authorizeCwd(root)).rejects.toThrow(/identity changed/)
  })

})
