# Plugin service split remediation

## Scope

The 646-line `electron/main/plugins.ts` combined discovery, settings parsing, package execution, MCP validation, locking, atomic updates, and the public service. It is now a small orchestration facade with the stable `PluginService` export; implementation details live under `electron/main/plugins/`.

## Module boundaries

- `plugins.ts`: public `PluginService`, per-instance mutation sequencing, discovery request coalescing, refresh state, and reveal authorization.
- `plugins/catalog.ts`: bounded/cached-at-the-service discovery inputs, metadata/catalog construction, project containment, package/MCP display redaction, and bundled skill lookup.
- `plugins/package-execution.ts`: package-source validation and fixed `prime-agent package install <source>` argv/process limits.
- `plugins/mcp.ts`: MCP input validation, project settings-path hardening, owner-token cross-instance lock/recovery, four-attempt fingerprint retry, and atomic mode-`0600` temporary-file replacement.
- `plugins/file-io.ts`: shared bounded file reads and filesystem error-code extraction.

No renderer/preload/API contract changed. `PluginService` remains exported from `electron/main/plugins.ts` with the same constructor and public methods.

## Size comparison

| File | Before | After |
| --- | ---: | ---: |
| `electron/main/plugins.ts` | 646 lines / 31,427 bytes | 97 lines / 4,280 bytes |
| `electron/main/plugins/catalog.ts` | extracted implementation | 292 lines / 13,905 bytes |
| `electron/main/plugins/mcp.ts` | extracted implementation | 235 lines / 11,080 bytes |
| `electron/main/plugins/package-execution.ts` | extracted implementation | 49 lines / 2,592 bytes |
| `electron/main/plugins/file-io.ts` | extracted implementation | 22 lines / 776 bytes |

The facade shrank by 85%. Total production source is slightly larger because module imports/exports and explicit dependency seams replace implicit same-file access.

## Preserved invariants

- MCP writes retain the four-attempt snapshot/fingerprint retry and never replace a conflicting external writer snapshot.
- Package installs and MCP updates use the same secure owner-token settings lock across `PluginService` instances; stale recovery only reaps a provably dead PID after re-checking owner identity.
- Settings reads remain bounded at 4 MiB; lock/temporary modes, exclusive temporary creation, fingerprint-before-rename, and cleanup remain unchanged.
- Project paths remain authorized, canonicalized, symlink-resistant, and contained before discovery or MCP configuration.
- Discovery limits, metadata concurrency, request coalescing, result bounds, redaction, and reveal allowlisting remain unchanged.
- Package execution retains a fixed executable/argv array, sanitized process environment behavior from `runProcess`, and the existing time/output limits.

## Verification

- `npm test -- tests/backend/plugins.test.ts` — passed (12 tests).
- `npm run typecheck` — passed.
- Full Vitest result: pending final run.
