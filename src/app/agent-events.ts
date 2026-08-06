import type { PrimeEventBuffer } from '@/lib/events'

export interface PendingAgentEvent {
  generation: number
  event: Record<string, unknown>
}

export interface TranscriptEventOwner {
  generation: number
  eventBuffer: PrimeEventBuffer
}

export interface TranscriptReconciliationMarker {
  generation: number
  runtimeId: string
  sessionFile: string
}

const TERMINAL_TRANSCRIPT_EVENTS = new Set([
  'agent_end',
  'extension_error',
  'error',
  'runtime_exit',
])

export function eventType(event: Record<string, unknown>): string {
  return typeof event.type === 'string' ? event.type : ''
}

export function needsTranscriptReconciliation(event: Record<string, unknown>): boolean {
  return eventType(event) === 'transport_error'
}

export function isTranscriptTerminalEvent(event: Record<string, unknown>): boolean {
  return TERMINAL_TRANSCRIPT_EVENTS.has(eventType(event))
}

export function reconciliationMatches(
  marker: TranscriptReconciliationMarker,
  generation: number,
  runtimeId: string,
  sessionFile: string | undefined,
): boolean {
  return marker.generation === generation
    && marker.runtimeId === runtimeId
    && marker.sessionFile === sessionFile
}


export function authoritativeTranscriptReadIsCurrent(
  marker: TranscriptReconciliationMarker,
  current: { generation: number; sessionFile?: string },
  currentRuntimeId: string | null,
): boolean {
  return marker.generation === current.generation
    && marker.sessionFile === current.sessionFile
    && (currentRuntimeId === null || currentRuntimeId === marker.runtimeId)
}

export function admitAgentEvent(
  generation: number,
  event: Record<string, unknown>,
  pendingLoad: TranscriptEventOwner | null,
  frameQueue: PendingAgentEvent[],
): 'transcript' | 'frame' {
  if (pendingLoad?.generation === generation) {
    pendingLoad.eventBuffer.push(event)
    return 'transcript'
  }
  frameQueue.push({ generation, event })
  return 'frame'
}

export function eventsForWorkspace(queue: PendingAgentEvent[], generation: number): Record<string, unknown>[] {
  return queue.filter((entry) => entry.generation === generation).map((entry) => entry.event)
}
