# Frontend Quality, Architecture, and State-Flow Audit

**Scope.** Renderer code under `src/`, the renderer/preload API boundary, and frontend-facing tests were reviewed from the working tree. This was an audit only; no production code was changed. Line numbers below refer to the reviewed working tree.

**Validation performed.** `npm run typecheck` passed. `npm test` passed all 12 files / 34 tests. The Electron Playwright suite was inspected but not re-run for this audit.

## Executive summary

The renderer has good baseline discipline (strict TypeScript, a narrow preload API, cleanup in resource-owning effects, and useful accessible primitives), but its core state is concentrated in `App`. The most important issue is that startup independently chooses a project and a session, then combines them when resuming an agent; this can resume one session in another project's working directory. Sending also lacks an in-flight admission state and can start duplicate runtimes. Most other findings stem from the same architectural pressure: async results have no ownership/version, mutation APIs use inconsistent failure contracts, and per-feature logic is embedded in a few large files.

### Severity summary

| Severity | Count |
|---|---:|
| High | 2 |
| Medium | 6 |
| Low | 3 |

## Findings

### FQ-01 — Startup can pair a session with the wrong project and miss its runtime

**Severity: High**

**Evidence**

- `src/App.tsx:169-170` independently selects `projectsResult.value[0]` and the first non-archived session; no invariant ties the two records together.
- `src/App.tsx:120-124` gives `activeProjectId` precedence even when the active session belongs to a different `projectPath`.
- `src/App.tsx:346-358` later combines the derived project folder with `activeSession?.filePath` in one `agent.start` call.
- The two service lists genuinely have different ordering rules: projects are pinned/last-opened ordered at `electron/main/projects.ts:81`, while sessions are updated-time ordered at `electron/main/sessions.ts:143`.

**Impact**

The transcript, Git status, working directory, and resumed agent context can refer to different workspaces. A prompt intended for session B can execute with project A as its CWD, which risks edits/commands in the wrong repository.

**Realistic trigger**

Pin project A, then work most recently in project B. On relaunch, the project list starts with A while the session list starts with B. The UI loads B's transcript but resolves A as `activeProject`; sending resumes B's file using A's CWD.

**Remediation**

Hydrate related entities atomically. In the bootstrap callback, derive one `chosenSession`, then derive `chosenProject` from `chosenSession.projectPath` (or deliberately choose a project first and a session within it). Commit the selection in one reducer action with an invariant such as `activeSession == null || projectContainsPath(activeProject, activeSession.projectPath)`. Add a test with differently ordered project/session arrays.

---

### FQ-02 — Concurrent sends can start duplicate agent runtimes

**Severity: High**

**Evidence**

- `src/App.tsx:125` defines busy state only from an already-streaming runtime/message.
- `src/App.tsx:334-358` enters `sendPrompt`, appends the user message, grants the project, and may await `agent.list`/`agent.start` without first setting an admission/in-flight state.
- Runtime/streaming state is not published until `src/App.tsx:359-362`.
- `src/components/Composer.tsx:44-49` submits without consulting `busy`, and `src/components/Composer.tsx:69-70` permits Enter submissions while busy; `busy` only changes styling and which footer button is displayed (`src/components/Composer.tsx:60,93-95`).

**Impact**

Two handlers can both capture `runtime === null` and both call `agent.start`. This consumes the four-runtime limit, duplicates session activity/events, and can send prompts to separate agent processes while the UI tracks only the last runtime assigned.

**Realistic trigger**

On a cold session, agent handshake takes a second or two. The user sends a prompt, types/pastes a correction, and presses Enter before the first `agent.start` resolves. Both calls observe no runtime and each starts one. Project authorization makes the race window larger for inferred projects.

**Remediation**

Introduce a synchronous admission mutex/ref plus an explicit reducer phase (`idle | starting | streaming | stopping | failed`). Set `starting` before any await, serialize runtime creation per session, and have subsequent submissions either queue as intentional follow-ups or remain disabled. Do not rely on React state from the handler's render closure as the lock. Add a deferred-Promise test proving two rapid submissions call `agent.start` once.

