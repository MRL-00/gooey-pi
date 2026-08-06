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

- **Scope release credentials narrowly** — commit: `7bef8184cc658c3a851ac97c2fb35b007268f83d`. Files: `.github/workflows/{ci,release}.yml`, `scripts/release/{lib,package}.mjs`, `tests/release-scripts.test.ts`. Intent: pin every GitHub Action, expose secrets only to preflight/package steps, and strip release credentials from package-internal quality/build processes and post-package verification except for the expected Team ID. Validation: `npm test -- --run tests/release-scripts.test.ts`, `npm run typecheck`, `npm run check`, `npm test` (126 tests). Remaining risk: public signing/notarization remains credential-gated in CI.
- **Verify the uploaded artifacts** — commit: `c84250f1243f0f7c130ff80ae104a95ec5b1a070`. Files: `scripts/release/{lib,verify-package}.mjs`, `tests/release-scripts.test.ts`. Intent: require exactly one DMG and ZIP, test both containers, mount/extract them without following symlinks, and validate each contained app's declared architecture, native architectures, ASAR, fuses, and (for public builds) Developer ID signature, Team ID, notarization staple, and Gatekeeper assessment. Validation: release-script tests (10 tests), `npm run typecheck`, `npm run check`, `npm test` (127 tests), QA package dry-run, direct unsigned electron-builder package plus archive verifier (pass). Remaining risk: credentialed public signature/notarization validation can run only in release CI; the full local QA wrapper reached a pre-existing rejected-setting E2E failure tracked in Section E before packaging.
- **Cover extracted plugin modules** — commit: `d79ba0a1396a22c9723f6cf9f96abb0e52e99b08`. Files: `vitest.config.ts`, `tests/release-scripts.test.ts`. Intent: include `electron/main/plugins/**/*.ts` in V8 coverage while retaining the existing global thresholds. Validation: release-script tests (11 tests), `npm run typecheck`, `npm run check`, `npm test` (128 tests), `npm run test:coverage` (72.68% statements, 57.94% branches, 83.40% functions, 80.97% lines). Remaining risk: none specific to this step.
- **Unify fuse hardening** — commit: `55e73544829f74c6e1e10f6951473c1b381d90b7`. Files: deleted `scripts/afterPack.cjs`; updated `tests/release-scripts.test.ts`. Intent: remove the dead duplicate hook and enforce the single `package.json`-configured `scripts/release/after-pack.cjs` implementation. Validation: release-script tests (12 tests), `npm run typecheck`, `npm run check`, `npm test` (129 tests). Remaining risk: none specific to this step.
- **Correct the supported Node version** — commit: `1696055eeeb87acae0dab12364a363d567f9ef2d`. Files: `README.md`, `AGENTS.md`, `.nvmrc`, `tests/release-scripts.test.ts`. Intent: align contributor requirements and version-manager metadata with the enforced Node >=22.12.0 and npm >=10.9.0 engines. Validation: release-script tests (13 tests), `npm run typecheck`, `npm run check`, `npm test` (130 tests). Remaining risk: none specific to this step.
- **Final Section A validation** — `npm run typecheck`, `npm run check`, `npm test` (130 tests), `npm run test:coverage` (72.68% statements, 57.89% branches, 83.40% functions, 80.97% lines), QA package dry-run, credential-shape preflight, and direct unsigned QA DMG/ZIP build plus archive verification passed. Credentialed Developer ID signing/notarization remains CI-gated. The full package wrapper is still blocked before packaging by the pre-existing rejected-setting E2E failure assigned to Section E.

### Section B log — authorization/lifecycle

- Project removal process revocation (commit recorded in final Section B log): `electron/main/projects.ts`, `electron/main/agent-rpc/manager.ts`, `electron/main/terminal.ts`, `electron/main/index.ts`; tests in `tests/backend/project-removal.test.ts`, `tests/backend/agent-rpc.test.ts`, and `tests/backend/terminal.test.ts`. Removal revokes new admission first, then awaits matching runtime and PTY teardown before persistence completes. Focused validation: `npm run typecheck`; `npx vitest run tests/backend/project-removal.test.ts tests/backend/agent-rpc.test.ts tests/backend/terminal.test.ts`.
- Project MCP directory pinning (commit recorded in final Section B log): `electron/main/plugins.ts`, `electron/main/plugins/mcp.ts`; race test in `tests/backend/plugins.test.ts`. Project, `.prime`, and `agent` identities plus the settings file type are revalidated around locking, reads, temporary writes, fingerprinting, and rename. Focused validation: `npm run typecheck`; `npx vitest run tests/backend/plugins.test.ts`.
- Tracked PTY teardown (commit recorded in final Section B log): `electron/main/terminal.ts`, `electron/main/ipc.ts`; concurrency test in `tests/backend/terminal.test.ts`. Owner revocation, output-limit kills, explicit kills, project removal, and shutdown reuse a tracked per-PTY escalation promise; `killAll` drains already-started teardowns. Focused validation: `npm run typecheck`; `npx vitest run tests/backend/terminal.test.ts`.
- Desktop-state shutdown drain (commit recorded in final Section B log): `electron/main/store.ts`, `electron/main/index.ts`; shutdown-admission test in `tests/backend/store.test.ts`. `beginShutdown` closes update admission synchronously and drains initialization plus the serialized persistence queue before the final quit. Focused validation: `npm run typecheck`; `npx vitest run tests/backend/store.test.ts`.
- Canonical session ownership (commit recorded in final Section B log): `electron/main/sessions.ts`; alias-ownership test in `tests/backend/sessions.test.ts`. Existing session cwd values and project filters are canonicalized before return/filtering, aligning session ownership with canonical project grants and runtime cwd values. Focused validation: `npm run typecheck`; `npx vitest run tests/backend/sessions.test.ts tests/backend/project-removal.test.ts`.

