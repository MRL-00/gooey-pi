# Prime Work — Remediation Plan

Source: full six-pass codebase review (2026-08-06). This plan covers every finding judged a genuine problem, a real performance issue, or meaningful tech debt. Findings deliberately excluded (with reasons) are listed at the end. Phases are ordered by risk: each phase leaves the tree green (`npm run typecheck && npm run check && npm test`) and each fix lands with its regression test in the same commit.

Conventions used below:
- **Fix** — the intended change, specific enough to implement without re-deriving it.
- **Test** — the regression test that must land with the fix.
- **Done when** — acceptance criteria.

---

## Phase 1 — Stop-the-bleeding criticals

### 1.1 Repair Windows/Linux packaging (4 bugs, one workstream)

**Problem:** No non-mac artifact can currently be produced. Four independent breaks.

**Fixes:**
1. `scripts/release/after-pack.cjs:5-8` — compute the executable per platform:
   - win32: `join(appOutDir, `${productFilename}.exe`)`
   - linux: `join(appOutDir, packager.appInfo.sanitizedName.toLowerCase())` (matches app-builder-lib's linuxPackager)
   - darwin: unchanged.
2. `package.json` `build.win.asarUnpack` — change every `node_modules/node-pty/prebuilds/win32/${arch}/...` to `node_modules/node-pty/prebuilds/win32-${arch}/...` (hyphenated, no nesting). Verify against `node-pty/lib/utils.js` (`prebuilds/${platform}-${arch}`).
3. `scripts/release/verify-cross-platform-package.mjs:53-62` — mirror the corrected node-pty paths; map platform `win` → directory `win32` when building the ZeroMQ regex (package.json:122 already uses `win32`; make the verifier agree). Collapse the dead ternary at line 63 while in the file.
4. `scripts/release/install-app-deps.mjs:7-8` — on win32, either resolve the real `electron-builder` JS entry and spawn `process.execPath` against it, or spawn with `shell: true` and properly quoted args. Prefer the execPath approach (no shell quoting risk).
5. `scripts/release/package.mjs:32-38` — same treatment for the bare `npm` spawns: use `process.platform === 'win32' ? 'npm.cmd' : 'npm'` with `shell: false` is rejected by Node for .cmd — so route through `shell: true` with a fixed, non-interpolated command string, or spawn `process.execPath` on npm's cli.js. Pick one strategy and use it in both scripts (DRY: put a `runCommand()` helper in `scripts/release/lib.mjs`).

**Test:** extend `tests/release-scripts.test.ts` to (a) assert the afterPack path math per platform against fixture contexts, (b) assert the unpack globs in package.json match at least one real file in `node_modules` per platform where present, (c) assert verifier regex and package.json globs agree on directory naming.

**Done when:** `npm run package:linux:local-qa` succeeds locally in CI (see 1.4); win path verified by the new unit tests plus the CI matrix job.

### 1.2 Crash-proof child stdio handling

**Problem:** No `'error'` listener on child stdout/stderr (`electron/main/agent-rpc/transport.ts:20-31`, `electron/main/process-utils.ts:215-216`); no `uncaughtException` handler exists. A SIGKILLed agent's `EPIPE`/`ECONNRESET` kills the entire app.

**Fixes:**
1. `transport.ts` — attach `'error'` handlers to `child.stdout` and `child.stderr` that route into the existing `failTransport` path (same as stdin does at `runtime.ts:50`).
2. `process-utils.ts` — attach `'error'` handlers on both pipes of every `runProcess` child that record the error and let the existing `close` handling settle the promise (guard against double-settle).
3. `electron/main/index.ts` — add a last-resort `process.on('uncaughtException')` + `process.on('unhandledRejection')` that logs (path under userData) and, for uncaughtException, attempts `stopChildProcesses()` before exiting non-zero. This is a backstop, not a swallow — still exits.

**Test:** new cases in `tests/backend/agent-rpc.test.ts` and `tests/backend/process-utils.test.ts`: emit `'error'` on a fake child's stdout after spawn; assert the runtime fails cleanly / the runProcess promise rejects, and the process does not get an uncaught exception (install a temporary `uncaughtException` spy).

**Done when:** killing a fake agent mid-stream in tests produces a failed runtime, not a crashed test process.

### 1.3 Fix the modal keydown guard (clipboard in modals)

**Problem:** `src/App.tsx:350` suppresses **all** Cmd/Ctrl keydowns when a `.modal` is open — paste/copy/cut/undo broken in every modal input; CommandPalette isn't covered at all.

**Fix:** Invert the logic. The guard's job is "don't fire *app shortcuts* while a modal is open" — so move the modal check into each shortcut branch instead of pre-empting all Cmd/Ctrl keys: compute `const modalOpen = ...` once, and `return` (without `preventDefault`) before the app-shortcut `switch` when `modalOpen`. Never `preventDefault` a key combination the app doesn't own. Include `.command-palette` in the same "overlay open" check so ⌘K/⌘N etc. behave consistently.

**Test:** jsdom test dispatching `keydown` (metaKey + 'v') with a modal in the DOM; assert `defaultPrevented === false`. Companion case: app shortcut (metaKey + 'n') with modal open does not fire `newSession`.

**Done when:** paste works in the provider key field; shortcuts remain suppressed behind modals.

### 1.4 Make CI catch all of the above

**Problem:** `ci.yml:48` gates packaging behind `workflow_dispatch`; that is why Phase 1.1's bugs shipped to main.

**Fix:** add a `packaging-smoke` job to `ci.yml` on pull_request: matrix `{macos-14, ubuntu-22.04, windows-2022}`, running `npm ci` + `node scripts/release/package.mjs --qa --platform <p>` (or, if runtime cost is a concern, at minimum `electron-builder --dir` + `verify-cross-platform-package.mjs` against the unpacked dir). Add `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }` and branch-filter `on: push` to `main` while in the file (M39).

**Done when:** a PR that reintroduces any 1.1 bug fails CI.

---

## Phase 2 — High-severity correctness

### 2.1 Optimistic message loss on background transcript reads

**Problem:** `src/hooks/useWorkspaceRuntime.ts:187,240-284` — non-reconciliation background reads replace `messages` wholesale and aren't cancelled by `prepareForPrompt`; composer stays enabled during them; the user's just-sent bubble vanishes.

**Fix:** make `prepareForPrompt` cancel/supersede **all** pending transcript loads, not just `reconciliation === true` ones; and make the external-sync read path reconcile (merge by message id / event replay on top of current state) instead of absolute replacement. If a load is superseded by a prompt, re-arm a reconciliation read after `agent_start` (the existing reconciliation machinery already does this).

**Test:** `tests/frontend/transcript-reconciliation.test.ts`: start a background read, send a prompt before it resolves, resolve the read; assert the optimistic user message survives.

### 2.2 RPC timeout leaves the command queued (double-execution)

**Problem:** `electron/main/agent-rpc/runtime.ts:178-197` + `transport.ts:35-55` — timed-out requests stay in the write queue; the agent can execute a prompt the UI reported as failed; retry runs it twice. Stalled writes pin the 32 MB queue budget.

**Fix:** give `FramedRpcTransport.enqueue` cancellation: return a handle (or accept an AbortSignal); on request timeout, remove the line from `writeQueue` if not yet written and decrement `queuedWriteBytes`. If it *was* already flushed to the child, keep the pending entry in a "zombie" set so a late response is logged as consumed rather than `orphan_response`, and surface a distinct error to the caller ("delivery uncertain — do not auto-retry") so the UI can warn instead of blind-retrying. Add a per-write deadline in the transport so a child that stops reading stdin fails the transport rather than pinning the budget forever.

**Test:** `tests/backend/agent-rpc.test.ts`: (a) timeout before flush → line never reaches child stdin, budget released; (b) timeout after flush → caller gets the delivery-uncertain error; (c) child stops reading → transport fails within the deadline.

### 2.3 Catalog refresh clobbers live session state

**Problem:** `src/hooks/useBootstrap.ts:33-45` — `mergeSessionCatalog` keeps only `unread`/`syncRevision`; live `status: 'waiting'`, renderer-only `eventRevision`, and optimistic `lastUserMessageAt` are lost ~200 ms after being set.

**Fix:** in the merge, prefer live-event fields when they are strictly newer: carry over `eventRevision` always (it is renderer-only), keep `status: 'waiting'` while an extension-UI request is open for that session (consult the pending-request map), and keep `lastUserMessageAt` if greater than the disk value. Also stop assigning a new `catalogRevision` to *every* session on any catalog change (`useBootstrap.ts:38`) — only bump sessions whose record actually changed (compare mtime/size fields already present).

**Test:** `tests/frontend/session-attention.test.ts`: set waiting via `extension_ui_request`, run a catalog merge, assert the badge/signature still reports waiting.

### 2.4 Reducer divergence on compaction (and the dual-reducer debt)

**Problem:** `src/lib/events.ts:323-325` vs `:423-427` — batched path gates `agent_start` on any streaming message; sequential path on a streaming assistant. Divergence is invisible because the equivalence test excludes compaction events.

**Fix (two steps):**
1. Immediate: make the batched gate identical to the sequential one (check the streaming message's role), and handle a carried-over streaming compaction from a previous batch.
2. Structural (Phase 5.1): eliminate the second implementation entirely.

**Test:** add compaction events (`compaction_start`/`compaction_end`) to the permutation pool in `tests/frontend/streaming-performance.test.ts:256-277`; add the specific two-batch scenario (batch A: compaction_start; batch B: agent_start) asserting both reducers produce identical output.

### 2.5 Torn project-authorization map

**Problem:** `electron/main/projects.ts:92-110` — `authorizedRoots` is cleared then repopulated across awaits (git spawns per project); concurrent `git:status`/`terminal:create`/`agent:start` intermittently fail.

**Fix:** build a **new** Map fully, then swap: `const next = new Map(); ...populate...; this.authorizedRoots = next;`. Keep the old map serving reads until the swap. Bump `authorizationRevision` on swap. Additionally, don't hold repopulation hostage to `branchProvider` — resolve authorization entries first (cheap identity checks), swap, then enrich branch info afterward.

**Test:** `tests/backend/projects.test.ts`: interleave a `list()` (with a slow fake branchProvider) and an `authorizedRootFor` lookup; assert the lookup never fails during the refresh.

### 2.6 `removalRoots` never released / removal failure leaks

**Problem:** `projects.ts:236-240` — deny-list entries persist forever; nested projects permanently blocked; a throw mid-removal leaves the project inert but listed.

**Fix:** wrap removal in try/finally that deletes the roots from `removalRoots` once the store update settles (success **or** failure); on success the authoritative block is "not in authorizedRoots" anyway. Fix the nested-project case by matching removal roots exactly (or excluding paths that are themselves still-registered project roots) rather than `isPathWithin` alone.

**Test:** `tests/backend/project-removal.test.ts`: (a) remove parent, assert nested registered project still authorized; (b) force `store.update` to throw, assert roots are released and the project still works.

### 2.7 `plugins:refresh` authorization bypass + unbounded reveal set

**Problem:** `electron/main/plugins.ts:138` skips `authorizeProject`; `knownPathsByOwner` (`plugins.ts:51,89`) grows forever and keeps revoked projects' paths revealable (contradicts docs/security.md:10).

**Fix:** (a) `refresh()` must call `this.authorizeProject(this.lastProjectPath)` and clear `lastProjectPath` when its project is removed; (b) key eviction: on project removal, delete `knownPathsByOwner.get('project:<path>')`; (c) cap per-owner sets (e.g. 4,096 paths) and total owners (e.g. 64, LRU).

**Test:** `tests/backend/plugins.test.ts`: list plugins for P, remove P, call refresh → throws authorization error; `authorizeReveal` on a P path → false.

### 2.8 Index-as-key in the timeline

**Problem:** `src/components/transcript/timeline.tsx:168-182` — reasoning/text/compaction/standalone-result parts keyed by index while tool results are spliced mid-array; expanded panels jump/collapse mid-stream.

**Fix:** give every part a stable id at creation time in the reducers (`events.ts` — parts already get ids for tool calls; extend to reasoning/text/compaction/result parts using a per-message monotonic counter, **not** `Date.now()`), and key on `part.id` everywhere. This co-lands with 2.9.

**Test:** rendering test: stream toolCall → text → toolResult insertion; assert the expanded reasoning panel (data-testid) stays attached to the same content.

### 2.9 `Date.now()` message-id collisions

**Problem:** `events.ts:165,284,383,391,426,472` — two messages created in the same millisecond share a React key; the transcript reconciles them into one.

**Fix:** replace with a module-level monotonic counter (`assistant-${++seq}`) or `crypto.randomUUID()`; counter preferred (deterministic for tests). Also add the missing consecutive-system-message guard at the `error`/`transport_error` branch (line 379-385) to match `runtime_exit`.

**Test:** replay a single batch containing `agent_start, delta, agent_end, agent_start`; assert two distinct message ids.

### 2.10 Session/runtime path canonicalization mismatch

**Problem:** `sessions.ts:230-236` (realpath) vs `agent-rpc/manager.ts:101,108,123` (resolve) — symlinked `~/.prime` detaches runtimes from sessions: sessions never show running, `archive()` doesn't stop the live agent.

**Fix:** canonicalize once at the boundary: when a runtime reports `sessionFile`, realpath it (cache the result on the runtime info; refresh on rename events). All comparisons then use canonical paths. Extract a shared `canonicalSessionPath()` helper used by both modules.

**Test:** `tests/backend/sessions.test.ts`: run the runtime-overlay case with the session root reached via a symlink; assert `list()` marks it running and `archive()` stops it.

---

## Phase 3 — The streaming performance loop

These land together as one workstream; they are one system. Target: during active streaming of a 10 MB transcript with 5,000 sessions on disk, the main process does **no full re-parse** and **no subprocess spawn** per append tick, and the renderer re-renders only the affected message.

### 3.1 Stop nuking the catalog cache on every append
`electron/main/sessions.ts:295-308` + `sessions/catalog.ts:83-86,172-210`.
**Fix:** split invalidation: a file-change event for session X should (a) invalidate only X's metadata cache entry, (b) mark the catalog list "stale" but let the existing 2 s `expiresAt` window serve reads — i.e. invalidate *content*, not the spawn-throttle. The `prime-agent list --all --json` spawn must be rate-limited independently of change events (min interval ≥ 2 s during bursts).

### 3.2 Incremental metadata reads
`catalog.ts:124` — cache key `path\0mtime\0size` forces full re-read per append.
**Fix:** cache `{ size, metadata, tailState }`; when a change arrives and `newSize > oldSize`, read only `[oldSize, newSize)`, feed through the JSONL decoder's retained partial-line state, and fold new records into the cached metadata (updatedAt, message counts, last message). Full re-read only on truncation (`newSize < oldSize`) or checksum mismatch of the retained partial line.

### 3.3 Cache canonicalization/stat in `scan()`
`catalog.ts:118-126`.
**Fix:** keep a `Map<name, {canonical, dev, ino, mtimeMs}>`; re-canonicalize only entries whose stat changed; drop entries for names that disappear.

### 3.4 Hoist runtime snapshots out of `SessionService.list()`
`sessions.ts:108` → `manager.ts:97-102`.
**Fix:** snapshot runtimes **once** per `list()` call (`manager.list()` → build `Map<canonicalSessionFile, snapshot>`), then O(1) lookup per session. Remove `structuredClone` from `snapshot()` for this path — return a frozen shallow copy; IPC will clone anyway (also fixes the double-clone at `sessions.ts:125,133`).

### 3.5 Renderer: reconcile instead of replace; drop the git-status-per-tick
`useWorkspaceRuntime.ts:258-284`, `useBootstrap.ts:147-172`, `App.tsx:114-116`.
**Fix:** (a) external-sync reads go through the same reconciliation path as 2.1 (merge by id) so unchanged messages keep identity and don't re-render; (b) `refreshGit` triggers on `agent_end`/`turn_end` and project switch, **not** on every catalog tick — remove it from the sessions-changed dependency chain; (c) per-session `syncRevision` only bumps when that session's file actually changed (see 2.3).

### 3.6 Composer/provider-list render cost
`src/components/Composer.tsx:257-266`, `App.tsx:383`, `useProviderCatalog.ts:69-74`.
**Fix:** group models by provider **once** in `useProviderCatalog` (memoized `Map<providerId, Model[]>`), memoize the `<option>` tree on `[models, providers, disabled set]`, wrap `Composer` in `memo`, and give `reasoningLevels` a module-level `EMPTY_LEVELS` constant fallback. Stabilize the arrays passed from `App.tsx:383` (memoize on catalog identity).

### 3.7 SummaryPanel and markdown parse cost
`src/components/inspector/SummaryPanel.tsx:6-7`, `MarkdownText.tsx:34-35`.
**Fix:** SummaryPanel: replace reduce/reverse/flatMap with a single reverse for-loop that stops at the first text part; memoize on `[messages]` — and since messages now keep identity for unchanged entries (3.5), pass the *last message* only where possible. Markdown: throttle re-parse of the actively streaming message (parse at most every ~100 ms or on newline boundaries), render the raw tail as plain text between parses; non-streaming messages keep the existing memo-by-text.

### 3.8 Timeline O(n²) and transcript assembly O(n²)
`src/lib/events.ts:188,272-278` renderer-side is fine at current sizes once keys are stable (2.8), but `electron/main/sessions/transcript.ts:311-315` needs a `Map<toolCallId, partIndex>` per assistant turn to kill the `findIndex` scan.

**Tests for Phase 3:** extend `tests/frontend/streaming-performance.test.ts` with render-count assertions (unchanged messages don't re-render across a sync tick); add a backend test asserting: N change events within 2 s cause ≤1 CLI spawn and only incremental reads (spy on fs open offsets).

---

## Phase 4 — Medium-severity fixes

### Electron surface
- **4.1** `index.ts:89-99` — in `will-attach-webview`, force `webviewTag: false` in the overridden preferences (add to the forced-prefs list). One-line fix closes the nested-guest escape. Test: assert the handler output prefs.
- **4.2** `index.ts:107-110` — add `will-redirect` and `will-frame-navigate` guards on the main window using the same trusted-URL predicate as `will-navigate`; extract the triplicated trust predicate (`ipc.ts:156-162`, `index.ts:272-274,280-282`) into one helper while there.
- **4.3** `ipc.ts:74-86` — replace the nested try/catch fallback in `app:reveal-path` with sequential guarded checks that `console.warn` on unexpected errors (match the `on()` path at line 64).
- **4.4** `browser-downloads.ts:29-53` — charge `windowBytes` with the declared `totalBytes` at admission (refund the delta as actuals arrive); admission check then holds under concurrency.
- **4.5** `store.ts` — (a) cap `archivedSessions` (5,000) and `dismissedProjectPaths` (1,024) at load and write, matching `disabledProviders`; (b) add narrow accessors (`getSettings()`, `getProjects()`) that clone only their slice, and migrate the four hot callers off full `snapshot()`; (c) guard startup load with a size check (reject > 64 MB with a clear error and a `.corrupt` rename) before `JSON.parse`.

### Session/process lifecycle
- **4.6** win32 process-tree kill (`runtime.ts:135-140`, `process-utils.ts:33-38`, `terminal.ts:53-54,225-228`): implement a win32 branch using `taskkill /pid <pid> /T /F` (spawned, awaited, bounded). Lands inside the Phase 5.2 `killProcessTree` extraction — do them together.
- **4.7** `transcript.ts:168-174` — decrement `textBudget` in the compaction branch like every sibling.
- **4.8** `transcript.ts:204,215-228` — only admit renderable record types (`message`, `compaction`, displayed `custom_message`) into `entries`/budgets; keep a light id→parentId edge map for *all* records so the parent-chain walk still traverses through non-renderable nodes.
- **4.9** `transcript.ts:213,222-230` — choose `leafId` as the last **renderable** record; if the walk dead-ends, fall back to the previous renderable record instead of rendering empty.
- **4.10** `agent-rpc/events.ts:37-41` — exempt `runtime_exit` from the rate cap (always deliver, once).
- **4.11** `sessions.ts:183-192` — route `followUp` candidate resolution through the catalog's `mapLimit` canonicalization (reuse `liveCatalog` data instead of serial realpaths).
- **4.12** `terminal.ts:224-233` — short-circuit `terminateProcess` when the pty already reported exit; re-snapshot (or verify start-time where available) before the SIGKILL rung to narrow the PID-reuse window; run per-terminal `ps` concurrently in `killAll`.
- **4.13** `manager.ts:54-61` — `this.runtimes.delete(runtime.runtimeId)` explicitly on failed start.
- **4.14** `jsonl.ts:14,21` — account bytes from the **encoded** input chunks (count consumed buffer bytes) rather than re-measuring decoded strings.

### Renderer state/UI
- **4.15** `agent-events.ts:73` / `useWorkspaceRuntime.ts:83-89` — bound the frame queue (e.g. 50k events): past the bound, coalesce by falling back to a "reconcile on next visible" flag (a fresh transcript read replaces replay). Flush on `visibilitychange` in chunks (e.g. 2k events per macrotask) to avoid the single giant synchronous replay.
- **4.16** `useWorkspaceRuntime.ts:72-89` — `flushAgentEvents` must `cancelAnimationFrame(agentEventFrameRef.current)` before nulling it.
- **4.17** `useAgentEvents.ts:80` — store the timer id, clear in effect cleanup, and coalesce (one pending refresh, not stacking).
- **4.18** `useBootstrap.ts:70-73` — merge into `runtimeSessionsRef.current` (only add/update entries from `agent.list()`; keep entries learned from live events).
- **4.19** `App.tsx:348-361` — rewrite the keydown effect with `useStableCallback` (exists in-repo) and a `[]` dep array. (Co-lands with 1.3.)
- **4.20** `ui.tsx:131-136` + `CommandPalette.tsx:28` — module-level overlay refcount: increment on mount, decrement on unmount, set `inert`/`aria-hidden` only on 0↔1 transitions. CommandPalette uses the same helper.
- **4.21** `ExtensionUiModal.tsx:143-197` — stop `preventDefault`ing Tab (let focus reach the footer); bind question navigation to explicit keys (ctrl+arrow / PageUp/Down); don't hijack printable keys when `document.activeElement` is a button.
- **4.22** Error boundary: add a single `ErrorBoundary` component wrapping (a) the app root in `main.tsx` (full-window fallback with reload button) and (b) each transcript message row (per-message "failed to render" fallback so one bad part can't blank the app). Preserve composer draft in the boundary via sessionStorage.
- **4.23** `Composer.tsx:199` — don't disable the textarea while `submitting`; guard double-submit in the submit handler instead, and refocus after send resolves.

### Domain modules
- **4.24** `git.ts:310-312` — narrow the catch: authorization + filter-guard + timeout errors return `{ isRepo: true, files: [], error }` (repo exists, operation failed); only `not a git repository` detection returns `isRepo: false`. Update `ChangesPanel.tsx:94` to render the error state distinctly from the no-repo state.
- **4.25** `git.ts` spawn dedupe — per-call-graph context: `status()` resolves toplevel + config **once** and passes them down; `commitIdentityOverrides` parses the already-fetched `config --list` instead of 4 extra spawns. (Full guard extraction is Phase 5.5.)
- **4.26** `projects.ts:284-301` — wrap `readdir`/recursion per directory in try/catch: skip unreadable dirs (record a `skipped` count in the result) instead of failing the listing.
- **4.27** `providers.ts:98-152` — single-flight `catalog()`: store the in-flight promise, return it to concurrent callers, clear in `finally` (same shape as `sessions.ts:39`; after Phase 5.3 use the shared helper).
- **4.28** `providers.ts:286-291` — `abortFlow` clears `flow.timer`, deletes from `this.flows`, and `runOAuth`'s finally becomes idempotent. Cancel-then-retry must always be possible.
- **4.29** `settings-schedules.ts:63-81` — map `raw.status === 'failed'` → `failed` regardless of `lastError`; map unknown statuses → a new `unknown` status (render as such), never `completed`.
- **4.30** `settings-schedules.ts:111-122` — treat "unknown command"/ENOENT from the CLI fallback as "no schedules" (empty list + a non-fatal warning surfaced once), keep throwing on genuine failures; cache the negative result for the session.
- **4.31** `plugins/mcp.ts:293-331` — convert `prepareProjectSettingsPath` + `verify()` to async fs (`fs/promises`); the lock loop already awaits between attempts, so this removes every sync syscall from the main thread.
- **4.32** `plugins/catalog.ts:67-74` — on parse/read failure, return `{}` **plus** a structured warning in the discovery result that the UI surfaces ("settings.json invalid — plugins hidden"), matching `readSettingsForUpdate`'s strictness philosophy.

### CI/tooling
- **4.33** `ci.yml` — add `release:bundle-size` to the CI build job.
- **4.34** `scripts/release/biome.json` — enable the recommended preset; fix or explicitly (with comment) suppress what it flags. Expand `format:check` to `electron src tests scripts`. Add `tsconfig.tests.json` (or include tests/scripts/configs in the node project) so `typecheck` covers them.
- **4.35** Workflows: `node-version-file: .nvmrc` in all 6 places; cache `~/Library/Caches/electron` + `~/.cache/electron-builder`; `npm ci --ignore-scripts` for the quality job; drop the redundant re-verification in release jobs (CI already ran it — release runs packaging + package-verify only); `if-no-files-found: error` on all uploads; add a `needs:`-gated aggregate job for release; upload only installers in the QA matrix; upload `latest-*.yml` for linux/win.
- **4.36** ZeroMQ: exclude other platforms' `zeromq/build/<platform>` trees from the asar via `files` negative globs (~16 MB per artifact); replace the hardcoded `libc-115-Release` in `lib.mjs:138`/package.json:90 with a wildcard + "exactly one match" assertion in the verifier; declare `zeromq` as a direct dependency at the version prime-agent uses.
- **4.37** `verify-package.mjs:113` — wrap `hdiutil detach` in its own try/catch (log, don't mask); always attempt `rmSync`.
- **4.38** Supply chain: add a weekly `npm audit --omit dev` workflow (Dependabot can't parse the R2 URL specs); document the R2 pinning contract in `docs/security.md` (lockfile sha512 is the integrity boundary; `npm install` regenerating the lock is the risk). Longer term (decision item D3): mirror prime-agent tarballs into a registry or versioned immutable bucket.

---

## Phase 5 — Refactors (the debt behind the bugs)

Each refactor here directly retires a bug class from earlier phases; none are cosmetic.

- **5.1 Unify the dual event reducers** (`src/lib/events.ts`, 482 lines). Keep the linked-list draft implementation as the single reducer; implement the sequential API as a batch of one. Split the module: `events/parse.ts` (record coercion), `events/reduce.ts` (reducer), `events/compaction.ts` (policy). The permutation-equivalence test becomes a pure regression suite over one implementation. Retires the H10 divergence class permanently.
- **5.2 One `killProcessTree(pid, {ladder})`** in `process-utils.ts`, used by runtime, terminal, and one-shot paths; win32 branch via `taskkill /T` (4.6). Also merge the two exit-wait helpers.
- **5.3 Shared async utilities**: one `mapLimit`, one `singleFlight(keyed in-flight dedupe)`, one admission-queue primitive — replacing the three limiters and four hand-rolled dedupe caches (`sessions.ts:39`, `catalog.ts:69-73`, plus 4.27). One `comparePaths`.
- **5.4 One JSONL frame-limit policy**: a named constants module with documented tiers; metadata and transcript readers of the same file use the same per-record tolerance.
- **5.5 `withRepositoryGuards(cwd, paths?)`** in `git.ts`: resolves toplevel, fetches config once, runs `rejectFilteredPaths`, returns context for the operation. `commit` explicitly documents (or adopts) the reject call. Retires the five-way duplication and the M29 spawn overhead together with 4.25.
- **5.6 One `ProcessOutcome` result shape** for subprocess-backed operations (`git`, package-execution, mcp settings, schedules CLI): `{ ok, output, reason: 'timeout'|'overflow'|'exit'|'blocked' }`. Renderer call sites simplify accordingly.
- **5.7 `projects.ts` folder-verification helper**: extract the duplicated verify-and-authorize block from `list()`/`remove()`; have `captureFolderIdentity` reuse the `requireExistingDirectory` realpath instead of re-resolving (halves the syscalls).
- **5.8 App.tsx decomposition**: move the inline mutation handlers into a `useWorkspaceActions` hook (pattern already established by `useWorkspaceRuntime`/`useSidebarActions`), memoized; App drops to composition + layout. Required for the memoization work in 3.6 to hold.
- **5.9 Deletions**: `src/app/runtime-queue.ts` (adopt it in `useExtensionUi` **or** delete it — decide by which is smaller; the review suggests adoption since `useExtensionUi.ts:44-45` re-implements it), dead `isLast`/`git` props and duplicate `ChangesCard` in `messages.tsx` (keep the pinned one in `Transcript.tsx`), merge `ProvidersSettings`/`ProviderSettings` into one file, `.standalone-output` dead CSS + add the missing `.transcript-active-placeholder` rule, stray blank block `git.ts:190-192`, dead ternary in `verify-cross-platform-package.mjs:63` (done in 1.1), duplicate vitest coverage include, `bundledSkillsDirectory` un-export, dead `Math.min` in `agent-daemon.ts:58` (replace with an explicit equality assertion), `!!app.isPackaged` → `app.isPackaged`, shared CSP constant for `index.ts:57/305`.

---

## Phase 6 — Test coverage for the gate-keeping paths

Ordered by risk of the untested path, not by effort:

1. **`verify()` (ipc.ts:51-56)** — direct tests: sub-frame sender, destroyed sender, post-dispose call, unauthorized sender id, wrong URL. This is the renderer→main auth gate.
2. **`validation.ts`** — dedicated test file: `requireWebUrl` (schemes, credentials, mailto), `requireGitPath` (incl. the backslash fix below), `requireExistingPath`/`isPathWithin` (traversal, symlinks).
3. **`strictJsonLines`** — invalid UTF-8, unterminated final line, oversized record, early-abort fd cleanup, partial-line resume (needed by 3.2 anyway).
4. **`app:open-external` / `app:reveal-path`** — assert on the `shell` mocks: allowed, denied, and error paths.
5. **Transcript graph** — eviction, broken-parent fallback (4.8/4.9), multi-compaction text budget (4.7), trailing `parentId: null`.
6. **Terminal termination** — short-circuit when exited (4.12); win32 branch unit-tested against a fake `taskkill`.
7. **`runtime_exit` exemption** (4.10) under a saturated limiter.
8. Replace the brittle `secrets\.` count assertions in `tests/release-scripts.test.ts:116-117` with structural checks (parse YAML; assert secrets appear only under the two signing steps); extend the action-pinning check to non-`actions/*` owners.

---

## Phase 7 — Low-severity sweep

Small, safe, batched into one or two commits at the end (each still with a test where behavior changes):

`requireGitPath` split on `/[\\/]/` · `projects.ts:294` only rewrite separators on win32 · diff-cap off-by-one (`git.ts:138-155`) · sort-before-slice + overflow warning (`providers.ts:115`) · containment root for user-scope configured paths (`catalog.ts:258-260`) · reject discovery waiters on shutdown (`plugins.ts:18-38`) · symmetric `removeListener` handling in `ipc.on()` + idempotence guard on `registerIpc` · `mailto:` credential check parity (`validation.ts:68-78`) · store load size guard (in 4.5) · `drainProcessQueue` try/catch around `pending.start()` · shutdown: replace `void Promise.all` with awaited + 10 s watchdog + logged rejections (`index.ts:341`) · explicit `part.type === 'image'` check (`transcript.ts:175-182`) · drop renderer-side pre-clone (`sessions.ts:125,133`, done in 3.4) · phantom tool row for id-less `tool_execution_end` (synthesize a stable fallback id from index) · toast timer cleanup (`App.tsx:57`) · ⌘,/Ctrl+, parity (`App.tsx:357`) · Sidebar attention store: validate parsed shape, prune ids absent from the catalog, skip the redundant first write · TerminalDrawer catch honors `cancelled` · caret-aware insert in Composer (`setRangeText`) · cancel rAF in `transcript/scroll.ts` cleanup · `EMPTY_LEVELS` constant + serviceTier-scoped effect (`useProviderCatalog.ts:69,105`) · render-bounds trailing-newline off-by-one · BrowserPanel annotations: wire into the prompt context or remove the affordance (decision D4) · `pathToFileURL` + fail-closed entrypoint guard (`verify-package.mjs:135`) · `--dry-run` prints "DRY RUN — nothing executed" · untrack `.prime-gui.log` and `.superdesign/` (keep `tmp` rule), anchor `.gitignore` dirs (`/out/` etc.) · ref-writes-during-render (`useStableCallback` et al.) → `useLayoutEffect` assignment · `useWorkspaceRuntime.ts:284` prune phantom deps; add recovery path for the orphaned `transcriptLoad` early-return (`:272`) · `promptAdmissionGenerationRef` cleared on `transport_error`/`runtime_exit` too (`:213`).

---

## Decisions required (not blocking Phases 1–7)

- **D1. Release architecture matrix** — RESOLVED (2026-08-07): ship separate mac arm64 and x64 DMGs (no universal binary — user declined doubling the binary size). Implemented via a mac packaging matrix (arm64 on macos-14, x64 on macos-13).
- **D2. Windows code signing** — RESOLVED (2026-08-07): no cert purchase; builds stay unsigned. The fuse/arch verification hardening landed in Phase 4 regardless. Label artifacts as unsigned in release notes.
- **D3. Dependency hosting** — DECIDED DIRECTION (2026-08-07): keep R2, but (a) front the bucket with a custom domain (`pub-*.r2.dev` is a rate-limited dev endpoint), (b) treat every released version path as immutable — never overwrite `/releases/vX.Y.Z/*`, (c) never casually regenerate the lockfile (its sha512 pins are the integrity boundary). IMPLEMENTED in-repo (2026-08-07): `scripts/release/dependency-pins.json` + a guard test make lockfile re-anchoring of the five non-registry packages a loud, reviewed failure; docs/security.md records the immutability and custom-domain rules. REMAINING (needs the bucket's Cloudflare account, which is not the one wrangler here is logged into): attach the custom domain in that account's dashboard, then update the `package.json` URLs + lockfile + pin file together. 4.38's weekly audit workflow covers CVE monitoring.
- **D4. BrowserPanel annotations** — RESOLVED (2026-08-07): build the feature out. Spec: annotation mode highlights DOM elements on hover in the embedded browser; click selects an element; user comments on it; captured element info (selector, tag, text snippet, rect) + comment auto-attach to the chat composer as an attachment and are serialized into the prompt on send; up to 20 annotations at a time, individually deletable.

## Explicitly not planned (accepted as-is)

- **TOCTOU realpath-then-use windows** (M4): requires local write access to project dirs; the dev/ino identity checks cover the persistent-grant case. Cost of fixing (fd-based verification everywhere) exceeds the residual risk. Revisit if threat model changes.
- **`will-navigate` current-URL comparison** (M2's dev-mode redirect vector): fixed indirectly by adding `will-redirect` guards (4.2); the dev-server-compromise scenario is out of scope beyond that.
- **`detached: true` orphan reaper** (survives main-process SIGKILL): a PID-file reaper adds real complexity; graceful paths are covered. Documented limitation.
- **`research/` and `fixes.md` tracked in repo**: documentation judgment call, not debt.

## Sequencing summary

| Phase | Content | Depends on |
|---|---|---|
| 1 | Packaging repair, stdio crash, modal clipboard, CI packaging smoke | — |
| 2 | 10 correctness fixes (data loss, double-exec, auth lifecycle, reducer parity, keys/ids) | — |
| 3 | Streaming performance loop (main + renderer, 8 items) | 2.1, 2.3 (merge machinery) |
| 4 | 38 medium fixes across surface/lifecycle/UI/domain/CI | 2.x for a few co-lands |
| 5 | 9 structural refactors that retire the bug classes | 2.4→5.1, 4.6→5.2 |
| 6 | Gate-keeping test coverage (8 suites) | interleave with 2–5 |
| 7 | Low sweep (~30 small fixes) | last |

Working rule for the whole plan: **every behavioral fix ships with its regression test in the same commit**, and every phase ends with `npm run typecheck && npm run check && npm test` green plus (from Phase 1 onward) the packaging smoke job green.
