import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('JsonStateStore', () => {
  it('serializes concurrent updates without losing data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-store-')); dirs.push(dir)
    const path = join(dir, 'state.json')
    const store = new JsonStateStore(path)
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update((state) => { state.archivedSessions.push(String(index)) })))
    expect(store.snapshot().archivedSessions).toHaveLength(20)
    expect(JSON.parse(readFileSync(path, 'utf8')).archivedSessions).toHaveLength(20)
  })

  it('backs up corrupt state and returns defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-store-')); dirs.push(dir)
    const path = join(dir, 'state.json')
    writeFileSync(path, '{broken')
    const store = new JsonStateStore(path)
    expect(store.snapshot().version).toBe(1)
    expect(store.snapshot().projects).toEqual([])
  })
})
