import { describe, expect, it } from 'vitest'
import { applyPrimeEvent } from '../../src/lib/events'
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
})
