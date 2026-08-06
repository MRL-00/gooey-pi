# Final finding-viability review

**Audit target:** `/Users/am.will/Applications/prime`  
**Adjudication snapshot:** 2026-08-05, after the remediation commits listed below  
**Method:** current-tree source review, first-pass finding-by-finding adjudication, focused repro/test reruns, and packaged-artifact checks. Production source was not modified by this review.

## Executive verdict

The current tree has **no viable Critical finding and no viable code-level High security finding**. The security and process boundary is materially stronger than the first-pass reports: stable project identities, authorization revision checks, bounded/coalesced session parsing, async bounded plugin discovery, hostile-repository Git containment, bounded one-shot processes, bounded transcript/diff rendering, workspace-owned runtimes, fatal RPC teardown, reliable RPC writes, escalated PTY cleanup, and safe fragment navigation are now implemented and tested.

One **High release blocker** remains: the repository's public macOS packaging path does not require a Developer-ID identity, notarization/stapling, or Gatekeeper acceptance, and the checked artifact is actually rejected by Gatekeeper. The remaining production findings are six Medium correctness/privacy/accessibility/performance issues and several Low reliability/maintainability/release-efficiency issues. None provides a demonstrated remote-webview-to-privileged-IPC escape.

**Verdict:** suitable for continued local QA; **not suitable for public macOS release** until FVR-01 is closed. The other Medium findings should be resolved before calling the product production-ready, but they are not equivalent to a signing/notarization release blocker.

## Exact commit and working-tree context

- Branch: `main`, tracking `origin/main`, **28 commits ahead / 0 behind** at the snapshot.
- HEAD: `eab12a6fb87ec3fb7a6e761f604c165d33652d51` — `keep renderer IPC authorized across safe fragments` (2026-08-05 22:44:21 -0600).
- Relevant final remediation chain:
  - `eab12a6` safe fragment navigation/IPC authorization;
  - `a592a74` authorization revision recheck after async filesystem work;
  - `4a593c2` async PTY enumeration plus HUP→TERM→KILL for leader/group/descendants;
  - `b0e13ea` fatal RPC teardown and serialized bounded writes;
  - `53649d6`, `2a108a9`, `0ad52ff`, `6107c5c`, `9879521`, `41e3a07`, `0cd35df` for Git/process, project identity, renderer runtime, plugin/lock, session scale, terminal event, and render-bound remediation.
- Tracked production source was clean relative to HEAD. Tracked documentation had uncommitted edits in `README.md`, `docs/security.md`, and `docs/validation.md` only: 45 insertions / 26 deletions; binary diff SHA-256 `e79009f1630bbaac326f1666690a2d2233df145e5a2cd018e4e6605d50a4552d`.
- Pre-existing untracked research files: `research/adversarial-ux-review.md`, `research/audit/01-electron-security-recheck.md`, `research/final-ux-verification.md`, `research/package-verification.md`, and `research/security-remediation-verification.md`. This report itself is the only additional audit output.

## Ranked remaining findings

### Critical

None.

### High

#### FVR-01 — Public macOS trust and release gates are not enforced — **release blocker**

**Evidence.** `package.json:12-18` makes packaging depend only on typecheck/build, not unit/E2E or packaged-artifact verification. `package.json:59-73` defines macOS targets/entitlements/fuse hook but no notarization or post-package Team-ID, stapling, or Gatekeeper gate. On the checked `release/mac-arm64/Prime Work.app`, `codesign --verify --deep --strict` passes internally, but `codesign -dv` reports `Authority=BackgroundComputerUse Local Dev` and `TeamIdentifier=not set`; `spctl -a -vv -t exec` exits 3 (`rejected`), and `xcrun stapler validate` exits 65 (no ticket).

**Impact/trigger.** A maintainer can run the documented package command and upload an artifact which appears signed and works locally but is rejected on another Mac. Asking users to bypass Gatekeeper defeats the code-origin boundary needed for trustworthy distribution and later updates.

**Remediation.** Publish only from clean release CI using the intended `Developer ID Application` identity. Require unit tests, hermetic Electron E2E, packaged-app smoke, expected Team ID/authority, `codesign --verify --deep --strict`, fuse/ASAR/native-architecture checks, notarization, stapling, and `spctl --assess` before publication. Local identities/packages must be labeled QA-only.

