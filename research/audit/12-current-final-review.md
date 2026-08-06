# Current final review

**Target:** `/Users/am.will/Applications/prime`  
**Snapshot:** HEAD `f8c67e5` plus the working tree inspected on 2026-08-05 23:01 MDT.  
**Method:** adjudicated `01-electron-security-recheck.md` and findings in `02`–`10` against current source, then reran focused validation. Audit only; no production source was edited by this review.

## Verdict

There is no remaining Critical issue and no demonstrated code-level Electron sandbox/IPC escape. The remediation series closed the earlier High safety/correctness findings. One **High public-release blocker** remains: the normal macOS packaging command can produce an artifact that is neither Developer-ID trusted nor notarized/stapled, and it does not gate on tests or packaged-artifact verification. The current tree is appropriate for local QA, but not public distribution. The remaining production issues are four Medium correctness/concurrency/performance problems and lower-severity reliability, test, and maintainability debt.

## Ranked remaining findings

### High

#### CFR-01 — Public macOS trust and release gates are not enforced (**release blocker**)

**Evidence.** `package.json:12-18` makes `package:mac` run only build/typecheck plus `electron-builder --mac`; unit tests, Electron E2E, packaged-app smoke, Team-ID checks, notarization, stapling, and Gatekeeper assessment are not prerequisites. `package.json:59-73` configures targets, entitlements, and `afterPack`, but no notarization or post-package trust gate. The repository itself acknowledges the missing public trust step at `docs/security.md:19` and `README.md:64-72`. The extant `release/mac-arm64/Prime Work.app` passes internal `codesign --verify --deep --strict`, but current direct checks report `Authority=BackgroundComputerUse Local Dev`, `TeamIdentifier=not set`, `spctl` exit 3 (`rejected`), and `stapler validate` exit 65 (no ticket).

**Remediation.** Publish only from clean release CI using a `Developer ID Application` identity. Gate publication on unit tests, hermetic Electron E2E, packaged-app smoke, expected Team ID/authority, strict code-sign verification, fuse/ASAR/native-architecture checks, notarization, stapling, and successful `spctl --assess`. Label local packages QA-only.

### Medium

#### CFR-02 — Composer drafts still cross project/session boundaries

**Evidence.** Draft text is component-local state at `src/components/Composer.tsx:37-40`. Workspace switches re-key `Transcript`, but the adjacent `Composer` has no workspace key at `src/App.tsx:693-694`, so the same draft survives selecting a different project/session or creating a new session.

**Impact.** A repository-specific or destructive prompt prepared for workspace A can be sent accidentally in workspace B even though runtime ownership itself is now correctly enforced.

**Remediation.** Key/reset the composer by stable project/session/new-session identity, or keep a draft map keyed by that identity. Add project, session, archive, and new-session transition tests.

#### CFR-03 — Schedule failures are represented as success or an unexplained partial catalog

**Evidence.** `src/App.tsx:635-640` catches schedule add/cancel failures, reports a toast, and resolves `Promise<void>`. `src/pages/ScheduledPage.tsx:9-16` treats any resolution as success, closes the modal, and clears the prompt. Independently, `electron/main/settings-schedules.ts:85-104` swallows individual runtime-list failures and invokes CLI fallback only when *zero* jobs were collected; mixed success/failure silently omits jobs.

**Impact.** A failed create loses the user's form contents, and a partial list looks complete, which can mislead users managing unattended work.

**Remediation.** Let mutation failures reject or return a checked result and preserve the form on failure. Return schedule list completeness/errors (or merge fallback whenever any runtime fails) and display degraded state.

#### CFR-04 — MCP settings can overwrite a concurrent CLI/editor update

**Evidence.** Package installation runs as an independent `prime-agent package install` process at `electron/main/plugins.ts:306-310`. MCP connect uses only `PluginService`'s private promise and lock, then reads and rewrites the entire settings object at `electron/main/plugins.ts:325-345`; the final whole-file atomic rename is at `electron/main/plugins.ts:569-576`. A CLI, editor, or package installation does not share this in-process queue/lock, and there is no content version/hash comparison immediately before rename.

**Impact.** If another writer changes settings after MCP's read but before its rename, that valid update can be silently lost.

**Remediation.** Use a settings transaction/lock shared with Prime Agent, or compare a captured file version/hash and retry a fresh read/merge on conflict. Route package install through the same transaction boundary.

#### CFR-05 — Streaming still repeats unrelated catalog/root work at event frequency

