# Frontend Performance Audit — Electron/React Renderer

**Scope:** `src/App.tsx`, renderer components/pages/data/events, the renderer-facing IPC implementations, build configuration, and tests.  
**Audit mode:** read-only production-code review. No production files were changed.  
**Validation:** `npm run typecheck` passed; `npm test` passed (12 files, 33 tests). A write-disabled Vite/Rollup production build was used for bundle measurement.

## Executive summary

The largest risks are concentrated in the transcript and diff surfaces. Agent deltas currently update state at the `App` root, causing the entire visible workspace to render for every event while Markdown is reparsed and smooth scrolling is restarted. Saved transcripts can be accepted at sizes far beyond what an all-at-once React DOM can handle, and the diff viewer can turn a 24 MiB diff into one React element per line. These paths can make the renderer visibly lag or hang during ordinary long-running agent work or when opening a large generated-file diff.

| ID | Severity | Finding |
|---|---|---|
| PERF-01 | **High** | Streaming deltas invalidate the whole application and repeatedly reparse growing Markdown |
| PERF-02 | **High** | Transcript loading has backend-scale limits but no renderer windowing, plus a quadratic last-message check |
| PERF-03 | **High** | The diff viewer eagerly expands up to 24 MiB into per-line React DOM |
| PERF-04 | **Medium** | Smooth autoscroll is restarted for every streaming update and reads layout each time |
| PERF-05 | **Medium** | File and activity catalogs render thousands of rows without virtualization |
| PERF-06 | **Medium** | Panel dragging drives root renders, terminal fitting, and synchronous persistence at pointer frequency |
| PERF-07 | **Medium** | Startup data waits for the slowest request and redundantly scans plugins |
| PERF-08 | **Medium** | Heavy terminal/Markdown and route code is eagerly shipped in one renderer chunk |
| PERF-09 | **Low** | The global shortcut listener is removed and re-added after every render |

No Critical findings were verified.

---

## Findings

### PERF-01 — Streaming deltas invalidate the whole application and repeatedly reparse growing Markdown

**Severity: High**

**Evidence**

- `src/App.tsx:188-204` subscribes to agent events in `App`; every relevant event calls root-level `setMessages` at `src/App.tsx:192`.
- `src/lib/events.ts:27-30` recreates the parts array and concatenates `last.text + delta` for each text/thinking delta. The accumulated string is copied again as it grows.
- `src/lib/events.ts:18-24` scans backward and then maps the complete message array for an update to the last assistant message.
- `src/App.tsx:430-458` renders the sidebar, toolbar, transcript, composer, inspector, command palette, and terminal from that same root. None of these boundaries is memoized.
- `src/components/Transcript.tsx:72-96,133-139` renders every message on each transcript render. Text parts invoke `MarkdownText` at line 80.
- `src/components/MarkdownText.tsx:21-33` invokes the full `react-markdown`/GFM parse and creates new `remarkPlugins` and `components` values on every render.
- The summary inspector adds full-history scans on the same hot path: `src/components/Inspector.tsx:51-59` reduces all messages/parts and copies/reverses/flat-maps them whenever the summary is visible.

**Impact**

Token/tool progress frequency is converted directly into React commit frequency. Work grows with both transcript history and current response length: old Markdown is reparsed even though old message objects are unchanged, while the streaming string is repeatedly copied. Sidebar/inspector/composer work also competes for the renderer thread. This can cause input lag, dropped animation frames, elevated CPU, and delayed terminal/browser interaction precisely while Prime is active.

**Realistic trigger / failure scenario**

A session with hundreds of prior messages receives a long Markdown response or verbose tool progress at tens of events per second. Each delta causes `App`, the full transcript, historical Markdown, sidebar, and summary inspector to render. Typing in the composer or clicking Stop becomes sluggish; on lower-powered machines the streamed response visibly arrives in bursts.

**Concrete remediation**

1. Buffer transport deltas outside React state and flush at most once per animation frame (or every 16–50 ms), coalescing adjacent text/thinking deltas.
2. Move transcript state/subscription behind a narrow external store or transcript controller so an event does not invalidate all of `App`.
3. `memo` message rows and `MarkdownText`; preserve stable old-message props (the event reducer already preserves most old message object identities). Hoist stable Markdown plugin/component configuration outside the component.
4. Separate the live trailing message from immutable transcript history so only the live row parses during streaming; optionally render live text cheaply and perform the full GFM parse after a throttled interval/finalization.
5. Add a React Profiler regression test that replays a representative delta burst and asserts bounded commits/time.

