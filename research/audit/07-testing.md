# Tests and verification quality audit

## Scope and method

Audit only; no production code was changed. I reviewed the test runners, all 13 test files, and the production paths those tests exercise, with particular attention to Electron trust boundaries, process/PTY behavior, persistent state, session parsing, renderer async behavior, and browser isolation.

Native verification performed on this checkout:

| Command | Result |
|---|---|
| `npm test -- --reporter=verbose` | **Pass:** 12 files, 33 tests |
| `npm run typecheck` | **Pass** |
| `npm run build` | **Pass** |
| `npm run test:e2e` | **Fail:** browser guest assertion failed; 5 passed, 1 failed, 3 did not run |
| `npx playwright test -g 'attaches an isolated'` | **Pass** in isolation |
| `npx playwright test` (immediate rerun) | **Pass:** 9 tests |
| `npm test -- --coverage` | **Fail before tests:** missing `@vitest/coverage-v8` |

Severity is based on user/data impact and the likelihood that the present verification process will miss or itself cause a failure. “Actual code finding” denotes observed defective behavior in production/test code; “test gap” denotes risky behavior for which I did not establish a current production failure.

## Findings

### TST-01 — High — The Electron E2E suite is not hermetic and records real Prime session contents in failure artifacts

**Classification:** Actual test-infrastructure/data-exposure finding.

**Evidence**

- `tests/e2e/app.spec.ts:19-24` creates a temporary Electron `userData` directory and passes `PRIME_WORK_E2E=1`, giving the appearance of isolation.
- `electron/main/sessions.ts:100-108` nevertheless fixes `sessionRoot` to `join(homedir(), '.prime', 'agent', 'sessions')`; neither the temporary Electron profile nor `PRIME_WORK_E2E` affects it.
- `electron/main/index.ts:156-178` discovers and invokes the real Prime executable and constructs `SessionService` without an injectable session root.
- `tests/e2e/app.spec.ts:149-168` selects/grants the first locally inferred project and opens a real PTY; line 156 explicitly makes the test outcome depend on whether local Prime data exists.
- `playwright.config.ts:8` retains a trace on failure. On the first audit run, the generated `test-results/.../error-context.md` contained real sidebar session titles and transcript text from `~/.prime/agent/sessions`, confirming exposure rather than merely a theoretical path.

**Impact**

A developer or CI runner's private prompts, project paths, session titles, and transcript content can be copied into Playwright snapshots/traces when an unrelated assertion fails. Such artifacts are commonly uploaded from CI. The suite also depends on and exercises the host's real project catalog, Prime CLI, and shell, so it can pass, skip, fail, or expose different data per machine.

**Realistic trigger**

Run `npm run test:e2e` on a workstation with existing Prime sessions, then hit any later Playwright failure. Playwright retains the trace and error snapshot of the currently selected real session; this happened during this audit. A CI artifact upload would then publish that material to everyone with artifact access.

**Remediation**

Inject all user-state roots and executables. In E2E mode, set a temporary `PRIME_AGENT_HOME`/session root, point agent discovery at a deterministic fake agent, and create fixture projects/transcripts under the test directory. Fail setup if production `~/.prime` would be read. Do not use “first local project.” Sanitize/disable traces until isolation is enforced, and add a setup assertion that every returned session/project path is beneath the test temp root.

---

### TST-02 — Medium — The single shared serial E2E scenario is order-dependent and one intermittent failure suppresses the rest of the suite

**Classification:** Actual verification-reliability finding.

**Evidence**

- `tests/e2e/app.spec.ts:6-9` stores one global app, page, user profile, and error array for every test.
- `tests/e2e/app.spec.ts:18-30` uses `test.describe.serial`, launches only once in `beforeAll`, and cleans up only in `afterAll`.
- Tests deliberately leave state for later tests: `tests/e2e/app.spec.ts:79-94` changes viewport and panel state, while `tests/e2e/app.spec.ts:96-105` immediately assumes the Browser tab can attach in that inherited state.
- `tests/e2e/app.spec.ts:101` uses a fixed 2.5-second sleep instead of waiting on a guest readiness event.
- `playwright.config.ts:5-7` further fixes the suite to one worker with no retries or repeat-each stress.

**Impact**

A timing or state leak in an early smoke test prevents later independent coverage (resize, PTY, and window recreation) from running. Results do not reliably identify which feature is broken, and a test passing alone does not show that the suite is stable.

**Realistic trigger**

The audit's first `npm run test:e2e` timed out at `tests/e2e/app.spec.ts:100` with zero browser guests, after which tests 7-9 did not run. The exact browser test passed when run alone, and the full suite passed on immediate rerun. That pass/fail/pass pattern is direct evidence of order/timing sensitivity.

