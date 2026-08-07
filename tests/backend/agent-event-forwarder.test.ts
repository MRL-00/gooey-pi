import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentEventForwarder } from '../../electron/main/agent-rpc'

// Complements tests/backend/security.test.ts, which already covers the
// envelope byte bound, aggregate window byte bound for normal events, and
// agent_end surviving count saturation. These tests pin the runtime_exit
// exemption, exactly-once limit reporting, and the reserve interplay.

interface Forwarded { runtimeId: string; event: Record<string, unknown> }

function forwarder(limits: Partial<{ maxEvents: number; maxEnvelopeBytes: number; maxWindowBytes: number; windowMs: number }>): { events: Forwarded['event'][]; emit: (event: Record<string, unknown>) => void } {
  const events: Forwarded['event'][] = []
  const instance = new AgentEventForwarder('runtime-test', (envelope: Forwarded) => events.push(envelope.event), limits)
  return { events, emit: (event) => instance.emit(event) }
}

const bytesOf = (event: Record<string, unknown>) => Buffer.byteLength(JSON.stringify({ runtimeId: 'runtime-test', event }), 'utf8')

afterEach(() => { vi.useRealTimers() })

describe('AgentEventForwarder runtime_exit exemption', () => {
  it('delivers runtime_exit exactly once each while the normal-event limiter is saturated', () => {
    const { events, emit } = forwarder({ maxEvents: 3, windowMs: 60_000 })
    for (let index = 0; index < 20; index += 1) emit({ type: 'message_update', index })
    emit({ type: 'runtime_exit', code: 1, expected: false })
    emit({ type: 'runtime_exit', code: 1, expected: false })

    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(3)
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(2)
    // Saturation is reported exactly once per window, not once per drop.
    expect(events.filter((event) => event.type === 'transport_error')).toHaveLength(1)
    expect(events.at(-2)?.type).toBe('runtime_exit')
  })

  it('lets critical events spend the byte reserve that normal events cannot touch', () => {
    const { events, emit } = forwarder({ maxEvents: 100, maxEnvelopeBytes: 10_000, maxWindowBytes: 1_000, windowMs: 60_000 })
    // reserve = min(64 KiB, 1000/4) = 250, so normal events stop at 750 bytes.
    const filler = { type: 'message_update', value: 'x'.repeat(700 - bytesOf({ type: 'message_update', value: '' })) }
    expect(bytesOf(filler)).toBe(700)
    emit(filler)
    expect(events).toHaveLength(1)

    const blocked = { type: 'message_update', value: 'y'.repeat(60) }
    emit(blocked)
    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(1)
    const byteReports = events.filter((event) => event.type === 'transport_error')
    expect(byteReports).toHaveLength(1)
    expect(String(byteReports[0].error)).toContain('byte rate')

    // A runtime_exit of comparable size still fits inside the reserved
    // headroom between 750 and the full 1000-byte window.
    emit({ type: 'runtime_exit', code: 3, expected: false })
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(1)

    // The full window cap still applies to critical events; the drop is
    // silent because the bytes limit was already reported this window.
    emit({ type: 'runtime_exit', code: 3, expected: false, padding: 'z'.repeat(400) })
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'transport_error')).toHaveLength(1)
  })

  it('caps lifecycle events at their own higher limit with a single report', () => {
    const { events, emit } = forwarder({ maxEvents: 5, windowMs: 60_000 })
    for (let index = 0; index < 40; index += 1) emit({ type: 'runtime_exit', code: 0, expected: true })
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(32)
    const reports = events.filter((event) => event.type === 'transport_error')
    expect(reports).toHaveLength(1)
    expect(String(reports[0].error)).toContain('lifecycle event rate')
  })

  it('resets saturation and reporting when the window rolls over', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { events, emit } = forwarder({ maxEvents: 1, windowMs: 1_000 })
    emit({ type: 'message_update', index: 0 })
    emit({ type: 'message_update', index: 1 })
    expect(events.map((event) => event.type)).toEqual(['message_update', 'transport_error'])

    vi.setSystemTime(1_001_500)
    emit({ type: 'message_update', index: 2 })
    emit({ type: 'message_update', index: 3 })
    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'transport_error')).toHaveLength(2)
  })
})
