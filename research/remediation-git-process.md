# Git and one-shot process remediation

## Scope

This change remediates process audit findings PS-01, PS-03, and PS-04 and the related backend Git correctness findings. The implementation is limited to the Electron main-process Git/process boundary, the shared Git response types, and backend tests. It does not change renderer, session, plugin, package, or index code.

Threat model: a user may open a repository whose local config, attributes, hooks, filenames, and working-tree contents are hostile. Merely inspecting that repository must not run repository-selected programs with the desktop process environment. Explicit Git mutations still use native Git, but repository hooks and configured clean/smudge/process filters are neutralized as far as native Git permits, and failures are never reported as successful booleans.

## PS-01: repository helper execution and environment leakage

All `GitService` subprocesses now use a purpose-built `restrictedGitEnvironment()` rather than the broad child environment:

- It constructs a new allowlist instead of copying `process.env`.
- It carries only process-location/platform values needed to find and start Git, fixed `C` locale values, noninteractive/pager controls, and Git safety controls.
- Provider tokens, cloud credentials, signing/SSH agent sockets, proxy credentials, application secrets, loader variables, and arbitrary custom variables are not inherited.
- Git configuration injection variables such as `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_EXTERNAL_DIFF`, and `GIT_EXEC_PATH` cannot leak because no Git/process variables are copied from the parent.
- System and global config are disabled with `GIT_CONFIG_NOSYSTEM=1` and empty config paths. Literal pathspec behavior and noninteractive operation are forced.

Every Git command is also prefixed with command-scope config that overrides repository config after it has been loaded:

- `core.fsmonitor=false` prevents repository-selected fsmonitor hooks.
- `core.hooksPath=/dev/null` (or `NUL` on Windows) prevents all repository hooks; commit also uses `--no-verify` as defense in depth.
- commit/tag signing and recursive/submodule status decoration are disabled.
- all diff reads use `--no-ext-diff`, `--no-textconv`, and ignore submodules.
- commit uses `--no-gpg-sign` and `--no-status`.

Git can apply clean filters while calculating a working-tree diff, not only during `git add`. Before status, diff, stage, unstage, restore, or commit, the service therefore performs a bounded, non-executing `git config --includes --name-only --list` inspection. It extracts every effective repository/include/worktree-defined `filter.<driver>.{clean,smudge,process,required}` driver and adds command-scope overrides that empty `clean`, `smudge`, and `process` and set `required=false`. Inspection is capped at 512 KiB, 5 seconds, 128 drivers, and 256 characters per driver; an ambiguous or oversized configuration aborts the operation instead of running it. Because global/system/environment config is disabled, no other configured filter command remains available.

This intentionally makes staging/restoring pass repository-filtered paths through as raw content. In particular, user-global Git LFS/filter configuration is not loaded. That behavior is the security tradeoff required to avoid executing repository-selected code from an automatic desktop integration.

## PS-03: global process admission bound and shutdown

`runProcess` now has a global bound of eight active one-shot children and a bounded FIFO of 64 waiting operations. Further work receives an explicit overload rejection instead of growing the process table without limit.

Shutdown closes admission before snapshotting children. Closing admission rejects every queued operation, and queue draining re-checks the closed state before spawning. Active children retain the TERM-to-KILL cleanup sequence. Normal child close/error removes it from tracking and admits the next queued operation only while admission remains open. This prevents both normal-operation fork storms and the race where queued work could start after a shutdown snapshot.

## PS-04: output, status-entry, and diff-line bounds

`ProcessResult` now reports:

- `outputExceeded`
- `stdoutBytes` and `stderrBytes` (observed counts)
- terminating `signal`
- the existing timeout state

`maxBytes` is a combined stdout+stderr retained budget rather than an independent budget for each stream. The first overflow records `outputExceeded`, sends TERM, and starts its own 500 ms KILL escalation; it no longer waits for the original operation timeout. Consumers can distinguish a complete nonzero result, timeout, signal, and output-limit termination.

Git applies smaller operation-specific budgets. Status and numstat parsing use NUL scanning rather than materializing unbounded `split()` arrays. Returned status changes are capped at 1,000 records, numstat maps are capped at 1,000 entries, and `GitStatus.truncated` explicitly marks the cap. A file with both index and worktree edits now yields one staged and one unstaged scoped record, so the existing renderer partitions display both halves without a renderer change.

Diff capture is capped at 2 MiB and parsing scans at most the retained string without creating a line array. A diff is capped at 5,000 rendered lines. `GitDiff` includes required `truncated` and optional `error` metadata, and its text contains a visible Prime Work truncation marker. Byte-limit overflow returns no misleading patch prefix: it returns an explicit “not displayed” marker and `truncated: true`.

## Explicit Git failure semantics

- `stage`, `unstage`, and `restore` return `true` only after a complete zero exit. Nonzero exits, signals, timeouts, output overflow, filter-inspection failure, and spawn/admission failure reject with a bounded actionable error. The older unstage fallback that could turn a failed restore into a successful reset/no-op was removed.
- `commit` keeps its existing `{ ok, output }` bridge contract, but timeouts and output overflow return `ok: false` with “result unknown; refresh status” guidance. Ordinary nonzero exits preserve bounded, ANSI-stripped Git diagnostics. Hooks and signing are disabled.
- status statistics failures are not silently converted to zero counts. Any incomplete status/numstat subprocess returns an explicit status error.
- diff nonzero/timeout failures reject; output and line truncation are separately represented.

## Verification coverage

`tests/backend/git.test.ts` now covers:

- a hostile repository with configured fsmonitor, external diff, clean/smudge filter, and pre-commit hook programs;
- parent secret/config-injection variables absent from the Git environment;
- status, diff, stage, restore, and commit completing without any hostile helper marker;
- stage failure caused by `.git/index.lock` and explicit commit failure;
- simultaneous staged/unstaged edits represented in both scopes;
- more than 1,000 status records and more than 5,000 diff lines producing bounded, explicitly truncated responses.

`tests/backend/process-utils.test.ts` covers:

- combined stdout/stderr truncation state and an output producer that ignores TERM;
- observed concurrency never exceeding the global bound under a burst;
- a saturated process pool plus queued request during shutdown, proving the queue is rejected and all active children are terminated.

Validation commands:

```sh
npm test -- --run tests/backend/git.test.ts tests/backend/process-utils.test.ts
npm run typecheck
npm test
```

## Residual boundary

Native Git remains a complex parser with the user's filesystem authority; this is defense in depth, not an OS sandbox. The executable is resolved from the application launch `PATH`, which is not repository-controlled but is not yet a packaged/pinned Git binary. A same-user attacker who can replace that executable or modify the running application's environment before launch already has comparable authority. If product requirements later need repository filters, hooks, signing, submodule recursion, or global Git identity/config, those features should be exposed as an explicit trust transition and run in an OS sandbox rather than weakening automatic read safety.
