import { describe, expect, it } from 'vitest'
import { applyPrimeEvent, createPrimeEventBuffer } from '../../src/lib/events'
import type { TranscriptMessage } from '../../src/types/api'

const streamingMessage = (): TranscriptMessage => ({
  id: 'assistant-1', role: 'assistant', timestamp: 1, streaming: true, parts: [{ type: 'text', text: 'partial' }],
})

describe('agent transport events', () => {
  it('finalizes the stream and shows transport errors', () => {
    const messages = applyPrimeEvent([streamingMessage()], { type: 'transport_error', error: 'Malformed agent output' })

    expect(messages[0].streaming).toBe(false)
    expect(messages.at(-1)?.role).toBe('system')
    expect(messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'Malformed agent output' }])
  })

  it('explains an unexpected runtime exit without duplicating an existing error', () => {
    const exited = applyPrimeEvent([streamingMessage()], { type: 'runtime_exit', code: 2, expected: false })
    expect(exited.at(-1)?.parts[0]).toEqual({ type: 'text', text: 'Prime Agent stopped unexpectedly (exit code 2). Send the message again to restart it.' })

    const afterTransportError = applyPrimeEvent(exited, { type: 'runtime_exit', code: 2, expected: false })
    expect(afterTransportError).toHaveLength(exited.length)
  })

  it('nests live agent messages in the streaming assistant activity', () => {
    const event = {
      type: 'custom_message', customType: 'agent_message', content: 'fallback',
      details: { message: 'Review complete.', from: { sessionName: 'reviewer' } },
    }
    const applied = applyPrimeEvent([streamingMessage()], event)
    expect(applied[0].parts.at(-1)).toEqual({ type: 'agentMessage', text: 'Review complete.', agentName: 'reviewer' })

    const buffered = createPrimeEventBuffer()
    buffered.push(event)
    expect(buffered.replay([streamingMessage()])[0].parts.at(-1)).toEqual({ type: 'agentMessage', text: 'Review complete.', agentName: 'reviewer' })
  })

  it('replays live events over an older transcript load result', () => {
    const pendingLoadEvents = createPrimeEventBuffer()
    pendingLoadEvents.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' plus live output' } })
    pendingLoadEvents.push({ type: 'agent_end' })

    const loaded = pendingLoadEvents.replay([streamingMessage()])
    expect(pendingLoadEvents.size).toBe(2)
    expect(loaded[0].parts).toEqual([{ type: 'text', text: 'partial plus live output' }])
    expect(loaded[0].streaming).toBe(false)
  })

  it('keeps automatic continuations in the same assistant turn after an agent end', () => {
    const events: Record<string, unknown>[] = [
      { type: 'agent_end' },
      {
        type: 'custom_message', customType: 'agent_message', content: 'fallback',
        details: { message: 'Child work finished.', from: { sessionName: 'reviewer' } },
      },
      { type: 'agent_end' },
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolCallId: 'next-tool', toolName: 'Read', args: { path: 'next.ts' } },
      { type: 'tool_execution_end', toolCallId: 'next-tool', toolName: 'Read', result: 'done' },
      { type: 'agent_end' },
    ]
    const assertContinuousTurn = (messages: TranscriptMessage[]) => {
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ id: 'assistant-1', role: 'assistant', streaming: false })
      expect(messages[0].parts.map((part) => part.type)).toEqual(['text', 'agentMessage', 'toolCall', 'toolResult'])
    }

    assertContinuousTurn(events.reduce((messages, event) => applyPrimeEvent(messages, event), [streamingMessage()]))
    const buffered = createPrimeEventBuffer()
    events.forEach((event) => buffered.push(event))
    assertContinuousTurn(buffered.replay([streamingMessage()]))
  })

  it('renders compaction start and completion without leaving a silent assistant stream', () => {
    const started = applyPrimeEvent([streamingMessage()], { type: 'compaction_start', reason: 'overflow' })
    expect(started[0]).toMatchObject({ role: 'assistant', streaming: false, parts: [{ type: 'text', text: 'partial' }] })
    expect(started.at(-1)).toMatchObject({
      role: 'system', streaming: true,
      parts: [{ type: 'compaction', status: 'running', reason: 'overflow' }],
    })

    const finished = applyPrimeEvent(started, {
      type: 'compaction_end', reason: 'overflow', willRetry: true, aborted: false,
      result: { summary: 'Earlier work was summarized.', tokensBefore: 99_175, firstKeptEntryId: 'kept-1' },
    })
    expect(finished.at(-1)).toMatchObject({ role: 'system', streaming: false, completedAt: expect.any(Number) })
    expect(finished.at(-1)?.parts[0]).toMatchObject({
      type: 'compaction', status: 'done', reason: 'overflow', tokensBefore: 99_175,
      summary: 'Earlier work was summarized.', willRetry: true,
    })
  })

  it('does not duplicate the persisted failure outcome and end event', () => {
    const events: Record<string, unknown>[] = [
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'message_end',
        message: { role: 'custom', customType: 'compaction_outcome', content: 'Auto-compaction skipped: no model', details: { reason: 'threshold', outcome: 'skipped' } },
      },
      { type: 'compaction_end', reason: 'threshold', aborted: false, errorSeverity: 'warning', errorMessage: 'Auto-compaction skipped: no model' },
    ]
    const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), [streamingMessage()])
    const buffered = createPrimeEventBuffer()
    events.forEach((event) => buffered.push(event))
    expect(buffered.replay([streamingMessage()])).toEqual(sequential)
    expect(sequential.filter((message) => message.parts.some((part) => part.type === 'compaction'))).toHaveLength(1)
    expect(sequential.at(-1)?.parts[0]).toMatchObject({ type: 'compaction', status: 'failed', outcome: 'skipped' })
  })

  it('does not duplicate a compaction already present in an authoritative reload', () => {
    const loaded: TranscriptMessage[] = [{
      id: 'persisted-compaction', role: 'system',
      parts: [{ type: 'compaction', status: 'done', reason: 'overflow', tokensBefore: 99_175, firstKeptEntryId: 'kept-1', summary: 'Earlier work.' }],
    }]
    const replayed = createPrimeEventBuffer()
    replayed.push({ type: 'compaction_start', reason: 'overflow' })
    replayed.push({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true, result: { summary: 'Earlier work.', tokensBefore: 99_175, firstKeptEntryId: 'kept-1' } })
    const result = replayed.replay(loaded)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('persisted-compaction')
  })
})