### PERF-02 — Transcript loading has backend-scale limits but no renderer windowing, plus a quadratic last-message check

**Severity: High**

**Evidence**

- `electron/main/sessions.ts:151-159` accepts a session file up to **256 MiB** and up to **200,000 records** before rejecting it.
- `electron/main/sessions.ts:154-176` retains all parsed entries in a `Map`, reconstructs the branch, and `electron/main/sessions.ts:177-213` returns the complete transcript over IPC.
- `src/App.tsx:208-217` installs that complete result directly as `messages`.
- `src/components/Transcript.tsx:121-140` maps the entire transcript to DOM; there is no pagination, windowing, `content-visibility`, or historical collapse.
- For every assistant row, `src/components/Transcript.tsx:136` allocates `messages.slice(index + 1)` and scans it to determine `isLast`. Across many assistant messages this is O(n²) work and transient allocation during each render.
- Full tool output is also mounted without a renderer-side display bound at `src/components/Transcript.tsx:55` and `src/components/Transcript.tsx:87`.

**Impact**

The backend's safety caps are not usable UI limits. Structured-cloning a very large transcript consumes memory in both processes; React then creates potentially hundreds of thousands of elements and parses all Markdown. The O(n²) `slice(...).some(...)` check compounds CPU and garbage collection. A file well below 256 MiB can freeze or crash the renderer.

**Realistic trigger / failure scenario**

A months-long agent session contains several thousand user/assistant/tool records and large shell outputs. Selecting it from the sidebar reads successfully, so no protective error is shown, but the window becomes unresponsive while IPC deserializes and React mounts every row. Subsequent streaming updates repeat much of that work.

**Concrete remediation**

1. Define a renderer-oriented transcript API: page from the newest N messages, load older pages on demand, and summarize/collapse large tool results. Do not send a 256 MiB object graph over IPC.
2. Virtualize message rows (variable-height virtualization with scroll-anchor preservation) or at minimum apply `content-visibility: auto` plus bounded incremental rendering as an interim measure.
3. Compute the last assistant index once in O(n), e.g. a reverse loop/useMemo, rather than `slice(...).some(...)` for every row.
4. Cap the displayed bytes/lines of tool results and provide an explicit “show more/open full output” path.
5. Add tests at realistic large-history sizes (for example 2k/10k messages and multi-megabyte outputs), measuring mount time, heap, and interaction latency.

### PERF-03 — The diff viewer eagerly expands up to 24 MiB into per-line React DOM

**Severity: High**

**Evidence**

- `electron/main/git.ts:91-101` permits `git diff` output up to **24 MiB** and returns the entire string through IPC.
- `src/components/Inspector.tsx:68-70` calls `text.split('\n')` and creates a `<span><i><code>` element set for every line in one render.
- `src/components/Inspector.tsx:88-101` stores the complete diff in React state and only ignores a late response; it does not cancel the underlying process/IPC or stream/page the result.
- `src/components/Inspector.tsx:131-134` mounts the entire `DiffView` in the scroll pane.

**Impact**

A large diff incurs multiple simultaneous copies (process output, IPC serialization, React state, `split` substrings) and several React/DOM nodes per line. Hundreds of thousands of lines can lock the renderer, trigger long garbage-collection pauses, or exhaust memory.

**Realistic trigger / failure scenario**

A generated lockfile, snapshot, minified asset, or data fixture changes and produces a 10–24 MiB diff. Clicking that changed file succeeds at the Git layer but hangs the inspector/window while React creates the line tree. Switching files before completion still leaves the original Git job consuming resources.

**Concrete remediation**

1. Lower the IPC/display limit and return explicit truncation metadata; offer “open externally” for oversized diffs.
2. Paginate or stream diff hunks and virtualize visible lines. Parse line classification once off the urgent render path (worker/main process) rather than constructing all nodes synchronously.
3. Add request IDs/cancellation (or killable child-process handles) so changing selection stops obsolete diff work.
4. Test generated 1 MiB, 10 MiB, and over-limit diffs with render-time/DOM-node budgets.

