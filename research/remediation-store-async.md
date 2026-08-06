# CFR-10: asynchronous durable desktop-state persistence

## Finding

`JsonStateStore.update()` previously executed the complete persistence path with synchronous `node:fs` calls on the Electron main thread. Every state change serialized the full JSON document, opened and wrote a temporary file, fsynced and closed it, renamed it, then opened and fsynced the containing directory before the main thread could process more work. The queue protected update ordering, but it did not make any of that filesystem work asynchronous.

This made routine project, session, and settings changes capable of stalling IPC, window events, and other main-process work on slow or contended storage.

## Remediation

The persistence pipeline now uses promise-based file operations and remains serialized behind the store's existing operation queue. No production caller changed: `snapshot()` remains synchronous and `update()` retains its existing promise API.

For each committed draft, the store now performs these awaited steps in order:

1. Open a unique same-directory temporary file with mode `0600`.
2. Write the complete JSON snapshot.
3. Fsync the temporary file.
4. Close the temporary file.
5. Atomically rename it over the state file.
6. Open and fsync the containing directory, retaining the prior compatibility behavior for filesystems that reject directory fsync.
7. Attempt temporary-file removal from an outer `finally` block on success and on every failing stage.

The state directory is still created with mode `0700`. Startup parsing remains synchronous so a valid snapshot is immediately available to existing callers. Missing or corrupt state schedules asynchronous default-state persistence on the same queue; corrupt input is still moved aside before recovery. A later update waits behind recovery, and a recovery failure does not permanently poison the queue.

A draft becomes the in-memory snapshot only after its durable persistence sequence finishes. If open, write, file fsync, close, rename, or cleanup fails, `update()` rejects, the previous in-memory snapshot stays authoritative, and subsequent queued updates can continue from that snapshot.

## Verification

`tests/backend/store.test.ts` now covers:

- concurrent update serialization without lost data;
- exact write/fsync/close/rename/directory-fsync ordering;
- snapshot publication only after directory durability completes;
- injected failures at open, write, file fsync, close, and rename;
- cleanup attempts for every injected failure;
- removal of a real partially written temp file and successful queue recovery;
- startup corrupt-file recovery ordered before a later update;
- `0700` directory and `0600` state-file permissions;
- persisted session archive behavior without transcript modification.

Validation completed:

- `npm test` — 20 files, 87 tests passed.
- `npm run typecheck` — main/preload and renderer TypeScript checks passed.
