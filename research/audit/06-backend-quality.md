# Electron main/backend quality audit

**Scope.** Static and test-backed audit of `electron/main/**`, `electron/preload/**`, the shared bridge types, their renderer consumers, and backend/E2E tests. Production code was not changed. I ran `npm test -- --reporter=dot` (12 files, 33 tests passed) and `npm run typecheck` (passed).

## Executive summary

The backend has unusually good security fundamentals for an Electron application: sandboxing and context isolation are enabled, IPC checks both the authorized `WebContents` and main frame URL, filesystem roots are canonicalized, child commands use argv rather than shells, and process/event/output limits exist. The principal risks are not missing baseline hardening, but shared mutable state and duplicated workflows: project authorization can race, startup does duplicate full session/plugin scans, the Git change contract cannot represent a normal Git state, and several error paths turn failure or truncation into apparently valid data.

### Findings by severity

| Severity | Count |
|---|---:|
| High | 1 |
| Medium | 8 |
| Low | 2 |
| Critical | 0 |

## Findings

### 1. High — The mutable project authorization cache can re-authorize a removed project during a concurrent list

**Evidence.** `ProjectService.list()` takes a persisted snapshot at `electron/main/projects.ts:34-35`, clears the live authorization set at `electron/main/projects.ts:41`, then mutates that shared set incrementally at `electron/main/projects.ts:43-52`, including an `await` for each branch lookup. `remove()` independently clears and reconstructs the same set at `electron/main/projects.ts:152-169`. Authorization trusts the cache and only rebuilds when it is completely empty at `electron/main/projects.ts:209-217`. The existing revocation test is sequential (`tests/backend/security.test.ts:34-48`) and does not overlap `list()` and `remove()`.

**Impact.** This is both a correctness race and an authorization-boundary regression. A directory the user removed can remain authorized for Git, terminal, file listing, agent cwd, and reveal operations until another cache rebuild. Conversely, while `list()` has populated only its first roots, valid operations against later projects can be spuriously denied.

**Realistic trigger.** With projects A and B, begin `projects:list`. It snapshots both, adds A, and waits in A's Git branch lookup (which can take up to two 5-second subprocesses). Remove B during that wait; `remove()` reconstructs the set without B. The stale `list()` then resumes, iterates its old B record, and adds B back. The same incremental construction can reject a terminal or Git request for B while A's branch is still resolving.

**Remediation.** Do not mutate the authorization boundary as a side effect of presentation-oriented `list()`. Derive authorized roots from a versioned store snapshot for each sensitive operation, or build a complete local `Set` and atomically publish it only if the store generation still matches. Serialize/remove invalidation against publication. Add a test with a deliberately blocked branch provider, overlap `list()` and removal of a later project, and assert B can never be authorized afterward.

### 2. Medium — Startup can perform two complete, uncached transcript-catalog scans

**Evidence.** The renderer starts `projects.list()` and `sessions.list()` concurrently at `src/App.tsx:155-160`. `ProjectService.list()` itself calls the session provider at `electron/main/projects.ts:26-27`, bound to another `sessions.list()` at `electron/main/index.ts:162-164`. Every `SessionService.list()` enumerates up to 5,000 JSONL files (`electron/main/sessions.ts:120-127`) and calls `readMetadata()` for each (`electron/main/sessions.ts:127-141`). `readMetadata()` streams the entire file, accepting files up to 256 MiB and 200,000 records (`electron/main/sessions.ts:286-336`). Only the separate CLI live catalog has request coalescing/cache (`electron/main/sessions.ts:246-266`); parsed JSONL metadata does not.

**Impact.** Application startup and refresh cost grows with the entire historical transcript corpus rather than changed sessions. The two initial requests can create 12 concurrent readers (two scans, limit six each). Under the declared limits, the backend may read an enormous amount of data merely to populate the sidebar, delaying projects, sessions, Git branches, and first interaction while generating avoidable I/O and garbage.

**Realistic trigger.** A long-time user with hundreds of multi-megabyte sessions launches the app. `projects:list` and `sessions:list` independently parse every transcript. On a slower or synced home directory, startup appears hung and repeated launches compound load.