---

### FQ-03 — Composer drafts leak across sessions and projects

**Severity: Medium**

**Evidence**

- The draft is component-local state at `src/components/Composer.tsx:35`.
- Session/project changes do not reset it.
- `src/App.tsx:463-464` keys `Transcript` by session but renders `Composer` without a session/project key, so the same Composer instance survives navigation.

**Impact**

Text prepared in one workspace can be sent to another workspace. This is especially risky for prompts containing repository-specific commands or destructive instructions.

**Realistic trigger**

Type an unsent migration prompt in project A, click a session under project B, then press Enter. The transcript changes but the old draft remains and `sendPrompt` executes it against B.

**Remediation**

Either key Composer by a stable workspace identity (for reset-on-navigation behavior) or lift drafts into a map keyed by session/new-session plus project ID (for intentional per-session draft preservation). Define and test the desired behavior for new-session, project switch, archive, and session switch.

---

### FQ-04 — Async project-owned data has no request ownership, allowing stale overwrites

**Severity: Medium**

**Evidence**

- `grantProject` unconditionally changes the active project and Git state after awaits at `src/App.tsx:252-258`, even if the user has selected something else meanwhile. Its direct `setGit` also bypasses the generation guard used by `refreshGit` at `src/App.tsx:226-242`.
- Skills are loaded both by the project effect (`src/App.tsx:153-159`) and by bootstrap (`src/App.tsx:164-172`). The bootstrap's global `plugins.list()` can finish after a project-specific list and overwrite it.

**Impact**

The visible selection can jump backward, Git changes can belong to the previously selected repository, and the plugin page can show the wrong project scope. This is both a correctness issue and actionable duplication: multiple call sites own the same `skills` cache without a precedence policy.

**Realistic trigger**

Select inferred project A (authorization/status is slow), then immediately select project B. A's completion calls `setActiveProjectId(granted.id)` and `setGit(...)` after B was selected. On startup, a slow global plugin scan can similarly overwrite the faster project-specific scan.

**Remediation**

Make `grantProject` side-effect free: return the grant and let a caller commit it only if a selection generation/token still matches. Key Git and skills state by project path, or use a query hook with cancellation/version checks. Consolidate plugin loading into one project-aware owner; bootstrap should seed inputs, not issue a competing unscoped fetch.

---

### FQ-05 — Validated settings are persisted on every keystroke without rollback

**Severity: Medium**

**Evidence**

- `src/pages/SettingsPage.tsx:15` wires `browserHome` and `terminalShell` controlled inputs directly to `onUpdate` on every `onChange`.
- `src/App.tsx:244-249` optimistically mutates settings, then only reports an IPC rejection; it neither restores the prior value nor marks the field invalid.
- The service rejects non-web URLs and invalid shells at `electron/main/settings-schedules.ts:29-30`.

**Impact**

Normal editing produces IPC calls for transient invalid values, can emit repeated error toasts, and leaves the renderer displaying a value the service did not persist. The visible setting then silently reverts after restart. Rapid responses also have no version guard, so an older returned settings snapshot can overwrite a newer optimistic edit.

**Realistic trigger**

Select the browser home field, delete its value, and type a new URL. The empty/partial values are sent immediately and rejected. Editing `/bin/zsh` toward another executable likewise sends invalid intermediate paths.

**Remediation**

Give text settings local draft state and commit on blur/Enter or a debounced, versioned save after renderer validation. Have `updateSettings` return a `Result`, roll back to the captured prior snapshot on failure, and ignore responses older than the latest mutation. Keep immediate persistence for booleans/selects where every intermediate value is valid.

---

### FQ-06 — Mutation boundaries disagree about how failure is represented

**Severity: Medium**

**Evidence**

