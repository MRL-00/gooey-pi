import { describe, expect, it } from 'vitest'
import {
  authoritativeTranscriptReadIsCurrent,
  isTranscriptTerminalEvent,
  needsTranscriptReconciliation,
  reconciliationMatches,
  type TranscriptReconciliationMarker,
} from '../../src/app/agent-events'

const marker: TranscriptReconciliationMarker = {
  generation: 7,
  runtimeId: 'runtime-current',
  sessionFile: '/sessions/current.jsonl',
}

describe('authoritative transcript reconciliation', () => {
  it('marks transport loss and waits for a terminal turn or runtime event', () => {
    expect(needsTranscriptReconciliation({ type: 'transport_error', error: 'event rate exceeded the desktop limit' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'transport_error' })).toBe(false)
    expect(isTranscriptTerminalEvent({ type: 'agent_end' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'error' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'extension_error' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'runtime_exit' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'compaction_end' })).toBe(true)
  })

  it('requires the same generation, runtime, and session before starting the reread', () => {
    expect(reconciliationMatches(marker, 7, 'runtime-current', '/sessions/current.jsonl')).toBe(true)
    expect(reconciliationMatches(marker, 8, 'runtime-current', '/sessions/current.jsonl')).toBe(false)
    expect(reconciliationMatches(marker, 7, 'runtime-new', '/sessions/current.jsonl')).toBe(false)
    expect(reconciliationMatches(marker, 7, 'runtime-current', '/sessions/other.jsonl')).toBe(false)
  })

  it('rejects a stale authoritative result after a workspace or runtime takeover', () => {
    expect(authoritativeTranscriptReadIsCurrent(marker, {
      generation: 7,
      sessionFile: '/sessions/current.jsonl',
    }, 'runtime-current')).toBe(true)
    expect(authoritativeTranscriptReadIsCurrent(marker, {
      generation: 8,
      sessionFile: '/sessions/current.jsonl',
    }, 'runtime-current')).toBe(false)
    expect(authoritativeTranscriptReadIsCurrent(marker, {
      generation: 7,
      sessionFile: '/sessions/other.jsonl',
    }, 'runtime-current')).toBe(false)
    expect(authoritativeTranscriptReadIsCurrent(marker, {
      generation: 7,
      sessionFile: '/sessions/current.jsonl',
    }, 'runtime-new')).toBe(false)
  })

  it('allows the terminal runtime result after runtime_exit clears the active runtime id', () => {
    expect(authoritativeTranscriptReadIsCurrent(marker, {
      generation: 7,
      sessionFile: '/sessions/current.jsonl',
    }, null)).toBe(true)
  })

  it('rejects a reconciliation result after a new same-runtime prompt is admitted', () => {
    expect(authoritativeTranscriptReadIsCurrent({ ...marker, admissionRevision: 2 }, {
      generation: 7,
      sessionFile: '/sessions/current.jsonl',
      admissionRevision: 2,
    }, 'runtime-current')).toBe(true)
    const afterAdmission = {
      generation: 7,
      sessionFile: '/sessions/current.jsonl',
      admissionRevision: 3,
    }
    expect(authoritativeTranscriptReadIsCurrent(
      { ...marker, admissionRevision: 2 },
      afterAdmission,
      'runtime-current',
    )).toBe(false)
    expect(authoritativeTranscriptReadIsCurrent(
      { ...marker, admissionRevision: 2 },
      afterAdmission,
      null,
    )).toBe(false)
  })

})
