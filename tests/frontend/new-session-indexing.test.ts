import { describe, expect, it, vi } from 'vitest'
import { indexStartedSession } from '../../src/hooks/useWorkspaceActions'
import type { PrimeWorkApi, SessionRecord } from '../../src/types/api'

const existing: SessionRecord = {
  id: 'existing', harness: 'prime', filePath: '/sessions/existing.jsonl', projectPath: '/project', title: 'Existing chat',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0, unread: false,
}

describe('new session indexing', () => {
  it('force-indexes a newly started session before navigation can hide it', async () => {
    const created: SessionRecord = {
      ...existing,
      id: 'created',
      filePath: '/sessions/created.jsonl',
      title: 'Created chat',
      status: 'running',
    }
    const list = vi.fn(async () => [existing, created])
    let sessions = [existing]
    const setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>> = (update) => {
      sessions = typeof update === 'function' ? update(sessions) : update
    }

    await indexStartedSession(
      { sessions: { list } } as unknown as PrimeWorkApi,
      'prime',
      created.filePath,
      setSessions,
    )

    expect(list).toHaveBeenCalledWith(undefined, true, 'prime', true)
    expect(sessions.map((session) => session.id)).toEqual(['existing', 'created'])
  })
})
