# GUI runtime health audit

**Scope.** Static audit of the Electron renderer, React components, CSS, renderer-facing services, and relevant tests. Production code was not modified. I also ran `npm test` (33/33 tests passed) and `npm run typecheck` (passed). Findings are ordered by severity.

## Findings

### 1. High — A valid saved transcript can make the renderer allocate and mount an effectively unbounded React/Markdown tree

**Evidence**

- `electron/main/sessions.ts:151-159` accepts transcript files up to **256 MiB** and as many as **200,000 JSONL records**.
- `electron/main/sessions.ts:177-213` materializes the entire selected branch into one `TranscriptMessage[]`; there is no renderer-oriented message, text, or node budget.
- `src/components/Transcript.tsx:78-90` renders every part of every assistant message, and `src/components/Transcript.tsx:133-139` maps every transcript message into the DOM.
- `src/components/MarkdownText.tsx:21-33` reparses every text part through `react-markdown`/GFM; no paging, truncation, virtualization, or `content-visibility` boundary exists.

**Impact.** Loading a large but service-valid session can block the renderer main thread for seconds or exhaust the Electron renderer, making the whole desktop window hang or crash. The 256 MiB/200,000-record backend admission limits are safety limits for parsing, not safe UI rendering limits.

**Realistic trigger.** A long-running agent session accumulates many assistant turns, or a tool/model emits a multi-megabyte Markdown response (large generated table/log). Selecting that session makes React create all articles and makes the Markdown parser build all ASTs synchronously before the user can interact.

**Remediation.** Introduce a UI-specific response contract: page/window transcript messages and cap individual display parts by bytes/lines with an explicit “show/download full output” affordance. Virtualize historical messages, memoize completed messages, and parse/render only the visible window. Add a stress test at the chosen UI budgets rather than testing only the parser's 256 MiB rejection boundary.

### 2. High — The diff viewer eagerly turns an admitted 24 MiB diff into potentially millions of DOM nodes

**Evidence**

- `electron/main/git.ts:91-101` permits `git diff` output up to **24 MiB** and returns it as one string.
- `src/components/Inspector.tsx:68-70` immediately executes `text.split('\n').map(...)` and creates a row `<span>` plus `<i>` and `<code>` for every line.
- `src/components/Inspector.tsx:88-101` automatically fetches and installs the full diff whenever a file is selected.
- `src/styles.css:399-407` uses a normal scrolling `<pre>`/grid; there is no line virtualization or render containment.

**Impact.** A generated file, minified artifact, snapshot, or lockfile with hundreds of thousands of changed short lines can freeze or crash the renderer merely by being selected in Changes. A 24 MiB short-line diff can produce well over a million React/DOM elements.

**Realistic trigger.** An agent rewrites a large generated JSON/snapshot file. The user opens Changes and selects it to review; the IPC succeeds, then the synchronous split/map and DOM commit monopolize the GUI.

**Remediation.** Enforce a much smaller display line/byte budget at the service and renderer boundary; return `{ text, truncated, totalBytes/lines }`. Virtualize diff rows or render chunks on demand, and offer opening/exporting the full diff outside the DOM viewer. Cover a many-short-lines diff in an Electron performance regression test.

### 3. Medium — Streaming forcibly smooth-scrolls to the bottom on every update, preventing review and adding animation/layout work

**Evidence**

- `src/components/Transcript.tsx:111-119` treats any streaming message as a reason to call `scrollTo({ top: scrollHeight, behavior: 'smooth' })` whenever `messages` changes.
- `src/lib/events.ts:56-60` creates a new message/part array for every text or thinking delta, so the effect is repeatedly triggered during normal token streaming.

**Impact.** A user cannot reliably scroll upward to read earlier output while the agent is running; each delta pulls the viewport back toward the bottom. Repeated overlapping smooth-scroll animations also cause avoidable scroll/layout work during the renderer's busiest update path.

**Realistic trigger.** While Prime is streaming a long answer, the user scrolls up to check the original prompt or an earlier tool call. The next token starts another smooth scroll and moves the viewport away from what the user was reading.

