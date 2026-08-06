# Electron main/backend performance and robustness audit

## Scope and method

Audit-only review of the Electron main process, preload-facing IPC services, the React call sites that drive those services, and all backend tests. The review focused on filesystem/process behavior, JSONL/session scaling, plugin discovery, Git, PTYs, cleanup, concurrency, and event-loop safety. No production source was changed.

Validation run: `npm test -- --reporter=dot` completed successfully: **12 test files / 33 tests passed**. The passing suite is a useful functional/security baseline, but its fixtures are small and do not exercise the scale and failure cases below.

Severity rubric: **High** = a realistic workload can make the application unavailable or exhaust the main process; **Medium** = material stalls, resource amplification, incorrect partial results, or persistent feature failure under a plausible trigger; **Low** = bounded degradation with limited user impact.

## Findings

### 1. High — Every session catalog request rereads every selected JSONL file from beginning to end, and startup requests the same catalog twice

**Evidence**

- `electron/main/sessions.ts:120-143` rereads the session directory and maps as many as 5,000 files on every `list()` call.
- `electron/main/sessions.ts:286-336` calls `stat()`, opens a stream, parses every JSONL record, and continues to EOF merely to derive catalog metadata. There is no metadata cache keyed by inode/mtime/size and no incremental tail index.
- `electron/main/sessions.ts:287-310` permits each catalog file to be as large as 256 MiB and 200,000 records.
- `electron/main/sessions.ts:105-106,246-266` cache only the `prime-agent list` subprocess result for two seconds; local JSONL metadata is not cached.
- `electron/main/index.ts:163` makes `projects.list()` obtain sessions through `sessions.list(undefined, true)`.
- `electron/main/projects.ts:26-27` awaits that provider whenever projects are listed.
- `src/App.tsx:158-160` concurrently invokes both `projects.list()` and `sessions.list(undefined, true)` during startup. Thus the same local session files are normally streamed and parsed twice at once (up to 12 active metadata readers because each list has a six-worker limit).
- `electron/main/sessions.ts:123` applies `.slice(0, 5_000)` before any deterministic recency ordering, so beyond the cap the visible subset depends on filesystem enumeration order.

**Impact**

Catalog cost is proportional to total transcript history, not the number of sessions or the small metadata needed by the sidebar. The stated caps permit about 1.25 TiB of logical input per list call (5,000 × 256 MiB), and the normal initial load duplicates that work. Far smaller real histories—hundreds of multi-megabyte sessions—will cause sustained disk reads, JSON parsing, slow startup, battery use, and contention with active agent I/O. Users with more than 5,000 logs can also lose an arbitrary current session from the UI.

**Realistic failure scenario**

A long-term user has 800 session files averaging 8 MiB. Opening the app causes the project request and session request to parse roughly 12.5 GiB in aggregate. On a laptop or synced/network-backed home directory, startup remains busy for a long time. Once the directory crosses 5,000 entries, a newly created session may not be in the unsorted first 5,000 and appears missing.

**Remediation**

Maintain a durable lightweight catalog (SQLite is appropriate) containing path, device/inode, size, mtime, parsed header, last status, and preview. Reparse only new/changed tails, coalesce concurrent list calls into one single-flight request, and have `projects.list()` consume the already-fetched catalog rather than calling `sessions.list()` again. Return paginated, mtime-sorted results and make any cap explicit/deterministic. Add scale tests that count file opens/bytes across repeated and concurrent lists and a >5,000-file ordering test.

### 2. High — Opening one allowed transcript can retain the entire parsed 256 MiB log in the Electron main heap and then clone a large result over IPC

**Evidence**

- `electron/main/sessions.ts:151-159` accepts a transcript up to 256 MiB / 200,000 records and reads it completely.
- `electron/main/sessions.ts:154,161-166` stores each eligible full parsed `entry` object in a `Map`, including content not on the final leaf branch.
- `electron/main/sessions.ts:167-176` only after EOF walks parent links to identify the branch, so all parsed entries remain live for the full scan.
- `electron/main/sessions.ts:177-213` then constructs the complete transcript array; message text, tool results, and images are retained for return.
- `electron/main/sessions.ts:57-62` permits each returned image payload to contain up to 16 MiB of string data.
- `electron/main/ipc.ts:87` returns the entire array through one `ipcMain.handle` result, requiring Electron structured-clone/serialization and a corresponding renderer allocation.

