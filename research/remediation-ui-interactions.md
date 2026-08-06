# UI interaction and persistence remediation

This change addresses GUI/runtime findings for modal shortcut isolation, stale command-palette callbacks, keyboard-inaccessible composer suggestions, optimistic settings divergence, browser-reset false success, and startup responses overwriting newer user choices.

## Changes

- Composer `/` commands, skill mentions, and context suggestions now expose combobox/listbox/option semantics, active-descendant state, arrow-key cycling, Enter selection, Escape dismissal, and pointer/keyboard parity.
- Command-palette filtering no longer memoizes callbacks from an older App render.
- Global shortcuts are suppressed while a destructive/confirmation modal owns focus, preventing a second command palette or workspace action from breaking modal isolation.
- Settings writes are serialized, retain a confirmed snapshot, and roll back the latest optimistic value when validation or persistence fails. Rapid input updates cannot roll back to another unconfirmed value.
- Browser-data reset only closes its confirmation after the backend reports full success; failures remain visible in the modal and toast, and do not recreate the browser guest as if clearing succeeded.
- Startup project/session/settings responses are generation/revision-owned. A user workspace or setting change made while startup I/O is pending is no longer overwritten. Inspector tab intent is likewise retained.
- The shell exposes an explicit readiness state used by independent Electron tests.

## Verification

The hermetic Electron suite now has 12 independent cases. Added coverage proves keyboard composer selection, modal shortcut exclusion, extension-question round-trip, rejected shell-setting rollback, readiness ownership, browser guest attachment, and the existing responsive/PTY/lifecycle behaviors. Final result: 12/12 passed after a production build.
