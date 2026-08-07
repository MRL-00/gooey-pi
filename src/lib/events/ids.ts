/**
 * Monotonic message ids for reducer-created transcript messages. A module
 * counter keeps ids stable and unique even when several messages are created
 * within one millisecond (Date.now()-based ids collided and made React merge
 * distinct messages under one key).
 */

let sequence = 0

export function nextEventMessageId(prefix: 'assistant' | 'stream' | 'error' | 'compaction'): string {
  sequence += 1
  return `${prefix}-${sequence}`
}

/** Test-only determinism hook: makes independent replays produce identical ids. */
export function resetPrimeEventMessageIds(): void {
  sequence = 0
}