**Remediation**

Use a fixture that launches a fresh isolated app (or explicitly resets all app state) for each logically independent test. Avoid `describe.serial` except for one intentionally end-to-end journey; split PTY, browser, resize, and lifecycle cases. Replace the fixed sleep with readiness assertions/events. Reset diagnostic arrays per test, and add a repeat stress job (for example `--repeat-each=10`) for the browser/window lifecycle cases.

---

### TST-03 — Medium — Rejected settings writes leave invalid optimistic values active in the renderer

**Classification:** Actual production-code finding exposed by missing renderer tests.

**Evidence**

- `src/App.tsx:226-232` applies a settings patch to React state before IPC validation; the rejection path only calls `reportError` and never restores the prior settings.
- `src/pages/SettingsPage.tsx:10` sends `browserHome` and `terminalShell` updates on every input `onChange`, so partial values are expected during ordinary typing.
- `electron/main/settings-schedules.ts:29-31` rejects a non-web browser URL and rejects a shell that fails `validateShell`; only a valid patch reaches persisted state.
- `vitest.config.ts:5-7` runs Node tests, and the only renderer-focused unit tests are event reduction and server-rendered Markdown (`tests/backend/events.test.ts:1-24`, `tests/backend/markdown.test.ts:1-27`); there is no test of settings failure/rollback.

**Impact**

The visible configuration can diverge from persisted configuration. In particular, an invalid optimistic terminal shell is passed to terminal creation, causing terminals to fail until the user repairs the value or restarts. The UI communicates an error toast but continues displaying and using the rejected value.

**Realistic trigger**

A user edits `/bin/zsh` by selecting and typing a new shell. Intermediate strings such as `/bin/` are submitted and rejected. React keeps the rejected intermediate value. If the user toggles the terminal before a later valid write, terminal creation validates the stale UI value and fails, while restart silently restores the older persisted value.

**Remediation**

Keep local draft fields and commit on blur/Enter/explicit Save, or retain the previous settings snapshot and roll back on IPC rejection. Surface field-level validation and await the update. Add renderer tests with a rejecting preload bridge covering URL and shell edits, rollback, error display, and successful persistence.

---

### TST-04 — Medium — The most important Electron IPC/webview trust boundaries are not regression-tested

**Classification:** Security test gap; no bypass was established.

**Evidence**

- `electron/main/ipc.ts:36-50` makes authorization depend on sender ID, main-frame identity, exact frame URL, destruction state, and registration lifecycle.
- `electron/main/index.ts:83-106` mutates webview preferences and blocks disallowed attach/navigation/redirect/frame-navigation paths.
- `electron/main/index.ts:140-150` authorizes after trusted load and revokes on untrusted navigation, renderer death, or close.
- The E2E bridge test at `tests/e2e/app.spec.ts:32-41` only proves that the trusted main renderer receives API groups.
- The browser test at `tests/e2e/app.spec.ts:96-105` only checks that one correctly partitioned webview element exists and that two error strings were not logged; it never attempts IPC from a guest/subframe, a wrong partition, a credentialed/disallowed URL, or after revocation.

**Impact**

A regression in the primary boundary between untrusted web content and filesystem/process IPC could ship while all current tests remain green. Typechecking cannot validate Electron event provenance, and the current positive-path E2E assertion would not detect an accidentally exposed preload bridge in a guest.

**Realistic trigger**

A future Electron upgrade changes `senderFrame` behavior, or a refactor removes one conjunct in `verify`/one revocation listener. The trusted renderer still loads and the browser guest still attaches, so both current tests pass, but guest content or a stale navigated renderer can invoke terminal, Git, plugin, or agent channels.

**Remediation**

Add main-process unit tests around `registerIpc` with mocked sender/main-frame combinations and lifecycle revocation. Add Electron integration tests that assert `window.prime` is absent in the guest, reject a wrong partition and unsafe/credentialed sources, deny subframe/guest IPC, revoke after untrusted navigation and destruction, and verify permission requests are denied. Keep these adversarial cases separate from the positive smoke test.

---

### TST-05 — Medium — Core session transcript/metadata semantics have almost no fixture coverage

**Classification:** Functional correctness test gap.

**Evidence**

