# Prime Work remediation plan

This document tracks the findings from the review of `origin/main` (`4dbefaef`) through the current working tree. A checkbox is complete only after the implementation is committed and its focused tests pass.

## A. Release, CI, and supply-chain safety

- [ ] **Scope release credentials narrowly.** Remove signing/notarization secrets from job-wide `env`; expose them only to the preflight/package steps, pin third-party actions to immutable commit SHAs, and ensure install/test/build code cannot read release secrets.
- [ ] **Verify the uploaded artifacts.** Require both DMG and ZIP outputs and validate the actual archives, signatures/notarization where applicable, architecture, and contained application rather than only the staging `.app`.
- [ ] **Cover extracted plugin modules.** Add `electron/main/plugins/**/*.ts` to coverage and keep the configured thresholds meaningful.
- [ ] **Unify fuse hardening.** Remove the dead duplicate `scripts/afterPack.cjs` or make it delegate to the single configured implementation.
- [ ] **Correct the supported Node version.** Align README/project instructions with the enforced Node `>=22.12.0` requirement.

Acceptance: release-script unit tests cover secret scoping helpers/artifact requirements where possible; `npm run check`, `npm run test:coverage`, and package dry-run/preflight checks pass.

## B. Project authorization and privileged lifecycle safety

- [ ] **Stop access on project removal.** Before removal completes, terminate all agent runtimes and terminals whose cwd is inside a removed root so the documented immediate revocation guarantee applies to already-running processes.
- [ ] **Close the project MCP symlink race.** Pin and revalidate `.prime/agent` directory identity through the write/rename, or use a no-follow/fd-relative strategy, so project-scoped settings cannot escape the project.
- [ ] **Track terminal teardown promises.** `killOwner`, output-limit termination, and `killAll` must share tracked termination promises so app shutdown waits through HUP/TERM/KILL escalation.
- [ ] **Drain desktop-state persistence.** Stop admitting state mutations during shutdown and await store initialization/pending writes before quitting.
- [ ] **Canonicalize session/project ownership.** Return/use canonical project paths so sessions created through symlink or lexical aliases still map to the correct granted project without creating inferred duplicates.

Acceptance: focused race/security tests cover removal with a live runtime, MCP directory substitution, concurrent terminal shutdown, immediate quit after a store update, and aliased session cwd ownership.

## C. Git integrity and multi-folder correctness

- [ ] **Do not silently bypass clean/smudge filters.** Preserve data integrity for Git LFS and other filtered paths; if filters cannot safely run, detect affected paths and fail closed with a clear error rather than staging/restoring different content.
- [ ] **Preserve a safe commit identity.** Continue blocking hooks/config injection while obtaining and explicitly supplying the user's `user.name`/`user.email` when available.
- [ ] **Support unstage on unborn HEAD.** Add a hardened fallback for repositories with no first commit.
- [ ] **Bind Git state and mutations to the active workspace cwd.** Support secondary project folders, clear/invalidate status synchronously on cwd changes, and prevent stale project-A paths from mutating project B.
- [ ] **Bind the terminal to the active workspace cwd.** A session rooted in a secondary folder must open its PTY in the same folder used by Prime and Git.

Acceptance: backend tests cover filters/LFS-style behavior, identity, unborn HEAD, and authorized repository roots; E2E covers Git and terminal behavior from a secondary folder and a workspace-switch race.

## D. Runtime events, transcripts, and scheduling

- [ ] **Retain background extension UI requests.** Cache pending requests per runtime and show the request when its waiting session becomes active; clear/cancel them deterministically.
- [ ] **Fix session attention semantics.** Advance `updatedAt`/an event revision on lifecycle changes, do not mark the currently visible completion unread, and ensure repeated background waits/completions generate new attention.
- [ ] **Prevent stale transcript reconciliation overwrite.** Obsolete or merge an in-flight authoritative read when a new same-runtime prompt is admitted, preserving optimistic user/assistant messages.
- [ ] **Bound and coalesce transcript reads.** Coalesce by canonical session path, cap global concurrency/admission, and avoid unlimited concurrent scans after rapid switching or hostile IPC calls.
- [ ] **Bound session discovery before stat fan-out.** Enforce a hard directory-work budget instead of realpath/stat work for every matching file before applying `maxSessionFiles`.
- [ ] **Align RPC image/frame limits.** A command accepted by schema validation must fit the transport, or validation must reject it consistently.
- [ ] **Preserve schedule runtime ownership during fallback.** Deduplicate CLI fallback records without overwriting successful runtime-attributed records.

Acceptance: focused frontend/backend tests cover background questions, repeated attention, new turns during reconciliation, read coalescing/concurrency, large session directories, image-size boundaries, and partial schedule fallback.