**Impact**

A 256 MiB UTF-8 file can expand substantially as JS strings and parsed object graphs. The `Map`, branch/transcript arrays, and IPC clone overlap in lifetime, so one supported transcript can create several hundred MiB of live data and long main-thread parse/serialization pauses. The result can freeze all windows and agent event handling or terminate the Electron main/renderer process from memory pressure.

**Realistic failure scenario**

A long session contains verbose bash/tool output and several base64 images and grows to 180 MiB. Selecting it makes the main process parse and retain every fork, including entries not displayed, then sends the entire chosen branch in a single IPC response. The app beachballs and may be killed for memory pressure even though the file is below the documented 256 MiB limit.

**Remediation**

Move parsing/index construction off the main thread. Store only compact normalized parent metadata or file offsets while finding the leaf, not each full raw object. Provide paginated/windowed transcript APIs (for example newest N messages with cursors), lazy-load tool output/images, and impose separate decoded-text/image/IPC-response budgets considerably below the file-size limit. Stress-test peak RSS and event-loop delay with a near-limit branching transcript.

### 3. High — Plugin discovery performs a potentially enormous synchronous filesystem crawl and metadata read on the main thread

**Evidence**

- `electron/main/plugins.ts:2` imports only synchronous filesystem primitives for discovery.
- `electron/main/plugins.ts:68-84` recursively calls `existsSync()` and `readdirSync()` to depth six. The 2,000-candidate cap does not bound traversal of directories/files that do not match a candidate type.
- `electron/main/plugins.ts:87-97` accepts configured directories and synchronously `lstatSync()`/`realpathSync()`s them before recursively collecting them.
- `electron/main/plugins.ts:133-161` runs all global, bundled, project, configured, and ancestor discovery inline before the async method yields.
- `electron/main/plugins.ts:164-188` synchronously `realpathSync()`s each candidate and, for markdown, calls `markdownMetadata()`.
- `electron/main/plugins.ts:18-21,33-40` synchronously reads as much as 128 KiB per markdown candidate; 2,000 candidates therefore allow roughly 250 MiB of synchronous metadata reads in addition to directory walking.
- `src/App.tsx:147-153` invokes discovery in an active-project effect, while `src/App.tsx:158-160` separately invokes it in the initial load. On initial mount this produces redundant global discovery, followed by another project-scoped scan when the first project becomes active.

**Impact**

All of this work blocks Electron's sole main event loop: window/IPC responsiveness, PTY forwarding, RPC stdout draining, child timeouts, and shutdown handling stop until discovery returns. Synchronous calls to a configured external, network, removable, or very broad path have no timeout and can make the whole desktop app unavailable.

**Realistic failure scenario**

A user configures a shared skills directory on a slow mounted workspace, or a broad directory containing a large non-skill tree. Opening the app invokes global discovery twice; selecting the project invokes it again. Repeated synchronous `readdir`/`realpath` and up to hundreds of MiB of reads beachball the app while an active agent's stdout pipe backs up.

**Remediation**

Use `fs/promises` with a bounded-concurrency walker in a worker thread, cancellation, per-root time budgets, and explicit traversal/file-byte budgets. Cache records by canonical path + mtime/size and invalidate with targeted watchers or manual refresh. Deduplicate overlapping roots and single-flight identical `list()` calls. Remove the duplicate startup request and do project discovery only when the Plugins view needs it. Preserve the existing depth/candidate/symlink limits as defense in depth.

### 4. Medium — JSONL framing does quadratic whole-buffer work for large fragmented records

**Evidence**

- `electron/main/jsonl.ts:10-13` appends each stream chunk and recomputes `Buffer.byteLength(buffer)` over the entire accumulated record; after the cap is crossed it also searches the accumulated string for LF.
- `electron/main/jsonl.ts:15-22` repeatedly searches and slices the remaining string for each line.
- `electron/main/jsonl.ts:34-48` repeats the append plus whole-buffer `Buffer.byteLength()` pattern in the RPC decoder, including another whole-tail measurement after framing.
- The allowed unframed sizes are large: 64 MiB for files at `electron/main/jsonl.ts:4,7`, and 16 MiB for agent RPC at `electron/main/agent-rpc.ts:247`.
- `tests/backend/jsonl.test.ts:5-18` verifies correctness with a tiny split UTF-8 input and an oversize value pushed in one call; it does not cover a large record fragmented into normal 64 KiB chunks or assert bounded work/event-loop delay.