### PERF-04 — Smooth autoscroll is restarted for every streaming update and reads layout each time

**Severity: Medium**

**Evidence**

- `src/components/Transcript.tsx:111-119` runs its scroll effect whenever the `messages` reference changes; streaming makes that happen for each delta.
- At `src/components/Transcript.tsx:115-116`, it reads `scroller.scrollHeight` and immediately requests `scrollTo(..., behavior: 'smooth')` for every streaming update.
- The code does not test whether the user is already near the bottom, so it also forces the viewport back down while a user attempts to inspect older output.

**Impact**

Repeated `scrollHeight` reads can force layout after React has changed content, and continuously restarting smooth scrolling adds compositor/main-thread work to the already expensive delta path. It also creates scroll fighting, which is both a usability and responsiveness failure.

**Realistic trigger / failure scenario**

During a verbose response, a user scrolls up to inspect an earlier tool result. The next token starts another smooth scroll to the bottom; at high event frequency animations are continually superseded and the transcript jitters while consuming extra frame time.

**Concrete remediation**

Track whether the viewport is within a small threshold of the bottom via a sentinel/`IntersectionObserver`. Only auto-follow while that flag is true. Coalesce the actual scroll to one `requestAnimationFrame` per batch and use immediate anchoring during rapid streaming; reserve smooth scrolling for discrete events such as a newly appended message.

### PERF-05 — File and activity catalogs render thousands of rows without virtualization

**Severity: Medium**

**Evidence**

- `electron/main/projects.ts:183-207` returns as many as **5,000** project entries.
- `src/components/Inspector.tsx:217-243` stores the complete entry list, filters it, then maps every result to a button; each row also repeatedly splits its path at lines 240 and 242.
- `electron/main/sessions.ts:120-143` catalogs up to **5,000** session files, and startup requests archived sessions too at `src/App.tsx:158-160`.
- `src/pages/ActivityPage.tsx:12-14` sorts/maps the full visible session list. `projectName` at line 13 performs a linear `projects.find` per rendered session, producing O(sessions × projects) lookup work.
- The E2E suite only navigates to the page (`tests/e2e/app.spec.ts:44-54`); it does not exercise large catalogs.

**Impact**

Opening Files or Activity can create thousands of DOM rows and large React reconciliation/paint work. Search keystrokes repeat the filtering/rendering. The activity project's per-row linear lookup adds avoidable CPU as catalogs grow.

**Realistic trigger / failure scenario**

A monorepo reaches the 5,000-entry cap, or a long-time user accumulates thousands of archived sessions. Opening Files/Activity pauses for noticeable time; typing a filter lags and scrolling consumes high CPU.

**Concrete remediation**

Virtualize both lists and render only the viewport plus overscan. Page/file-query the IPC API instead of transferring and retaining everything. Precompute a `Map<projectPath, projectName>` once. Cache lowercase search fields/path depth/basename on ingestion, and use `useDeferredValue`/`startTransition` for non-urgent filtering.

### PERF-06 — Panel dragging drives root renders, terminal fitting, and synchronous persistence at pointer frequency

**Severity: Medium**

**Evidence**

- `src/components/ResizeHandle.tsx:51-55` calls `onChange` for every `pointermove` without animation-frame throttling.
- `src/App.tsx:448` and `src/App.tsx:452` connect those changes directly to `App` state setters. Therefore every drag step re-renders the full workspace rooted at `src/App.tsx:430-458`, including a potentially large transcript.
- `src/App.tsx:138-139` writes the current width/height to synchronous `localStorage` after each state change.
- Terminal container changes trigger a new fit request on every resize observation at `src/components/TerminalDrawer.tsx:99-100`; scheduled animation frames are not coalesced/cancelled.

**Impact**

Dragging competes with transcript/inspector rendering, synchronous storage, layout, and xterm fitting at pointer-event frequency. The handle can trail the cursor or stutter badly in a large session.

**Realistic trigger / failure scenario**

With a long transcript and terminal open, the user drags the terminal or inspector over several hundred pixels. Dozens to hundreds of root commits, storage writes, and fit calculations occur in under a second, causing visible jank.

**Concrete remediation**

Keep the live drag dimension in a CSS custom property/ref and update it at most once per animation frame; commit React state only at frame cadence or on pointer-up. Persist to `localStorage` on pointer-up or with a debounce. Coalesce/cancel outstanding xterm fit RAFs. Isolate/memoize transcript and sidebar so layout state cannot re-render them.

