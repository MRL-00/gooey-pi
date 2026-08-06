# Final Electron E2E gate repair

## Scope

Only `tests/e2e/app.spec.ts` and `playwright.config.ts` were changed for the gate repair. This note records the investigation and validation; no production behavior was relaxed or changed by this work.

## Findings

### Rejected shell setting

The shell field is now a draft/commit control. `fill()` only edits the local draft; blur or Enter starts the asynchronous settings update. On a backend rejection, the settings hook rolls the optimistic application state back to the confirmed `/bin/zsh`, while `DraftSettingField` deliberately keeps the rejected text as a dirty draft and exposes an inline alert. The underlying backend error is also reported through the toast.

The old test waited for rejection immediately after `fill()` and expected the input itself to roll back, so it neither committed the draft nor matched the intended draft-preservation behavior.

### Initial Electron lifecycle and cleanup

The suite creates a unique fixture root, user-data directory, HOME, session catalog, state file, and Prime Agent executable for every test. The intermittent failure occurred before the renderer became ready: the fixed 30-second `firstWindow()` wait consumed most of the former 45-second test budget, leaving too little time for Electron's asynchronous `before-quit` cleanup. A stalled graceful close could then leave an Electron process alive and make later cold starts less reliable.

Startup now has an explicit bounded two-attempt policy. Each attempt instruments pages as early as possible, requires the real `.app-shell[data-ready=true]` milestone, and fully closes a failed attempt before retrying. Teardown first permits graceful shutdown, then sends `SIGKILL` after a bounded deadline and waits for the close signal before deleting the fixture. The global test budget is 75 seconds so both startup recovery and teardown have time to complete; expect timeouts and functional assertions are unchanged. Fixture directories and environment remain unique and host-independent.

### Other stale timing gates

Two pre-existing UI checks were sensitive to effects/ResizeObserver timing:

- The compact panel test now waits for sidebar removal plus removal of both workbench and toolbar `inert` states, then exercises the inspector toggle through its keyboard-accessible control. It still verifies fixed overlay positioning, scrims, mutual panel exclusion, and restored workbench interactivity.
- The terminal resize test waits until the measured `aria-valuemax` actually permits the requested resize, starts a real pointer drag from the stable handle center, and asserts the handle entered its resizing state before verifying the size delta and keyboard resize.

## CFR-11 live boundary coverage

The Electron smoke suite now proves the privileged boundary in a running application:

1. The trusted main renderer can invoke the preload bridge.
2. A same-document safe fragment retains both the bridge and working IPC.
3. An injected iframe/subframe has no `window.prime` exposure.
4. The isolated `persist:prime-work-browser` webview guest has no `window.prime` exposure.
5. After a programmatic navigation to a non-approved `data:` document, the stale preload proxy cannot invoke privileged IPC and receives `IPC sender is not authorized`.

These checks exercise the actual preload, webContents authorization/revocation, sender-frame validation, and guest partition rather than mocking them.

## Validation

- `npm run typecheck` — passed.
- `npm run build:bundle` — passed.
- Targeted boundary/settings/browser tests — 3 passed.
- Startup stress: first smoke test with `--repeat-each=10` — 10 passed.
- Responsive/resize stress: targeted tests passed after synchronization repair.
- Full `npx playwright test tests/e2e/app.spec.ts` — 18 passed in 32.6s.
- Final `npm run test:e2e` (typecheck, production bundle, full hermetic E2E) — 18 passed in 58.1s; the first test recovered one bounded cold-start miss and completed in 26.6s, confirming the retry/cleanup lifecycle closes the observed flake.