**Duplicates:** ESR-01, BSP-01, BSP-03, TST-07.

### Medium

#### FVR-02 — E2E can read and retain the operator's real Prime data

**Evidence.** `tests/e2e/app.spec.ts:18-24` isolates only Electron `userData` while copying the host environment; `electron/main/sessions.ts:212` fixes the session root at `~/.prime/agent/sessions`; `tests/e2e/app.spec.ts:149-168` selects a real discovered project and opens a real PTY, skipping on a clean host. `playwright.config.ts:9` retains traces on failure. The first pass directly observed real session text in a failure artifact; the current paths are unchanged.

**Impact/trigger.** Any later E2E assertion failure on a developer/CI host with real sessions can copy private titles, paths, prompts, or transcript content into retained/uploaded traces. Results also vary by host and can pass while skipping the only real PTY integration.

**Remediation.** Inject session/config/home/executable roots; use synthetic transcripts/projects and a deterministic fake agent; fail setup if production roots would be read; use fresh independent fixtures for logically separate tests. Disable or sanitize retained traces until isolation is proven.

**Duplicates:** TST-01, backend-quality 11.

#### FVR-03 — Composer drafts cross workspace boundaries

**Evidence.** The draft remains component-local at `src/components/Composer.tsx:36-40`; workspace/session switches do not clear or re-key it. `src/App.tsx:608-609` keys `Transcript` by session but keeps the same `Composer` instance.

**Impact/trigger.** Text prepared for project/session A remains after selecting B and can be submitted against B. Repository-specific or destructive instructions can therefore run in the wrong workspace despite runtime ownership itself now being correct.

**Remediation.** Either key/reset the composer by a stable project/session/new-session identity, or keep an explicit draft map keyed by that identity. Test project, session, archive, and new-session transitions.

**Duplicate:** FQ-03.

#### FVR-04 — Failed settings/browser/schedule mutations still advance optimistic or apparent-success UI

**Evidence.** `src/App.tsx:334-340` applies settings optimistically and does not roll back/reload on rejection. The free-text browser-home and shell inputs still call `onUpdate` for every keystroke (`src/pages/SettingsPage.tsx:15`), while backend validation rejects transient invalid values (`electron/main/settings-schedules.ts:29-31`). Browser clearing returns `false` on any failure (`electron/main/settings-schedules.ts:34-44`), but `src/App.tsx:590` ignores the result, remounts the browser, and the modal closes immediately. Schedule creation catches and swallows rejection (`src/App.tsx:559-562`), so `src/pages/ScheduledPage.tsx:12` closes and clears its prompt after a resolved `void` failure.

**Impact/trigger.** Ordinary editing can leave a rejected shell/URL visible and active until restart. Storage/auth clearing can appear complete while data remains or clearing is partial. A failed schedule loses the user's only form copy.

**Remediation.** Keep validated local drafts and commit on blur/Enter/Save; version or serialize saves; roll back/resync on rejection. Standardize mutations on a checked result/throw contract. Await all browser clear operations with structured results and only close/remount/clear forms on confirmed success.

**Duplicates:** FQ-05, FQ-06 (residual non-Git portion), TST-03, TST-08, data-concurrency 10 and 13.

#### FVR-05 — MCP settings can still lose a concurrent non-cooperating writer's update

**Evidence.** `electron/main/plugins.ts:306-310` launches `prime-agent package install` outside the MCP settings mutation/lock. `connectMcp` acquires its app-specific lock, reads the full settings object, merges, and renames the full object at `electron/main/plugins.ts:313-345,569-576`. The lock correctly coordinates cooperating `PluginService` instances, but the CLI/editor/another protocol does not share it and there is no pre-rename version/hash compare.

**Impact/trigger.** A package/default/model change written by the CLI or another process between MCP's read and rename can be silently overwritten. Package install and MCP connect are both exposed workflows, so this is not only an editor-theory race.

**Remediation.** Use one settings transaction API/lock protocol shared with Prime Agent CLI. Otherwise capture a content version/hash and retry a fresh read/merge on conflict; coordinate package install through the same transaction boundary.

**Duplicate:** data-concurrency 8 (downgraded from its broader pre-lock claim).

