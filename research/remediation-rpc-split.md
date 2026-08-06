# RPC backend split

## Scope

The desktop RPC backend was split by responsibility without changing its public import path. `electron/main/agent-rpc.ts` remains the compatibility facade for `AgentRpcManager`, `AgentEventForwarder`, and `AgentEventLimits`.

## Size before and after

The before measurement was taken from the working tree immediately before this refactor, including the existing lifecycle-event limit hardening.

| File | Before | After |
| --- | ---: | ---: |
| `electron/main/agent-rpc.ts` | 560 lines / 26,501 bytes | 3 lines / 170 bytes |
| `electron/main/agent-rpc/command-schema.ts` | — | 132 lines / 8,368 bytes |
| `electron/main/agent-rpc/events.ts` | — | 85 lines / 3,228 bytes |
| `electron/main/agent-rpc/transport.ts` | — | 59 lines / 2,641 bytes |
| `electron/main/agent-rpc/runtime.ts` | — | 220 lines / 9,197 bytes |
| `electron/main/agent-rpc/manager.ts` | — | 108 lines / 4,681 bytes |
| `electron/main/agent-rpc/types.ts` | — | 1 line / 48 bytes |
| **RPC backend total** | **560 lines / 26,501 bytes** | **608 lines / 28,333 bytes** |

The small total increase is module imports, exports, and the explicit framed-transport boundary. The largest implementation module is now 220 lines.

## Responsibility boundaries

- `command-schema.ts`: renderer command allowlist, payload shapes, unknown-key rejection, field bounds, image constraints, session-path validation, and thinking-level values.
- `events.ts`: envelope construction, serialized-byte accounting, event/window rate limits, lifecycle-event reserve, and bounded limit reporting.
- `transport.ts`: strict 16 MiB JSONL frame decoding, secret-safe stderr draining, serialized stdin writes, and per-write/queued-byte limits.
- `runtime.ts`: request correlation, pending-request count/byte budgets, state tracking, fatal transport teardown, process-group TERM/KILL escalation, and stop timing.
- `manager.ts`: runtime registry/admission, maximum runtime count, launch arguments, authorization rechecks, session lookup, rename/stop helpers, and shutdown.
- `agent-rpc.ts`: stable public re-exports.

## Preserved controls

The extraction keeps the existing command names and validation branches, 20 MiB command cap, 16 MiB frame cap, 2 MiB write cap, 32 MiB queued-write and in-flight budgets, 32-request pending cap, four-runtime cap, response-command correlation, event count/byte limits, single limit reports, lifecycle-event accounting, fatal frame teardown, detached process groups, graceful abort, TERM/KILL escalation, and admission closure before shutdown snapshots.

## Verification

- `npx vitest run tests/backend/agent-rpc.test.ts tests/backend/security.test.ts`: 11/11 passed.
- `npx tsc --noEmit -p tsconfig.node.json && npx tsc --noEmit -p tsconfig.web.json`: passed.
- `npm test`: 96/96 passed on the final full run. An earlier fully parallel run hit two timing/process flakes outside the RPC split; both passed on immediate focused rerun before the clean full run.
