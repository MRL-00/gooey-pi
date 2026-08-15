import { describe, expect, it } from 'vitest'
import { LiveContextUsageTracker, withLiveContextUsage } from '../../electron/main/agent-rpc/context-usage'

describe('live context usage tracking', () => {
  it('uses reported output usage and falls back to streaming character estimates', () => {
    const tracker = new LiveContextUsageTracker()

    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 60 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
    })
    expect(tracker.tokens).toBe(100)

    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 160 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'more' },
    })
    expect(tracker.tokens).toBe(160)

    tracker.handleEvent({ type: 'message_end', message: { role: 'assistant', usage: { output: 200 } } })
    expect(tracker.tokens).toBe(200)
    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 5 } },
      assistantMessageEvent: { type: 'thinking_delta', delta: 'x'.repeat(40) },
    })
    expect(tracker.tokens).toBe(210)
  })

  it('never moves backward during a stream and resets on the next user message', () => {
    const tracker = new LiveContextUsageTracker()
    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 80 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'first' },
    })
    const update = tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 50 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'second' },
    })
    expect(update.changed).toBe(false)
    expect(tracker.tokens).toBe(80)

    expect(tracker.handleEvent({ type: 'message_start', message: { role: 'user', content: 'next' } })).toEqual({ changed: true, reset: true })
    expect(tracker.tokens).toBe(0)
  })

  it('ignores contradictory or malformed usage fields', () => {
    const tracker = new LiveContextUsageTracker()
    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'user', usage: { output: 999 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'ignored' },
    })
    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: -1 } },
      assistantMessageEvent: { type: 'text_delta', delta: '12345678' },
    })
    expect(tracker.tokens).toBe(2)
  })
})

describe('live context usage projection', () => {
  it('adds only activity beyond the snapshot baseline', () => {
    expect(withLiveContextUsage(
      { tokens: 50_000, contextWindow: 100_000, percent: 50 },
      350,
      200,
    )).toEqual({ tokens: 50_150, contextWindow: 100_000, percent: 50.14999999999999 })
  })

  it('preserves unknown post-compaction usage', () => {
    const unknown = { tokens: null, contextWindow: 100_000, percent: null } as const
    expect(withLiveContextUsage(unknown, 1_000, 0)).toBe(unknown)
  })
})
