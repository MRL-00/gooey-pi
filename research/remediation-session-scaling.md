# Session scaling remediation

## Problem summary

The session backend did expensive work on the renderer's startup path:

- `projects:list` obtains the all-session catalog while `sessions:list` requests the same catalog directly. Concurrent calls independently enumerated and parsed JSONL files.
- The directory's first 5,000 entries were selected in filesystem enumeration order. That order is not a stable proxy for recency.
- Unchanged JSONL files were reparsed on every list.
- Transcript reads retained as many as 200,000 parsed records and could return extremely large tool output, arguments, image data, and message collections over IPC into the DOM.
- `StrictJsonlDecoder` appended every fragment to one growing string. Highly fragmented records could repeatedly copy the buffered prefix and exhibit quadratic work.

## Remediation

### Catalog scans

`SessionService` now has one in-flight all-session scan shared by every concurrent filtered/unfiltered `list` call. Archive and project filtering, plus runtime status overlay, happen after the shared scan so callers still receive the requested view. The project provider in `electron/main/index.ts` deliberately uses the same all-session query as renderer startup.

Discovery now:

1. enumerates JSONL names;
2. canonicalizes and stats candidates with bounded concurrency;
3. rejects candidates resolving outside the canonical session root;
4. deduplicates canonical paths;
5. sorts by descending mtime with canonical path as a deterministic tie break; and
6. selects at most the newest 5,000 **before** JSONL metadata parsing.

Parsed metadata is cached against the canonical-path + mtime + size fingerprint. A post-read stat prevents a concurrently changing file from being stored under a stale fingerprint. Cache entries outside the current selected catalog are pruned, and per-fingerprint in-flight reads are coalesced. Live `prime-agent list` metadata is applied to copies, not cached JSONL metadata, so transient status cannot contaminate the file cache. The existing short-lived live-catalog cache remains authoritative for avoiding repeated subprocess work.

Archive/restore behavior is unchanged: archive state remains in `JsonStateStore`; no transcript is modified or moved.

### Transcript/IPC bounds

Transcript traversal continues to find the newest branch, but retains only the most recent 10,000 graph records and 16 MiB of JSONL record data while scanning. This yields a recent suffix if the older parent chain falls outside the window. A transcript record is capped at 8 MiB.

Before returning over IPC, the backend applies recent-first budgets:

| Resource | Returned cap |
| --- | ---: |
| Messages | 400 |
| Parts | 2,000 |
| Conversation text/thinking | 1 MiB |
| Tool results | 512 KiB total, 128 KiB per part |
| Tool-call arguments | 256 KiB total, 128 KiB per part |
| Image data | 512 KiB total, 256 KiB per part |

Oversized strings retain a beginning and ending around an explicit truncation marker. Budgets are allocated newest-to-oldest, preserving the most recent conversational context and tool failures. The current IPC signature remains unchanged; these semantics are compatible with a future paginated transcript endpoint because the returned value is already a bounded recent window.

### JSONL framing

JSONL framing now holds decoded fragments in an array and joins them once per complete line. Byte counts are maintained incrementally, preserving strict LF-only framing, CRLF handling, UTF-8 decoding, and maximum-frame enforcement without growing-string concatenation.

## Validation

Backend coverage was added for:

- concurrent catalog scan coalescing and sequential metadata cache reuse/invalidation;
- newest-first selection and deterministic mtime tie breaking;
- the 400-message recent transcript suffix;
- tool argument/output/image truncation; and
- a 50,000-fragment JSONL record.

Commands:

```sh
npx vitest run tests/backend/sessions.test.ts tests/backend/jsonl.test.ts tests/backend/store.test.ts
npm test
npm run typecheck
```