## E. Renderer state and settings correctness

- [ ] **Guard startup New Session.** Cmd-N and buttons during bootstrap must not leave `workspaceRef` empty while the UI falls back to an apparently usable project.
- [ ] **Guard plugin catalog ownership.** Global, project, refresh, and stale requests must only commit results for their owning project generation.
- [ ] **Fix optimistic settings rollback across queued fields.** Reconcile panel state from the complete confirmed settings object so an older failed patch cannot leave shell state inconsistent after a newer successful patch.
- [ ] **Restore the diagnostics preference control.** Allow a persisted `telemetry: true` preference to be disabled, or remove/migrate the unused setting deliberately.
- [ ] **Correct download preference semantics.** `browserAskForDownloads=false` must not silently block all downloads; either implement a safe no-prompt policy or rename the setting/control to reflect blocking.
- [ ] **Repair the rejected-setting E2E.** Trigger the draft commit explicitly (Save/blur/Enter) and verify inline/backend failure plus rollback so the release E2E gate passes.

Acceptance: reducer/component tests cover cross-field queue failure; E2E covers startup input, plugin switching, telemetry, downloads, and rejected draft settings.

## F. Performance, DRY, and maintainability

- [ ] **Make Sidebar memoization effective.** Stabilize callback props or move streaming transcript state below the app shell so every RAF delta does not rerender project/session navigation.
- [ ] **Make tool syntax rendering linear.** Tokenize with offsets/types in one pass; do not call `indexOf`/`slice` over the full 200k-character output for every token.
- [ ] **Deduplicate transcript-load lifecycle code.** Use one read/replay/error/finally/deferred-reconciliation state machine for initial and reconciliation loads.
- [ ] **Canonicalize plugin discovery keys and reveal ownership.** Coalesce on canonical project roots, globally bound discovery, and avoid last-writer-wins reveal allowlists.
- [ ] **Remove dead ancestor discovery work.** Keep the explicit project containment boundary and avoid walking parent directories that containment will always reject, unless a separately authorized VCS root is introduced.
- [ ] **Monitor initial bundle cost.** Keep terminal lazy-loaded and either justify or reduce the eagerly preloaded Markdown vendor chunk.

File-size judgment: there is no size-only blocker. `Transcript.tsx` (about 396 lines) is the best extraction candidate; `App.tsx` (about 360), the Electron composition root, and the split plugin/session modules remain acceptable if the concrete issues above are resolved.

Acceptance: streaming tests assert Sidebar render stability and linear large-output handling; transcript lifecycle tests exercise the single shared path; production build output is recorded.

## G. Final orchestration and validation

- [ ] Review every section commit for trust-boundary regressions and unrelated changes.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run check`.
- [ ] Run `npm test`.
- [ ] Run `npm run test:coverage`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:e2e`.
- [ ] Record final bundle sizes, package/release checks that can run locally, and any platform/credential-gated checks.

## Working protocol and implementation log

Every remediation worker must:

1. Re-read this document before editing.
2. Work only in its assigned section/worktree.
3. Update that section's log below with the commit SHA, files changed, focused validation, and any remaining risk before reporting completion.
4. Commit implementation, tests, and the log update together. The orchestrator updates the checkboxes only after review/cherry-pick.

These logs are the durable coordination record for compaction and handoff.

### Orchestrator log

- `b3be4c4` created the complete remediation tracker.
- `6b975cf` added the durable worker logging protocol.
- Preserved the pre-remediation working tree in `stash@{0}` and `/tmp/prime-pre-remediation.patch`.
- Created isolated `fix/section-a` through `fix/section-f` worktrees and delegated all six sections. Integration will be reviewed and cherry-picked into `main` in dependency order, followed by conflict resolution and full validation.

### Section A log — release/CI

- **Scope release credentials narrowly** — commit: `scope-release-credentials` (final SHA recorded below). Files: `.github/workflows/{ci,release}.yml`, `scripts/release/{lib,package}.mjs`, `tests/release-scripts.test.ts`. Intent: pin every GitHub Action, expose secrets only to preflight/package steps, and strip release credentials from package-internal quality/build processes and post-package verification except for the expected Team ID. Validation: `npm test -- --run tests/release-scripts.test.ts`, `npm run typecheck`, `npm run check`, `npm test` (126 tests). Remaining risk: public signing/notarization remains credential-gated in CI.

### Section B log — authorization/lifecycle

- Pending.

### Section C log — Git/multi-folder

- Pending.

### Section D log — runtime/transcripts/schedules

- Pending.

### Section E log — renderer/settings

- Pending.

### Section F log — performance/DRY

- Pending.