**Impact**

For a record delivered in equal chunks, repeatedly measuring the complete accumulated string scans the prefix over and over (quadratic cumulative work). A permitted 64 MiB single-line JSON record delivered in 64 KiB chunks causes on the order of 32 GiB of cumulative prefix byte scanning before JSON parsing, aside from string concatenation/slicing costs. This occurs in the main process and can stall session loading or RPC event handling.

**Realistic failure scenario**

A transcript record embeds a large base64 image/tool result, or an RPC `get_messages` response approaches the 16 MiB frame cap. The OS/Node stream fragments it into many chunks. The app spends seconds repeatedly rescanning the growing tail before it can parse or reject the record.

**Remediation**

Implement framing with a `Buffer`/chunk queue and tracked undecoded byte count; scan only newly arrived bytes for LF and concatenate once per completed frame. If strings are retained, maintain a scan offset and byte counter rather than recomputing the entire tail. Lower single-frame limits and move large payloads to cursor/blob APIs. Add fragmented 16/64 MiB performance tests that instrument elapsed time or bytes scanned.

### 5. Medium — Terminal cleanup synchronously runs a full `ps` subprocess on the Electron main thread for every PTY

**Evidence**

- `electron/main/terminal.ts:3,40-52` uses `execFileSync('/bin/ps', ...)` with a two-second timeout and parses the entire process table synchronously.
- `electron/main/terminal.ts:168-178` calls that blocking function before the first `await` in every terminal termination.
- `electron/main/terminal.ts:138-140` starts all terminal terminations with `Promise.all`, but each async call runs synchronously through `processTree()` before yielding; with the allowed eight terminals (`electron/main/terminal.ts:95`), eight full `ps` calls run serially on the main thread.
- `electron/main/ipc.ts:123` triggers the same cleanup path when a renderer is revoked, and `electron/main/index.ts:250` does so during application quit.
- `tests/backend/terminal.test.ts:17-30` usefully verifies that one detached descendant dies, but does not measure main-loop blocking or multi-terminal cleanup.

**Impact**

Closing a terminal, losing/reloading the renderer, or quitting can block every Electron callback for up to two seconds per PTY—up to 16 seconds at the service's own maximum—before graceful delays even start. During a renderer crash this postpones recovery; during normal use it freezes window/UI and agent IPC.

**Realistic failure scenario**

Eight terminals are open on a machine under process-table/filesystem pressure. The renderer reloads. `revoke()` calls `killOwner()`, and the main process synchronously executes and parses `ps` eight times; the app appears hung and RPC/terminal events are not serviced throughout the burst.

**Remediation**

Use asynchronous `execFile`/`runProcess`, or take one asynchronous process-table snapshot and derive descendants for all PTYs in a batch. Prefer reliable process-group/job-object ownership so enumeration is only a fallback. Make `killOwner()` return/track a promise and add an eight-terminal test with a main-loop heartbeat to ensure cleanup yields.

### 6. Medium — One-shot subprocesses have no runtime concurrency limit; one Git refresh alone launches three processes

**Evidence**

- `electron/main/process-utils.ts:9,66-84` tracks children in a `Set` for shutdown but has no semaphore, per-operation single-flight, queue, or upper admission bound.
- `electron/main/git.ts:58-65` launches `git status`, unstaged `git diff --numstat`, and staged `git diff --cached --numstat` concurrently for each status call.
- `electron/main/ipc.ts:101` exposes status as an invoke handler without coalescing/cancellation.
- `src/components/Inspector.tsx:122` leaves the Refresh changes action callable while a refresh is in flight, and `src/App.tsx:199-200,219-224` can also schedule refreshes on agent terminal/error events and project changes.
- Each default process may retain up to 16 MiB from **each** output stream (`electron/main/process-utils.ts:74,85-104`), so overlapping status calls amplify both process and memory use.

**Impact**

Rapid or overlapping requests multiply expensive repository walks, file descriptors, process-table entries, CPU, disk I/O, and buffered output. A small number of clicks/events on a large repository can spawn dozens of Git processes and make all of them slower; there is no backend pressure signal until unrelated OS limits or memory pressure occur.

