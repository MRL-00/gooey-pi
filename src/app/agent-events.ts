import type { PrimeEventBuffer } from '@/lib/events'
import type { PrimeContextUsage } from '@/types/api'

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
  admissionRevision?: number
}

const TERMINAL_TRANSCRIPT_EVENTS = new Set([
  'agent_end',
  'compaction_end',
  'extension_error',
  'error',
  'runtime_exit',
])

export function eventType(event: Record<string, unknown>): string {
  return typeof event.type === 'string' ? event.type : ''
}

export function contextUsageFromEvent(event: Record<string, unknown>): PrimeContextUsage | null {
  if (eventType(event) !== 'context_usage' || typeof event.contextUsage !== 'object' || event.contextUsage === null || Array.isArray(event.contextUsage)) return null
  const raw = event.contextUsage as Record<string, unknown>
  if (!Number.isSafeInteger(raw.contextWindow) || Number(raw.contextWindow) <= 0) return null
  const tokens = raw.tokens === null ? null : Number.isSafeInteger(raw.tokens) && Number(raw.tokens) >= 0 ? Number(raw.tokens) : undefined
  const percent = raw.percent === null ? null : typeof raw.percent === 'number' && Number.isFinite(raw.percent) && raw.percent >= 0 ? raw.percent : undefined
  if (tokens === undefined || percent === undefined) return null
  return { tokens, contextWindow: Number(raw.contextWindow), percent }
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
  current: { generation: number; sessionFile?: string; admissionRevision?: number },
  currentRuntimeId: string | null,
): boolean {
  return marker.generation === current.generation
    && marker.sessionFile === current.sessionFile
    && (marker.admissionRevision ?? 0) === (current.admissionRevision ?? 0)
    && (currentRuntimeId === null || currentRuntimeId === marker.runtimeId)
}

/** Maximum events held for animation-frame replay before falling back to an authoritative transcript read. */
export const AGENT_EVENT_QUEUE_LIMIT = 50_000

/** Maximum events replayed per macrotask when draining a large queue on visibilitychange. */
export const AGENT_EVENT_FLUSH_CHUNK = 2_000

export function admitAgentEvent(
  generation: number,
  event: Record<string, unknown>,
  pendingLoad: TranscriptEventOwner | null,
  frameQueue: PendingAgentEvent[],
  queueLimit = AGENT_EVENT_QUEUE_LIMIT,
): 'transcript' | 'frame' | 'overflow' {
  if (pendingLoad?.generation === generation) {
    pendingLoad.eventBuffer.push(event)
    return 'transcript'
  }
  if (frameQueue.length >= queueLimit) return 'overflow'
  frameQueue.push({ generation, event })
  return 'frame'
}

export function eventsForWorkspace(queue: PendingAgentEvent[], generation: number): Record<string, unknown>[] {
  return queue.filter((entry) => entry.generation === generation).map((entry) => entry.event)
}