**Remediation.** Create one `SessionCatalog` service with a coalesced in-flight refresh and cache metadata by canonical path plus `mtime`/size (or consume authoritative CLI catalog data and lazily parse only missing preview fields). Have both project aggregation and the sessions IPC use the same immutable catalog snapshot. In the renderer, avoid requesting data already necessarily produced by another aggregate call, or expose a single bootstrap endpoint. Add a test that concurrent project/session listing invokes metadata parsing once per file.

### 3. Medium — The Git status contract loses files that are both staged and unstaged

**Evidence.** `GitFileChange` exposes a single `staged: boolean` at `src/types/api.ts:99-105`. Porcelain codes with both index and worktree changes (for example `MM`) are collapsed to one record; the backend sets `staged` solely from the first status column and selects only one numstat map at `electron/main/git.ts:75-83`. The renderer then exclusively partitions records by that boolean at `src/components/Inspector.tsx:73-87`.

**Impact.** A common Git state cannot be represented. The unstaged portion of an `MM`, `AM`, or similar file disappears from the Unstaged tab, its diff and line counts are hidden, and the user can commit believing all visible work for that file is staged. The hidden working-tree edits only become visible after another state change such as committing or unstaging.

**Realistic trigger.** Edit a tracked file, stage it, then edit it again. `git status --porcelain` returns `MM`; Prime Work shows the file only under Staged and displays the cached diff, while the second edit is absent from the review UI.

**Remediation.** Model index and worktree state independently (for example `indexStatus`, `worktreeStatus`, `stagedStats`, `unstagedStats`) or return separate scoped change records with stable composite keys. Parse both porcelain columns and both numstat maps. Extend `tests/backend/git.test.ts:15-50` with a stage-then-edit case and assert the file appears in both scopes with the correct diffs.

### 4. Medium — Git mutation failures are encoded as booleans and then treated as success

**Evidence.** `stage`, `unstage`, and `restore` return only a boolean (`electron/main/git.ts:104-118`, `electron/main/git.ts:131-140`; contract at `src/types/api.ts:164`). In the renderer, `mutate()` awaits those calls but never checks the returned boolean, refreshes, and returns `true` at `src/components/Inspector.tsx:104-117`. This differs from `commit`, which returns `{ ok, output }` and is checked at `electron/main/git.ts:120-124` and `src/components/Inspector.tsx:119-126`.

**Impact.** Operational Git failures are silent. The UI can close a destructive-action confirmation and report no error even though restore did nothing, or appear to accept stage/unstage while the state remains unchanged. The backend also discards the stderr needed to explain the problem.

**Realistic trigger.** An existing `.git/index.lock`, filesystem permission failure, or conflicted path causes `git add`, `restore`, or `reset` to exit nonzero. The service resolves `false`; the consumer follows its success path and suppresses the actionable Git error.

**Remediation.** Use one result contract for all Git mutations, such as `{ ok: true } | { ok: false; error: string }`, or throw a typed operational error on nonzero exit. Preserve bounded, ANSI-stripped stderr. Make the renderer branch on the result. Add failure tests using an index lock and assert the error crosses IPC and remains visible.

### 5. Medium — Plugin discovery performs synchronous, weakly bounded filesystem traversal on Electron's main thread, twice at startup

**Evidence.** Discovery recursively calls `existsSync`, `readdirSync`, `lstatSync`, `realpathSync`, and `readFileSync` at `electron/main/plugins.ts:18-23` and `electron/main/plugins.ts:68-97`. Although candidate output is capped at 2,000, the cap counts matching files, so a large tree containing few candidates can still traverse every directory through depth six (`electron/main/plugins.ts:69-83`). The async `list()` contains no yielding asynchronous I/O around the scan (`electron/main/plugins.ts:133-192`). The renderer can issue two initial no-project scans: the project-dependent effect at `src/App.tsx:147-153` and bootstrap request at `src/App.tsx:155-160`.

**Impact.** Because IPC and window lifecycle share the main thread, a large or slow configured tree freezes all windows, terminal/event delivery, and navigation security handlers. Duplicate startup scans double that blocking work. This is not merely module style; it is an availability defect caused by sync I/O in the broker.

**Realistic trigger.** Configure a skills/extensions path on a large monorepo or network/synced volume with a deep `vendor`/generated tree that is not named `node_modules`. Opening Plugins or launching the app synchronously walks the tree and the desktop UI stops responding.

