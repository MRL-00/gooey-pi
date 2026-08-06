# Data Integrity and Async/Concurrency Audit

## Scope and method

Reviewed the Electron main process, preload bridge, React renderer, and all backend/E2E tests, with emphasis on project/session identity, persistence, plugins/settings, IPC, process lifetime, and event ordering. This was a source audit only; no production code was changed. `npm test` completed successfully: **12 files, 33 tests passed**. The findings below are nevertheless reachable orderings or explicit failure paths not covered by the current suite.

## Executive summary

The most serious risks are in the renderer's treatment of project- and session-scoped async state. Git status can arrive for an old project and then drive a destructive operation in the new project; an active runtime can remain bound to an old project and receive a prompt after the UI moves to another; and prompt submission has no single-flight guard, so two runtimes can be started for one logical send. Persistence inside `JsonStateStore` is substantially better: updates are serialized and the file replacement is crash-conscious.

## Findings

### 1. High — A late Git/project request can make the Changes UI operate on the wrong repository

**Evidence**

- `src/App.tsx:219-224` starts `git.status(activeProject.primaryFolder)` and unconditionally calls `setGit` when it finishes; there is no request generation or check that the project is still active.
- `src/App.tsx:234-240` similarly lets a completed inferred-project grant unconditionally select that project and install its Git status.
- `src/App.tsx:261-270` allows another project/session selection while those awaits are outstanding.
- `src/components/Inspector.tsx:73-82` combines the current project's `cwd` with the separately supplied `git.files` snapshot.
- `src/components/Inspector.tsx:103-108` executes stage/unstage/restore against that current `cwd`, while `src/components/Inspector.tsx:127-137` obtains the paths from the potentially stale `git.files` and exposes the destructive Revert action.

**Impact**

Project identity and Git data can diverge. The strongest consequence is permanent loss of uncommitted work: a path displayed from repository A can be passed to `git restore` in repository B. Stale branches, diffs, stage-all sets, and commit context can also be shown under the wrong project.

**Realistic failure scenario**

Repository A has a slow `git status` (large working tree or slow filesystem). The user switches to B; B's status completes first. A then completes and overwrites `git`. The inspector now has B as `project`/`cwd` but A's changed-file list. If both repositories contain `src/config.ts` and the user confirms Revert on the displayed A entry, the command restores `src/config.ts` in B.

**Remediation**

Store Git state with its project identity, e.g. `{ projectId, cwd, requestId, status }`. Increment a generation on project change and only commit a response if both generation and canonical cwd still match. Apply the same guard to `grantProject`. Before any mutation, require the Git snapshot's cwd to equal the current canonical project cwd; disable actions while status is absent/stale. Key or reset `ChangesPanel` by project ID. Add a deferred-promise test that resolves A after B and asserts no A paths can be acted on in B.

### 2. High — Runtime state is not bound to the active project/session, so prompts can run in the previous workspace

**Evidence**

- `src/App.tsx:261-264` changes the active project/session but never clears or reconciles `runtime` / `runtimeIdRef`.
- `src/App.tsx:330-346` reuses any current runtime if its ID is still in `agent.list()`; it does not compare `runtime.cwd` with the selected project or `runtime.sessionFile` with the selected session before sending.
- `src/App.tsx:266-273` only recognizes the one runtime already held in React state when selecting a session; it does not query the manager for another runtime belonging to that session.
- During bootstrap, `src/App.tsx:158-170` tries to match runtimes using the render-closure values of `sessions` and `activeSessionId`, not the fulfilled `sessionsResult`, so an idle runtime for the newly selected initial session is normally missed.
- The backend intentionally retains multiple runtimes (`electron/main/agent-rpc.ts:411-448`) and exposes enough identity (`src/types/api.ts:61-68`) to perform the missing checks.

**Impact**

An agent can receive a prompt in the wrong directory/session and modify the wrong project. Existing runtimes become orphaned from the UI; returning to their sessions can start duplicates, consume the four-runtime limit, lose event visibility, and create multiple actors associated with the same transcript.

**Realistic failure scenario**

The user finishes a turn in project A, leaving its runtime idle, then clicks project B (rather than a B session row). The UI shows B, but the A runtime remains live. Sending “update the deployment config” passes the liveness-only check and is sent to A, so A's files/session are changed while the user believes B is active. A similar orphan occurs after relaunch because bootstrap misses a non-streaming runtime.

**Remediation**

Make runtime selection a derived, session/project-keyed operation rather than one global nullable object. On every project/session transition, synchronously detach the old runtime from the composer, query `agent.list()`, and attach only a runtime whose canonical cwd and session file match. At send time, revalidate both identities, not just runtime ID; otherwise start/attach the correct runtime. Bootstrap should use `sessionsResult.value` and the chosen session ID. Consider a backend command that atomically “get or start runtime for session” to make the invariant authoritative.