**Realistic failure scenario**

On a large monorepo, status takes 10–15 seconds. A user clicks refresh ten times because nothing appears to happen while agent-end events also schedule refreshes. Thirty or more Git children traverse the same working tree simultaneously, saturating disk/CPU and potentially retaining hundreds of MiB of output.

**Remediation**

Add a global bounded subprocess semaphore plus stricter per-service limits. Make Git status single-flight per canonical repository, replace queued obsolete requests with the newest one, and expose cancellation via `AbortSignal`. Disable/debounce refresh while pending. Consider one porcelain command or cached status/index integrations rather than three full processes per request. Test a slow fake Git executable under a refresh burst and assert the maximum concurrent child count.

### 7. Medium — Process output-limit termination can run until the original timeout and consumers cannot distinguish truncated output

**Evidence**

- `electron/main/process-utils.ts:7` returns only `code`, `stdout`, `stderr`, and `timedOut`; there is no `truncated`/`limitExceeded` state.
- `electron/main/process-utils.ts:97-104` applies `maxBytes` independently to stdout and stderr, sends only `SIGTERM` on overflow, and keeps receiving/processing later chunks.
- The SIGKILL escalation at `electron/main/process-utils.ts:91-95` is installed only by the original timeout path, not when the byte limit is crossed. A child that ignores SIGTERM after overflowing can therefore continue consuming CPU/I/O until the full timeout and another two seconds.
- `electron/main/process-utils.ts:117` resolves a normal-looking result after a limit kill with `timedOut === false`.
- `electron/main/git.ts:99-101` returns stdout from a failed/limit-killed diff when stderr is empty, so the renderer can receive the retained prefix as if it were the complete diff. Status similarly converts an overflow into `isRepo: false` at `electron/main/git.ts:61-66`.

**Impact**

The byte cap bounds retained chunks per stream, but not post-limit process duration/work, total two-stream buffering, or correctness. Large output can tie up a process slot for tens of seconds, and users can act on a silently incomplete diff. With finding 6's overlapping calls, the retained buffers and lingering producers multiply.

**Realistic failure scenario**

A generated-file change produces more than the 24 MiB diff cap. Prime sends SIGTERM to Git and retains the first 24 MiB. Git exits by signal with empty stderr; `GitService.diff()` returns that prefix with no truncation/error field. A user reviewing the tail never sees omitted hunks. A package/install helper that traps SIGTERM can instead continue emitting until its 10-minute operation timeout.

**Remediation**

Use one shared total-output budget, stop/destroy both pipes at the limit, mark `limitExceeded`, and start a short independent SIGKILL escalation immediately. Prefer rejecting with a typed error over returning an ambiguous code. Teach Git APIs/UI to show “diff too large/truncated” and use paginated/file-scoped diffs. Add tests for a child that exceeds the cap and ignores SIGTERM, and for consumer behavior on truncation.

### 8. Medium — State mutations synchronously clone, rewrite, fsync, rename, and directory-fsync the entire store on the main thread

**Evidence**

- `electron/main/store.ts:103-112` `structuredClone()`s the full state for every snapshot/update and persists the full draft for every mutation.
- `electron/main/store.ts:119-132` uses synchronous open/write/fsync/close/rename and a second synchronous directory open/fsync/close.
- These methods run inside the promise queue callback (`electron/main/store.ts:107-116`), which is still main-thread JavaScript; the promise chain serializes mutations but does not move blocking I/O off-thread.
- Common UI actions route through this path: every settings patch at `electron/main/settings-schedules.ts:13-31`, project touch at `electron/main/projects.ts:173-180`, and archive toggle at `electron/main/sessions.ts:227-235`.
- If write/fsync/rename fails, `electron/main/store.ts:120-128` closes the descriptor but has no `unlink` cleanup for the uniquely named temporary file, so repeated failures leak temp files.

**Impact**

A durability flush can block unpredictably on slow, encrypted, synced, removable, or pressured storage; while it blocks, Electron cannot drain agent/PTY pipes or service any window. Store cost also grows with all archived/dismissed paths because every small toggle clones and rewrites the entire document. Disk-full or fsync/rename failures can leave an accumulating set of `.tmp` files and worsen recovery.