- Git stage/unstage/restore are typed as `Promise<boolean>` at `src/types/api.ts:164` and return `false` for command failure at `electron/main/git.ts:136-140`, but `src/components/Inspector.tsx:104-112` ignores those booleans and returns `true` unless an exception was thrown. The revert dialog then closes on that synthetic success at `src/components/Inspector.tsx:150`.
- Browser-data reset returns `false` on caught failure (`electron/main/settings-schedules.ts:34-43`), but `src/App.tsx:445` ignores the value and increments the browser generation anyway; `src/pages/SettingsPage.tsx:15` closes immediately.
- `addSchedule` catches and swallows errors at `src/App.tsx:414-417`, while `ScheduledPage` treats resolved `void` as success and closes/clears the form at `src/pages/ScheduledPage.tsx:16`.

**Impact**

The UI reports completion by closing/clearing controls when the operation did not complete. For Git restore this can make users believe changes were discarded; for schedules it destroys the only copy of a prompt after an RPC failure; browser cleanup can appear successful while cookies/cache remain.

**Realistic trigger**

A Git index lock makes `git restore` return `false`; the frontend refreshes and closes the confirmation because `mutate` returns `true`. Or the schedule runtime exits between opening and submitting the modal; App shows a transient toast but the child still clears the prompt.

**Remediation**

Standardize all mutation APIs on one contract—prefer a discriminated `Result<T, AppError>` for expected operational failure, with throws reserved for exceptional transport failure. Components should close/clear only on `ok: true` and render the error near the action. Add a shared mutation helper/hook for pending/error state rather than reimplementing inconsistent `try/catch` behavior.

---

### FQ-07 — Streaming work is O(transcript size) per event and reparses old Markdown

**Severity: Medium**

**Evidence**

- Every agent event enters React state at `src/App.tsx:195-199`.
- `updateLastAssistant` scans backward and maps the full message array for each delta at `src/lib/events.ts:15-22`.
- `Transcript` maps the complete transcript on every render at `src/components/Transcript.tsx:133-139`.
- Each old assistant text is reparsed by `ReactMarkdown` (`src/components/MarkdownText.tsx:21-33`); message rows are not memoized or virtualized.

**Impact**

Long sessions increasingly consume CPU during token streaming, causing input lag, choppy scrolling, and delayed stop actions. The cost grows with both accumulated messages and event frequency.

**Realistic trigger**

Open a session with hundreds/thousands of messages and stream a long answer with frequent text/tool updates. Every small delta copies the full message list and rerenders/reparses the entire visible transcript.

**Remediation**

Normalize transcript state (stable message IDs plus an order list), update only the active message, memoize message/part rows, batch high-frequency deltas per animation frame, and virtualize older rows for large sessions. Preserve scroll anchoring when virtualizing. Add a render-count/performance regression test with a large transcript and many deltas.

---

### FQ-08 — Modal and command-palette overlay ownership is duplicated and not stack-safe

**Severity: Medium**

**Evidence**

- `Modal` directly sets and clears `.app-shell` `inert`/`aria-hidden` at `src/components/ui.tsx:128-145`.
- `CommandPalette` independently duplicates that behavior at `src/components/CommandPalette.tsx:28-31`.
- The global shortcut can open the palette while another modal is active (`src/App.tsx:426-439`); it has no “overlay already open” guard.

**Impact**

With two overlays mounted, closing either one unconditionally makes the application shell interactive even though the other modal remains. Focus traps can also compete. This breaks modal accessibility and allows background interaction in states the UI says are blocked.

**Realistic trigger**

Open “Clear browser data?”, press Cmd+K, then close the command palette. The reset dialog remains, but palette cleanup removes `inert`/`aria-hidden` from the shell that the modal still needs.

**Remediation**

Create one Dialog/Overlay provider that maintains a stack or reference count, owns background inertness once, and routes Escape only to the topmost overlay. Build CommandPalette on the same primitive, or prevent it from opening while a blocking dialog is active. Add an E2E test for stacked overlays and background inertness after closing the top overlay.

---

### FQ-09 — The renderer bridge/event contracts are only partially type-safe

