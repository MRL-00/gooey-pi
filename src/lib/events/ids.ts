import type { MessagePart } from '@/types/api'

/**
 * Monotonic transcript identity for reducer-created messages and parts. A
 * module counter keeps ids stable and unique even when several are minted
 * within one millisecond (Date.now()-based ids collided and made React merge
 * distinct messages under one key).
 */
let transcriptIdSeq = 0
export function nextTranscriptId(prefix: string): string {
  transcriptIdSeq += 1
  return `${prefix}-${transcriptIdSeq}`
}

/** Test-only: restarts generated ids so replays are deterministic. */
export function resetTranscriptIdsForTests(): void { transcriptIdSeq = 0 }

// Every part minted by the reducers gets a stable identity at insertion time
// so the timeline can key on it: tool results are spliced into the middle of
// streaming part lists, and index keys detach expanded panels mid-stream.
export function withPartId<Part extends MessagePart>(part: Part): Part {
  return { ...part, partId: nextTranscriptId('part') }
}
