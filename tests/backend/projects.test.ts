import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
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
    await store.update((state) => { state.projects.push({ id: 'project', name: 'Project', path: root, folders: [root], primaryFolder: root, pinned: false, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }) })

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
})