**Evidence.** Every admitted agent event performs root `setMessages` at `src/App.tsx:318-337`. Delta reduction still scans/maps the transcript and concatenates the growing text at `src/lib/events.ts:18-30`. `Sidebar` is a non-memoized root child and performs project×session scans at `src/components/Sidebar.tsx:53-63,98-101`; Activity maps the full visible catalog and performs a linear project lookup per row at `src/pages/ActivityPage.tsx:12-14`. The service admits up to 5,000 session files (`electron/main/sessions.ts:17,265-305`). Transcript/diff hard caps prevent the old catastrophic DOM cases, but they do not isolate or batch this hot state path.

**Impact.** Sustained streaming with a large session/project catalog can delay typing, stop controls, and scrolling through repeated unrelated grouping and Markdown/current-message work.

**Remediation.** Batch deltas per animation frame, move streaming transcript state below `App`, memoize root surfaces/callbacks, index project membership once, and virtualize Activity/catalog rows. Add profiler budgets for 5,000 sessions plus sustained deltas.

### Low

#### CFR-06 — Free-text settings still validate/persist every keystroke

**Evidence.** The browser-home and shell inputs call `onUpdate` directly from `onChange` in the single JSX line at `src/pages/SettingsPage.tsx:21`. Backend validation requires a complete web URL/executable shell at `electron/main/settings-schedules.ts:29-31`. The current serialized rollback path at `src/App.tsx:336-367` prevents persistent divergence, but ordinary replacement typing produces invalid intermediate prefixes and repeated IPC/error/rollback cycles.

**Remediation.** Keep local field drafts and validate/commit on blur, Enter, or Save; show inline validation without replacing in-progress text.

#### CFR-07 — Event throttling does not reconcile from the authoritative transcript

**Evidence.** `electron/main/agent-rpc.ts:176-215` intentionally drops excess/oversized events and emits at most a transport-error marker. The renderer handles that marker by finalizing state at `src/App.tsx:318-337`; it does not call `sessions.read` or otherwise rehydrate missing output.

**Remediation.** On a limit marker or turn end, reconcile from the authoritative session log with generation/runtime guards. Preserve critical lifecycle delivery separately.

#### CFR-08 — Initial renderer-load rejection can leave a hidden window

**Evidence.** The window is shown only on `ready-to-show` at `electron/main/index.ts:147`, while `window.loadURL(...)` is detached with `void` at `electron/main/index.ts:152`; bootstrap cannot catch its rejection.

**Remediation.** Await/catch the initial navigation, destroy or retry the hidden window, and show a bounded local error surface.

#### CFR-09 — Startup and package delivery remain unnecessarily heavy

**Evidence.** Startup applies all results only after the slowest `Promise.allSettled` member at `src/App.tsx:287-308`. Every page, xterm, and Markdown surface is statically imported at `src/App.tsx:3-19`, while `electron.vite.config.ts:17-21` defines no lazy/manual split. The verified build produced one approximately **1.57 MB** renderer JS chunk. Renderer libraries remain production dependencies at `package.json:21-29`, so Builder also collects their module trees despite Vite already bundling them.

**Remediation.** Apply independent startup results as they settle, lazy-load optional pages/terminal/browser-heavy surfaces, allowlist only true main-process runtime modules in the package, and enforce entry/artifact size budgets.

#### CFR-10 — Large multi-owner files and synchronous persistence remain maintainability/latency hotspots

**Evidence.** Current physical sizes are `src/styles.css` 794 lines, `src/App.tsx` 710, `electron/main/plugins.ts` 615, `electron/main/sessions.ts` 558, and `electron/main/agent-rpc.ts` 554. `App` owns bootstrap, workspace/runtime, extension UI, transcript, Git, settings, panels, and navigation; `plugins.ts` owns discovery, metadata, install, MCP validation, locking, and persistence. `JsonStateStore.update` still clones and synchronously writes/fsyncs/renames the entire state on Electron's main thread at `electron/main/store.ts:118-143`, and failure after temp creation has no temp-file cleanup.

**Remediation.** Split along the ownership seams above; move recurrent durable writes to asynchronous I/O with `finally` cleanup, while retaining serialization and fsync semantics. Format `SettingsPage` into reviewable sections instead of one multi-kilobyte physical JSX line.

#### CFR-11 — Test coverage is stronger but still lacks an enforceable coverage/performance/security gate

