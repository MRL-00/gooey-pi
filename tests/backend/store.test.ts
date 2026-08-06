import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonStateStore } from '../../electron/main/store'
import { SessionService } from '../../electron/main/sessions'

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
