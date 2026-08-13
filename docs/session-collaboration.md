# Session collaboration

GooeyPi lets top-level sessions in the same harness and working directory coordinate without turning them into parent/child subagents. In the composer, type `@` and part of a sidebar session title, then select the result. The visible `@title` is sent with a model-only routing block containing the stable session UUID. A session's context menu also exposes **Copy session UUID** for explicit coordination prompts.

Every Prime, OMP, and pi runtime receives four app-owned tools:

- `session_list`: list accessible peer titles, UUIDs, status, and liveness.
- `session_read`: read a bounded recent snapshot and cursor without modifying the peer.
- `session_send`: deliver an attributed prompt or follow-up. If the saved peer is idle/offline, GooeyPi starts its normal RPC runtime first; the runtime manager revalidates its project and session paths.
- `session_wait`: wait up to 30 seconds for a peer to become idle and produce context after a cursor. Sends are non-blocking, and tool guidance prohibits mutual waits.

## Upstream research

The three harnesses do not provide one common top-level-session API:

| Runtime | Existing collaboration | Missing piece |
|---|---|---|
| Codex Desktop | Addressable tasks, background sends, bounded reads, and cursor-based waits; titles resolve to stable task IDs. | This is the product behavior GooeyPi mirrors, not a harness API GooeyPi can call. |
| Prime Agent 0.7.2 | Daemon `send_message` accepts a UUID/name and can wake a saved session. Agent-origin messaging and observation are family-scoped, and observation does not uniformly cover top-level workers. | No uniform cross-worker read/wait contract suitable for all GooeyPi harnesses. |
| OMP 17.2.15 | Task subagents can follow up/await inside one parent run; `/collab` and `omp join` provide a live shared relay room. | No arbitrary saved top-level session UUID/name read/send/wait RPC. |
| pi 0.84.1 | Current-session RPC, `switch_session`, and illustrative subprocess subagent/handoff extensions. | `switch_session` replaces the caller's runtime; there is no durable peer mailbox or arbitrary target API. |

Using Prime's daemon transport only for Prime would create three different semantics and would bypass its deliberate family restrictions. Mutating OMP/pi JSONL would violate harness ownership. The minimal uniform design is therefore a GooeyPi-owned broker over the existing per-harness RPC managers.

## Trust and lifecycle boundaries

- Access is same-harness, same-canonical-working-directory, and excludes the caller. A multi-folder workspace does not silently widen one session's authority to its other roots, and harness-scoped project grants never authorize another harness.
- Every runtime receives a separate random bearer token bound to its immutable harness/session claim. Tokens stay in the child environment and never cross renderer IPC.
- Target UUIDs are exact and validated. Titles are display-only; `@title` resolution happens in the renderer against the visible sidebar catalog.
- Session JSONL remains read-only. Reads go through the owning `SessionService`; sends go through the owning live RPC manager.
- Read snapshots are limited to 40 recent messages and 96 KiB of text. Sends are limited to 64 KiB. Waits are capped at 30 seconds, broker calls are body-bounded and rate-limited, and cached catalogs prevent wait polling from rescanning all session files.
- An offline send may start a normal runtime only after the existing manager reauthorizes both cwd and canonical session path. Concurrent wake requests share one in-flight start.
- Routing blocks are stripped from the rendered user transcript. User-supplied routing delimiters are neutralized before GooeyPi adds its own block.

Native Prime subagent messaging, OMP task subagents/relay rooms, and pi extensions remain unchanged. Session collaboration is an additional top-level coordination surface.