**Remediation.** Track whether the viewport was already near the bottom before an update. Auto-follow only in that state, pause following as soon as the user scrolls away, and provide a “Jump to latest” control. Batch token updates and use an immediate/rAF-coalesced scroll rather than restarting smooth animation per token.

### 4. Medium — Panel dragging synchronously rerenders the whole application and persists storage on every pointer move

**Evidence**

- `src/components/ResizeHandle.tsx:51-55` calls `onChange` for every `pointermove` without requestAnimationFrame coalescing.
- `src/App.tsx:136-139` clamps state and synchronously writes each changed width/height to `localStorage`.
- `src/App.tsx:430-453` owns the panel size at the root and renders the transcript, Markdown, inspector, browser, composer, and terminal below that root; these heavy children are not memoized.
- The changed CSS variables at `src/App.tsx:438-452` also necessarily trigger layout; terminal size changes additionally drive `ResizeObserver`/`fit.fit()` at `src/components/TerminalDrawer.tsx:99-100`.

**Impact.** Inspector/terminal dragging degrades as transcript/project size grows: a high-frequency pointer stream causes root React reconciliation, Markdown rerendering, synchronous storage writes, layout, and terminal fitting in the same interaction.

**Realistic trigger.** Drag the inspector divider in a long session or drag the terminal while it has substantial scrollback. Pointer input outruns commits, producing a visibly lagging handle and dropped frames.

**Remediation.** During drag, rAF-throttle an imperative CSS custom-property update; commit React state and `localStorage` once on pointer-up (with a debounced fallback). Memoize transcript/history/sidebar subtrees so size changes do not reparse their content. Add a drag test with a large seeded transcript and assert frame/commit counts.

### 5. Medium — Command-palette actions retain callbacks from an older App render

**Evidence**

- `src/components/CommandPalette.tsx:14-24` recreates `commands` with current callback props on every render.
- `src/components/CommandPalette.tsx:25` memoizes the filtered command objects with only `[query]`, so unchanged queries retain old command objects and their old closures.
- `src/App.tsx:243-279` defines the toggle/navigation callbacks as render-local functions that close over current panel/layout state, while `src/App.tsx:457` keeps the palette mounted even while closed.

**Impact.** Keyboard commands can perform the wrong state transition. This is especially visible for toggles and makes the command palette unreliable as the keyboard-first control surface.

**Realistic trigger.** Start with the sidebar open, close it using the toolbar, then open the untouched palette (`⌘K`, query still empty) and choose “Toggle sidebar.” The memoized command can still call the initial `toggleSidebar` closure, whose captured `sidebarOpen` was `true`, and sets it to `false` again instead of reopening it. The terminal toggle has the analogous failure.

**Remediation.** Either remove this insignificant filter memo, or memoize `commands` with complete callback dependencies and include it in the filtered memo dependencies. Prefer stable `useCallback` handlers and functional state transitions for toggles. Add an E2E test that changes a panel outside the palette and then toggles it twice through the palette without typing a query.

### 6. Medium — The integrated terminal does not enable xterm's screen-reader DOM

**Evidence**

- `src/components/TerminalDrawer.tsx:60-69` constructs xterm with cursor, font, scrollback, and theme options but does not set `screenReaderMode`.
- The installed xterm version defaults that option off at `node_modules/@xterm/xterm/src/common/services/OptionsService.ts:37`; its type documentation says this option exposes the supporting DOM for NVDA and VoiceOver.
- `src/components/TerminalDrawer.tsx:109-116` only labels the outer section; it does not provide an alternate accessible output/status surface.

**Impact.** VoiceOver/NVDA users can reach a region named “Integrated terminal” but cannot reliably inspect the terminal buffer/output, excluding them from a core developer workflow.

**Realistic trigger.** A VoiceOver user opens the terminal, runs a command, and attempts to review output or the current prompt. The canvas-based terminal is present visually, but xterm has not created its screen-reader support elements.

**Remediation.** Enable `screenReaderMode` (unconditionally or through an accessibility preference with an easily discoverable default), verify focus/input and output announcements with VoiceOver and NVDA, and add an accessibility smoke assertion for xterm's supporting DOM.

### 7. Medium — Generated response content and completion are not announced to assistive technology

**Evidence**

