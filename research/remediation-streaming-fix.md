# Streaming performance remediation

## Verdict: ACCEPTED

The blockers in `remediation-streaming-final-review.md` are remediated in the current uncommitted patch.

## Remediation

- **Transcript read / RAF ownership:** live events now have exactly one owner. `admitAgentEvent` sends an event to the active transcript load buffer or the frame queue, never both. Workspace activation creates the transcript buffer synchronously, closing the pre-effect admission gap. Read success replays the ordered buffer over disk state; read failure replays it over current renderer state before reporting the failure. Frame flushes remain generation-filtered, and workspace activation clears and cancels the old queue.
- **Sidebar memo safety:** indexed session grouping is retained. The memo comparator now compares every data and callback prop, so a replacement handler is never hidden by memoization.
- **Activity batching:** filter, query, and the visible limit now share one state transition. Criteria updates reset the cap to 250 in the same render, while “show more” grows by bounded 250-row batches.

## Regression coverage

`tests/frontend/streaming-performance.test.ts` deterministically covers:

1. transcript read before the simulated RAF flush, with each delta applied once;
2. simulated RAF flush before transcript read, with each delta applied once and in arrival order;
3. rejection of an old workspace generation while preserving current-generation frame order;
4. identical Sidebar data props plus a replacement handler, invoking only the new handler;
5. Activity batch growth, final partial batches, and atomic query/filter resets.

The Vitest config now resolves the renderer `@` alias so focused tests can import the owned renderer modules directly.

## Validation

- `npm run typecheck` — **PASS**
- `npx vitest run tests/frontend/streaming-performance.test.ts tests/backend/events.test.ts tests/frontend/runtime-state.test.ts` — **PASS** (3 files, 12 tests)

No commit was created.
