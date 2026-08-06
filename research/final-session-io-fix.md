# Final session I/O acceptance fix

## Scope

This closure addresses the remaining backend acceptance blockers in session transcript reads and session catalog discovery. The renderer/IPC contract and transcript/session JSONL limits are unchanged.

## Transcript admission

`SessionService.read` still canonicalizes and authorizes every requested path with `requireSessionPath` before any sharing occurs. After authorization, reads are keyed by the canonical session path:

- Concurrent requests for the same session share one in-flight `readTranscript` scan.
- Each caller receives a `structuredClone` of the scan result, so callers never share mutable arrays, messages, parts, or tool argument objects.
- A service-wide FIFO admission gate permits at most two distinct transcript scans at once. Additional distinct-session scans wait, while requests for an already queued or active session coalesce with that request.
- Admission and in-flight entries are released in `finally` paths, including read failures.
- The existing 256 MiB file limit, record/graph/part/text budgets, streaming marker behavior, and canonical-path authorization are unchanged.

This prevents overlapping renderer requests from independently streaming the same near-limit JSONL file and bounds simultaneous scans across different sessions.

## Catalog admission

Previously, catalog discovery called `realpath` and `stat` for every `.jsonl` directory name and only then applied `maxSessionFiles`. A large directory could therefore cause unbounded per-entry filesystem I/O despite the catalog result budget.

Discovery now performs admission from the single directory listing before per-entry I/O:

1. Filter visible `.jsonl` names.
2. Rank UUIDv7 session names by their embedded 48-bit timestamp, newest first.
3. Rank unknown legacy names by reverse lexical order as a deterministic fallback.
4. Admit at most `maxSessionFiles` names.
5. Only for admitted names, canonicalize, enforce containment, stat, deduplicate by canonical path, sort by actual mtime/canonical-path tie break, fingerprint, and parse metadata.

The normal Prime session filename is UUIDv7, making filename recency a useful bounded preselection signal without touching every directory entry. Actual mtime ordering, canonical containment checks, canonical-path deduplication, `(path, mtime, size)` fingerprints, metadata concurrency, and post-read stat validation remain in place for admitted files.

A narrow `SessionCatalogIo` provider makes discovery call budgets observable in tests without weakening the production implementation. The 50,000-entry test verifies that a three-file budget performs four canonicalizations (root plus three candidates), six stats (discovery plus post-parse validation), and three metadata reads.

## Verification

- `npm test -- --run tests/backend/sessions.test.ts`
- `npm run typecheck`
- `npx biome lint --config-path=scripts/release/biome.json electron/main/sessions.ts electron/main/sessions/catalog.ts electron/main/sessions/transcript.ts electron/main/sessions/metadata.ts tests/backend/sessions.test.ts`

Focused tests cover per-session coalescing, authorization per caller, deep return cloning, global transcript admission, UUIDv7 candidate selection, actual newest ordering among admitted files, cache fingerprints, and bounded catalog provider calls.

Results at handoff:

- Focused sessions suite: 11/11 passed.
- Typecheck: passed.
- Owned-file Biome lint: passed.
- Full Vitest: 145/146 passed. The sole failure reproduces when run alone in `tests/backend/providers.test.ts` (`honors exact ChatGPT subscription discovery results when they are available`, unexpected `gpt-5.6-terra`) and is outside this session I/O scope.