- `electron/main/sessions.ts:151-213` reconstructs a branch from parent IDs, merges assistant/tool records, caps image data, and derives streaming state from loosely typed JSONL.
- `electron/main/sessions.ts:286-355` independently scans JSONL to derive session identity, title, timestamps, depth, model, lifecycle/status, and preview from many event shapes.
- The only direct `SessionService` test, `tests/backend/store.test.ts:29-46`, writes a single `{"type":"session"}` line and tests archive visibility; it does not assert parsing, branching, message parts, status, or malformed input.
- `tests/backend/jsonl.test.ts:4-19` correctly tests framing/size, but not the higher-level session interpretation.

**Impact**

Changes in Prime Agent JSONL formats or local parser refactors can silently produce missing messages, a wrong conversation branch, mis-associated tool results, incorrect status, or blank/misleading titles without failing CI/local tests. These are central user-facing data-integrity behaviors.

**Realistic trigger**

A transcript contains branched messages, multiple assistant fragments, `tool_call`/`toolResult` variants, malformed lines, and a live streaming runtime. A refactor changes leaf selection or role normalization; the UI shows an obsolete branch or tool output in the wrong assistant turn, while the archive-only test remains green.

**Remediation**

Create a checked-in, synthetic corpus representing current and legacy Prime JSONL shapes. Assert branch selection, cycles/orphans/duplicate IDs, malformed and oversized records, assistant/tool merging, image caps, timestamps, status precedence, live-catalog overrides, streaming flags, rename fallback, and session-root/symlink authorization. Add contract fixtures captured from supported Prime Agent versions with secrets removed.

---

### TST-06 — Medium — There is no scale/performance regression test for startup session discovery

**Classification:** Performance test gap with a concrete unbounded-work path (within high caps).

**Evidence**

- `electron/main/sessions.ts:120-143` admits up to 5,000 session files and calls `readMetadata` for each, six at a time.
- `electron/main/sessions.ts:286-336` scans every record of every admitted file, permitting up to 256 MiB and 200,000 records per file.
- `src/App.tsx:155-174` waits for the entire `Promise.allSettled` batch—including session listing—before applying even already-completed metadata, settings, projects, and runtime results.
- The only session fixture in `tests/backend/store.test.ts:30-46` is a one-line tiny file. No test or configured threshold measures list/startup latency, memory, renderer responsiveness, transcript render size, or build bundle size.

**Impact**

A large but permitted session history can turn startup into prolonged CPU/disk work and delay all initial UI hydration. A seemingly harmless parser or rendering change can materially worsen launch latency without any failing verification gate.

**Realistic trigger**

A long-time user accumulates thousands of JSONL files, several containing tens of thousands of records. Launch triggers concurrent full scans; because App waits for all settled promises, project/settings/meta state is not committed until the slow session list finishes. Existing tests complete instantly and cannot catch the regression.

**Remediation**

Add generated scale fixtures and budgets for `SessionService.list`, metadata memory, and first usable renderer state (cold and warm cache). Refactor verification targets around paginated/indexed metadata or bounded tail/header reads, and test progressive App hydration so unrelated services render before session discovery completes. Add a bundle-size budget to the build gate as a separate lightweight performance guard.

---

### TST-07 — Medium — Normal build/test/package commands do not gate on Electron E2E results

**Classification:** Verification-gate finding.

**Evidence**

- `package.json:15-17` defines `test` as only `vitest run` and E2E as a separate command.
- `vitest.config.ts:5-7` includes only `tests/**/*.test.ts`; the Electron suite is `tests/e2e/app.spec.ts`, so `npm test` cannot discover it.
- `package.json:12` makes `build` run only typecheck plus `electron-vite build`.
- `package.json:18` makes `package:mac` depend on that build, not on either test suite.

**Impact**

The standard green commands can produce and package an app whose preload/window/browser/PTY integration suite is failing. The failure observed during this audit did not affect `npm test`, `npm run build`, or the packaging dependency chain.

**Realistic trigger**

A change breaks webview attachment or last-window recreation. A maintainer runs `npm test` and `npm run build`, both pass, then produces a DMG via `package:mac`; no script in that path executes Playwright.

**Remediation**

Add a canonical `verify` script that runs typecheck, unit/integration tests, coverage, build, and hermetic E2E. Gate release/package workflows on it (or an equivalent required CI matrix). Keep a faster explicit `test:unit` for iteration, but make documentation and release automation use `verify`.

---

### TST-08 — Low — Browser-data clearing reports success to the UI even when the service returns failure, and the confirming path is untested

**Classification:** Actual production error-reporting finding plus safety-test gap.

**Evidence**

