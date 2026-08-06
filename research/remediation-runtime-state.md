# Runtime and Session State Remediation

## Scope

This change remediates frontend audit findings FQ-01/FQ-02 and the related renderer data-concurrency findings without changing the Electron backend. The implementation is limited to workspace/session selection, renderer runtime ownership, prompt admission, and transcript hydration.

## Invariants introduced

1. **Workspace selection is one operation.** `selectStartupWorkspace` chooses the first active session that is contained by an available project, resolves multi-folder membership through `ProjectRecord.folders`, uses that session's project path as the working directory, and attaches only a runtime matching both that CWD and session file. There is no fallback to an unrelated streaming runtime.
2. **Runtime attachment has workspace ownership.** Each project/session transition advances a renderer generation and synchronously detaches the previous runtime before any authorization or runtime-list request. Async reconciliation is generation-checked. Stored sessions require an exact `(cwd, sessionFile)` match; a newly created session may retain only the runtime started and owned by its current generation.
3. **Prompt admission is synchronous and single-flight.** A reusable admission primitive closes before the first await. The admitted operation owns user-message append, runtime discovery/start, and command acceptance, so a second rapid submission can create neither a second user message nor a second runtime. Composer has its own synchronous guard, and suggestion/composer controls expose the starting/loading state.
4. **Transcript hydration preserves newer events.** A session read owns a generation-scoped event buffer. Runtime events still update the live transcript immediately; when the older read completes, buffered events are replayed over the loaded base before publication. Switching workspace invalidates the old load.
5. **Stale async work cannot rebind the UI.** Project grants, runtime-list results, runtime starts, and transcript reads validate the active generation before publishing state. A runtime whose startup finishes after navigation is stopped rather than attached to the new workspace.

## Focused verification

- `tests/frontend/runtime-state.test.ts`
  - differently ordered project/session inputs select the session's containing multi-folder project;
  - an idle runtime is found only when both CWD and session file match;
  - a deferred startup proves concurrent admission appends/starts once.
- `tests/backend/events.test.ts`
  - buffered live deltas and completion are replayed over an older transcript result.

Validation commands:

```text
npm run typecheck
npx vitest run tests/frontend/runtime-state.test.ts tests/backend/events.test.ts
```
