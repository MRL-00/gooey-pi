import { describe, expect, it } from 'vitest'
import { AgentEventForwarder } from '../../electron/main/agent-rpc/events'
import type { PrimeEventEnvelope } from '../../src/types/api'

function forwarder(limits: Partial<{ maxEvents: number; maxEnvelopeBytes: number; maxWindowBytes: number; windowMs: number }> = {}) {
  const delivered: PrimeEventEnvelope[] = []
  const events = new AgentEventForwarder('runtime-1', (envelope) => delivered.push(envelope), limits)
  return { events, delivered }
}

describe('AgentEventForwarder runtime_exit exemption', () => {
  it('delivers runtime_exit under a saturated event-count limiter', () => {
    const { events, delivered } = forwarder({ maxEvents: 5 })
    for (let index = 0; index < 20; index += 1) events.emit({ type: 'message_update', index })
    const deliveredTypes = delivered.map(({ event }) => event.type)
    expect(deliveredTypes.filter((type) => type === 'message_update')).toHaveLength(5)

    events.emit({ type: 'runtime_exit', code: 1, expected: false })
    expect(delivered.at(-1)?.event).toMatchObject({ type: 'runtime_exit', code: 1 })
  })

  it('delivers runtime_exit under saturated lifecycle and byte limiters', () => {
    const { events, delivered } = forwarder({ maxWindowBytes: 512 })
    for (let index = 0; index < 40; index += 1) events.emit({ type: 'agent_start' })
    const beforeExit = delivered.filter(({ event }) => event.type === 'agent_start').length
    expect(beforeExit).toBeLessThanOrEqual(32)

    events.emit({ type: 'runtime_exit', code: null, signal: 'SIGKILL', expected: false })
    expect(delivered.filter(({ event }) => event.type === 'runtime_exit')).toHaveLength(1)
  })

  it('delivers runtime_exit at most once', () => {
    const { events, delivered } = forwarder()
    events.emit({ type: 'runtime_exit', code: 0, expected: true })
    events.emit({ type: 'runtime_exit', code: 0, expected: true })
    expect(delivered.filter(({ event }) => event.type === 'runtime_exit')).toHaveLength(1)
  })
})
