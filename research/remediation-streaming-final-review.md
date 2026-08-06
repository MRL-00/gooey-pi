# Streaming performance final review

## Verdict: REJECT

Scope reviewed: the current uncommitted changes in `src/App.tsx`, `src/components/Sidebar.tsx`, and `src/pages/ActivityPage.tsx`. No production files were edited.

There are two correctness blockers in the proposed optimizations. The frame queue preserves order inside an ordinary batch and has an appropriate workspace-generation guard, but it can apply an event twice when a transcript load resolves before the queued animation frame. The Sidebar custom comparator also deliberately treats changed function props as equal, so it does not preserve the component's callback-prop contract.

## Findings

### Blocker 1 — transcript-load events can be replayed and then frame-applied a second time

**Locations:** `src/App.tsx:343-350`, `src/App.tsx:379-385`, `src/App.tsx:237-249`

Every admitted agent event is currently sent to both paths while a transcript read is pending:

1. line 349 pushes it into `pendingLoad.eventBuffer`;
2. line 350 also queues it in `pendingAgentEventsRef` for the next animation frame.

If `sessions.read()` resolves before that frame, line 385 installs `pendingLoad.eventBuffer.replay(value)`, which already contains the event. The later frame then reduces the same event over that installed result. Text/thinking deltas are not idempotent, so a delta such as `"x"` becomes `"xx"`. Error events can likewise be duplicated; other event types happen to be idempotent only in some states.

The opposite schedule (frame flush first, read result second) ends with a correct single replay because the transcript replacement overwrites the temporary frame result. Thus this is timing-dependent and the existing pure event-buffer test does not exercise it.

**Required remediation:** establish a single owner for events received during a pending transcript load. One safe design is to buffer them without also frame-queuing them; on read success replay the buffer over the loaded transcript, and on read failure replay the buffer over current messages before reporting the error. An alternative is to tag queued events with the load token and atomically remove/flush exactly those entries before installing the replay. Add integration coverage for both schedules: read resolves before RAF and RAF occurs before read, asserting each delta appears once.

### Blocker 2 — Sidebar memo equality ignores all callback props

**Location:** `src/components/Sidebar.tsx:155-162`

The comparator returns `true` based only on data/selection/overlay props and ignores `onSelectProject`, `onSelectSession`, `onNavigate`, `onNewSession`, `onAddProject`, `onClose`, `onOpenPalette`, `onRenameSession`, and `onArchiveSession`. React therefore retains callbacks from the last admitted render even when the caller deliberately supplies replacements. In `App`, these functions are recreated inline or in the component body, so this is not merely a theoretical mismatch in referential identity.

Several current closures happen to have their important changing inputs correlated with compared props (for example `compactLayout` with `overlay`, and `sessions` with the `sessions` array), while some are semantically stable. That coincidence is fragile and does not make it valid for `Sidebar` to discard changed callback props. A direct render/rerender test with identical data props and a replacement callback would invoke the old callback.

**Required remediation:** preserve function-prop semantics. Prefer stabilizing App handlers with `useCallback` (and avoiding inline wrapper functions), then use normal `memo(SidebarView)` shallow equality. Alternatively include every callback in the custom comparison, accepting that unstable parent callbacks will defeat the optimization. Add a rerender test proving the newest callback is invoked.

### Non-blocking — Activity batch limit resets after commit

**Location:** `src/pages/ActivityPage.tsx:24-25`

The 250-row cap and progressive “show more” behavior are otherwise straightforward, and filtering/sorting still occurs before slicing. However, after a user has expanded beyond 250, changing filter/query renders the new result set once with the old `visibleLimit`; the effect resets it only after commit. This can briefly render far more than 250 matching rows, precisely on the interaction the batching is intended to protect.

Reset the limit synchronously in the filter/query change handlers, or keep criteria and limit in one state transition / derive an effective limit keyed to the criteria. Add focused coverage for initial 250 rows, progressive increments, and immediate reset on query/filter change. Also note that trimming the query and resolving folder aliases are small behavior changes from the previous implementation; they appear reasonable but should be intentional.

## What is preserved

- **Order within a frame batch:** `push` plus ordered `reduce` preserves arrival order.
- **Ordinary workspace isolation:** each queued item records the current generation; `activateWorkspace` clears the queue, cancels the scheduled frame, increments the generation, and the flush filters against the current generation.
- **Runtime admission:** the existing exact `runtimeIdRef` check still rejects events from non-owned runtimes before queueing.
- **Runtime lifecycle state:** `agent_start`, terminal/error events, and `runtime_exit` still update runtime state synchronously; a queued `runtime_exit` remains eligible after the runtime ref is cleared because the queued message event is generation-scoped. The transcript-load double-application race above is the exception that prevents acceptance.
- **Activity ordering:** visible rows remain sorted newest-first before they are sliced into batches.

## Validation run

- `npm run typecheck` — **PASS**
- `npx vitest run tests/backend/events.test.ts tests/frontend/runtime-state.test.ts` — **PASS** (2 files, 6 tests)

The passing tests do not cover App's deferred-RAF/transcript-read interleaving, Sidebar rerender callback replacement, or Activity's post-commit batch reset.

## Acceptance gate

Reject until both blockers are remediated and regression tests cover:

1. live delta during transcript load with read-before-RAF and RAF-before-read scheduling, exactly once and in arrival order;
2. workspace switch before a scheduled flush, with no old-workspace event admitted;
3. Sidebar identical data props plus changed handler, invoking only the newest handler;
4. Activity batch growth and synchronous criteria reset.
