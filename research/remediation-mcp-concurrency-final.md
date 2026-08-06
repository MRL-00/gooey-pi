# CFR-04 final: MCP settings concurrency

## Finding

`connectMcp` rewrites the complete Prime Agent settings document. An in-process promise and Prime Work lock serialize cooperating `PluginService` callers, but a Prime CLI subprocess or editor does not honor either mechanism. A stale read followed by an unconditional atomic rename could therefore discard unrelated settings.

## Remediation

The MCP update is an optimistic, bounded transaction:

1. Acquire the existing per-settings-file, cross-instance owner-token lock.
2. Read the complete settings bytes (bounded at 4 MiB), validate the JSON object, and capture a SHA-256 fingerprint. A missing file has an explicit `missing` version.
3. Revalidate `mcpServers`, reject a duplicate server, and merge only the requested server into the freshly read object, preserving all unknown keys.
4. Serialize the candidate into a private same-directory temporary file created with `wx` and mode `0600`.
5. Hash the live file immediately before the atomic rename. If its version differs, delete the candidate, reread the complete current document, re-merge, and retry.
6. Stop after four conflicts with `Prime Agent settings changed repeatedly; no MCP configuration was overwritten`. The final external snapshot remains live.

This retains the existing atomic same-directory replace, temporary-file cleanup, secure file mode, project containment/symlink validation, JSON/size bounds, and cross-instance stale-lock ownership checks.

Package installation now acquires the same global settings-file lock for the lifetime of the fixed-argv Prime CLI subprocess. This coordinates package installs launched by one `PluginService` with MCP updates launched by another instance, in addition to the existing per-instance mutation queue. It cannot make an independently launched Prime CLI or editor honor Prime Work's lock, so those writers are handled by the fingerprint/retry path.

As with any portable POSIX compare-then-rename implementation, a non-cooperating process can theoretically write in the instruction-sized interval between the final hash and rename; eliminating that boundary requires a compare-and-swap/transaction primitive shared with Prime Agent. The remediation removes the broad stale read/merge window, detects every conflict through the final pre-commit comparison, bounds retry/livelock, and coordinates all package installs initiated by Prime Work.

## Deterministic coverage

`tests/backend/plugins.test.ts` now verifies:

- an external full-file write injected after MCP's read and before its rename is detected and its unrelated key survives;
- two consecutive external revisions cause fresh reread/merge retries and the latest revision survives;
- continuous external revisions exhaust exactly four attempts, reject explicitly, and leave the external snapshot untouched;
- package install in one service instance holds the shared lock while an MCP connection from a second instance waits, then rereads and preserves the package change;
- the pre-existing cross-instance MCP serialization, stale-owner recovery, project containment, HTTP/stdio validation, and duplicate protection remain covered.

## Verification

- `npm test -- --run tests/backend/plugins.test.ts` — passed, 12 tests.
- `npm run typecheck` — passed for node and renderer TypeScript projects.