### PERF-07 — Startup data waits for the slowest request and redundantly scans plugins

**Severity: Medium**

**Evidence**

- Bridge-backed collections start empty at `src/App.tsx:64-72`.
- `src/App.tsx:155-176` starts seven requests concurrently, which is positive, but applies **all** fulfilled results only inside a single `Promise.allSettled(...).then(...)` at lines 158-174. Fast metadata/settings/projects therefore remain unapplied until the slowest request settles.
- A separate effect also calls `bridge.plugins.list(...)` at `src/App.tsx:147-153`, while startup independently calls `bridge.plugins.list()` at `src/App.tsx:158-160`. After the active project is set, the first effect runs again for project-scoped plugins.
- Plugin listing performs recursive synchronous filesystem traversal/read work at `electron/main/plugins.ts:68-83,133-192` (up to 2,000 candidates), on Electron's main thread.
- Session listing can inspect up to 5,000 files at `electron/main/sessions.ts:120-143`, making it a plausible slow member of the all-settled barrier.

**Impact**

The first useful renderer state is gated by unrelated slow work. Duplicate plugin scans add avoidable disk I/O and can block Electron main-process responsiveness because much of the scan is synchronous. On large home/project skill trees, startup feels blank or frozen longer than necessary.

**Realistic trigger / failure scenario**

A user has thousands of session files and a large `~/.agents/skills` tree on a slower disk. `getMeta` and settings return quickly, but no startup result is committed until the session/plugin work finishes; global plugins are scanned twice and then project plugins trigger another scan.

**Concrete remediation**

Start requests together but attach independent handlers (or use a small resource hook/store per domain) so each result paints as soon as it resolves. Establish one owner for plugin loading, deduplicate identical in-flight requests, and cache scan results keyed by scope/path with invalidation on refresh/install/config changes. Move synchronous filesystem traversal off the Electron main thread or convert it to bounded asynchronous/worker work.

### PERF-08 — Heavy terminal/Markdown and route code is eagerly shipped in one renderer chunk

**Severity: Medium**

**Evidence**

- `src/App.tsx:3-15` statically imports every component and page, including `TerminalDrawer` even when the terminal is closed.
- `src/components/TerminalDrawer.tsx:3-5` statically imports xterm, its fit addon, and xterm CSS.
- `src/components/MarkdownText.tsx:2-3` statically imports `react-markdown` and GFM parsing.
- `electron.vite.config.ts:17-22` defines a single renderer input and no manual/dynamic split strategy.
- **Verified measurement:** a write-disabled production Vite build transformed 1,856 modules and emitted one JS chunk of **760,704 bytes raw / 216,064 bytes gzip**. Rollup's module metadata attributed roughly **293,609 rendered bytes before final minification** to `@xterm`. No secondary feature chunk was emitted.

**Impact**

Users pay parse/compile/startup cost for terminal, settings, plugins, activity, scheduled work, and inspector features before using them. The effect is more important in Electron because renderer startup directly affects first-window responsiveness.

**Realistic trigger / failure scenario**

A user opens the app only to read/send a chat and never opens the terminal. The renderer still downloads from the app bundle and parses xterm plus every page on startup, delaying interactive readiness and increasing baseline memory.

**Concrete remediation**

Use `React.lazy`/dynamic imports for `TerminalDrawer`, non-session pages, and heavyweight inspector panels. Keep the default conversation shell in the entry chunk; preload optional chunks on idle or hover if desired. Add CI bundle budgets for entry raw/gzip size and assert that xterm is absent from the initial chunk. Re-measure actual Electron first-window/interactive timing after splitting.

### PERF-09 — The global shortcut listener is removed and re-added after every render

**Severity: Low**

**Evidence**

- The shortcut effect at `src/App.tsx:408-421` has no dependency array. React therefore executes its cleanup and adds a new `keydown` listener after every committed `App` render.
- Streaming events cause frequent root renders at `src/App.tsx:188-204`, and resize dragging does so through `src/App.tsx:448,452`.

**Impact**

This is not a listener leak—the cleanup is present—but it creates unnecessary global listener churn on the hottest render paths and makes stable memoized child boundaries harder to introduce.

**Realistic trigger / failure scenario**

