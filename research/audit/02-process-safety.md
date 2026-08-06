# Command and Process Safety Audit

## Scope and approach

Audit-only review of the Electron main-process boundary and the React call sites that drive it, with emphasis on `agent-rpc`, `node-pty`, Git, process lifecycle, environment handling, injection, secret exposure, and denial of service. I read the relevant implementation and backend/security tests, ran the focused test suite, and performed two disposable local reproductions (a Git `core.fsmonitor` helper and a PTY leader that ignores `SIGHUP`). No production code was modified.

Focused tests run:

```text
npm test -- --run tests/backend/agent-rpc.test.ts tests/backend/terminal.test.ts \
  tests/backend/git.test.ts tests/backend/security.test.ts
```

Result: **4 files, 13 tests passed**.

## Findings

### PS-01 — High — Merely refreshing a repository can execute repository-configured programs with the desktop app's secrets

**Evidence**

- `electron/main/git.ts:58-65` implements status by invoking native `git status` and two `git diff` processes in the selected repository. It does not neutralize executable Git configuration such as `core.fsmonitor`.
- `src/App.tsx:219-224` calls that status path automatically whenever the active project changes; no Git mutation or explicit “run code” confirmation is needed.
- `electron/main/git.ts:104-123` also exposes `git add`/`restore`/`commit`. Those operations can invoke configured clean/smudge filters and commit hooks.
- `electron/main/process-utils.ts:39-46` defines the supposedly safe child environment by copying all of `process.env` and removing only a small loader-oriented denylist. `electron/main/process-utils.ts:76-82` supplies it to every Git child. Tokens such as `GH_TOKEN`, `NPM_TOKEN`, cloud credentials, signing-agent variables, proxy credentials, and custom application secrets therefore reach any Git helper/hook/filter.
- `tests/backend/git.test.ts:13-51` covers ordinary repositories and argv separation, but never a hostile `.git/config`, hook, filter, or child environment.

**Impact**

An imported repository can obtain arbitrary code execution as the logged-in user when it becomes active, before the user asks to run the project. The helper receives the Electron process's environment and can read/modify user files, steal inherited credentials, access the network, or leave a detached process behind. This defeats the value of the otherwise careful renderer-to-main authorization boundary.

**Realistic trigger / exploit scenario**

A user downloads and extracts a project archive that includes its `.git` directory (or opens an existing shared/worktree directory). Its `.git/config` contains:

```ini
[core]
    fsmonitor = /path/in/the/archive/fsmonitor.sh
```

Opening the project causes the effect at `src/App.tsx:224`, which reaches `git status` at `electron/main/git.ts:62`. In a disposable repository on the audit host, configuring an executable `core.fsmonitor` script that touched a marker caused the exact status argv used by Prime Work to run the script and still return exit code 0. No commit or terminal action was necessary. A similar issue exists later for repository-configured filters during stage/restore and hooks during commit.

**Remediation**