**Realistic failure scenario**

The user has thousands of archived sessions and toggles panels while the home volume is under heavy writeback. Each toggle clones/stringifies the whole state and performs two synchronous fsyncs, producing visible stalls. If the disk becomes full after creating the temp file, repeated settings attempts leave a new UUID-named temp file each time.

**Remediation**

Use asynchronous filesystem operations (or a dedicated persistence worker), coalesce/debounce noncritical UI preference updates, and split high-growth collections from preferences (or use SQLite transactions). Preserve atomic rename and directory durability without doing them on the event loop. Always remove the temp in an outer `finally` on failure and clean stale owned temp files on startup. Add fault-injection tests for write/fsync/rename failures and event-loop delay tests.

### 9. Medium — A crash can leave the plugin settings lock permanently stale

**Evidence**

- `electron/main/plugins.ts:322-329` acquires a lock by creating a directory and removes it only through the returned in-process release callback.
- `electron/main/plugins.ts:326-336` treats every existing lock identically, waits 40 × 50 ms, and then fails; it never inspects lock age, owner PID, or host and never reclaims an abandoned lock.
- `electron/main/plugins.ts:222-239` does release in `finally` for ordinary exceptions, which is good, but no `finally` can run after process crash, SIGKILL, or power loss.
- `tests/backend/plugins.test.ts:11-76` covers valid writes and duplicate logical MCP names, but not a pre-existing/stale lock or crash recovery.

**Impact**

One unclean exit in the small window after lock acquisition permanently disables `connectMcp()` for that settings scope across all future launches. Every attempt waits about two seconds and reports “busy,” and there is no automatic recovery path.

**Realistic failure scenario**

Prime Work is force-killed while adding an MCP server. `settings.json.lock/` remains. After restart, all MCP additions for that user/project fail forever until the user discovers and manually deletes an internal lock directory.

**Remediation**

Use a well-tested cross-process lock with PID/host/timestamp metadata and atomic stale-lock reclamation. At minimum, write ownership metadata, verify whether the owner is alive, apply a conservative stale age, and atomically rename/remove stale locks. Clean only locks provably owned/stale and test pre-existing live and dead-owner cases.

### 10. Medium — Project listing serializes per-project Git subprocess latency and repeatedly scans the session array

**Evidence**

- `electron/main/projects.ts:43-53` loops persisted projects serially and awaits `branchProvider()` inside the loop.
- `electron/main/git.ts:48-55` can execute two sequential Git subprocesses per project (symbolic ref, then detached-HEAD fallback), each with a five-second timeout.
- `electron/main/projects.ts:51` filters the entire sessions array once per persisted project; inferred project processing again filters/maps/sorts sessions at `electron/main/projects.ts:56-65`.
- `src/App.tsx:158-164` makes project listing part of initial application data load.
- `tests/backend/projects.test.ts:19-42` covers a tiny one-project file listing, and `tests/backend/git.test.ts:15-50` covers small local repositories; neither covers many projects, slow Git, or list latency.

**Impact**

Project-list latency grows as the sum, rather than the maximum, of repository probe times, plus O(projects × sessions) array work. Several stale/slow repositories can delay the project list by minutes; 100 failing probes have a theoretical timeout chain near 1,000 seconds. This is in addition to the full session scans in finding 1.

**Realistic failure scenario**

A user retains 30 projects, several on a sleeping external volume or with slow Git metadata. At startup, branch probes are awaited one by one. The sidebar's project data stays unavailable even though most projects could have been returned immediately with cached/unknown branches.

**Remediation**

Build session counts and per-project timestamp aggregates in one pass. Return the project list without blocking on branch decoration, then load/cache branches asynchronously. If branches must be included, use a small bounded-concurrency mapper, per-repo single-flight/cache keyed by `.git`/HEAD mtimes, and a short aggregate deadline so slow repositories yield `undefined` rather than delaying all projects.

## Positive controls observed