**Severity: Low**

**Evidence**

- `Window.prime` is declared mandatory at `src/types/api.ts:170`, although no-bridge/demo mode is explicitly supported and checked at `src/App.tsx:42,66`.
- Agent events and commands are broad dictionaries (`src/types/api.ts:71-74,151`) rather than discriminated unions.
- Preload subscription validates only “non-null object” and then casts to the requested generic at `electron/preload/index.ts:4-8`.

**Impact**

The compiler cannot catch misspelled command types, missing event fields, or unguarded bridge access in supported browser/demo mode. Such errors become runtime-only failures and are easy to introduce during agent-protocol changes.

**Realistic trigger**

A new component directly calls `window.prime` because the declaration says it always exists; the component crashes in the sample/no-preload renderer. Or a refactor sends `{type: 'followup'}` instead of the protocol's `follow_up`; TypeScript accepts it and the backend rejects only at runtime.

**Remediation**

Declare the global as `prime?: PrimeWorkApi`, expose a `usePrimeBridge()` abstraction, and define shared discriminated `AgentCommand`/`PrimeEvent` unions. Validate IPC event envelopes with runtime type guards/schema parsing before invoking renderer callbacks. Keep `unknown` only at the actual IPC boundary and narrow immediately.

---

### FQ-10 — Core feature files exceed healthy responsibility boundaries

**Severity: Low**

**Evidence**

- `src/App.tsx` is 479 lines. Lines `65-100` create roughly two dozen independent state/ref cells, lines `102-242` contain layout/bootstrap/event/data effects, lines `244-424` contain mutations/navigation/runtime orchestration, and lines `441-477` assemble every page and pane.
- `src/components/Inspector.tsx` is 302 lines and embeds four unrelated feature surfaces: Summary (`51-66`), Git Changes (`73-153`), Browser (`164-228`), and Files (`230-257`) before the shell at `276-302`.
- `src/pages/SettingsPage.tsx:15` places the entire multi-section renderer in one approximately 8.7 KB physical line, making line-based review, coverage, and conflict resolution unusually difficult.
- `src/styles.css` is 780 lines; its own section boundaries—Sidebar `184`, Transcript `246`, Inspector `343`, Browser `417`, Terminal `461`, shared pages `478`, plugins `546`, settings `595`, overlays `648`—already identify clean module seams.

**Impact**

Changes to one workflow require understanding unrelated state and create broad rerenders/merge conflicts. More importantly, the size hides coupling: startup selection, runtime admission, project authorization, Git, skills, settings, panels, and navigation share one closure, which enabled FQ-01, FQ-02, and FQ-04.

**Realistic trigger**

Adding “remember last session per project” requires modifying bootstrap, selection handlers, runtime restoration, transcript loading, and send behavior inside the same component; a locally reasonable edit can violate a distant invariant. Multiple developers editing settings or inspector features also collide on single long lines/files.

**Remediation**

Refactor along existing seams, not arbitrary line counts:

1. `useWorkspaceController` reducer: projects/sessions/active selection with explicit invariants.
2. `useAgentSession`: runtime registry, admission phase, event application, send/stop.
3. `useProjectGit(projectPath)` and `useProjectSkills(projectPath)`: keyed request ownership.
4. `usePanelLayout`: compact/sidebar/inspector/terminal state and persistence.
5. Separate `SummaryPanel`, `ChangesPanel`, `BrowserPanel`, and `FilesPanel` modules.
6. Separate Settings section components with local validated drafts.
7. Split CSS by those feature modules while retaining a small tokens/base stylesheet.

Keep the top-level App as composition/routing, not the owner of every async workflow.

---

### FQ-11 — Tests do not exercise renderer state races or failure contracts

**Severity: Low**

**Evidence**