#### FVR-06 — Overlay and composer accessibility ownership is not stack-safe

**Evidence.** `Modal` independently sets/clears `.app-shell` inertness (`src/components/ui.tsx:128-145`); `CommandPalette` duplicates the boolean ownership (`src/components/CommandPalette.tsx:28-31`). Global shortcuts can open/mutate UI over a modal without checking the active overlay (`src/App.tsx:571-584`). Composer suggestions are a labeled generic `div` with mouse buttons and no combobox/listbox relationship or arrow/Enter selection (`src/components/Composer.tsx:65-83`). The terminal screen-reader DOM and a start/completion announcer are now present, but generated answer blocks are not themselves announced.

**Impact/trigger.** Cmd-K over a confirmation creates competing `aria-modal` dialogs; closing one can expose the background while the other remains. Keyboard/screen-reader users cannot reliably discover or select slash/skill suggestions, a core input path.

**Remediation.** Use one overlay stack/provider with reference-counted inertness, topmost Escape/focus ownership, and shortcut suppression. Implement the ARIA combobox/listbox keyboard pattern for suggestions. Add accessibility-tree and keyboard-only E2E coverage.

**Duplicates:** FQ-08, GUI 8 and 9; GUI 7 is partially fixed and folded here at Low residual weight.

#### FVR-07 — Renderer streaming/catalog work still scales poorly

**Evidence.** Every accepted agent event still calls root `setMessages` (`src/App.tsx:267-284`). Completed transcript rows and the visible transcript are now bounded/memoized, but `Sidebar` remains a non-memoized root child and repeatedly performs project×session scans (`src/components/Sidebar.tsx:53-63,98-101`). Summary derives full-history values on render (`src/components/Inspector.tsx:52-64`). Activity maps the full visible catalog, while project/session services admit up to 5,000 entries; Files limits each render tranche to 1,000 (`src/components/Inspector.tsx:238-283`) rather than virtualizing it.

**Impact/trigger.** A large catalog plus a verbose stream repeatedly pays unrelated grouping/history work and can cause typing/scroll/stop latency. Opening Activity or successively expanding Files can still mount thousands of rows. The original unlimited transcript and million-line diff crashes are fixed; this is a lower-severity residual performance issue.

**Remediation.** Batch deltas per animation frame, isolate transcript state from `App`, memoize/index Sidebar by project path in one pass, and virtualize Activity/File catalogs. Add 5,000-session and sustained-stream profiler budgets.

**Duplicates:** PERF-01, PERF-05, FQ-07, GUI 10 (all downgraded/merged).

### Low

#### FVR-08 — Schedule listing can silently return a partial catalog

`electron/main/settings-schedules.ts:85-104` swallows per-runtime failures and uses CLI fallback only when *no* runtime returned jobs. With mixed success/failure, jobs from the failed runtime disappear without an incomplete marker. Return `{jobs, errors, complete}` or merge fallback whenever any runtime fails. **Duplicate:** backend-quality 7.

#### FVR-09 — Event-rate truncation does not rehydrate the authoritative transcript

`electron/main/agent-rpc.ts:176-215` intentionally drops oversized/excess events and emits one transport error; `src/App.tsx:267-286` does not re-read/reconcile after a throttle error. A valid large/bursty tool result can therefore remain absent until manual session reload. Rehydrate on limit/error/end and preserve critical lifecycle events. **Duplicate:** data-concurrency 12.

#### FVR-10 — Initial renderer load failure can leave a hidden window

`electron/main/index.ts:147-152` shows only on `ready-to-show` and detaches `window.loadURL(...)` with `void`; bootstrap cannot observe rejection. Await/catch navigation, destroy the hidden window, and show a bounded retry/error surface. **Duplicate:** backend-quality 10.

#### FVR-11 — Command-palette callbacks can be stale; the global listener still churns

`src/components/CommandPalette.tsx:14-25` rebuilds commands but memoizes filtered command objects only on `[query]`, retaining older toggle closures when the query is unchanged. `src/App.tsx:571-584` removes/re-adds the global shortcut listener after every render. Include commands/callback dependencies or use stable functional callbacks; install one stable listener. **Duplicates:** GUI 5, PERF-09.

#### FVR-12 — Startup and bundle work are not progressively/lazily delivered

