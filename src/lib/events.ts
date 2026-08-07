/**
 * Thin re-export so existing imports keep working. The implementation lives in
 * `events/parse.ts` (record coercion), `events/compaction.ts` (compaction
 * policy), `events/reduce.ts` (the reducer), and `events/ids.ts` (message ids).
 */
export {
  applyPrimeEvent,
  createPrimeEventBuffer,
  replayPrimeEvents,
  type PrimeEventBuffer,
  type PrimeEventReplayStats,
} from './events/reduce'
export { resetPrimeEventMessageIds } from './events/ids'
