# Plugin discovery and MCP settings remediation

## Scope

This change addresses the plugin audit findings in `electron/main/plugins.ts` and adds focused coverage in `tests/backend/plugins.test.ts`. It does not change package installation, MCP transport validation, the persisted MCP schema, or the project settings symlink policy.

## Discovery remediation

Plugin discovery no longer uses synchronous `readdirSync`, `readFileSync`, `lstatSync`, or `realpathSync` work on the Electron main thread. Discovery now uses promise-based filesystem operations and streaming `opendir()` iteration.

The traversal shares explicit per-discovery limits:

- 2,000 unique candidate files;
- 1,000 opened directories;
- 20,000 inspected directory entries;
- depth remains capped at six levels;
- 2,500 total returned records after package/MCP settings metadata; and
- settings input is capped at 4 MiB.

Markdown metadata reads use an exact 128 KiB prefix read rather than reading an entire file and slicing afterward. Candidate canonicalization and metadata extraction run through at most 16 workers, bounding simultaneous file buffers and filesystem requests. Symlink directory entries remain excluded. Project roots and explicitly configured project paths are canonicalized and checked for containment before traversal or metadata reads, with a final containment check retained before a record is returned.

Concurrent `list()`/`refresh()` requests with the same requested project key now share the same in-flight promise. The entry is removed on either fulfillment or rejection, so subsequent refreshes perform a new scan.

## MCP settings mutation remediation

MCP definitions retain the existing explicit representation:

- HTTP: `{ type: "http", url, enabled: true }`;
- stdio: `{ type: "stdio", command, args?, enabled: true }`;
- existing names are not overwritten; and
- the success response still explains that the definition is saved for a new Prime session and does not claim package installation.

Each settings mutation now:

1. enters the existing per-service promise queue;
2. acquires an interprocess directory lock;
3. rereads and validates the current settings file **after** lock acquisition;
4. merges only the new `mcpServers` entry;
5. atomically renames a uniquely named, mode-0600 temporary file; and
6. releases the lock only if its owner token still matches.

The lock contains a versioned owner record with PID, random token, and creation time. A contender reclaims a lock only when all of the following hold:

- the owner record is complete and valid;
- `process.kill(pid, 0)` reports `ESRCH`, proving that PID is not live;
- a separate atomic recovery directory is acquired to serialize competing reapers; and
- the owner record is reread and exactly matches the originally observed token before removal.

Unknown, malformed, permission-denied, or live owners are never age-evicted. This is intentionally conservative: PID reuse can delay recovery but cannot cause an active owner to be removed. Competing stale-lock recovery and normal acquisition remain exclusive; if another process wins the post-removal `mkdir`, the reaper does not remove that replacement lock.

Project MCP settings still reject symlinked `.prime`, `agent`, or `settings.json` components and re-check canonical containment while creating directories.

## Verification

Focused tests cover:

- duplicate in-flight refresh coalescing;
- contained project-configured discovery and rejection of outside/symlink targets;
- unchanged HTTP and stdio MCP serialization;
- project settings symlink rejection;
- duplicate-name and credential validation;
- two independent `PluginService` instances merging concurrent changes without a lost update; and
- recovery from a lock whose recorded child-process owner has exited.

Commands run:

```text
npm test -- --run tests/backend/plugins.test.ts
npm run typecheck
npm test
```

## Residual limits

The lock coordinates Prime processes that use this protocol; an unrelated writer that ignores the lock can still race the final rename. Atomic rename prevents partial JSON but cannot provide a universal compare-and-swap across non-cooperating applications. A crash in the very small interval between creating a lock directory and writing its owner record leaves no provably stale owner, so the implementation fails closed and reports settings as busy rather than deleting an unverifiable lock.