**Remediation.** Move discovery to async `fs/promises` with bounded worker concurrency (or a worker thread for unavoidable synchronous parsers), cap visited directories/entries and elapsed work—not only emitted candidates—and cache/coalesce scans by roots plus mtimes. Consolidate the two renderer load effects. Split the 385-line module into scanner, metadata parser, package installer, and settings repository so discovery cannot block settings mutation concerns.

### 6. Medium — A crash while connecting MCP leaves a permanent settings lock

**Evidence.** `acquireSettingsLock()` creates a lock directory and retries `EEXIST` 40 times (`electron/main/plugins.ts:322-336`). The lock contains no owner PID, creation metadata, lease, or stale recovery. It is removed only by the returned callback (`electron/main/plugins.ts:328-329`), normally reached through `finally` at `electron/main/plugins.ts:222-239`. Existing plugin tests cover successful writes and duplicate names (`tests/backend/plugins.test.ts:11-76`) but not crash/stale-lock recovery.

**Impact.** An application/process crash between lock acquisition and `release()` makes every later MCP connection in that scope fail as “settings are busy” forever. Restarting the app does not recover; the user must know which hidden `.lock` directory to delete manually.

**Realistic trigger.** The app or machine loses power after `mkdirSync(lockPath)` and before the settings rename/finally runs. On every subsequent connection attempt, all 40 retries see the orphan directory.

**Remediation.** Store owner PID, timestamp, and a random token in an atomic lock file/directory; on contention, reclaim only when the lease is expired and the recorded process is demonstrably dead. Release only a lock whose token is still owned. Alternatively use a proven cross-process file-lock library. Add a stale-lock fixture and a concurrent-live-owner test.

### 7. Medium — Schedule listing silently returns a partial result when any one runtime fails

**Evidence.** Without an explicit runtime, the service queries all runtimes and swallows each error at `electron/main/settings-schedules.ts:85-91`. It consults the CLI fallback only when `jobs.length === 0` at `electron/main/settings-schedules.ts:92-102`, then deduplicates and returns without any partial/error marker at `electron/main/settings-schedules.ts:104`.

**Impact.** One successful runtime masks failures from all others. Jobs owned by a failed/busy runtime disappear from the Scheduled page, with no indication that the list is incomplete; the user cannot inspect or cancel those jobs from the UI.

**Realistic trigger.** Two agent runtimes are active. Runtime A returns one schedule while B exits or times out during `list_schedules`. The catch drops B's failure, A makes `jobs.length` nonzero, and the CLI fallback that could recover B's persisted jobs is skipped.

**Remediation.** Track failed runtime IDs separately. If any runtime query fails, merge the CLI fallback with successful responses, or return `{ jobs, errors, complete }` so the UI can show partial state. Do not use output emptiness as a proxy for request success. Add ScheduleService tests for mixed success/failure and duplicate merging.

### 8. Medium — Process output limiting can surface a truncated Git diff as valid text

**Evidence.** `ProcessResult` has no truncation/output-limit field (`electron/main/process-utils.ts:7`). Once a stream passes `maxBytes`, `collect()` merely sends `SIGTERM` and keeps the bounded prefix (`electron/main/process-utils.ts:97-104`); close resolves the same result shape at `electron/main/process-utils.ts:112-118`. `GitService.diff()` permits 24 MiB and, on nonzero exit, still returns `stderr || stdout` as the diff text with no error state (`electron/main/git.ts:91-101`).

**Impact.** Callers cannot distinguish complete output from a prefix cut at the safety limit. Review is integrity-sensitive: showing an incomplete diff without a truncation banner can cause omitted changes to escape review. A child that handles/ignores TERM also continues until the normal timeout because output overflow has no dedicated escalation state.

**Realistic trigger.** Review a generated or otherwise very large text diff over 24 MiB. The process is terminated, the collected stdout prefix is returned in `GitDiff.text`, and the inspector renders it as if it were the whole patch.

**Remediation.** Add `outputExceeded` (and ideally per-stream byte counts) to `ProcessResult`; stop collecting after the first overflow, use a bounded TERM-to-KILL escalation, and require callers to handle overflow explicitly. For Git diff, return a discriminated `{ ok, text, truncated/error }` result and display a clear limit message rather than partial content alone. Add an oversized-output subprocess test and a Git contract test.