- Vitest is configured for a Node environment and broad `tests/**/*.test.ts` inclusion at `vitest.config.ts:4-6`; the test inventory contains backend tests, not mounted React component/controller tests.
- The only direct reducer coverage, `tests/backend/events.test.ts:1-25`, covers two terminal error/exit cases, not normal streaming deltas or tool updates.
- The Electron smoke suite covers navigation, theme, one modal, responsive panels, browser, resizing, and terminal happy paths (`tests/e2e/app.spec.ts:48-169`) but supplies no delayed/reordered bridge promises or failed boolean operations.

**Impact**

Critical state invariants and async ownership are unprotected. Typecheck and happy-path E2E both pass while FQ-01 through FQ-06 remain possible.

**Realistic trigger**

A bootstrap refactor still renders and passes navigation smoke tests, but differently ordered project/session lists resume the wrong workspace. A Git service returns `false`; the suite never asserts that the confirmation stays open and an error appears.

**Remediation**

Extract the controllers/reducers above and unit-test them without Electron. Add a jsdom React test layer with a typed fake bridge whose promises can be delayed, rejected, or resolved out of order. Cover: atomic hydration, two rapid sends, project-switch races, draft isolation, rejected settings, `false` Git/reset results, schedule failure, and stacked overlays. Keep the current real-Electron smoke tests as integration coverage rather than asking them to model every race.

## Positive observations

- `tsconfig.web.json:5` enables strict TypeScript, and the renderer and preload share `PrimeWorkApi` instead of maintaining duplicate interface declarations.
- The API already uses useful domain unions in several places (`MessagePart`, `McpConnectionInput`, `WorkspaceView`), providing a good pattern for tightening agent commands/events.
- Session/diff/file effects generally use cancellation flags (`src/App.tsx:215-224`, `src/components/Inspector.tsx:98-102,236-245`), avoiding many stale-unmount updates.
- Runtime bootstrap now matches against `sessionsResult` rather than a stale closure (`src/App.tsx:174-177`), and project Git refreshes use a request generation guard (`src/App.tsx:226-242`).
- Terminal ownership is handled carefully: late PTYs are killed and observers/listeners/addons are disposed at `src/components/TerminalDrawer.tsx:81-105`.
- `ResizeHandle` has keyboard semantics and ARIA separator state (`src/components/ResizeHandle.tsx:72-85`), and focus-trapping/restore behavior exists in a reusable hook (`src/components/ui.tsx:92-126`).
- Model-authored Markdown does not enable raw HTML, blocks remote image rendering, and protocol-gates external links (`src/components/MarkdownText.tsx:9-30`).
- Inspector Git selection now tracks the visible staged/unstaged set (`src/components/Inspector.tsx:83-87`), and commit failures inspect `{ok, output}` (`src/components/Inspector.tsx:119-126`).

## Dismissed / non-findings

- **Raw Markdown XSS:** not reported. `ReactMarkdown` uses `skipHtml`, images become text placeholders, and links are restricted to HTTP(S)/mailto before leaving the app.
- **Keyboard effect listener leak:** not reported. `src/App.tsx:426-439` runs every render, but React executes the prior cleanup before re-running it; this is inefficient/noisy, not an accumulating-listener bug.
- **Terminal listener/PTY leak:** not reported. The effect explicitly handles late creation and disposes the PTY, xterm instance, observers, and event subscriptions.
- **Diff request stale update after selection:** not reported. The diff effect uses a cancellation flag on dependency change.
- **File size alone:** not treated as a defect. FQ-10 is included because the files combine independently changing domains and the refactor seams are already visible; the concern is coupling and demonstrated failure modes, not a universal line-count threshold.

## Recommended order

1. Fix atomic bootstrap/selection invariants (FQ-01).
2. Add send admission serialization (FQ-02).
3. Isolate drafts and add request ownership for project data (FQ-03/FQ-04).
4. Standardize mutation results and settings persistence (FQ-05/FQ-06).
5. Add focused controller/component tests before the structural split (FQ-11), then perform FQ-10 incrementally.
6. Address transcript scaling and shared overlay/type primitives (FQ-07/FQ-08/FQ-09).
