# Final schedule reconciliation fix

## Root cause

The all-runtime schedule listing appended successful runtime records first and then appended the CLI fallback catalog. A last-write `Map` dedupe by job ID allowed an ownerless fallback duplicate to replace the runtime-owned record. The renderer could consequently fall back to the currently active runtime when cancelling instead of using the runtime that successfully reported the job. Runtime fan-out also appended into a shared array as requests completed, so duplicates returned by multiple runtimes had timing-dependent precedence.

## Resolution

- Each runtime response is normalized into its own catalog and `Promise.all` preserves the order from `agents.list()`.
- Catalog reconciliation is first-write by job ID: the first successful runtime catalog wins deterministically and retains its `runtimeId`.
- CLI fallback records are added only for IDs not supplied by a successful runtime, so they can fill failed or absent catalogs without erasing known ownership.
- A duplicate title with a distinct ID remains a distinct schedule; identity remains the schedule ID.
- Existing completeness behavior is unchanged: a failed runtime requires a complete, valid CLI recovery catalog or the list rejects with an explicit incomplete-catalog error. Fully successful empty runtime catalogs do not invoke fallback.

## Verification

- `npm test -- --run tests/backend/schedules.test.ts` — passed (4 tests).
- `npx tsc --noEmit -p tsconfig.node.json` — passed.
- `npm run typecheck` — node typecheck passed, but the renderer typecheck is currently blocked by unrelated concurrent changes in `src/hooks/useWorkspaceRuntime.ts` (`sessions.onChanged` is absent from the current bridge type and the callback binding is implicitly `any`).

The added regression test covers duplicate IDs across ordered runtime catalogs and CLI fallback, duplicate names on distinct IDs, preservation of runtime ownership, fallback-only fill behavior, and cancellation routed through the preserved owner runtime.