- **No production polling loop:** there is no backend `setInterval` or filesystem polling loop. Session/Git/plugin refreshes are request/event driven; this avoids constant idle I/O.
- **Process spawning is argument-safe and generally bounded per invocation:** `electron/main/process-utils.ts:76-83`, `electron/main/agent-rpc.ts:246`, and `electron/main/terminal.ts:100` use argv with `shell: false` (or a PTY shell selected from an allowlist). `runProcess` has time and output caps, safe-environment filtering, process-group termination, and shutdown admission/cleanup (`electron/main/process-utils.ts:28-46,66-119`). The findings above concern concurrency, cap semantics, and main-thread cleanup—not shell injection.
- **Agent and terminal cardinality are bounded:** four RPC runtimes (`electron/main/agent-rpc.ts:445-449`) and eight PTYs (`electron/main/terminal.ts:94-104`). RPC pending requests/bytes are also bounded (`electron/main/agent-rpc.ts:325-353`).
- **Agent stderr is drained without retaining secrets:** `electron/main/agent-rpc.ts:248-255` consumes stdout and drains stderr. Pending requests and timers are cleared on response/failure (`electron/main/agent-rpc.ts:356-408`).
- **RPC/terminal event floods have explicit budgets:** agent envelopes have count, per-envelope, and byte-window controls (`electron/main/agent-rpc.ts:146-220`); terminal output is rate-limited and coalesced into 16 ms IPC batches (`electron/main/terminal.ts:142-165`).
- **Terminal and child shutdown logic is substantive:** renderer revocation kills owned PTYs (`electron/main/ipc.ts:121-130`), agent stop is idempotent with graceful/TERM/KILL escalation (`electron/main/agent-rpc.ts:292-323`), and application quit closes admission before cleanup (`electron/main/index.ts:238-250`).
- **Plugin discovery is not wholly unbounded:** it skips symlinks/hidden entries/`node_modules`, limits recursion depth, and caps candidates (`electron/main/plugins.ts:68-84`). Those controls reduce exposure but do not make synchronous main-thread traversal safe.
- **State updates are serialized and durable in the success case:** the queue prevents lost in-process updates, and temp-file + rename + fsync is stronger than a direct overwrite (`electron/main/store.ts:86-133`).
- **Project file traversal is asynchronous and bounded:** it skips symlinks/generated trees and stops at 5,000 entries (`electron/main/projects.ts:183-207`).
- **Download resources are bounded and released:** concurrent/byte budgets, owner cancellation, `done` removal, and shutdown cancellation exist at `electron/main/browser-downloads.ts:17-59` and `electron/main/index.ts:101,248`.

## Dismissed false alarms / non-findings

- The absence of `fs.watch` is **not** itself a leak; the current design opens streams per request and `for await` closes them normally. The problem is repeated full scans, not leaked session file descriptors.
- `RpcRuntime`'s ignored stderr content is **not** a blocked-pipe bug: a data listener at `electron/main/agent-rpc.ts:255` drains it.
- `waitForExit()` attaches multiple continuations to one promise, but runtime stop is memoized at `electron/main/agent-rpc.ts:231,292-295`; concurrent stops do not start duplicate kill ladders.
- PTY output is **not** accumulated without limit: it flushes every ~16 ms, caps IPC chunks, and kills sustained/bursting producers (`electron/main/terminal.ts:142-165`). The blocking issue is process-tree enumeration during cleanup.
- Plugin recursion does have depth/candidate/symlink controls, so describing it as literally infinite would be incorrect. Its remaining risk is synchronous, duplicate, potentially broad I/O with no time budget.
- The state store's synchronous constructor read at `electron/main/store.ts:90-100` occurs before the window is created and the state file is normally small. It was not reported separately; recurrent synchronous mutation/fsync and growth/failure behavior are the material issue.
- Git commands use `--` before renderer-supplied paths and validate relative segments (`electron/main/git.ts:96-99,111-139`; `electron/main/validation.ts:80-85`). This audit found resource/scaling issues, not command-injection behavior.

## Test coverage assessment

The backend suite is strong on input validation, argv-only process execution, lifecycle cleanup, concurrent state correctness, JSONL framing correctness, event budgets, RPC response correlation, and one detached PTY descendant. The principal missing layer is adversarial performance/fault testing: large and branching JSONLs, repeated catalog calls, >5,000 sessions, fragmented near-limit frames, plugin walks on broad/slow roots, stale locks, fsync/write failures, output-cap-ignoring children, rapid Git refresh bursts, many slow projects, eight-terminal cleanup, event-loop delay, and peak RSS. Those tests should accompany the remediations above so the existing safety bounds become enforceable performance contracts rather than only nominal constants.
