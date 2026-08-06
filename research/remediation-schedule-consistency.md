# Schedule consistency remediation

This change addresses `CFR-03` and the earlier partial-catalog/mutation findings.

- Schedule add/cancel failures now reject to the page instead of being swallowed as apparent success.
- The creation modal remains open with its prompt and schedule intact, exposes an inline alert, and disables dismissal while a request is active.
- Cancel failures retain the task and show an actionable page alert; no optimistic paused state is fabricated.
- Catalog refresh failures are tracked separately from successful mutations and remain visible on the Scheduled page.
- Runtime catalog fan-out records whether any runtime failed. A partial result is never silently returned: Prime Work merges a successful CLI fallback, or rejects with an explicit incomplete-catalog error.
- Empty catalogs from fully responding runtimes remain valid and no longer trigger unnecessary CLI work.

Focused tests cover complete multi-runtime merge, explicit rejection of an unrecoverable partial catalog, and CLI recovery after runtime failure.