- `src/components/Transcript.tsx:75-90` renders assistant Markdown/tool content in ordinary articles with no live/log semantics.
- The only live region is `src/components/Transcript.tsx:92`, and its text remains the static phrase “Prime is working”; the generated content is outside it.
- On completion, that live region is simply removed and ordinary actions are inserted at `src/components/Transcript.tsx:93`; no completion announcement is emitted.

**Impact.** A screen-reader user may hear that work started but receives neither a usable batched announcement of the answer nor a definitive “completed/failed” update, so they must manually search the transcript after every run.

**Realistic trigger.** Submit a prompt with VoiceOver. The response streams visually for several seconds, “Prime is working” disappears, and focus remains in the composer with no spoken indication that the answer is ready.

**Remediation.** Give the transcript appropriate `role="log"`/live semantics or maintain a separate polite status announcer. Batch announcements by block/turn (not token) and announce completion/error explicitly. Test start, streamed block, completion, and abort with an accessibility-tree assertion.

### 8. Medium — Global shortcuts can stack a command palette over a modal and break modal isolation

**Evidence**

- `src/App.tsx:408-421` handles shortcuts on `window` without checking for an existing dialog/overlay, editable target, `event.defaultPrevented`, or `paletteOpen`.
- `src/components/ui.tsx:131-145` portals a modal and independently sets/removes `.app-shell` `inert`/`aria-hidden`.
- `src/components/CommandPalette.tsx:28-31` portals a second modal surface and independently performs the same boolean set/remove operation.

**Impact.** Two `aria-modal` dialogs can coexist. When the top palette closes, its cleanup removes `inert` and `aria-hidden` from the app shell even though the original modal is still open, exposing modal background content to assistive technology and violating the focus model. Other global shortcuts can also mutate the hidden workspace while a confirmation is open.

**Realistic trigger.** Open “Clear browser data?”, then press `⌘K`. The command palette opens over the confirmation. Press Escape once to close the palette; the confirmation remains, but the palette cleanup makes the application shell non-inert.

**Remediation.** Centralize overlay state and background inerting with a stack/reference count. Suppress non-overlay global actions while a modal is active, and make the topmost overlay the sole focus/escape owner. Add an E2E test for modal → `⌘K` → Escape and assert exactly one modal plus continued background inertness.

### 9. Medium — Composer suggestion popups are mouse-oriented rather than an accessible keyboard combobox

**Evidence**

- `src/components/Composer.tsx:61-73` keeps focus in a plain textarea and only handles Enter-to-submit and Escape; it exposes no `aria-expanded`, `aria-controls`, `aria-activedescendant`, or arrow-key selection behavior.
- `src/components/Composer.tsx:74-79` renders the appearing suggestions in a generically labeled `<div>`, with no listbox/menu role or association to the textarea.
- `src/components/Composer.tsx:40-42` opens the popup as a side effect of typed content, but there is no live announcement that choices appeared.

**Impact.** Screen-reader users are not told that slash-command/skill suggestions exist, and keyboard users cannot navigate/accept them with the conventional arrow/Enter flow. Enter instead submits the current raw text; discovering that Tab happens to reach the buttons is not a robust command interface.

**Realistic trigger.** Type `/` or `@` without a mouse. A visual menu appears, but ArrowDown does nothing and Enter sends the incomplete prompt rather than selecting the highlighted/first suggestion.

**Remediation.** Implement the ARIA combobox/listbox pattern (or a documented menu-button pattern): stable popup ID, expanded/controls/active-descendant state, roving active option, ArrowUp/Down, Enter acceptance, Escape close, and an empty-results announcement. Test it exclusively from the keyboard and through the accessibility tree.

### 10. Medium — Sidebar session grouping is quadratic at the service's supported catalog size and reruns during streaming

**Evidence**

- `electron/main/sessions.ts:120-143` supports catalogs of up to 5,000 session files.
- `src/components/Sidebar.tsx:61-62` filters every project and calls `activeSessions.some(...)` inside that filter.
- `src/components/Sidebar.tsx:97-99` again filters all active sessions separately for every visible project.
- Agent events update root state at `src/App.tsx:188-193`, and the non-memoized Sidebar is rendered from the root at `src/App.tsx:430-445`, so this unrelated catalog work repeats during token streaming.