### 3. High — Prompt submission is re-entrant and can start multiple runtimes for one logical session

**Evidence**

- `src/components/Composer.tsx:44-50` has no synchronous submission ref/lock; `setValue('')` does not prevent a second already-dispatched submit.
- `src/components/Composer.tsx:69-70,94` launches `submit()` with `void`, while the `busy` prop only changes after a later React render.
- `src/App.tsx:317-345` appends the user message and awaits project granting/runtime discovery before marking the runtime streaming. Multiple invocations therefore capture the same null/stale `runtime` and can each call `agent.start`.
- `electron/main/agent-rpc.ts:426-449` admits each start independently (up to four); it has no session-keyed deduplication.

**Impact**

Two agent processes/sessions can be created for one composer action. The last completion wins `runtimeIdRef`; earlier events are ignored, user messages and replies split across transcripts, and runtime slots leak. When resuming an existing transcript, duplicate actors also risk competing writes/actions against the same session context.

**Realistic failure scenario**

On a cold start, the first send clears the textbox but leaves `busy=false` throughout project authorization and the runtime handshake. The user types and submits a second prompt during that delay. Both calls captured no runtime and each starts one; one response stream disappears when the other overwrites `runtimeIdRef`. Even with an existing idle runtime, two sends during the `agent.list()` round trip both use the captured `isStreaming=false` value and can issue two `prompt` commands rather than queueing the second as `follow_up`.

**Remediation**

Set a synchronous `submittingRef` (and visible starting state) before the first await and clear it only after command acceptance/failure. Disable all send/suggestion entry points from that same state. Prefer a session-scoped single-flight promise so concurrent sends await the same start. Add backend idempotency (`clientRequestId`) or a session-keyed get-or-start primitive as defense in depth. Test with two concurrent `onSend` calls and a deliberately delayed handshake.

### 4. Medium — Session loading can overwrite newer live events for the same session

**Evidence**

- `src/App.tsx:188-202` applies agent events directly to `messages`.
- Independently, `src/App.tsx:208-217` reads the transcript and later replaces the entire array with `setMessages(value)`.
- The cancellation flag at `src/App.tsx:213-216` only detects session selection/unmount; it does not detect events received while the same session read was pending.
- `electron/main/sessions.ts:151-165` streams the whole active JSONL file, so a large transcript leaves a meaningful overlap window with agent output.

**Impact**

Thinking/text deltas and tool events that were visible can disappear, the streaming marker can revert, and the renderer can show an incomplete turn until another reload. The JSONL remains authoritative, but the live UI—the user's basis for approvals and follow-up—is stale.

**Realistic failure scenario**

The app opens a large currently running session. While `sessions.read` is parsing it, several deltas arrive and update the transcript. The older read result then resolves and replaces those updates; if the file writer had not flushed the same content when the stream reached EOF, the current output is absent.

**Remediation**

Use a per-session load generation plus an event buffer/sequence. Load the base transcript, then replay events received after the load began before publishing it, or defer event subscription/attachment until hydration completes. Re-read the authoritative transcript on `agent_end` and after transport loss. Test by holding `sessions.read`, injecting events, and resolving the older read afterward.

### 5. Medium — Concurrent project listing can re-authorize a project after removal

**Evidence**

- `electron/main/projects.ts:34-41` snapshots projects, then clears the shared `authorizedRoots` set.
- `electron/main/projects.ts:43-53` performs awaited filesystem/branch work and incrementally adds roots from that old snapshot to the shared set.
- `electron/main/projects.ts:152-169` removes a project, clears the same set, and rebuilds it, but does not serialize against an already-running `list()`.
- `electron/main/projects.ts:209-217` treats the shared set as the authorization source for later file/Git/terminal operations.
- `tests/backend/security.test.ts:34-49` verifies only sequential list → remove → authorize; it does not exercise an overlapping list.

**Impact**

The user's removal/revocation boundary is not stable. A stale `list()` can restore access to the removed folder, allowing subsequent Git, terminal, file-list, or reveal IPC operations until another cache rebuild.

**Realistic failure scenario**

With projects A and B, a `projects:list` call processes A and waits on A's slow branch lookup. The user removes B; removal rebuilds authorization without B. The stale list resumes, processes its snapshotted B, and adds B back to `authorizedRoots`.

**Remediation**