`src/App.tsx:231-255` applies all startup data only after the slowest `Promise.allSettled` member. All feature pages/xterm/Markdown are statically imported (`src/App.tsx:3-15`); the verified build emits one **1,571,126-byte** renderer JS chunk. Plugin scans themselves are now async, bounded and coalesced, so the old main-thread-freeze claim is fixed. Apply independent startup results and lazy-load heavyweight optional surfaces; add a measured entry budget. **Duplicates:** PERF-07/08 and BSP-05 (downgraded).

#### FVR-13 — Small but real main-process latency tails remain

`JsonStateStore.update()` still clones and synchronously rewrites/fsyncs/renames the full state (`electron/main/store.ts:118-145`), and a failed persistence can leave its temp file. `ProjectService.list()` serially awaits branch lookup per persisted project and repeats session filtering (`electron/main/projects.ts:61-93`). These are bounded in normal use and no freeze benchmark was demonstrated, so the first-pass Medium claims are downgraded. Use async durability I/O/cleanup and bounded or deferred branch decoration with one-pass session aggregates. **Duplicates:** backend-performance 8 and 10.

#### FVR-14 — Packaging/toolchain efficiency policy is missing

Renderer-only libraries remain production dependencies (`package.json:21-29`) and are duplicated into ASAR. The checked ASAR extracted to about **46 MiB `node_modules` vs 1.7 MiB `out`**; examples include Lucide ~28.9 MiB and React DOM ~7.1 MiB. The app also contains 275 `.lproj` directories totaling about 47.2 MiB across bundles, while the UI is English-only. README still says Node 20 although locked Electron 43 requires Node >=22.12. No updater exists, but absence of auto-update is a product/distribution choice rather than a standalone vulnerability.

Move bundled renderer libraries to dev-only packaging, allowlist runtime modules, define supported locales, set `engines`/`packageManager`, and adopt artifact size budgets. Define a signed update/EOL policy after FVR-01. **Duplicates:** BSP-04/06/07 kept Low; BSP-02 rejected as a defect but retained as policy advice.

#### FVR-15 — Verification and type-safety gaps remain

Coverage is configured but unusable because `@vitest/coverage-v8` is absent; `npm test -- --coverage` fails. Electron E2E remains serial/order-dependent and does not adversarially exercise every guest/subframe/revocation path. Session tests now cover caching, recency, transcript suffixes and part caps, but not a broad versioned branch/tool corpus. Renderer tests cover the remediated workspace admission/event replay but not drafts, settings failures, overlay stacks, or catalog-scale render budgets. Agent command/event payloads remain broad dictionaries and demo-mode `window.prime` typing is optimistic.

Install/enforce coverage, hermeticize/split E2E, add the focused cases above, and narrow bridge/event unions. **Duplicates:** FQ-09/FQ-11; TST-02/04/05/06/09 (all Low after current remediation/tests).

## Separate release blocker

**Block public publication of DMG/ZIP artifacts.** FVR-01 is the only final release blocker. A local QA package is acceptable if unmistakably labeled local/unnotarized and never uploaded as a public release. Closing code/test Medium issues does not substitute for Developer-ID/notarization/Gatekeeper gates; conversely, notarization does not close the Medium correctness/privacy issues.

## File-size and DRY assessment

Current largest production files (physical lines):

| File | Lines | Assessment |
|---|---:|---|
| `src/styles.css` | 786 | Existing section seams should become feature stylesheets. |
| `src/App.tsx` | 624 | Too many independent owners: bootstrap, workspace/runtime, Git, settings, panels, navigation. This contributes to broad renders and mutation inconsistency. |
| `electron/main/plugins.ts` | 615 | Discovery, metadata, install validation, MCP schema, locking, and atomic settings persistence should be separated. |
| `electron/main/sessions.ts` | 558 | Catalog/cache and transcript interpretation/bounding are distinct responsibilities. |
| `electron/main/agent-rpc.ts` | 554 | Validation, event limiting, framed transport/write queue, runtime, and registry are separable despite corrected behavior. |
| `src/components/Inspector.tsx` | 329 | Summary, Git, browser, and files are separate feature surfaces. |