### Section C log — Git/multi-folder

- **Git filter/LFS integrity** (`fix(git): fail closed for filtered path mutations`): `electron/main/git.ts`, `tests/backend/git.test.ts`. Hardened Git keeps filter commands disabled, inspects attributes without executing drivers, and fails filtered status/diff/stage/restore operations before content can change. Focused validation: `npm test -- --run tests/backend/git.test.ts` (7 passed). Remaining risk: trusted filter execution remains intentionally delegated to an external Git client.

### Section D log — runtime/transcripts/schedules

- Pending.

### Section E log — renderer/settings

- Pending.

### Section F log — performance/DRY

- `361d140` stabilizes every Sidebar callback at the App shell memo boundary (`src/App.tsx`, `src/hooks/useStableCallback.ts`) and adds a streaming-parent memo assertion (`tests/frontend/streaming-performance.test.ts`). Focused validation: `npm run typecheck`; `npx vitest run tests/frontend/streaming-performance.test.ts` (7 passed).
- `3fdb896` replaces repeated full-output searches with offset/type tokens (`src/lib/syntax-text.ts`, `src/components/Transcript.tsx`); the 200k-character regression test proves exact reconstruction and zero `String#indexOf` calls (`tests/frontend/syntax-text.test.ts`). Focused validation: `npm run typecheck`; `npx vitest run tests/frontend/syntax-text.test.ts tests/frontend/transcript-rendering.test.ts` (5 passed).
- `2934e07` routes initial and reconciliation reads through one read/replay/error/finally/deferred state machine (`src/app/transcript-load.ts`, `src/hooks/useWorkspaceRuntime.ts`). Lifecycle and single-path assertions live in `tests/frontend/transcript-load.test.ts`. Focused validation: `npm run typecheck`; `npx vitest run tests/frontend/transcript-load.test.ts tests/frontend/transcript-reconciliation.test.ts tests/frontend/streaming-performance.test.ts` (16 passed).
- `e42e80f` canonicalizes authorized project keys before coalescing, enforces a process-wide two-discovery bound, and retains reveal allowlists per user/project owner (`electron/main/plugins.ts`). Alias, concurrency, and cross-owner reveal tests are in `tests/backend/plugins.test.ts`. Focused validation: `npm run typecheck`; `npx vitest run tests/backend/plugins.test.ts` (15 passed).
- `49037fe` removes rejected ancestor traversal and scans only the authorized project’s own `.agents/skills` root while preserving containment (`electron/main/plugins/catalog.ts`). The boundary regression in `tests/backend/plugins.test.ts` confirms local discovery and ancestor exclusion. Focused validation: `npm run typecheck`; `npx vitest run tests/backend/plugins.test.ts` (16 passed).
- `f811e18` lazy-loads Transcript so its Markdown graph is no longer in the initial renderer module graph, while preserving the Terminal boundary (`src/App.tsx`, `tests/frontend/bundle-boundaries.test.ts`). Focused validation: `npm run typecheck`; focused Vitest (5 passed); `npm run build`. Production output: entry 124.45 kB, Transcript 27.94 kB, Markdown vendor 372.86 kB, Terminal 8.31 kB + vendor 415.93 kB (uncompressed); `out/renderer/index.html` preloads only React/icons, not Markdown/Terminal.
- Final Section F validation (working tree at `66ed632` plus this log): `npm run typecheck` passed; `npm run check` passed; `npm test` passed (29 files, 138 tests); `npm run build` passed with the bundle sizes above. Remaining risk: Markdown and terminal vendor payloads remain large when their lazy boundaries are opened, but neither is initially preloaded. `scripts/afterPack.cjs` remains untouched for Section A’s fuse-hardening owner; no Section F checkbox or any other section log/checkmark was changed.