Do not mutate the live authorization set incrementally. Compute roots in a local set, then publish only if a store revision still matches; alternatively serialize list/add/remove/cache rebuild under one mutex. Best is to derive authorization from the current persisted snapshot on each sensitive call (with a versioned cache). Add a deterministic overlap test using a blocked branch provider.

### 6. Medium — PTY data and exit events can be emitted before the renderer subscribes

**Evidence**

- `electron/main/terminal.ts:100-112` spawns the PTY, installs its handlers, and may send `terminal:data` / `terminal:exit` before returning the `terminalId` from `create`.
- Although normal output is batched by a 16 ms timer (`electron/main/terminal.ts:157-159`), exit explicitly flushes immediately and sends exit (`electron/main/terminal.ts:106-110`).
- The renderer waits for `terminal.create()` to resolve and only then installs both subscriptions at `src/components/TerminalDrawer.tsx:85-91`.
- The current terminal test covers descendant cleanup only (`tests/backend/terminal.test.ts:16-30`).

**Impact**

Initial shell output can be missing. A short-lived/failing shell can have its exit lost entirely; after the create promise resolves, the renderer sets `connected=true` even though the backend has already deleted the PTY, leaving a false live indicator and input sent to a nonexistent terminal.

**Realistic failure scenario**

A login shell's startup file prints an error and exits immediately. Main flushes and emits exit before the invoke response reaches React. No listener exists, so the terminal appears connected with neither error nor exit status.

**Remediation**

Introduce an explicit attach/ready handshake: create allocates and buffers per-terminal output/exit, renderer subscribes, then acknowledges readiness and receives/replays the buffer. Another option is a preload-level permanent subscriber with a bounded per-ID buffer established before any create. Include sequence numbers and test an immediately exiting fake PTY.

### 7. Medium — A crash leaves the MCP settings lock permanently wedged

**Evidence**

- `electron/main/plugins.ts:322-336` implements the lock as a persistent `${settingsPath}.lock` directory and treats every `EEXIST` identically for 40 attempts.
- There is no owner token, PID, timestamp, liveness check, or stale-lock recovery.
- Cleanup occurs only through the in-process `finally` at `electron/main/plugins.ts:222-239`; process crash/forced termination cannot execute it.

**Impact**

All future MCP connection attempts for that settings file fail with “settings are busy” after roughly two seconds, across app restarts, until the user manually discovers and removes the directory. A crash after the atomic rename but before release produces this denial even though the prior connection succeeded.

**Realistic failure scenario**

The OS kills the app during `writeSettingsAtomically` or immediately afterward. On relaunch, the lock directory remains. Every Connect server action exhausts the retry loop and fails forever.

**Remediation**

Use a proven cross-process lock implementation with ownership tokens and stale-lock recovery, or store PID/start time/token in an exclusively created lock file and reclaim only after verifying the owner is dead/expired. Release only a lock whose token is owned by this process. Add crash-artifact and live-owner tests.

### 8. Medium — MCP read/modify/write can overwrite settings changed by another writer

**Evidence**

- `electron/main/plugins.ts:203-207` launches `prime-agent package install` outside `settingsMutation` and the MCP lock path.
- `electron/main/plugins.ts:222-236` protects MCP calls only with this service's private lock, then reads the entire settings object, merges one MCP entry, and writes the entire object.
- `electron/main/plugins.ts:314-319,339-345` performs no file version/hash check between read and rename.
- The same service later discovers package registrations from settings (`electron/main/plugins.ts:259-267`), confirming that plugin/package metadata and MCP metadata share the settings domain.

**Impact**

A package/default/model/extension change made by the CLI, an editor, another Prime process, or any writer that does not honor this exact lock can be silently lost when the stale whole-object snapshot is renamed over it.

**Realistic failure scenario**

While Connect MCP holds its directory lock and has read `settings.json`, `prime-agent package install` (or another Prime CLI) records a new `packages` entry. Connect MCP then writes its older object plus `mcpServers`, deleting the just-installed package registration.

**Remediation**

Route all mutations through one cross-process transaction mechanism understood by the CLI, ideally a Prime Agent settings command. Otherwise capture inode/mtime/content hash after read, verify immediately before replace, and retry by re-reading/merging on conflict. Coordinate package install and MCP changes with the same lock protocol and add a concurrent-writer test.

### 9. Medium — Extension UI responses report success before the pipe write succeeds

**Evidence**

- `electron/main/agent-rpc.ts:274-279` special-cases `extension_ui_response`, checks `writable`, calls `stdin.write`, ignores its return/callback, and immediately fabricates `{ success: true }`.
- Other RPC writes explicitly use a completion callback and reject on write error at `electron/main/agent-rpc.ts:325-353`.

**Impact**