### 9. Medium — `extension_ui_response` bypasses the reliable RPC write path and acknowledges before delivery

**Evidence.** Most commands use `request()`, which installs timeout/pending accounting and observes the `stdin.write` callback at `electron/main/agent-rpc.ts:325-353`. `extension_ui_response` instead performs a direct write and immediately returns synthetic success at `electron/main/agent-rpc.ts:274-279`; it neither observes callback errors/backpressure nor receives an agent acknowledgement. This duplicated special path lives inside the 511-line transport/validation/runtime module.

**Impact.** A confirmation/input response can be reported to the renderer as successful even if the pipe fails just after the writable check. The agent may remain blocked waiting for UI input while the desktop believes the response was delivered, with no pending request to reject or time out.

**Realistic trigger.** The agent exits or closes stdin between `stdin.writable` and completion of the write. Node reports the asynchronous write error via callback/stream, but this invocation has already resolved `{ success: true }`.

**Remediation.** Extract one framed-writer abstraction used by both requests and one-way messages. At minimum await the write callback, enforce a byte/in-flight budget, and fail on close/error; preferably define an RPC acknowledgement for extension UI responses. Add a fake-agent test that closes stdin during this command and assert the invocation rejects rather than synthesizing success.

### 10. Low — Initial renderer load failures escape bootstrap and can leave an invisible window

**Evidence.** `createWindow()` starts `window.loadURL(trustedRendererUrl)` with `void` at `electron/main/index.ts:147-153`. The outer startup `.catch` at `electron/main/index.ts:202-230` cannot observe that detached promise. The window is initially hidden at `electron/main/index.ts:116-122` and shown only on `ready-to-show` at `electron/main/index.ts:147`.

**Impact.** A failed initial navigation can become an unhandled rejection while the user sees no window and bootstrap still appears successful.

**Realistic trigger.** The development renderer server disappears between URL resolution and navigation, or a packaged renderer asset is missing/corrupt. `ready-to-show` never arrives and no recovery/error window is presented.

**Remediation.** Make creation/loading asynchronous and await it from bootstrap, or attach an explicit catch that logs bounded diagnostics, destroys the hidden window, and shows a controlled startup error/retry. Test an intentionally unavailable renderer URL.

### 11. Low — Backend E2E coverage is non-hermetic and can pass by skipping the real integration

**Evidence.** `SessionService` hard-codes `~/.prime/agent/sessions` at `electron/main/sessions.ts:100-108`. E2E launch isolates only Electron `userData`, not `HOME` or the agent/session root (`tests/e2e/app.spec.ts:18-24`). The PTY test obtains whatever project exists in the developer's real catalog and skips when none exists (`tests/e2e/app.spec.ts:149-168`).

**Impact.** Results depend on the executing user's private sessions, installed agent, filesystem, shell, and network. A clean CI machine can report green while skipping terminal authorization; a developer machine can expose real project metadata to the test process and exhibit unrelated slowness/flakes. Important bootstrap/catalog behavior is not reproducible.

**Realistic trigger.** Run E2E on clean CI: no local session-derived project exists, so the only real PTY integration is skipped. Run it on a workstation with thousands of sessions: startup behavior and selected project differ from CI.

**Remediation.** Inject `sessionRoot`, agent executable, and home/config roots (as `PluginService` already permits for `agentDir`), launch E2E with fixture directories and a deterministic fake RPC agent, and fail rather than skip the required PTY path. Keep a separately labeled opt-in host-integration suite if desired.

## Oversized-module and refactor assessment

The backend is not broadly bloated, but four files carry several independent reasons to change:

| File | Lines | Concrete seam |
|---|---:|---|
| `electron/main/agent-rpc.ts` | 511 | Extract command schemas/validation, framed transport, `RpcRuntime`, event forwarding, and registry. Finding 9 demonstrates that duplicated transport paths already behave differently. |
| `electron/main/plugins.ts` | 385 | Extract async discovery/indexing, metadata parsing, package-source/install, and locked settings repository. Findings 5 and 6 are independent failure domains currently coupled here. |
| `electron/main/sessions.ts` | 356 | Extract JSONL transcript projection from a cached/coalesced session catalog and runtime overlay. Finding 2 is the missing catalog seam. |
| `electron/main/index.ts` | 251 | Extract renderer protocol/window hardening and lifecycle/bootstrap orchestration. Finding 10 is caused by detached window loading inside synchronous construction. |