A high-rate agent stream or panel drag causes dozens of `removeEventListener`/`addEventListener` pairs per second, adding avoidable main-thread work to an already busy renderer.

**Concrete remediation**

Make shortcut actions stable with `useCallback` and give the effect an explicit dependency list, or install one listener once and read the latest actions/state from refs (`useEffectEvent` where supported is another option). Add a unit/integration assertion that rerenders do not increase listener registrations.

---

## Positive observations

- **Subscriptions and expensive objects are cleaned up correctly.** `electron/preload/index.ts:4-10` returns precise IPC unsubscriptions; the agent effect returns it at `src/App.tsx:203`. Terminal cleanup disconnects both observers, event listeners, xterm disposables, kills the PTY, and disposes the terminal at `src/components/TerminalDrawer.tsx:101-106`.
- **Terminal output avoids React state.** `src/components/TerminalDrawer.tsx:60-68,89` uses xterm directly and caps scrollback at 5,000 lines, avoiding a React render per PTY chunk.
- **Async stale-result guards exist.** Session reads (`src/App.tsx:208-217`), diffs (`src/components/Inspector.tsx:88-101`), and file lists (`src/components/Inspector.tsx:223-233`) avoid setting state after the view/request is obsolete.
- **Independent startup IPC is at least launched concurrently.** `src/App.tsx:158-160` does not serialize the seven calls; PERF-07 concerns the shared completion barrier and duplicate plugin owner, not a request waterfall.
- **Several derived lists are memoized and bounded locally.** Examples include active sessions/visible projects (`src/components/Sidebar.tsx:53-62`) and file filtering/status maps (`src/components/Inspector.tsx:235-237`).
- **The browser guest is not mounted by default.** `src/components/Inspector.tsx:282-286` mounts only the selected inspector panel, avoiding an idle webview's process/network cost. Retaining the guest across tab changes would be a product tradeoff, not an automatic recommendation.

## Dismissed false alarms / non-findings

- **No verified event/subscription leak:** every reviewed renderer global/IPC/observer subscription has a corresponding cleanup. The missing dependency array on the shortcut effect is PERF-09 listener churn, not accumulating listeners.
- **No terminal recreation on ordinary `App` renders:** `reportError` is stabilized with `useCallback` at `src/App.tsx:141-145`, so the terminal effect dependency at `src/components/TerminalDrawer.tsx:107` does not change merely because the root rendered.
- **Named `lucide-react` imports were not treated as a bundle defect:** the production build tree-shook them to a comparatively small module contribution. The verified initial-chunk concern is the unsplit feature graph, especially xterm/Markdown.
- **React `StrictMode` at `src/main.tsx:9` is not a production double-render finding:** its extra effect/render checks are development behavior.
- **The browser panel's unmount-on-tab-switch behavior was not filed as a defect:** it can cause reload cost/history loss, but it also releases a high-cost guest. This needs product-level persistence requirements and runtime measurement before changing it.
- **Small demo timer handling is adequate:** timers are collected and cleared on unmount at `src/App.tsx:94,206`; no production bridge path uses them.

## Test and measurement gaps

- `tests/backend/events.test.ts:9-24` checks two error/finalization cases only; it does not replay text/tool delta bursts, assert coalescing, or measure reducer/render scaling.
- `tests/e2e/app.spec.ts:44-54,108-169` verifies navigation, resizing, and terminal behavior, but has no large transcript, large diff, 5,000-row catalog, heap, long-task, React commit-count, or startup timing coverage.
- Recommended CI gates: entry-chunk gzip budget; no-xterm-in-entry assertion; startup time to settings/projects paint; 1,000-event streaming profiler benchmark; transcript/diff/catalog DOM-node and interaction-latency budgets; and a resize test with a large transcript.

## Recommended remediation order

1. **Protect the renderer from large data:** transcript pagination/windowing and diff truncation/virtualization (PERF-02/03).
2. **Fix the live hot path:** event coalescing, narrow state ownership, memoized rows/Markdown, and bottom-aware RAF scrolling (PERF-01/04).
3. **Make resizing and large catalogs incremental** (PERF-05/06).
4. **Improve first-window work:** incremental startup results, plugin dedup/cache, and lazy chunks (PERF-07/08).
5. **Remove low-level listener churn and add performance budgets** (PERF-09 and test gaps).