Approval/input/cancellation can be lost while the renderer is told it succeeded. The extension/agent may remain blocked waiting for a response, and there is no pending request associated with the write for `fail()` to reject.

**Realistic failure scenario**

The runtime exits between the `writable` check and the asynchronous pipe write, or the pipe errors under backpressure. `agent.command` has already resolved success, while the response never reached the agent.

**Remediation**

Return a promise settled by the write callback; reject on callback error, `error`, or premature `close`. Respect `write() === false`/`drain` where necessary. If the protocol provides an acknowledgment, use the normal request/response path rather than a fabricated success. Add a test that closes stdin during the response write.

### 10. Medium — Browser-data reset failures and partial clears are treated as success by the UI

**Evidence**

- `electron/main/settings-schedules.ts:34-43` starts six clear operations with `Promise.all` but catches any rejection and returns only `false`; other operations can still be running or may already have partially succeeded.
- `src/App.tsx:423-427` ignores that boolean and always increments `browserGeneration`, recreating the browser surface.
- `src/pages/SettingsPage.tsx:12-16` fires `onResetBrowser()` with `void` and closes the confirmation modal immediately, with no result/error state.

**Impact**

Users can believe cookies, auth, cache, and history were cleared when some or all remain. If one promise rejects early, the newly recreated webview can also race the still-running clear operations, producing a partially reset profile.

**Realistic failure scenario**

`clearAuthCache()` rejects while `clearStorageData()` is still pending. Main returns `false`; React ignores it, recreates the browser, and closes the dialog. The user proceeds assuming sign-in data was removed even though the reset was incomplete.

**Remediation**

Use `allSettled`, await every clear, return structured per-partition/per-operation results, and do not recreate the webview until all work settles. Surface failure/partial-success and keep a retry action. The modal should await the result and only claim/behave as success when it is complete.

### 11. Low — Git mutation/commit failures are discarded by the Changes panel

**Evidence**

- Backend methods deliberately return success values (`electron/main/git.ts:104-124`).
- `src/components/Inspector.tsx:103-108` ignores the booleans from stage/unstage/restore.
- `src/components/Inspector.tsx:111-115` ignores `{ ok, output }` from commit, closes the modal, and clears the message regardless.

**Impact**

The UI provides a completed interaction after lock conflicts, hooks, identity errors, or Git command failures. A failed commit message is lost from the form; a user may proceed believing work was committed or restored. Refresh can eventually reveal the unchanged state, but no cause is shown.

**Realistic failure scenario**

A pre-commit hook rejects a commit. The backend returns `ok:false` with hook output; the renderer closes the modal and erases the message without showing the failure.

**Remediation**

Check every returned status. Throw/display backend output on false, preserve the commit modal/message for retry, and only refresh/close after success. Disable concurrent mutations and associate their completion with the same project snapshot described in finding 1.

### 12. Low — Event throttling leaves the live transcript permanently incomplete until manual reload

**Evidence**

- `electron/main/agent-rpc.ts:176-196` drops non-exit events beyond 500 events/s, 8 MiB/envelope, or 32 MiB/window; it forwards only a transport-error marker.
- The decoder accepts records up to 16 MiB (`electron/main/agent-rpc.ts:247`), so an otherwise valid event can exceed the forwarder's 8 MiB cap.
- `src/lib/events.ts:89-92` turns `transport_error` into a system message and finalizes streaming, but `src/App.tsx:188-201` does not rehydrate from the authoritative session afterward.
- `tests/backend/security.test.ts:86-114` intentionally verifies dropping, but not transcript recovery.

**Impact**

Large tool results or bursts are absent from the live transcript; later deltas may start a second synthetic assistant message after the first was finalized. The error is visible (so this is not silent corruption), and disk JSONL remains intact, which limits severity, but the event view does not converge automatically.

**Realistic failure scenario**

An agent emits a valid 9 MiB `tool_execution_end` record. The decoder accepts it, the forwarder drops it and emits `transport_error`, and the current UI never displays the tool result unless the user changes sessions/reloads.

**Remediation**

After a throttle/error and on `agent_end`, re-read the current transcript and reconcile by stable entry IDs. Prefer bounded truncation/coalescing with an explicit “output truncated; reload” part over dropping semantic lifecycle events. Treat `agent_start`/`agent_end` as critical control events even when data events are throttled.

### 13. Low — Failed settings persistence leaves optimistic renderer state divergent

**Evidence**

