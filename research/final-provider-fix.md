# Final provider/settings acceptance fix

## Scope

Closed the provider and settings acceptance blockers from the final quality review while preserving the existing fixed IPC surface, main-process validation, auth-store ownership, and catalog redaction.

## Changes

- **Ordered runtime mutations:** provider model, reasoning-effort, and fast-tier changes now enter one serialized queue. Each mutation has a revision and runtime-owner check, so stale completions cannot synchronize or roll back a newer selection. A latest command rejection restores the prior optimistic state, refreshes the authoritative runtime, and reports the failure. Switching runtime or unmounting invalidates pending UI reconciliation.
- **Single-writer provider policy:** removed the renderer `settings:update` after `providers:set-enabled`. The main IPC handler remains the sole writer of `disabledProviders`; the renderer consumes the authoritative catalog returned by that operation.
- **Subscription availability:** a configured `openai-codex` account retains its built-in ChatGPT subscription catalog when executable-model discovery is empty or partial. Exact executable keys still govern other providers, so unconfigured providers do not become available. Optional discovery rejection is downgraded to a bounded generic catalog warning rather than exposing exception details.
- **Provider accessibility:** enable checkboxes have provider-specific accessible names; OAuth account choices use ordinary buttons in a labelled group rather than an incomplete listbox pattern; API-key save failures render as `role="alert"` within the still-active dialog.
- **Privacy setting:** restored the optional diagnostics checkbox and its `onUpdate({ telemetry })` behavior.
- **Test collection/runtime:** Vitest collects both `.test.ts` and `.test.tsx` with automatic JSX transform. Added jsdom for behavioral renderer tests. Coverage now includes the provider backend, provider hook, and extracted plugin backend modules.
- **Behavioral tests:** replaced static-markup provider tests with mounted interaction tests covering toggle rejection and accessible naming, modal-local API-key rejection, OAuth selection behavior, telemetry persistence, serialized rapid effort updates, model rollback/synchronization, and absence of duplicate settings persistence. Backend cases cover configured empty/partial/full subscription discovery and prove unconfigured providers remain unavailable.

## Validation

- `npm run typecheck` — pass
- `npm test -- --run tests/backend/providers.test.ts tests/frontend/provider-settings.test.tsx` — pass
- `npm test -- --run` — provider checkpoint pass (29 files / 152 tests). A later shared-tree rerun after another agent added `renderer-concurrency.test.tsx` was temporarily red only in that concurrent work's three new settings/transcript/bootstrap cases (29 files passed; provider tests remained green).
- `npm run test:coverage` — provider checkpoint pass (29 files / 157 tests; 72.83% statements, 58.43% branches, 81.88% functions, 80.15% lines)
- `npm run check` — pass
- `npm run build` — final pass after all provider changes

No commit was created.