`ipc.ts` (133), `git.ts` (142), `store.ts` (134), `terminal.ts` (190), and validation/process helpers are reasonably sized. The priority should be the seams above, not arbitrary line-count reduction.

## Positive observations

- **Strong Electron boundary:** sandbox, context isolation, disabled Node integration, guest hardening, permission denial, navigation restrictions, and a packaged CSP are explicit (`electron/main/index.ts:83-107`, `electron/main/index.ts:125-134`, `electron/main/index.ts:205-219`).
- **IPC authorization is defense-in-depth:** registration verifies the authorized sender ID, non-destroyed sender, main frame identity, frame URL, and `WebContents` URL on every call (`electron/main/ipc.ts:36-58`), and revocation kills owned terminals (`electron/main/ipc.ts:121-131`).
- **Input validation is substantive, not cosmetic:** filesystem realpaths, root containment, typed records, unknown-key rejection, argument bounds, command allowlisting, and URL credential rejection are applied at backend trust boundaries (`electron/main/validation.ts:10-85`, `electron/main/agent-rpc.ts:39-143`).
- **Subprocess execution avoids shell interpolation** and strips dangerous inherited loader options (`electron/main/process-utils.ts:39-47`, `electron/main/process-utils.ts:66-83`). Shutdown closes admission before snapshots and has focused race tests (`electron/main/process-utils.ts:28-37`, `tests/backend/security.test.ts:116-164`).
- **Resource limits are pervasive:** transcript sizes/record counts, RPC pending bytes/counts, event envelopes/windows, terminals/output, downloads, and process output/time are all bounded. The issue in Finding 8 is reporting the limit, not absence of one.
- **State updates are serialized and durably fsynced** (`electron/main/store.ts:86-133`), with concurrent-update and corruption tests (`tests/backend/store.test.ts:11-28`).
- **Bridge/channel coverage currently matches:** every main invoke/event input channel has a preload caller; the only preload-only names are the three intentional outbound subscriptions (`agent:event`, `terminal:data`, `terminal:exit`).

## Dismissed false alarms / non-findings

- **No shell injection in Git/package/agent calls.** Inputs are passed as argv with `shell: false`; Git paths are placed after `--`, and package/MCP inputs are validated. Strings beginning with `-` are explicitly rejected where they could become options.
- **No project symlink escape found.** Authorization canonicalizes via `realpath`, and recursive file listing skips symlinks (`electron/main/projects.ts:189-205`, `electron/main/validation.ts:48-65`).
- **The custom protocol traversal check is not vulnerable to ordinary `..`, encoded separators, NULs, credentials, query, or fragment tricks** on the currently configured macOS target (`electron/main/index.ts:39-56`).
- **The unbounded-looking agent event stream is bounded before Electron IPC.** Envelope size, count, and byte-window controls are implemented and directly tested (`electron/main/agent-rpc.ts:146-221`, `tests/backend/security.test.ts:86-114`).
- **Store concurrent updates are not a lost-update bug.** They are deliberately serialized through `queue` and clone/persist/publish in order (`electron/main/store.ts:107-116`).
- **Broad inferred roots are not silently authorized.** `/` and the home directory are excluded, and inferred projects require an explicit grant before sensitive operations (`electron/main/projects.ts:56-77`, `electron/main/projects.ts:112-133`); tests cover this boundary.

## Recommended order

1. Make project authorization publication atomic and add the concurrency regression test (Finding 1).
2. Introduce the shared cached session catalog and remove duplicate startup scans (Finding 2).
3. Correct the Git change/result contracts before expanding Git UI behavior (Findings 3, 4, and 8).
4. Make plugin discovery asynchronous/coalesced and make locks recoverable (Findings 5 and 6).
5. Fix partial schedule reporting and unify agent transport writes (Findings 7 and 9).
6. Make lifecycle load errors observable and hermeticize E2E fixtures (Findings 10 and 11).