This is a maintainability finding, not a release blocker. The most consequential DRY violations are (1) duplicated Modal/CommandPalette focus/inert ownership, (2) duplicated project/session membership/grouping rather than one indexed selector, and (3) repeated renderer mutation try/catch contracts. The settings page remains a single very long physical JSX line, which impairs line review even though its component is not high in `wc -l`.

## Validation performed on the final snapshot

- `npm test`: **17 files / 65 tests passed**, including the new hostile RPC-overflow, authorization-revision, PTY leader escalation, Git hardening/correctness, session-scale, render-bound, and IPC URL tests.
- `npm run typecheck`: passed.
- `npm run build`: passed; emitted main 152.87 kB, preload 4.06 kB, and one renderer JS chunk **1,571.13 kB**.
- `npm audit --json`: 0 reported vulnerabilities (565 dependencies; point-in-time npm advisory result).
- `npm test -- --coverage`: failed immediately because `@vitest/coverage-v8` is missing (validates FVR-15).
- Packaged artifact: internal strict code-sign verification passed; Team ID absent; Gatekeeper rejected; no stapled ticket (validates FVR-01).
- ASAR/locale inspection: renderer dependencies are duplicated and all locale packs remain (validates FVR-14).
- Electron E2E was **not rerun** during final adjudication because the unchanged non-hermetic harness reads real host sessions and retains failure traces—the exact FVR-02 exposure. Static/current-path confirmation and the first-pass direct reproduction are sufficient.

## First-pass disposition map

**Legend:** Keep = present at the stated practical class; Downgrade = present but mitigated/lower impact; Fixed = absent on this snapshot; Reject = speculative/product choice/not a demonstrated defect. Duplicate findings are mapped to one final ID.

