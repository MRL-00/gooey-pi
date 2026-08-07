import { describe, expect, it } from 'vitest'
import { AGENT_EVENT_QUEUE_LIMIT, admitAgentEvent, contextUsageFromEvent, type PendingAgentEvent } from '../../src/app/agent-events'

describe('context usage events', () => {
  it('accepts bounded authoritative usage and preserves post-compaction unknowns', () => {
    expect(contextUsageFromEvent({
      type: 'context_usage', contextUsage: { tokens: 50_000, contextWindow: 100_000, percent: 50 },
    })).toEqual({ tokens: 50_000, contextWindow: 100_000, percent: 50 })
    expect(contextUsageFromEvent({
      type: 'context_usage', contextUsage: { tokens: null, contextWindow: 100_000, percent: null },
    })).toEqual({ tokens: null, contextWindow: 100_000, percent: null })
  })

  it('rejects malformed, negative, and unrelated payloads', () => {
    expect(contextUsageFromEvent({ type: 'message_end' })).toBeNull()
    expect(contextUsageFromEvent({ type: 'context_usage', contextUsage: { tokens: -1, contextWindow: 100, percent: 0 } })).toBeNull()
    expect(contextUsageFromEvent({ type: 'context_usage', contextUsage: { tokens: 1, contextWindow: 0, percent: 1 } })).toBeNull()
    expect(contextUsageFromEvent({ type: 'context_usage', contextUsage: { tokens: 1, contextWindow: 100, percent: Number.NaN } })).toBeNull()
  })
})

describe('agent event admission bound', () => {
  it('admits frame events until the queue bound and reports overflow past it', () => {
    const queue: PendingAgentEvent[] = []
    expect(admitAgentEvent(1, { type: 'message_update' }, null, queue, 2)).toBe('frame')
    expect(admitAgentEvent(1, { type: 'message_update' }, null, queue, 2)).toBe('frame')
    expect(admitAgentEvent(1, { type: 'message_update' }, null, queue, 2)).toBe('overflow')
    expect(queue).toHaveLength(2)
  })

  it('keeps routing to a pending transcript load regardless of queue depth', () => {
    const queue: PendingAgentEvent[] = Array.from({ length: 2 }, () => ({ generation: 1, event: {} }))
    const buffered: Record<string, unknown>[] = []
    const pendingLoad = { generation: 1, eventBuffer: { push: (event: Record<string, unknown>) => { buffered.push(event) } } }
    expect(admitAgentEvent(1, { type: 'message_update' }, pendingLoad as never, queue, 2)).toBe('transcript')
    expect(buffered).toHaveLength(1)
  })

  it('exposes a bounded default queue limit', () => {
    expect(AGENT_EVENT_QUEUE_LIMIT).toBe(50_000)
  })
})