**Evidence.** Vitest is Node-only and only declares reporters at `vitest.config.ts:4-7`; `package.json:31-43` lacks `@vitest/coverage-v8`. `npm test -- --coverage` fails immediately with “Cannot find dependency `@vitest/coverage-v8`.” The focused IPC test proves trusted-URL normalization but not live guest/subframe/revocation handler behavior (`tests/backend/ipc-security.test.ts:1-13`). There is no automated 5,000-session+sustained-stream render budget, and `package:mac` does not run tests (`package.json:15-18`).

**Remediation.** Install/configure a coverage provider with meaningful branch/function thresholds; add full live IPC/webview revocation cases, session-version corpus tests, and measured renderer/startup budgets; make these and hermetic E2E mandatory release gates.

## Major findings now fixed

- **Project grant substitution and authorization races:** stable device/inode identity is captured and checked (`electron/main/projects.ts:22-35`), and authorization rejects if its revision changes during async verification (`electron/main/projects.ts:263-275`).
- **RPC overflow/unreliable extension writes:** decoder failures pause output and execute bounded process-group TERM→KILL (`electron/main/agent-rpc.ts:250-264,327-344`); all renderer writes use a serialized byte-bounded callback-observed queue (`electron/main/agent-rpc.ts:346-365`).
- **Hostile-repository Git execution/secrets and process storms:** Git disables fsmonitor/hooks/external diff/signing/filter drivers and uses a restricted environment (`electron/main/git.ts:15-32,161-187`); one-shot work has 8-active/64-queued bounds plus explicit output-limit state/escalation (`electron/main/process-utils.ts:18-23,168-188,221-223`).
- **PTY teardown and early-event loss:** process-tree enumeration is asynchronous and leader/group/descendants receive HUP→TERM→KILL (`electron/main/terminal.ts:41-69,180-192`); renderer subscriptions/buffering precede terminal creation (`src/components/TerminalDrawer.tsx:80-110`).
- **Unbounded transcript/diff rendering:** transcript graph/IPC budgets and a 400-message cap are enforced (`electron/main/sessions.ts:17-31,331-415`); the renderer windows messages (`src/components/Transcript.tsx:120-167`) and caps diffs at 2 MiB/4,000 rendered lines (`src/components/Inspector.tsx:69-75`).
- **Synchronous/unbounded plugin discovery and permanent stale locks:** discovery is async and directory/entry/candidate bounded (`electron/main/plugins.ts:17-23,130-180`); provably dead lock owners can be recovered (`electron/main/plugins.ts:533-566`).
- **Wrong workspace runtime, duplicate sends, stale Git, and transcript-load overwrite:** workspace generations/runtime identity, single-flight submission, Git request IDs, and buffered event replay are present (`src/App.tsx:232-268,318-367,390-407,523-597`; `src/lib/workspace.ts:32-63`).
- **Git scope/failure ambiguity:** staged+unstaged state becomes separate scope records and output-limit failures are explicit (`electron/main/git.ts:104-153,203-238`); renderer mutations check results (`src/components/Inspector.tsx:109-135`).
- **Fragment navigation IPC loss:** trusted URL comparison ignores only the fragment (`electron/main/ipc.ts:26-34`) and Markdown prevents native fragment navigation (`src/components/MarkdownText.tsx:10-17`).
- **Non-hermetic E2E exposure:** each test now uses a temporary HOME, synthetic session/project, fake agent, and fresh app lifecycle (`tests/e2e/app.spec.ts:18-95`).
- **Recent UX correctness/accessibility items:** settings rejection rollback/browser reset failure handling, modal shortcut suppression, keyboard composer suggestions, xterm screen-reader mode, completion announcement, and accessible extension questions are implemented in the current tree (`src/App.tsx:336-367,648-663,676-706`; `src/components/Composer.tsx:61-125`; `src/components/TerminalDrawer.tsx:60-110`; `src/components/Transcript.tsx:115-152`; `src/components/ExtensionUiModal.tsx:15-61`).

## Validation and release posture

- `npm run typecheck`: **pass** on the final inspected working tree.
- `npm test`: **pass — 18 files / 68 tests**.
- `npm audit --omit=dev`: **0 known vulnerabilities** at audit time.
- `npm test -- --coverage`: **fails** because `@vitest/coverage-v8` is absent (CFR-11).
- A nine-test hermetic E2E run passed before the newest extension/question and UX additions. A later independent full invocation overlapped other active Playwright runs, so no clean current full-suite result is claimed here; release CI must supply the authoritative isolated run.
- Existing package: strict internal signature passes, but Gatekeeper rejects and no notarization ticket is stapled (CFR-01).

**Release decision:** local QA may continue. Do **not** publish the DMG/ZIP until CFR-01 is closed; address CFR-02 through CFR-05 before describing the product as production-ready.