| Report / first-pass finding | Decision | Final disposition |
|---|---|---|
| 01 ESB-01 project symlink rebind | **Fixed** | `2a108a9`; stable dev/inode identities and regressions. |
| 01 ESB-02 RPC overflow child survives | **Fixed** | `b0e13ea`; fatal one-shot TERM/KILL path and hostile fixture. |
| 01 ESB-03 fragment revokes IPC | **Fixed** | `eab12a6`; fragment-aware trust plus prevented/default scroll handling. |
| Recheck ESR-01 macOS trust | **Keep High** | FVR-01. |
| Recheck ESR-02 RPC fatal lifecycle | **Fixed** | `b0e13ea`. |
| Recheck ESR-03 in-flight authorization after removal | **Fixed** | `a592a74`; revision rechecked after identity awaits. |
| Recheck ESR-04 fragment IPC revocation | **Fixed** | `eab12a6`. |
| 02 PS-01 repository-configured Git code execution/secrets | **Fixed** | `53649d6`; allowlisted env, hooks/fsmonitor/filter containment and tests. |
| 02 PS-02 PTY leader not escalated | **Fixed** | `4a593c2`; async tree and leader/group HUP→TERM→KILL. |
| 02 PS-03 unbounded process admission | **Fixed** | `53649d6`; active/queue bounds and shutdown closure. |
| 02 PS-04 pathological Git output/DOM expansion | **Fixed** | `53649d6` + `0cd35df`; explicit byte/entry/line/render caps. |
| 02 PS-05 extension response bypasses write bounds | **Fixed** | `b0e13ea`; shared serialized bounded writer and callback completion. |
| 03 PERF-01 root streaming/Markdown work | **Downgrade Medium** | FVR-07; old rows/window now bounded/memoized, root/catalog work remains. |
| 03 PERF-02 unlimited transcript/O(n²) last check | **Fixed** | `9879521` + `0cd35df`; bounded backend/window and O(n) last ID. |
| 03 PERF-03 24 MiB diff DOM | **Fixed** | 2 MiB/5,000 service caps and 4,000 renderer-line cap. |
| 03 PERF-04 forced smooth autoscroll | **Fixed** | pinned-to-bottom check and immediate rAF scroll. |
| 03 PERF-05 unvirtualized catalogs | **Downgrade Medium** | FVR-07; partial tranche bounds exist, Activity/sidebar scale remains. |
| 03 PERF-06 resize root/localStorage frequency | **Fixed** | CSS-variable drag and commit on pointer-up. |
| 03 PERF-07 startup barrier/duplicate plugin scans | **Downgrade Low** | FVR-12; barrier remains; plugin scans are async/coalesced. |
| 03 PERF-08 eager renderer bundle | **Downgrade Low** | FVR-12; measured but no launch-budget failure demonstrated. |
| 03 PERF-09 shortcut listener churn | **Keep Low** | FVR-11. |
| 04 backend-perf 1 repeated full session catalogs | **Fixed** | `9879521`; in-flight coalescing and fingerprint cache. |
| 04 backend-perf 2 256 MiB transcript heap/IPC | **Fixed** | bounded record suffix and per-resource IPC budgets. |
| 04 backend-perf 3 sync plugin crawl | **Fixed** | `6107c5c`; async traversal with directory/entry/candidate/worker limits. |
| 04 backend-perf 4 quadratic JSONL framing | **Fixed** | fragmented buffer and 50k-fragment regression. |
| 04 backend-perf 5 sync `ps` per PTY | **Fixed** | `4a593c2`; asynchronous `execFile`. |
| 04 backend-perf 6 unbounded one-shot concurrency | **Fixed** | `53649d6`. |
| 04 backend-perf 7 ambiguous/slow output-limit termination | **Fixed** | explicit output state and independent TERM/KILL escalation. |
| 04 backend-perf 8 synchronous state persistence | **Downgrade Low** | FVR-13; real tail, no demonstrated Medium freeze. |
| 04 backend-perf 9 permanent plugin lock | **Fixed** | owner token/PID recovery and concurrent-writer tests. |
| 04 backend-perf 10 serial project branch/session scans | **Downgrade Low** | FVR-13. |
| 05 FQ-01 wrong startup workspace/runtime | **Fixed** | `0ad52ff`; atomic workspace selection and tests. |
| 05 FQ-02 duplicate runtime starts | **Fixed** | synchronous single-flight admission and tests. |
| 05 FQ-03 cross-workspace composer draft | **Keep Medium** | FVR-03. |
| 05 FQ-04 stale project-owned async results | **Fixed** | workspace/Git generations and plugin coalescing; no dangerous stale Git repro remains. |
| 05 FQ-05 settings per-keystroke/no rollback | **Keep Medium** | FVR-04. |
| 05 FQ-06 inconsistent mutation failures | **Downgrade Medium** | Git portion fixed; settings/browser/schedule residual in FVR-04. |
| 05 FQ-07 streaming O(history) | **Downgrade Medium** | FVR-07. |
| 05 FQ-08 overlay ownership | **Keep Medium** | FVR-06. |
| 05 FQ-09 partial bridge type safety | **Keep Low** | FVR-15. |
| 05 FQ-10 oversized feature files | **Keep Low** | File-size/DRY assessment. |
| 05 FQ-11 missing renderer race/failure tests | **Downgrade Low** | Runtime/event tests added; residual FVR-15. |
| 06 backend-quality 1 stale list reauthorizes removal | **Fixed** | revision guards; distinct in-flight gap also fixed by `a592a74`. |
| 06 backend-quality 2 duplicate catalog scans | **Fixed** | `9879521`. |
| 06 backend-quality 3 staged+unstaged file lost | **Fixed** | `53649d6`; separate scope records and regression. |
| 06 backend-quality 4 Git false treated success | **Fixed** | checked failures/output and tests. |
| 06 backend-quality 5 sync plugin scan | **Fixed** | `6107c5c`. |
| 06 backend-quality 6 permanent MCP lock | **Fixed** | `6107c5c`. |
| 06 backend-quality 7 partial schedule list | **Keep Low** | FVR-08 (downgraded). |
| 06 backend-quality 8 truncated diff treated valid | **Fixed** | `53649d6`. |
| 06 backend-quality 9 unreliable extension response | **Fixed** | `b0e13ea`. |
| 06 backend-quality 10 hidden initial-load failure | **Keep Low** | FVR-10. |
| 06 backend-quality 11 non-hermetic E2E | **Keep Medium** | FVR-02. |
| 07 TST-01 E2E host-data exposure | **Downgrade Medium** | FVR-02; real exposure, but test-artifact/host-access scope, not product RCE. |
| 07 TST-02 serial/order-dependent E2E | **Keep Low** | FVR-15. |
| 07 TST-03 rejected optimistic settings | **Keep Medium** | FVR-04. |
| 07 TST-04 missing Electron boundary regressions | **Downgrade Low** | IPC URL tests added; broader guest/lifecycle gaps remain, no bypass. |
| 07 TST-05 sparse session semantics fixtures | **Downgrade Low** | caching/bounds fixtures added; broader corpus gap in FVR-15. |
| 07 TST-06 no startup scale test | **Downgrade Low** | scale/caching unit coverage added; no end-to-end budget. |
| 07 TST-07 package not gated by E2E | **Keep Medium / dedupe** | absorbed into release-blocking FVR-01 pipeline requirement. |
| 07 TST-08 browser reset false success | **Upgrade from Low to Medium / dedupe** | FVR-04 because it is a privacy-result contract, not only a test gap. |
| 07 TST-09 unusable coverage | **Keep Low** | FVR-15; directly reproduced. |
| 08 BSP-01 macOS signing/notarization | **Keep High** | FVR-01. |
| 08 BSP-02 no updater | **Reject as standalone defect** | Product/distribution policy; retain signed update/EOL recommendation under FVR-14. |
| 08 BSP-03 package bypasses release gates | **Keep Medium / dedupe** | FVR-01 release pipeline. |
| 08 BSP-04 renderer deps duplicated in ASAR | **Downgrade Low** | FVR-14; size/efficiency, not runtime correctness. |
| 08 BSP-05 one eager renderer chunk | **Downgrade Low** | FVR-12. |
| 08 BSP-06 Node support contradiction | **Keep Low** | FVR-14. |
| 08 BSP-07 all locale packs | **Keep Low** | FVR-14. |
| 09 data 1 stale Git operates on wrong repo | **Fixed** | request/generation and workspace ownership guards. |
| 09 data 2 runtime not bound to workspace | **Fixed** | `0ad52ff`. |
| 09 data 3 prompt re-entrant | **Fixed** | `0ad52ff`. |
| 09 data 4 transcript load overwrites events | **Fixed** | generation-scoped event replay. |
| 09 data 5 list reauthorizes removed project | **Fixed** | revision guard/regressions. |
| 09 data 6 early terminal events lost | **Fixed** | pre-create subscription/buffer in `41e3a07`. |
| 09 data 7 permanent MCP lock | **Fixed** | `6107c5c`. |
| 09 data 8 MCP whole-object lost update | **Downgrade Medium** | cooperating writers fixed; non-cooperating CLI race remains FVR-05. |
| 09 data 9 extension response early success | **Fixed** | `b0e13ea`. |
| 09 data 10 browser reset false success | **Keep Medium** | FVR-04. |
| 09 data 11 Git mutation failures discarded | **Fixed** | `53649d6` plus renderer checks. |
| 09 data 12 throttled events never converge | **Keep Low** | FVR-09. |
| 09 data 13 failed settings stays optimistic | **Keep Medium** | FVR-04. |
| 10 GUI 1 unlimited transcript DOM | **Fixed** | backend budgets + 250-row progressive window. |
| 10 GUI 2 million-node diff | **Fixed** | service/renderer byte+line bounds. |
| 10 GUI 3 forced streaming scroll | **Fixed** | pinned-bottom behavior. |
| 10 GUI 4 resize rerender/storage frequency | **Fixed** | pointer-up state commit. |
| 10 GUI 5 stale command-palette callbacks | **Keep Low** | FVR-11 (downgraded from Medium). |
| 10 GUI 6 xterm screen-reader DOM off | **Fixed** | `screenReaderMode: true`. |
| 10 GUI 7 response/completion not announced | **Partially fixed / Low residual** | completion announcer exists; response-block announcement folded into FVR-06. |
| 10 GUI 8 modal/palette stacking | **Keep Medium** | FVR-06. |
| 10 GUI 9 inaccessible composer suggestions | **Keep Medium** | FVR-06. |
| 10 GUI 10 quadratic sidebar grouping | **Downgrade Medium** | FVR-07; transcript/render bounds reduce amplification, grouping remains. |

## Bottom line

The remediation commits invalidate most alarming first-pass claims. The final source of truth is: **one High distribution blocker, six Medium product issues, Low residual reliability/performance/maintainability work, and no demonstrated Critical or remote Electron boundary escape.**
