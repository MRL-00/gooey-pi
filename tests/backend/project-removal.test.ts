import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'
import type { SessionRecord } from '../../src/types/api'

const dirs: string[] = []
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
      pinned: false, createdAt: now, lastOpenedAt: now,
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

  it('does not duplicate a persisted multi-folder project as an inferred project', async () => {
    const { folder, store, session, service } = fixture()
    const primary = join(folder, 'primary')
    const secondary = join(folder, 'secondary')
    mkdirSync(primary); mkdirSync(secondary)
    session.projectPath = secondary
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'project-1', name: 'Project', path: primary, folders: [primary, secondary], primaryFolder: primary,
      pinned: false, createdAt: now, lastOpenedAt: now,
    }) })

    const projects = await service.list()
    expect(projects).toHaveLength(1)
    expect(projects[0].id).toBe('project-1')
    expect(projects[0].sessionCount).toBe(1)
  })
})
