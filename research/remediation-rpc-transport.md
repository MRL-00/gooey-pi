# RPC transport failure remediation

## Findings addressed

- `ESB-02`: an oversized JSONL frame only received a direct `SIGTERM`, allowing an uncooperative child to keep writing while the decoder retained and repeatedly revisited a large frame.
- `PS-05` / backend-quality transport finding: `extension_ui_response` bypassed request-write backpressure and acknowledged before its pipe write completed.

## Changes

- Decoder failure is now a one-way fatal transport state. Stdout is paused immediately, all pending requests are rejected, stdin is destroyed, the detached process group receives TERM, and a bounded wait escalates to process-group KILL.
- A failed decoder is not finalized again on stream end, avoiding a retained oversized fragment join and a second malformed-JSON event.
- All RPC writes, including extension UI responses and correlated requests, use one serialized write queue with a 2 MiB per-message bound and 32 MiB aggregate queued-byte bound.
- Extension responses report success only after the Node pipe write callback succeeds. Correlated requests remove their pending record when a queued write fails.

## Verification

The hostile regression fixture completes a valid handshake, emits more than the 16 MiB frame limit, ignores TERM, and remains alive. The test proves exactly one frame-limit transport error is emitted, process-group KILL removes the child, and the runtime disappears from the manager. Existing negative, mismatched, and failed-handshake RPC tests continue to pass.