- `electron/main/settings-schedules.ts:34-43` catches any clear failure and returns `false`.
- `src/App.tsx:426` ignores that boolean and always increments `browserGeneration`, remounting the browser as though clearing succeeded.
- `src/pages/SettingsPage.tsx:10` invokes `onResetBrowser` with `void` and immediately closes the irreversible-action dialog.
- `tests/e2e/app.spec.ts:64-76` tests only Escape/cancel/focus restoration; it never clicks “Clear browsing data” or verifies cookies/cache/download cancellation and failure behavior.

**Impact**

Users can be told by the completed UI flow that local browsing data was cleared when cookies/auth/cache remain. This is especially problematic because the dialog describes an irreversible privacy action.

**Realistic trigger**

Electron rejects one clearing operation because a session is closing or storage is busy. `Promise.all` rejects, the service returns `false`, but the dialog closes and browser remounts without an error; the user assumes sign-in data was removed.

**Remediation**

Propagate a thrown error or inspect the boolean, keep the dialog busy/open until completion, and show explicit success/failure. Add an isolated-profile E2E test that seeds a cookie/storage value, confirms clearing, verifies removal and active-download cancellation, then injects a clear failure and verifies the UI does not claim success.

---

### TST-09 — Low — Coverage is configured but cannot run and has no enforcement policy

**Classification:** Test-tooling gap.

**Evidence**

- `vitest.config.ts:7` configures text/HTML coverage reporters.
- `package.json:31-43` lists dev dependencies but no Vitest coverage provider.
- `package.json:15` has no coverage script or flag.
- During this audit, `npm test -- --coverage` stopped with `MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'`.
- `vitest.config.ts:7` also defines no include-all-source policy or line/branch/function thresholds.

**Impact**

The apparent coverage configuration provides no usable measurement or regression gate. Entire sensitive modules (`ipc.ts`, settings/schedules, most session logic, renderer orchestration) can remain untouched without a visible signal.

**Realistic trigger**

A maintainer tries to assess coverage before release; the command fails. They run ordinary tests instead, which remain green despite newly uncovered branches or whole files.

**Remediation**

Install the Vitest-version-compatible coverage provider, add `test:coverage`, include all `electron/**/*.ts` and `src/**/*.{ts,tsx}` production files (not only imported files), and establish ratcheting branch/line/function thresholds. Publish the report from the canonical verify/CI workflow; do not treat thresholds as a substitute for the adversarial and scale tests above.

## Positive verification practices

- The backend suite is small but unusually substantive where it does exist: `tests/backend/security.test.ts:68-164` uses real child processes to verify TERM/KILL escalation, process admission shutdown, and outbound-byte limits.
- `tests/backend/git.test.ts:15-50` operates on an isolated real Git repository and covers destructive restore as well as stage/unstage/commit, avoiding mocks that would miss argv behavior.
- `tests/backend/terminal.test.ts:16-30` opens a real PTY and verifies detached descendants are killed, with defensive cleanup.
- `tests/backend/browser-downloads.test.ts:25-49` covers unsafe schemes, gesture/setting checks, size caps, aggregate concurrency, owner teardown, and streaming cap crossing.
- `tests/backend/projects.test.ts:19-42` and `tests/backend/security.test.ts:24-66` exercise symlink/path authorization and inferred-project boundaries with temporary roots.
- `tests/backend/markdown.test.ts:19-27` explicitly verifies raw HTML is not enabled and remote Markdown images are not loaded.
- E2E tests use role/label locators and cover modal focus/inert restoration, compact overlays, keyboard tab navigation, resize accessibility, PTY presence, and macOS window recreation (`tests/e2e/app.spec.ts:44-176`). Retained traces are useful once the data-isolation defect is fixed.
- Typecheck, backend tests, and the production build all passed during this audit.

## Dismissed false alarms / limits

- I did **not** report the macOS-specific real-PTY test as a portability defect: the checked-in packaging target is explicitly macOS (`package.json:59-68`), and the PTY test passed on the target platform.
- I did **not** treat the 2.5-second browser delay as proof of a product navigation bug. It is a test-robustness smell and is included only as part of the empirically flaky shared E2E design; the browser test passed in isolation and on rerun.
- I did **not** claim an IPC or webview exploit. The reviewed production checks are defense-in-depth and appear deliberate; TST-04 is specifically the absence of adversarial regression verification.
- I did **not** infer low quality merely from test count or lack of coverage percentage. Findings are tied to concrete high-risk paths, an unusable command, observed E2E instability, or user-visible failure handling.
- `tests/backend/store.test.ts:21-28` says it “backs up” corrupt state but asserts only fallback defaults. The implementation does attempt the backup (`electron/main/store.ts:94-103`); this is a narrow assertion omission, not evidence that backup is broken, so it was not elevated to a separate finding.