1. Treat native Git configuration as executable content, not data. For read-only status/diff, prefer a library/path that does not execute repository-defined programs, or run Git in an OS sandbox with network and filesystem access reduced to what the operation needs.
2. At minimum, use a fixed trusted Git executable and force non-executing configuration for every read: for example an application-owned empty hooks directory and `-c core.fsmonitor=false`; retain `--no-ext-diff`. Clear Git configuration injection variables (`GIT_CONFIG_COUNT`, all corresponding `GIT_CONFIG_KEY_*`/`VALUE_*`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_GLOBAL`, `GIT_EXEC_PATH`, etc.). This minimum does **not** by itself solve arbitrary named filter drivers used by `git add`/checkout-like operations.
3. For stage/restore/commit, either use a non-executing implementation, sandbox the process, or explicitly warn/confirm when executable hooks or filters are configured. Do not silently equate adding a folder with trusting its Git programs.
4. Give Git a purpose-built allowlisted environment. Do not pass API tokens or unrelated Electron/agent credentials. Add hostile-repository tests that assert `status`, `diff`, stage, restore, and commit cannot unexpectedly run a marker helper and that secrets are absent.

### PS-02 — Medium — Terminal shutdown never escalates against a surviving PTY leader

**Evidence**

- `electron/main/terminal.ts:168-177` removes the terminal from tracking, snapshots only its descendants, sends the process group and PTY leader `SIGHUP`, and then proceeds.
- `electron/main/terminal.ts:178-181` escalates `SIGTERM` and `SIGKILL` **only to the previously snapshotted descendant PIDs**. The PTY leader/process group never receives either escalation.
- `electron/main/terminal.ts:126-131` consequently reports a successful kill after `terminate()` returns even though the root process may still be alive, and deletion at `electron/main/terminal.ts:171` means it is no longer included in `killAll()` or the eight-terminal limit at `electron/main/terminal.ts:95`.
- `tests/backend/terminal.test.ts:15-29` checks a normal zsh plus an existing `nohup sleep` descendant. It does not cover the shell being replaced with (`exec`) a HUP-resistant process, a leader that traps HUP, or a process created during the snapshot/escalation window.

**Impact**

Closing a terminal, losing its renderer owner, exceeding the output limit, or quitting the application can leave arbitrary commands running with the user's privileges and inherited environment. Repeating the sequence bypasses the tracked eight-terminal limit and can consume unbounded CPU, memory, file descriptors, or network resources. A lingering process can also retain secrets that were present in the terminal environment.

**Realistic trigger / failure scenario**

A command replaces the shell rather than becoming its child:

```sh
exec node -e 'process.on("SIGHUP",()=>{}); setInterval(()=>{},1000)'
```

In a disposable `node-pty` reproduction using the same group-HUP plus `pty.kill('SIGHUP')` sequence, the process retained the PTY leader PID and was still alive 800 ms later; it had to be killed explicitly. The production code would delete it from `terminals` and return success after 500 ms.

**Remediation**

- Apply the full HUP → TERM → KILL sequence to the PTY process group/root as well as descendants, not just HUP to the root.
- Await the `onExit`/process-exit signal at each phase and return success only after verified exit. If cleanup fails, keep the terminal tracked and surface the failure.
- Re-enumerate the tree during escalation, because descendants can appear after the initial `ps` snapshot. Avoid signaling stale raw PIDs after delays without identity checks; on platforms that support them, use pidfds/job objects/cgroups or an equivalent process container. Use platform-specific job control on Windows.
- Add tests for an `exec`-replaced HUP-resistant leader, a late-forking/session-escaping descendant, and `killAll()` on both.

### PS-03 — Medium — Process admission is unbounded during normal operation and error events can amplify into a process storm

**Evidence**

- `electron/main/process-utils.ts:9-10,72-84` tracks children in a `Set` and closes admission only during shutdown; it has no global/per-service concurrency limit, queue bound, or per-renderer quota.
- `electron/main/ipc.ts:48-50,101-106` forwards every authorized Git invocation directly, with no single-flight, cancellation, or rate limit.
- One status call immediately starts three children in parallel (`electron/main/git.ts:61-65`).
- `src/App.tsx:198-200` schedules a fresh Git status after **every** `agent_end`, `extension_error`, `error`, or `transport_error`; it neither cancels nor coalesces timers/requests. The agent transport intentionally permits as many as 500 events per second (`electron/main/agent-rpc.ts:153-157,176-181`).
- The manual refresh is also not disabled while work is pending (`src/components/Inspector.tsx:131-135`).

**Impact**

A buggy or hostile agent/extension can exhaust the user's process table and drive large concurrent buffer allocations in the Electron main process. The app may freeze or crash, other applications may fail to fork, and shutdown can become slow while `stopChildProcesses()` tries to signal a huge snapshot. A compromised trusted renderer can reach the same outcome by repeatedly invoking any process-backed channel.

**Realistic trigger / failure scenario**

A project extension causes the agent to emit a burst of small `extension_error` events. Each accepted event schedules a status refresh 160 ms later, and each refresh starts three Git processes. The transport's 500-event window can therefore schedule roughly 1,500 Git children from one second of output. On a large repository, the 15-second timeouts keep them overlapping. Repeated clicks on Refresh during a slow status operation are a lower-rate non-malicious version of the same failure.

**Remediation**

- Add a bounded semaphore to `runProcess` (and separate fair per-service/per-owner quotas), a small bounded queue, and an explicit overload error. Reserve capacity for shutdown-critical work.
- Make Git status single-flight per canonical repository: coalesce callers, debounce agent-driven refreshes, and cancel/replace stale work using `AbortSignal` plus process-group termination.
- Track and clear scheduled refresh timers, and disable the refresh control while a refresh is in flight.
- Apply IPC request-rate limits so renderer compromise cannot turn process-backed APIs into a fork bomb. Add a stress test asserting a burst produces at most the configured number of children and one/coalesced status refresh.

### PS-04 — Medium — Byte caps still allow pathological Git output to expand into millions of objects/DOM nodes

**Evidence**

- `electron/main/process-utils.ts:73-74,85-104` permits `maxBytes` independently for stdout and stderr and buffers both entirely in memory. The default is 16 MiB **per stream**.
- Status starts three such processes (`electron/main/git.ts:61-65`) and then materializes complete split arrays/maps and an unbounded `status.files` array (`electron/main/git.ts:68-84`). A single status operation may therefore retain up to roughly 96 MiB of raw captured buffers before string/object expansion, not the apparent 16 MiB operation limit.
- Diff explicitly permits 24 MiB per stream and returns captured/truncated text to the renderer (`electron/main/git.ts:91-101`).
- The Changes panel automatically requests the first selected file's diff (`src/components/Inspector.tsx:74-75,85-102`) and renders `text.split('\n').map(...)` as one React subtree per line (`src/components/Inspector.tsx:68-70`), with no line count, virtualization, or truncation indicator.

**Impact**

A large or deliberately line-dense repository can cause a large main-process memory spike during status and then freeze/crash the renderer during diff rendering. A 24 MiB diff containing very short lines can expand to millions of strings and React elements. This is reachable from project data, not only from a compromised renderer.

**Realistic trigger / failure scenario**

The first changed file in an opened repository is a generated text file containing millions of one-character lines. Opening Changes automatically requests its diff. Git produces output up to the 24 MiB cap; even if the process is terminated at the cap, `git.ts:100-101` can return the captured text, and `DiffView` attempts to create millions of spans synchronously. Separately, a tree with millions of short untracked names expands the 16 MiB porcelain result into a very large `GitFileChange[]` during the automatic status call.

**Remediation**

- Use a total combined stdout+stderr budget rather than a per-stream budget, and set much smaller operation-specific limits. Kill with timed escalation immediately on limit breach and return a distinct `truncated/tooLarge` result instead of treating partial output as a usable diff.
- Cap parsed status entries and paths, stop parsing once the cap is reached, and return pagination/truncation metadata.
- Stream or page diffs, cap both bytes and lines before IPC, and virtualize the rendered lines. Do not mount one React element per line for untrusted multi-megabyte text.
- Add adversarial tests with many short status records and a multi-million-line diff, including heap/concurrency assertions.

### PS-05 — Low — `extension_ui_response` bypasses the RPC queue's correlation and backpressure bounds

**Evidence**

- `electron/main/agent-rpc.ts:136-141` accepts an arbitrary syntactically valid response ID and up to 1 MiB of value data; it does not establish that an extension UI request with that ID is outstanding.
- `electron/main/agent-rpc.ts:274-278` special-cases the command, calls `child.stdin.write()`, ignores the boolean backpressure result, installs no per-write completion/error handling, and immediately reports success.
- By contrast, ordinary requests enforce 32 pending entries and a 32 MiB in-flight budget and retain write failure handling (`electron/main/agent-rpc.ts:325-352`). The special path bypasses all of those controls.
- The command is reachable through the general `agent:command` IPC handler (`electron/main/ipc.ts:91-93`). Existing agent RPC tests (`tests/backend/agent-rpc.test.ts:37-67`) cover response error/mismatch/handshake behavior but not this one-way path.

**Impact**

If the agent stops reading stdin, repeated responses accumulate in Node's writable queue and main-process memory without the 32 MiB budget. Calls can report success although the write later fails. This is primarily an availability and state-integrity issue; exploitation at high rate requires a compromised/buggy trusted renderer, hence Low severity.

**Realistic trigger / failure scenario**

An agent presents an extension prompt and then deadlocks without consuming stdin. A buggy UI retry loop (or renderer compromise) repeatedly sends 1 MiB `extension_ui_response` values with invented IDs. Every call resolves successfully while `child.stdin` queues data past its high-water mark, eventually exhausting the Electron main process.

**Remediation**

Track outstanding extension UI request IDs and accept exactly one response per live request. Route these writes through the same byte-accounted queue as normal RPC traffic. If `write()` returns false, stop admission until `drain`; enforce a small queue limit and fail/stop the runtime on overflow. Resolve only from the write callback, propagate errors, and reject responses after stopping begins. Add a non-reading fake-agent stress test.

## Positive controls observed

- Command construction is consistently argv-based: `spawn(..., { shell: false })` at `electron/main/process-utils.ts:76-82` and `electron/main/agent-rpc.ts:246`, and `execFileSync` rather than `exec` at `electron/main/terminal.ts:42`. I found no renderer-controlled shell-string interpolation in the audited paths.
- Git file operands are relative-segment validated (`electron/main/validation.ts:80-85`) and placed after `--` in diff/stage/restore/unstage (`electron/main/git.ts:96-99,108-117,136-139`). Commit messages are separate argv values after `-m` (`electron/main/git.ts:120-124`).
- Project CWDs are canonicalized and restricted to authorized roots (`electron/main/projects.ts:209-223`). Terminal IDs are random and owner-bound (`electron/main/terminal.ts:102-104,184-188`), and shells are canonical executable files from a constrained list (`electron/main/terminal.ts:71-88`).
- Agent RPC has a four-runtime cap, pending request count/byte budgets, timeouts, response-command matching, strict JSONL frame limits, and outbound event rate/byte caps (`electron/main/agent-rpc.ts:246-287,325-380,426-449`; `electron/main/jsonl.ts:29-54`). Agent stderr is drained but deliberately not forwarded (`electron/main/agent-rpc.ts:255`), reducing accidental secret display.
- Terminal output is coalesced and guarded by per-terminal/global byte-rate and IPC-chunk limits (`electron/main/terminal.ts:36-38,142-159`). One-shot and agent shutdown close admission before taking cleanup snapshots, and agent/process utilities implement TERM→KILL escalation (`electron/main/process-utils.ts:28-36`; `electron/main/agent-rpc.ts:292-322`). Tests explicitly cover those shutdown races and escalation.
- IPC verifies the exact authorized main frame and renderer URL before dispatch (`electron/main/ipc.ts:36-56`), materially reducing exposure of these powerful APIs to webviews/subframes.

## Dismissed false alarms / design boundaries

- **Commit-message and Git-path shell injection:** not a finding. Even messages/filenames containing shell metacharacters remain single argv elements because no shell is used. A commit message beginning with `-` is consumed as the value of the preceding `-m`; file arguments are separated by `--`.
- **Model/session option injection:** not a finding. Model values beginning with `-` are rejected (`electron/main/agent-rpc.ts:435-438`), thinking is allowlisted, and session paths are validated before becoming option values.
- **The integrated terminal can run arbitrary commands:** intentional functionality, not itself a vulnerability. PS-02 concerns falsely successful cleanup and untracked survivors, not the terminal's intended authority.
- **Inherited environment in the agent and interactive terminal:** likely necessary for the developer-tool use case (provider credentials and normal shell behavior). The concrete security defect is passing the same broad environment to repository-triggered Git helpers. Product documentation should nevertheless tell users that terminal/agent subprocesses receive the app's environment.
- **PATH-selected `git` and `PRIME_AGENT_BINARY`:** these are hardening opportunities, but I did not count them independently. Altering the launch environment/PATH generally already requires same-user control. Pinning/canonicalizing a trusted executable would still reduce ambiguity and complements PS-01.
- **Terminal shell allowlisting TOCTOU and PID reuse:** a same-user attacker able to replace an allowed executable already has equivalent execution. Raw descendant PID reuse during the 500 ms shutdown sequence is theoretically capable of signaling an unrelated process, but I did not promote it as a separate finding without a practical reproduction; process handles/job containers recommended in PS-02 also address it.