- `src/App.tsx:226-231` applies the patch optimistically to React and panel state before awaiting persistence.
- The catch at `src/App.tsx:231-232` only shows an error; it neither rolls back nor fetches `settings.get()`.
- Backend persistence occurs before swapping in-memory state (`electron/main/store.ts:107-113`), so a disk error correctly leaves backend state old while the renderer remains new.
- Settings inputs send updates on every change (`src/pages/SettingsPage.tsx:12-15`), making validation/persistence failures during partial edits routine rather than theoretical.

**Impact**

The visible preference can differ from behavior and from what survives restart. This matters for browser download prompting, terminal shell choice, and privacy/telemetry expectations.

**Realistic failure scenario**

Disk-full or an invalid intermediate browser URL makes `settings.update` reject. The UI continues displaying the optimistic value and the current window may behave from it, while the main process and saved file retain the previous setting.

**Remediation**

Keep the previous snapshot and roll back on failure, or immediately resynchronize with `settings.get()`. For free-text fields, edit locally and persist on blur/submit after validation rather than on every keystroke. Add a monotonically increasing mutation ID if multiple optimistic patches may overlap.

## Positive controls observed

- `electron/main/store.ts:107-116` serializes state mutations through a promise queue, clones drafts, persists before publishing state, and keeps the queue usable after rejection. `electron/main/store.ts:119-132` uses a unique temp file, file `fsync`, atomic rename, and best-effort directory `fsync`. `tests/backend/store.test.ts:12-18` exercises 20 concurrent updates without loss.
- `electron/main/agent-rpc.ts:325-353,356-380,404-408` bounds pending RPC count/bytes, times requests out, validates response command identity, and consistently clears timers/accounting on completion/failure.
- Shutdown admission is closed before snapshots (`electron/main/agent-rpc.ts:424-449,495-503`; `electron/main/process-utils.ts:28-37`), with explicit race tests at `tests/backend/security.test.ts:116-164`.
- Runtime and PTY stop paths are idempotent/bounded and attempt process-tree cleanup (`electron/main/agent-rpc.ts:292-323`; `electron/main/terminal.ts:168-182`). Existing tests cover RPC escalation and detached terminal descendants.
- Several project-dependent effects correctly use cancellation flags, notably plugin listing (`src/App.tsx:147-153`), diff loading (`src/components/Inspector.tsx:88-101`), and file listing (`src/components/Inspector.tsx:223-233`). The gaps above are specific effects that do not carry identity/generation through completion.
- MCP settings writes preserve unrelated fields in the uncontended case and use temp-plus-rename (`electron/main/plugins.ts:225-236,339-345`); tests verify preservation and duplicate refusal (`tests/backend/plugins.test.ts:12-31,65-76`).

## Dismissed / non-findings

- **Concurrent `JsonStateStore.update` lost updates:** dismissed. The queue and clone/persist/publish ordering prevent the common stale-snapshot overwrite within the single app process; the passing concurrency test supports this.
- **Incomplete trailing JSONL record corrupts persistence:** dismissed. Session reads do not write the transcript, malformed/in-progress lines are skipped, and `strictJsonLines` preserves framing. At worst a concurrent read is temporarily incomplete; finding 4 addresses the renderer convergence problem.
- **`void refreshGit()` creates an unhandled rejection:** dismissed. `refreshGit` catches its own IPC rejection at `src/App.tsx:219-222`; its issue is stale completion identity, not an unhandled promise.
- **Shared `jobs.push` inside `ScheduleService.list` is a memory race:** dismissed. JavaScript execution is single-threaded here and each push is atomic between awaits (`electron/main/settings-schedules.ts:85-104`). No evidence establishes colliding job IDs across runtimes, so the Map deduplication was not reported as a defect.
- **Sequential removal fails to revoke access:** dismissed. The sequential path is explicitly rebuilt and tested. Finding 5 is limited to an overlapping stale `list()`.
- **Event limits themselves are unsafe:** dismissed as a resource-control concern. They are valuable and tested; finding 12 is specifically the missing convergence/recovery after an intentional drop, not the existence of limits.

## Test gaps to prioritize

1. Deferred A/B project status responses followed by attempted Revert; assert cwd and status source can never differ.
2. Project switch with a live idle runtime; assert send cannot target the previous cwd/session.
3. Two simultaneous sends during delayed runtime handshake; assert exactly one start and one command stream.
4. Transcript read held pending while events arrive; assert hydration replays rather than overwrites them.
5. `projects.list()` blocked mid-enumeration while another project is removed; assert authorization remains revoked.
6. PTY that emits and exits before `terminal.create` resolves; assert buffered output and exit are delivered.
7. Stale MCP lock artifact and a conflicting settings writer; assert recovery/no lost fields.
8. Pipe-close during `extension_ui_response`; assert the renderer receives rejection, not fabricated success.
