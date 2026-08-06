# Settings page remediation

## Scope

This remediation addresses CFR-06 and the Settings page maintainability finding without changing `App.tsx`, the preload/API contract, or backend validation. The renderer continues to treat the main-process settings service as authoritative.

## Changes

- Split the former single-line `SettingsPage` renderer into section components under `src/pages/settings/` for General, Appearance, Prime Agent, Browser, Terminal, Privacy, and About.
- Kept the existing reasoning-summary and tool-call transcript preferences in the Prime Agent section.
- Added a reusable, accessible `DraftSettingField` for the two validated free-text settings:
  - `browserHome`
  - `terminalShell`
- Draft edits remain local. A write is attempted only on blur, Enter, or the Save button, and unchanged or locally invalid drafts do not call `onUpdate`.
- Browser homes are checked for a complete HTTP(S) URL, length, and embedded credentials, then normalized in the same way as the backend URL parser.
- Shell paths are checked locally for non-empty/maximum length, NUL bytes, and an absolute path. Executability and `/etc/shells` membership remain privileged backend checks.
- Inline errors use `role="alert"`, `aria-invalid`, and `aria-describedby`. A rejected write keeps the user's draft so it can be corrected.

## Synchronization and race handling

The pure state reducer in `draft-state.ts` tracks the displayed draft, last committed baseline, latest prop source, edit revision, and one in-flight commit. Prop changes synchronize a clean field but do not overwrite dirty or in-flight text.

Only one write per field can be in flight. If the user edits while that write is pending, its completion updates the baseline without replacing the newer text. Stale completion IDs are ignored. The reducer also recognizes the optimistic-prop-then-rollback sequence used by `App.tsx`, including a rollback rendered immediately before or after the update promise settles, and preserves the submitted draft with an inline error.

`SETTINGS_FIELD_SECTIONS` is typed as `Record<keyof AppSettings, SettingsSection>`. This creates a compile-time inventory of every settings field and makes future additions fail type checking until section ownership is chosen.

## Tests

`tests/frontend/settings-page.test.ts` deterministically covers:

- edit-versus-commit behavior;
- clean prop synchronization and dirty draft preservation;
- direct rejection preservation;
- optimistic rollback ordering on both sides of promise settlement;
- stale completions and edits made during a pending write;
- browser-home and terminal-shell local validation;
- canonical browser URL output; and
- ownership of every `AppSettings` field, including the reasoning/tool visibility preferences.

## Validation

- `npm run typecheck`
- `npm test -- --run tests/frontend/settings-page.test.ts`
- `npm test`
- `npm run build`
