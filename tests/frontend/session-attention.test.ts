import { describe, expect, it } from 'vitest'
import { applySessionLifecycleEvent, sessionAttentionSignature } from '../../src/app/session-attention'
import type { SessionRecord } from '../../src/types/api'

const session = (): SessionRecord => ({
  id: 'session',
  filePath: '/sessions/session.jsonl',
  projectPath: '/project',
  title: 'Session',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
})

describe('session lifecycle attention', () => {
  it('does not mark a visible completion unread', () => {
    const completed = applySessionLifecycleEvent(session(), { type: 'agent_end' }, true, Date.parse('2025-01-01T00:00:01.000Z'))
    expect(completed).toMatchObject({ status: 'complete', unread: false, eventRevision: 1 })
    expect(completed.updatedAt).toBe('2025-01-01T00:00:01.000Z')
    expect(sessionAttentionSignature(completed)).toBeUndefined()
  })

  it('gives repeated background waits and completions distinct attention revisions', () => {
    const waiting = applySessionLifecycleEvent(session(), { type: 'extension_ui_request' }, false, 1)
    const waitingAgain = applySessionLifecycleEvent(waiting, { type: 'extension_ui_request' }, false, 1)
    const completed = applySessionLifecycleEvent(waitingAgain, { type: 'agent_end' }, false, 1)
    const completedAgain = applySessionLifecycleEvent(completed, { type: 'agent_end' }, false, 1)

    expect(sessionAttentionSignature(waiting)).toBe('waiting:1')
    expect(sessionAttentionSignature(waitingAgain)).toBe('waiting:2')
    expect(sessionAttentionSignature(completed)).toBe('complete:3')
    expect(sessionAttentionSignature(completedAgain)).toBe('complete:4')
    expect(Date.parse(waitingAgain.updatedAt)).toBeGreaterThan(Date.parse(waiting.updatedAt))
  })

  it('advances lifecycle revision without changing attention for failures', () => {
    const failed = applySessionLifecycleEvent(session(), { type: 'transport_error' }, false, 1)
    expect(failed).toMatchObject({ status: 'failed', eventRevision: 1 })
    expect(sessionAttentionSignature(failed)).toBeUndefined()
  })

  it('finishes a manual compaction when no continuation is scheduled', () => {
    const running = applySessionLifecycleEvent(session(), { type: 'compaction_start', reason: 'manual' }, true, 1)
    const completed = applySessionLifecycleEvent(running, { type: 'compaction_end', reason: 'manual', willRetry: false }, true, 2)
    expect(running.status).toBe('running')
    expect(completed).toMatchObject({ status: 'complete', unread: false, eventRevision: 2 })
  })
})
