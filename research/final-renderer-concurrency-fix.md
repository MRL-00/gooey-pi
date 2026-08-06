# Final renderer concurrency fix

## Scope

Completed the renderer remediation on `fix/audit-final-closure` while preserving the concurrent provider, session-I/O, schedule, E2E, release, and package changes in the shared worktree. The partially applied workspace/event work was reviewed, corrected, and covered with deterministic tests. No commit was created.

## Closure

### Sidebar and large catalogs

- App routes all Sidebar handlers through `useSidebarActions`, whose callback identities remain stable while dispatching to the latest render's actions. `Sidebar` therefore compares equal and skips transcript-only RAF renders without weakening its strict comparator.
- Sidebar session ownership is indexed in one pass and project rows remain capped at seven sessions.
- A 5,000-session deterministic test asserts exactly 5,000 session index scans and seven materialized rows for the project.

### Linear event-frame replay

- `replayPrimeEvents` now applies a whole RAF batch with one transcript scan/copy and linked part drafts, avoiding repeated message maps, tool index scans, and array shifts.
- Ordered behavior remains equivalent to sequential `applyPrimeEvent` for text/thinking deltas, anonymous and identified tools, partial/final results, turn boundaries, errors, and exits.
- Deterministic mixed-event permutations, a 2,000-message/1,000-delta scan-bound test, and 50 sustained 200-delta batches assert structural scan/copy and state-commit bounds rather than wall-clock timing.

### Bootstrap, workspace, and prompt ownership

- Projects and sessions settle and select/display the startup workspace before runtime discovery completes. Late runtime attachment requires the exact startup generation, cwd, and session file.
- Sidebar mounting and Cmd+N admission are held until bootstrap completes; new-session admission also requires an owned project.
- Initial and reconciliation transcript reads use one lifecycle. Prompt admission invalidates and replays an older reconciliation buffer, rejects its late authoritative result, and gates terminal events from the prior turn until the admitted turn starts.

### Scoped asynchronous UI state

- Plugin list ownership lives in the small `usePluginSkills` hook. A monotonic guard validates request ID, workspace generation, and global/project path for automatic loads and manual refreshes; stale success, error, and loading completions are ignored.
- Extension UI requests are retained independently per runtime. Background requests are not shown in the active workspace and are surfaced when their runtime becomes active; replacement, timeout, response, and exit cleanup remain runtime-scoped.
- Authoritative settings saves and the latest queued rollback reconcile the full settings value into all standalone sidebar/inspector/terminal panel states.

### Startup bundle

- `Transcript` is dynamically imported behind Suspense. The production build emits separate `Transcript-*.js` and `markdown-vendor-*.js` chunks; `out/renderer/index.html` preloads React and icons only, not markdown.
- `src/App.tsx` is 367 lines, below the 400-line ceiling. New hooks are focused (`usePluginSkills`: 44 lines; `useSidebarActions`: 45 lines).

## Deterministic coverage added

- `tests/frontend/streaming-performance.test.ts`
  - stable Sidebar callback dispatch and 5,000-session row/index bounds
  - event equivalence, deterministic mixed permutations, transcript scan bounds, and sustained frame commit bounds
  - scoped request and background runtime queue invariants
- `tests/frontend/renderer-concurrency.test.tsx`
  - queued settings failure restoring every panel state
  - same-runtime stale reconciliation rejection after prompt admission
  - workspace selection before delayed runtime discovery
  - background extension UI surfaced on runtime activation
  - stale global/project/plugin refresh completion rejection across generations and paths

## Validation

Final validation in `/private/tmp/prime-audit-verify`:

- `npm run typecheck` — passed.
- `npm test` — passed: 30 files, 164 tests.
- `npm run build` — passed for main, preload, and renderer bundles.
- `git diff --check` — passed.

No commit was created.