**Impact.** With many projects/sessions, navigation render cost grows as projects × sessions, and unrelated message deltas repeatedly pay it. The sidebar can become sluggish even before DOM volume is considered.

**Realistic trigger.** A user with hundreds of project roots represented across a few thousand retained sessions starts an agent response. Each streamed update rerenders the App and repeatedly scans the full session catalog for every project.

**Remediation.** Build a memoized `Map<projectPath, SessionRecord[]>` in one pass, derive search membership from that index, memoize Sidebar against catalog/navigation props, and virtualize the project groups if needed. Add a 5,000-session render benchmark and verify message updates do not rerender Sidebar.

## Positive controls observed

- **Markdown safety is intentionally layered.** `src/components/MarkdownText.tsx:20-30` uses `skipHtml`, replaces images with text placeholders, and only dispatches `http(s)`/`mailto` links. `electron/main/ipc.ts:61-64` validates again before `shell.openExternal`. `tests/backend/markdown.test.ts:19-27` verifies raw HTML and remote image suppression. I found no concrete Markdown XSS or tracking-image issue.
- **The Electron browser guest is materially hardened.** `src/components/Inspector.tsx:192-198` requests sandbox/context isolation/no Node, and `electron/main/index.ts:83-102` overwrites guest preferences, constrains the persistent partition and initial URL, denies popups, and validates guest-initiated navigations/redirects.
- **Focus fundamentals are better than typical custom desktop UI.** `src/components/ui.tsx:90-125` has reusable trapping and focus restoration; `src/components/ui.tsx:128-145` supplies modal naming/modal semantics; inspector tabs implement roving focus at `src/components/Inspector.tsx:263-282`; separators expose value/orientation and keyboard resizing at `src/components/ResizeHandle.tsx:25-37,72-86`. The E2E suite exercises modal focus, compact overlays, tab arrows, and both resize orientations (`tests/e2e/app.spec.ts:64-147`).
- **Viewport and motion accommodations are deliberate.** `src/App.tsx:99-137` tracks compact layout and bounds resizable panes with `ResizeObserver`; `src/styles.css:713-776` supplies compact overlays/touch sizing; both the setting and OS preference disable animations (`src/styles.css:691,778-780`).
- **Visual resources are cleaned up.** `src/components/TerminalDrawer.tsx:99-106` disconnects observers/listeners, kills the PTY, and disposes xterm. The browser guest only exists for the active Browser tab (`src/components/Inspector.tsx:282-286`), rather than remaining invisibly mounted across all inspector tabs.

## Dismissed false alarms / non-findings

- The 71 KiB stylesheet is large, but size alone is not a runtime defect; selectors are mostly shallow/static, animations are short, and reduced-motion paths exist. The concrete reflow problems above come from update strategy and unbounded DOM, not raw CSS byte count.
- The custom Markdown anchor renderer does not re-enable raw HTML or remote media. React escaping, `react-markdown`'s URL handling, the renderer protocol check, and the main-process URL validator prevent the obvious `javascript:`/HTML/image paths; I did not report them as vulnerabilities.
- xterm's `ResizeObserver`/`fit.fit()` could look like a resize loop, but it is rAF-deferred, guarded during transitions, disconnected on cleanup, and is the standard fitting mechanism. The reported issue is the unthrottled root resize path around it, not the observer itself.
- CSS below 720 px is mostly unreachable in the packaged Electron window because `electron/main/index.ts:116-121` sets a 960 px minimum width. That is dead/future responsive coverage, not an operational defect in the supported window range.
- Index keys inside immutable, append-oriented message parts are not ideal, but I found no demonstrated state corruption from them; stateful tool/thinking parts use stable tool IDs where available. No finding was raised on style preference alone.

## Test coverage gaps tied to the findings

The current tests validate Markdown structure/suppression and several good focus/resize paths, but there are no tests for transcript/diff size budgets, user-controlled scroll-follow, render counts during resizing/streaming, command callback freshness, xterm screen-reader mode, response announcements, nested overlays, composer popup keyboard behavior, or large sidebar catalogs. Those are the highest-value regression additions after remediation.
