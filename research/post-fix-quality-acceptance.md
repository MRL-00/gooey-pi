# Post-fix quality acceptance — `fix/audit-final-closure`

## Verdict: **ACCEPT**

I independently reviewed the current working tree in `/private/tmp/prime-audit-verify` against every blocker in `final-quality-acceptance-ee379.md`. I did not change product or test code. The requested report is the only file I created.

All acceptance blockers are fixed in the implementation, the formerly excluded TSX tests are now collected and behaviorally meaningful, and every permitted non-Electron gate passes. Per the coordination pause, I did **not** run Playwright or launch Electron.

## Validation

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm test -- --run` | **PASS** — 36 files, 232 tests |
| `npm run test:coverage` | **PASS** — 36 files, 232 tests; 75.84% statements, 63.38% branches, 83.92% functions, 82.55% lines |
| `npm run build` | **PASS** — main, preload, and renderer production bundles |

These gates were rerun independently on the staged merge result (`c911e77` plus `origin/main` at `1358408`) after conflicts were resolved. The production HTML still preloads only `react-vendor` and `icons-vendor`. `Transcript` (35.31 kB) and `markdown-vendor` (372.86 kB) remain separate dynamic chunks, and markdown is not module-preloaded by `out/renderer/index.html`.

The merged build remains within every CFR-09 bundle budget: main 212,208 / 262,144 bytes; preload 5,051 / 16,384; initial renderer entry plus modulepreloads 730,897 / 1,310,720; largest renderer JS/CSS chunk 554,693 / 614,400; total renderer JS/CSS 1,780,423 / 2,097,152. These metrics were independently measured from the merged build output. The normal suite retains deterministic collector tests plus one-over-budget rejection for every bundle and package metric.

## Merge-conflict regression review

I inspected the staged three-way merge, concentrating on the 31 paths changed by both parents. The resolutions preserve the accepted closure rather than selecting one side wholesale:

- Bootstrap retains atomic project/session ownership and late runtime attachment, then adds main's bounded session-change subscription.
- Workspace runtime retains the unified transcript read lifecycle, prompt admission revision, buffered reconciliation, and RAF batch reducer while adding externally changed transcript ownership.
- Settings retains full authoritative panel reconciliation and adds transient compact-layout ownership so background saves do not undo an in-progress responsive panel transition.
- Extension UI retains pending requests per runtime and now responds through the visible request ref, removing the brief runtime-switch ambiguity noted in the earlier review.
- App retains lazy Transcript/Markdown, scoped plugin loading, stable Sidebar callback proxies, and initialized New Session admission while incorporating main's Git-status and live-session work.
- Session service retains canonical-path transcript coalescing and two-read concurrency, now also bounding the pending queue; catalog discovery still admits by filename before per-entry canonicalization/stat.
- Provider rollback/ordering/fallback and all provider accessibility/telemetry fixes remain intact.

The merged tests exercise both sides of these resolutions: initial/external transcript races, queued settings plus transient panels, background extension activation, plugin scope ownership, bounded transcript pending admission, 50,000-name discovery, provider behavior/accessibility, syntax complexity, bundle boundaries, and release budgets. I found no conflict marker, dropped acceptance guard, or merge-induced blocker.

## Blocker-by-blocker acceptance

### 1. Bootstrap ownership — **fixed**

`useBootstrap` settles projects and sessions together, publishes both, activates the selected owned workspace, and only then sets `initialized`. Runtime discovery is deliberately off the critical path and can attach only to the selected generation and exact cwd/session. `App` does not mount Sidebar until initialization, and `newSession` refuses admission until initialization and an authoritative project are present. This removes the interval in which the displayed fallback project and workspace owner could disagree.

The mounted hook test delays runtime discovery and proves project/session activation and initialization occur first. The test does not synthesize Cmd+N through the whole App, but the explicit `initialized`/project guard and conditional Sidebar mount are direct and sufficient.

### 2. Queued settings rollback — **fixed**

Successful latest saves and latest failures now call `applySettings` with the complete authoritative settings object, rather than the mutation's narrow patch. Consequently all three standalone panel states (`sidebarOpen`, `inspectorOpen`, and `terminalOpen`) reconcile with `settings` after queued operations.

The mounted hook test is meaningful: it performs two queued mutations, controls both promises, rejects the latest mutation, and asserts all panel states plus the complete settings object. It covers the same stale-panel mechanism, although adding the exact inverse ordering from the original report (first failure, second success) would make the regression intent even clearer. Inspection confirms that inverse ordering also installs the second operation's full saved object.

### 3. Same-runtime transcript reconciliation — **fixed**

`prepareForPrompt` now invalidates an in-flight reconciliation owned by the same generation, replays its already-buffered events onto current state, clears deferred reconciliation, and causes the late authoritative promise result to fail the object-identity ownership check. Terminal reconciliation from the prior turn is gated until the newly admitted turn starts.

The mounted hook test starts a real initial read, starts a deferred same-runtime reconciliation, buffers a live delta, admits a prompt, resolves the stale read, and proves the stale authoritative transcript does not replace current state.

### 4. Transcript lifecycle and backend read admission — **fixed**

Initial and reconciliation reads share `startTranscriptRead`; the duplicated completion/error/finalization paths are gone. `SessionService` authorizes every caller, coalesces in-flight reads by canonical session path, returns a deep clone to each caller, and admits at most two distinct transcript scans through a FIFO service-wide gate.

Backend tests meaningfully hold reader promises open and assert one scan for concurrent same-session requests, independent cloned results, per-caller authorization, and a maximum of two active scans across three sessions.

### 5. Plugin request ownership — **fixed**

The old competing bootstrap/App writers are replaced by `usePluginSkills`. One monotonic guard binds automatic loads and refreshes to request ID, workspace generation, and exact global/project scope. Success, error, and loading completion are ignored when any owner component is stale.

The mounted test controls four deferred completions and proves stale global, prior-project, refresh, generation, and path completions cannot replace the current catalog.

### 6. Background extension UI — **fixed**

`useAgentEvents` forwards extension UI events before filtering non-active runtimes. `useExtensionUi` keeps one pending request independently per runtime, displays only the active runtime's request, surfaces a retained background request when its runtime becomes active, and scopes replacement, timeout, response, and exit cleanup to the owning runtime.

The mounted test creates a background confirmation while another runtime is active, verifies it is hidden but not cancelled, switches runtime ownership, and verifies the original request appears. Queue tests also verify simultaneous runtime entries remain isolated.

### 7. Provider rollback and command ordering — **fixed**

Model, effort, and fast mutations enter one serialized queue. Revision and runtime-owner checks prevent an older completion from rolling back or synchronizing over a newer selection. The latest failure restores the relevant optimistic snapshot and then refreshes authoritative runtime state. Model and thinking commands execute in order within one queued mutation.

Mounted hook tests prove only the first rapid effort command is admitted initially, prove the latest rejection rolls back and synchronizes, and prove a rejected model command restores model/effort and refreshes the runtime. The provider-enable path also no longer performs a duplicate renderer settings write; main remains the single persistence owner.

### 8. ChatGPT subscription fallback — **fixed**

Configured `openai-codex` accounts now retain built-in catalog availability when optional executable discovery is empty or partial. Other providers and unconfigured Codex accounts remain governed by exact executable discovery. The catalog emits a bounded fallback warning rather than leaking discovery errors.

Focused backend tests cover empty, partial, complete, and unconfigured cases.

### 9. Sidebar streaming isolation — **fixed**

`useSidebarActions` creates stable callback identities while dispatching through the latest App actions, so transcript-only App updates satisfy Sidebar's still-strict comparator. Sidebar session ownership is indexed in one pass and rendered rows remain bounded to seven per project.

The tests verify callback identity, latest-closure dispatch, strict comparator equality, exactly one scan of 5,000 sessions, and the seven-row render admission. A low-level cleanup remains desirable: App's global keydown effect still has no dependency list and is reinstalled after App renders. That no longer invalidates Sidebar or changes correctness, so it is not an acceptance blocker, but it is avoidable listener churn.

### 10. Lazy markdown — **fixed**

`Transcript` is loaded with `React.lazy` behind Suspense, and its static markdown dependency is therefore behind that chunk boundary. Production output provides concrete proof: separate `Transcript` and `markdown-vendor` chunks exist, and neither appears in the HTML module-preload list.

### 11. Linear syntax and event batching — **fixed**

The syntax tokenizer uses a monotonically advancing cursor, classifies repeated strings at their actual position, performs no `indexOf` restart scans, preserves the full admitted source text, and caps styled fragments at 10,000.

RAF flushes now call `replayPrimeEvents` once per frame. The reducer scans/copies the transcript once, drafts affected messages once, and uses linked/indexed part drafts rather than repeated message maps and part searches. Tests compare it to sequential semantics for mixed text, thinking, tool, error, terminal, and turn events; run 100 deterministic mixed permutations; instrument transcript/part scans and copies; and exercise 50 sustained 200-delta batches. These are structural complexity assertions, not fragile timing checks.

### 12. Bounded 50,000-session discovery — **fixed**

Catalog discovery ranks directory-entry names and slices to `maxSessionFiles` before per-entry canonicalization or stat work. Only admitted names receive containment validation, stat, metadata parsing, and post-parse stat validation. The 50,000-entry test asserts a three-file budget causes four canonicalizations total (root plus three), six stats, and three metadata reads, and verifies an old unadmitted filename is never inspected.

## Accessibility and settings acceptance

- Provider enable checkboxes have provider-specific `aria-label` values.
- API-key save errors are rendered as `role="alert"` inside the active modal.
- OAuth choices are ordinary buttons inside a labelled group, avoiding the incomplete listbox pattern.
- Privacy settings again expose a diagnostics toggle that calls `onUpdate({ telemetry })`.
- The collected jsdom tests interact with the controls and assert callbacks, errors, modal locality, and accessible semantics rather than relying on static markup substrings.

## TSX collection and test quality

`vitest.config.ts` includes `tests/**/*.test.{ts,tsx}` and configures the automatic JSX transform. Both TSX files are collected in the normal suite: `provider-settings.test.tsx` (9 tests) and `renderer-concurrency.test.tsx` (6 tests). They mount hooks/components in jsdom and drive controlled promises and DOM events, so the former false-green collection problem is closed.

The expanded merged suite is generally strong and deterministic. The main minor gaps remain the exact inverse settings-queue ordering noted above and a unit-level whole-App keyboard/bootstrap interaction; direct guards and the parent's merged Electron smoke cover the wiring. Main also introduces a small `src/lib/plugin-catalog.ts` admission helper tested in isolation while the production plugin hook continues to use the equivalent, more general scoped-request guard. That redundant helper/test should eventually be consolidated, but it does not weaken the mounted production-hook race coverage or reveal a behavioral defect.

## Architecture and file sizes

- `App.tsx`: 386 lines, still below the stated 400-line App ceiling after incorporating main's live-session and Git ownership work.
- `Transcript.tsx`: 119 lines after merging main's active-stream rendering optimization; decomposed transcript modules remain 39–149 lines.
- `useWorkspaceRuntime.ts`: 311 lines after adding externally changed transcript ownership, while initial/reconciliation reads still share one lifecycle.
- `usePluginSkills.ts`: 44 lines.
- `useSidebarActions.ts`: 45 lines.
- Provider enable persistence has one writer in main rather than a second renderer settings update.

The merged tree's largest TypeScript file is now `electron/main/git.ts` at 401 lines (one line above the earlier general 400-line heuristic); it is a cohesive privileged Git service and does not regress the renderer splits under acceptance. Other larger cohesive files include `electron/main/plugins/mcp.ts` at 364, `src/lib/events.ts` at 325, `electron/main/providers.ts` at 320, and `useWorkspaceRuntime.ts` at 311. The merge did not restore the duplicated transcript lifecycles or mixed 396-line Transcript component.

### CFR-09 executable size gates

The size policy is now executable rather than documentation-only. `size-budgets.mjs` measures main/preload bundles, the exact renderer module entry/preload graph from production HTML, the largest renderer JS/CSS chunk, total renderer JS/CSS, `app.asar`, regular files in the application bundle, DMG, and ZIP. It validates safe integer metrics and fails at one byte above each explicit ceiling. `release:verify` invokes the build-output gate after bundling, while post-package verification applies artifact budgets. Path handling rejects escaping or URL-like initial references and forbidden non-file renderer entries. The fixture tests exercise actual collection and every failure threshold, so these are meaningful regression gates rather than constant-only assertions.

The package verifier also enforces an exact unpacked native allowlist and complete Mach-O architecture coverage, avoiding the previous broad ZeroMQ wildcard and unverified extra binaries. This final addition introduces no renderer or runtime correctness regression and remains comfortably within its build budgets.

## Coordination caveat

I intentionally did not launch Playwright/Electron during this independent post-merge recheck, exactly as requested. My evidence is static conflict-resolution inspection plus fresh non-Electron typecheck, Vitest, coverage, and production build gates. The parent separately reports the merged tree's 23/23 Electron E2E, local QA package, zero audit findings, and fail-closed public preflight; those results are corroborating coordination evidence, not represented as independently rerun here.

## Final DRY cleanup

After this acceptance pass, the unused duplicate `src/lib/plugin-catalog.ts` admission helper and its isolated duplicate test were removed. Production retains the mounted generation/path/request-scoped `usePluginSkills` guard and its structural coverage. The final unit count is 35 files / 230 tests.
