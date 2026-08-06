# Renderer throughput remediation

The final UI pass keeps high-rate Prime output and large session catalogs responsive without changing the visual design.

- Prime event application is batched to one React state commit per animation frame and generation-tagged, so queued output from a prior workspace cannot cross a project/session switch.
- The sidebar is memoized across transcript-only updates and pre-indexes sessions by project rather than rescanning the full catalog for every project.
- Activity resolves project names through a prebuilt map and renders session results in accessible batches of 250 instead of materializing up to 5,000 rows at once.
- The main-process event gate reserves part of its strict byte window for one diagnostic and bounded lifecycle events, ensuring a dropped-output warning and `agent_end`/`runtime_exit` can still reach the renderer without making the channel unbounded.

TypeScript, focused event/security tests, the complete Vitest suite, and Electron E2E are the validation gates for this change.
