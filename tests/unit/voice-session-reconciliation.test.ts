import { describe, expect, it, vi } from 'vitest'
import { waitForVoiceSession } from '../../src/lib/voice'
import type { SessionRecord } from '../../src/types/api'

const session: SessionRecord = {
  id: 'omp-session', harness: 'omp', projectPath: '/tmp/omp', filePath: '/tmp/omp/session.jsonl', title: 'OMP voice task',
  createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z', status: 'running', depth: 0,
}

describe('voice task session reconciliation', () => {
  it('waits for a newly created OMP session to enter the project catalog', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([session])
    const wait = vi.fn(async () => undefined)

    await expect(waitForVoiceSession(session.filePath, load, wait)).resolves.toEqual({ session, sessions: [session] })
    expect(load).toHaveBeenCalledTimes(3)
    expect(wait.mock.calls).toEqual([[100], [200]])
  })

  it('returns null after the bounded retry window', async () => {
    const load = vi.fn(async () => [])
    const wait = vi.fn(async () => undefined)

    await expect(waitForVoiceSession(session.filePath, load, wait)).resolves.toBeNull()
    expect(load).toHaveBeenCalledTimes(6)
    expect(wait).toHaveBeenCalledTimes(5)
  })
})
