# Final renderer performance and startup closure

## Scope

Closed the residual CFR-05/CFR-09 renderer findings in `App`, renderer hooks, Sidebar wiring, and Prime event reduction. The work also incorporates the final-quality follow-ups for bootstrap ownership, transcript reconciliation admission, scoped plugin reads, background extension UI, settings rollback, and Transcript code splitting.

## Changes

### Sidebar render isolation

- Added a stable action proxy (`useSidebarActions`) whose callback identities live for the App instance while calls dispatch through the latest render's actions.
- Kept `areSidebarPropsEqual` strict: handler changes still invalidate arbitrary callers, so there are no stale-closure exceptions in the comparator.
- App now passes only stable callback props to Sidebar. A transcript-only App update therefore compares equal and skips the Sidebar root render.
- Added deterministic tests which verify all callback identities are retained and the newest action implementation is invoked.

### Linear Prime-event frame batches

- Replaced per-event transcript reduction in RAF flushes with `replayPrimeEvents`.
- The batch reducer scans the transcript once, copies the transcript at most once, lazily drafts each affected message once, and represents drafted parts as an indexed linked sequence. This gives `O(messages + parts + deltas)` batch behavior without repeated full transcript or tool-part scans.
- Event order, text/thinking coalescing, first-ID tool upserts, partial/final tool-result placement, terminal finalization, errors, and runtime exits remain equivalent to ordered `applyPrimeEvent` replay.
- Added equivalence, ordering, bounded scan/copy instrumentation, large transcript/delta, and sustained-frame tests.

### Progressive bootstrap and workspace ownership

- Projects and sessions now settle together, are applied together, and establish the startup workspace before `initialized` becomes true.
- Sidebar is not mounted and Cmd+N is ignored until that ownership exists.
- Runtime discovery is no longer on the startup critical path. Runtime/session ownership metadata is merged later, and a runtime attaches only when generation, cwd, and session file still match the selected startup workspace.
- Startup failures are still reported independently and successful project/session results remain usable.

### Transcript lifecycle and prompt admission

- Consolidated duplicate initial/reconciliation transcript-read completion paths into `startTranscriptRead`.
- A same-runtime prompt admission now invalidates/replays any older reconciliation buffer and gates terminal reconciliation from the older turn until the new turn starts.
- RAF event flushes use the linear batch reducer while retaining generation and transcript-load event ownership.

### Remaining renderer ownership fixes

- Plugin lists moved to `usePluginSkills`, using one monotonic request guard across request ID, workspace generation, and project path; stale global/project results and stale loading/error completions are ignored.
- Extension UI requests are queued independently by runtime. Background requests are retained and surfaced only when their runtime becomes active; replacement/timeout/exit cleanup remains runtime-scoped.
- Authoritative settings saves and latest rollback failures now reconcile all standalone panel states, not only the patch that happened to finish last.
- `Transcript` is dynamically imported with a Suspense boundary. The production build emits separate Transcript and markdown chunks and does not preload markdown from the App entry.
- Removed the dead renderer session-change subscription that was not part of the narrow preload API; transcript refresh remains driven by authoritative runtime reconciliation.

## Validation

Executed after the final edits:

- `npm run typecheck` — passed.
- `npm test` — 29 files, 157 tests passed.
- `npm run build` — passed (main, preload, and renderer production bundles).
- Renderer output includes separate `Transcript-*.js` and `markdown-vendor-*.js` chunks.

No commit was created.
