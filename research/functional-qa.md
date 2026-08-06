# Prime Work desktop functional QA

**Result:** **FAIL / not release-clean** — the core desktop flow is usable, but two repeatable defects remain. The automated hands-on run recorded **17 passing functional checks and 1 failing check**; browser navigation also produced uncaught renderer/main errors despite reaching the requested pages.

## Test setup

- App: Prime Work `0.1.0`
- Host: macOS (`darwin`), 1440×920 Electron window
- Working copy: `/Users/am.will/Applications/prime`
- Build: `npm run build` — **PASS** (typechecks and all main/preload/renderer bundles completed)
- Launch: Playwright Electron with the package entry point (`_electron.launch({ args: ['.', ...] })`)
- Isolated app state: `/private/tmp/prime-work-functional-qa`
- Data/services: real preload IPC bridge, real Prime session/plugin discovery, real embedded `<webview>`, and a real PTY. The run found 1 inferred project, 7 visible saved sessions, and 34 skills.
- Safety: no prompt was sent, no plugin was installed, no schedule was created, and no Git/file mutation was performed. Only isolated QA settings were persisted. Production source was not edited.

Raw machine-readable results are in [`functional-qa-results.json`](functional-qa-results.json); the reproducible Playwright driver is [`qa-run.mjs`](qa-run.mjs).

## Pass/fail steps

| # | Result | Step | Observation |
|---:|:---:|---|---|
| 0 | PASS | Build | `npm run build` completed typecheck and Electron Vite main/preload/renderer builds without errors. |
| 1 | PASS | Cold launch/preload | Window title and shell rendered; `window.prime` exposed `app`, `projects`, `sessions`, `agent`, `terminal`, `git`, `plugins`, `settings`, and `schedules`. |
| 2 | PASS | Project/session service load | 1 project group and 7 visible real saved-session rows loaded. |
| 3 | PASS | Projects page | Navigation, search/no-match state, clearing search, and opening the first project all worked. |
| 4 | PASS | Sidebar project/session tree | Project collapse/expand worked; a saved session could be selected and its transcript loaded. |
| 5 | PASS | Activity | Page loaded; All showed 7 entries, Needs attention showed 2, and an activity opened its session. |
| 6 | PASS | Scheduled | Page rendered; New schedule was correctly disabled with an explanatory tooltip when no live runtime existed. |
| 7 | PASS | Plugins & skills | Skills tab showed 34 cards; Refresh returned; Install modal opened, accepted text, and canceled without mutation. |
| 8 | PASS | Settings/runtime/about | General, Prime Agent, and About sections rendered; runtime status appeared and About reported version `0.1.0`. |
| 9 | PASS | Sidebar toggle | Hide/show worked from toolbar controls and with `⌘B`. |
| 10 | PASS | Command palette | `⌘K`, focused search, no-results state, Escape dismissal, filtering, Enter, and Open Settings all worked. |
| 11 | PASS | Dark mode | Dark theme applied (`html[data-theme=dark]`, body `rgb(23, 23, 22)`) and later persisted across window recreation. |
| 12 | PASS | Inspector tabs | Summary, Changes, and Files rendered; Files filtering worked. Changes correctly showed “No Git repository” for this non-Git workspace. |
| 13 | PASS | Real Browser webview | Isolated live guest loaded `https://www.google.com/`; guest DOM/title, history, and page annotation/comment worked. |
| 14 | PASS* | Browser address/history | `https://example.com/` loaded as “Example Domain”; Back returned to Google and Forward returned to Example Domain. *The actions emitted uncaught errors; see PW-001.* |
| 15 | PASS | Integrated terminal/PTY | PTY connected, echoed a unique token, and `pwd` returned `/Users/am.will/Applications/prime`. |
| 16 | **FAIL** | Terminal New/Split/Maximize | Clicking all three enabled controls caused no observable state/layout change: tab-button count `2→2`, terminal surfaces `1→1`, drawer height `312.8→312.8 px`. |
| 17 | PASS | Terminal Clear/Close | Both controls worked and the drawer detached. |
| 18 | PASS | Close/reopen | Closing the last macOS window left the app broker alive; an app activation created exactly one new authorized window. Project data and dark mode persisted. |

## Console and main-process errors

### Actionable

1. **Browser navigation emits an uncaught renderer page error** when entering `https://example.com/`:

   ```text
   Error invoking remote method 'GUEST_VIEW_MANAGER_CALL':
   Error: ERR_ABORTED (-3) loading 'https://example.com/'
   ```

2. **Main process stderr logged three `GUEST_VIEW_MANAGER_CALL` / `ERR_ABORTED (-3)` blocks** while navigating to Example Domain and using Back/Forward.
3. **Renderer console logged two additional errors** (`Unexpected error while loading URL`) for Google/Example navigation. The guest ultimately reached the correct URL in every check, so this is an error-handling/race defect rather than a total navigation failure.

### Non-actionable test/dev noise

- Five Electron “Insecure Content-Security-Policy” warnings appeared while exercising remote webview guests. Electron explicitly says these development warnings do not appear once packaged; the built app HTML contains a CSP meta tag and packaged mode adds headers.
- `NO_COLOR`/`FORCE_COLOR` warnings came from the test/build environment.
- `Debugger ending on ws://…` is Playwright Electron shutdown output.
- No React page crash, preload failure, terminal main error, or app bootstrap failure was observed.

## Prioritized bugs

### PW-001 — High — Browser navigations succeed but throw `ERR_ABORTED` as uncaught errors

**Repro**

1. Open a session and select Inspector → Browser.
2. Wait for Google to finish loading.
3. Enter `https://example.com/` and press Enter.
4. Click Back, then Forward.

**Actual:** the expected pages render, but the first address navigation raises a renderer `pageerror`; address navigation and history traversal also log repeated main/renderer `ERR_ABORTED (-3)` errors.

**Expected:** successful user-requested navigation should not reject or surface errors.

**Impact:** noisy/crashy error telemetry and potentially flaky/reverted browser navigation. The behavior is consistent with competing loads (the controlled webview `src` update plus an explicit `loadURL`) and missing handling for an aborted superseded load.

### PW-002 — Medium — Enabled terminal New, Split, and Maximize controls are inert

**Repro**

1. Open a project session and the integrated terminal.
2. Click **New terminal** (`+`), **Split terminal**, and **Maximize terminal**.

**Actual:** no new tab/PTY, no split surface, and no drawer-size/class change occur.

**Expected:** each control performs its labeled action, or unfinished controls are hidden/disabled with an explanatory tooltip.

**Impact:** misleading primary terminal UI; users cannot use the multi-terminal/layout features the toolbar advertises.

## Screenshots

- [`qa-session-initial.png`](qa-session-initial.png) — loaded project/session shell
- [`qa-projects.png`](qa-projects.png) — Projects page
- [`qa-dark-settings.png`](qa-dark-settings.png) — Appearance settings in dark mode
- [`qa-browser-webview.png`](qa-browser-webview.png) — real Google webview with saved annotation count
- [`qa-terminal.png`](qa-terminal.png) — live PTY and Example Domain guest
- [`qa-failure-terminal-new-split-and-maximize-toolbar-actions-change-terminal-layout.png`](qa-failure-terminal-new-split-and-maximize-toolbar-actions-change-terminal-layout.png) — unchanged layout after inert toolbar actions
- [`qa-reopened.png`](qa-reopened.png) — recreated window with persisted dark theme/project data
