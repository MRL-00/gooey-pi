import { describe, expect, it } from 'vitest'
import { applySessionLifecycleEvent, readClearedAttention, sessionAttentionSignature, sessionCompanionNotificationSignature, sessionShowsCompanionNotification } from '../../src/app/session-attention'
import { mergeSessionCatalog } from '../../src/hooks/useBootstrap'
import type { SessionRecord } from '../../src/types/api'

const session = (): SessionRecord => ({
  id: 'session',
  harness: 'prime',
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
    expect(sessionShowsCompanionNotification(completed)).toBe(true)
    expect(sessionShowsCompanionNotification(completed, sessionCompanionNotificationSignature(completed))).toBe(false)
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
    expect(sessionAttentionSignature(failed)).toBe('failed:1')
    expect(sessionShowsCompanionNotification(failed)).toBe(true)
  })

  it('shows the companion badge only for new terminal turns or attention states', () => {
    expect(sessionShowsCompanionNotification(session())).toBe(false)
    expect(sessionShowsCompanionNotification({ ...session(), status: 'complete' })).toBe(false)
    expect(sessionShowsCompanionNotification({ ...session(), status: 'complete', unread: true })).toBe(true)
    expect(sessionShowsCompanionNotification({ ...session(), status: 'waiting' })).toBe(true)
    expect(sessionShowsCompanionNotification({ ...session(), status: 'waiting' }, `waiting:${session().updatedAt}`)).toBe(false)
  })

  it('ignores desktop rate-limit drops: the agent is still running', () => {
    const running = applySessionLifecycleEvent(session(), { type: 'agent_start' }, true, 1)
    const afterLimit = applySessionLifecycleEvent(running, { type: 'transport_limit', kind: 'count' }, true, 2)
    expect(afterLimit).toBe(running)
  })

  it('finishes a manual compaction when no continuation is scheduled', () => {
    const running = applySessionLifecycleEvent(session(), { type: 'compaction_start', reason: 'manual' }, true, 1)
    const completed = applySessionLifecycleEvent(running, { type: 'compaction_end', reason: 'manual', willRetry: false }, true, 2)
    expect(running.status).toBe('running')
    expect(completed).toMatchObject({ status: 'complete', unread: false, eventRevision: 2 })
  })
})

describe('catalog merges over live session state', () => {
  it('keeps a waiting badge while its extension-UI request is still open', () => {
    const waiting = applySessionLifecycleEvent(session(), { type: 'extension_ui_request' }, false, 1)
    expect(sessionAttentionSignature(waiting)).toBe('waiting:1')

    const diskRecord: SessionRecord = { ...session(), status: 'running', updatedAt: '2025-01-01T00:00:05.000Z' }
    const [merged] = mergeSessionCatalog([waiting], [diskRecord], undefined, new Map(), 0, () => true)
    expect(merged.status).toBe('waiting')
    expect(merged.eventRevision).toBe(1)
    expect(sessionAttentionSignature(merged)).toBe('waiting:1')

    const [settled] = mergeSessionCatalog([waiting], [diskRecord], undefined, new Map(), 0, () => false)
    expect(settled.status).toBe('running')
  })

  it('keeps a newer optimistic lastUserMessageAt over the disk value', () => {
    const live: SessionRecord = { ...session(), lastUserMessageAt: '2025-01-01T00:10:00.000Z' }
    const diskRecord: SessionRecord = { ...session(), lastUserMessageAt: '2025-01-01T00:00:00.000Z' }
    const [merged] = mergeSessionCatalog([live], [diskRecord], undefined, new Map(), 0)
    expect(merged.lastUserMessageAt).toBe('2025-01-01T00:10:00.000Z')
  })

  it('bumps the catalog revision only for records that actually changed', () => {
    const unchanged: SessionRecord = { ...session(), id: 'same', filePath: '/sessions/same.jsonl', syncRevision: 3 }
    const moved: SessionRecord = { ...session(), id: 'moved', filePath: '/sessions/moved.jsonl', syncRevision: 3 }
    const movedOnDisk: SessionRecord = { ...moved, updatedAt: '2025-01-02T00:00:00.000Z', syncRevision: undefined }
    const [mergedSame, mergedMoved] = mergeSessionCatalog(
      [unchanged, moved],
      [{ ...unchanged, syncRevision: undefined }, movedOnDisk],
      undefined,
      new Map(),
      7,
    )
    expect(mergedSame.syncRevision).toBe(3)
    expect(mergedMoved.syncRevision).toBe(7)
  })
})

describe('cleared-attention store', () => {
  it('guards malformed persisted values, including the null literal', () => {
    expect(readClearedAttention('null')).toEqual({})
    expect(readClearedAttention('[]')).toEqual({})
    expect(readClearedAttention('"waiting:1"')).toEqual({})
    expect(readClearedAttention('not json')).toEqual({})
    expect(readClearedAttention(null)).toEqual({})
    expect(readClearedAttention('{"a":"waiting:1","b":7}')).toEqual({ a: 'waiting:1' })
  })
})
