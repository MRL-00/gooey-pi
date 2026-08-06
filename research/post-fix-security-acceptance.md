# Post-fix security acceptance — `fix/audit-final-closure`

**Reviewed tree:** `/private/tmp/prime-audit-verify`, pending merge of `1358408` into `c911e77` on `fix/audit-final-closure`, with the full integrated closure also reviewed relative to `bb41cf7`
**Method:** independent source/diff and conflict-resolution review plus non-Electron validation. Product/test code was not edited by this review.
**Verdict:** **ACCEPT**. I found **no remaining code blocker** in the requested CFR/security scope or in the pending merge resolution.

Public Apple distribution was not executed because this host has no Developer ID/notarization secrets. That is an external credential prerequisite, not a source defect: both the standalone preflight and the public package entry point fail closed before quality/build/package work when the credentials are absent.

## Validation

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run check` | **PASS** — 159 files linted; 12 release/config files format-checked |
| `npm test` | **PASS** — 36 files, 232 tests |
| `npm run release:bundle-size` | **PASS** — main 212,208 B; preload 5,051 B; initial renderer 730,897 B; largest chunk 554,693 B; total renderer JS/CSS 1,781,632 B |
| `npm audit --json` | **PASS** — 0 known vulnerabilities across 786 dependencies |
| `git diff --check && git diff --cached --check` | **PASS** |
| Clean-environment `npm run release:preflight` | **EXPECTED FAIL-CLOSED** — missing `RELEASE_SIGNING_TEAM_ID` |
| Clean-environment `node scripts/release/package.mjs --public --dry-run` | **EXPECTED FAIL-CLOSED** — missing `RELEASE_SIGNING_TEAM_ID` |

The integrated tree also has recorded green results for coverage (75.82% statements, 63.38% branches, 83.92% functions, 82.52% lines), build, 23/23 Electron tests, and the local QA package pipeline. Per the explicit coordination instruction, I did **not** independently rerun Playwright, launch Electron, or rebuild/package the application during this merge review. My independent reruns are the non-Electron checks in the table above.

## Pending-merge conflict review

I inspected every resolved path recorded in `MERGE_MSG`, not only the aggregate staged diff. The resolutions preserve both sides' required controls:

- `sessions.ts` and `sessions/catalog.ts` retain canonical authorization, bounded/coalesced transcript reads, deep-cloned results, two-scan FIFO admission, deterministic bounded catalog admission, containment/deduplication, and post-read validation.
- `settings-schedules.ts` retains atomic bounded provider-disable updates plus deterministic first-owner schedule reconciliation and fail-closed handling of incomplete runtime catalogs.
- `verify-package.mjs` retains the exact native unpack/architecture policy while adding per-artifact app verification and package-size accounting.
- `App.tsx`, Transcript, and the resolved hooks retain workspace-generation/runtime ownership, prompt admission, single-owner event buffering, stale-read/reconciliation guards, background extension-UI isolation, serialized optimistic settings rollback, and provider mutation ordering.
- The settings-page resolutions retain Privacy and Providers as separate sections, protected auth-store handoff, bounded catalog rendering, and the atomic Enable-all path.
- The resolved backend/frontend/release tests cover the combined behavior; the E2E conflict preserves both original security boundary cases and the incoming reliability cases.

There are no unresolved index entries, and both working-tree and staged whitespace checks pass.

## CFR adjudication

| Finding | Final status | Acceptance basis |
|---|---|---|
| **CFR-01** public macOS trust/release gates | **Closed** | Public credentials are validated first; release verification requires typecheck, checks, coverage, build, bundle budgets, hermetic E2E, exact package verification, signature Team ID, staple, Gatekeeper, and public artifacts. QA is explicitly separate. |
| **CFR-02** composer draft ownership | **Closed** | Composer identity includes project plus session, or project plus new-workspace generation, so drafts cannot cross project/session/new-session boundaries. |
| **CFR-03** schedule semantics/catalog completeness | **Closed** | Add/cancel errors reject and preserve UI state. Runtime fan-out is reconciled deterministically in runtime-list order; first owned ID wins, fallback only fills missing IDs, and cancellation retains the reporting runtime owner. Mixed duplicate-ID/name and fallback routing are tested. |
| **CFR-04** MCP concurrent writers | **Closed with documented primitive limit** | MCP updates take the shared owner-token lock, fingerprint the bounded complete file, privately stage, compare immediately before rename, reread/remerge on conflict, retry four times, and fail without overwrite. App-launched package install holds the same lock. A non-cooperating writer can still race the final compare-to-rename instruction window because POSIX rename is not CAS; this is the already documented platform residual, not the broad stale-write defect. |
| **CFR-05** streaming/catalog scaling | **Closed** | Agent events are generation-owned and RAF-batched through linear `replayPrimeEvents`; Sidebar callbacks are stable while still dispatching current actions; project/session indexing is single-pass and visible rows are bounded. Structural tests cover 5,000 sessions, 1,000 deltas, deterministic event equivalence, and sustained batches. |
| **CFR-06** free-text setting IPC churn | **Closed** | Browser home and shell use local drafts and commit only on blur, Enter, or Save, with local validation, single-flight settlement, stale completion guards, and preserved rejected drafts. |
| **CFR-07** dropped-output reconciliation | **Closed** | Transport-loss markers and terminal lifecycle events trigger an authoritative, generation/runtime/session-guarded transcript read; live events have a single owner and are replayed once. Prompt admission invalidates stale same-runtime reconciliation. |
| **CFR-08** hidden initial window on load failure | **Closed** | Initial `loadURL` is awaited; failure destroys the hidden window and propagates into bounded startup failure handling. Window creation is single-flight and shutdown-aware. |
| **CFR-09** startup/package weight | **Closed** | Projects/sessions establish the startup workspace without waiting for runtime discovery; optional surfaces and Transcript/Markdown are lazy chunks; renderer-only libraries are not duplicated into ASAR. New enforceable gates cap main/preload, initial renderer/modulepreloads, every renderer JS/CSS chunk, total renderer JS/CSS, ASAR, app regular-file bytes, DMG, and ZIP. The two new ignored-path scripts were explicitly force-staged and are present in the deliverable. |
| **CFR-10** ownership and durable persistence | **Closed** | Former monoliths are split by ownership. `JsonStateStore` serializes promise-based temp write, file fsync, close, atomic rename, directory fsync, cleanup in `finally`, and publishes memory only after persistence succeeds. Failure/recovery/permissions/order tests pass. |
| **CFR-11** enforceable assurance | **Closed within the instructed validation envelope** | TS and TSX tests are collected, V8 coverage thresholds and release gates exist, security/performance/session/provider/release regression tests are present, and live renderer/subframe/webview/stale-preload authorization coverage is in the Electron smoke suite. This review did not rerun Electron by instruction. |

## Additional requested security/correctness review

### IPC, renderer, and remote browser

The preload remains a frozen, fixed-domain bridge; it does not expose `ipcRenderer` or dynamic channels. Main-process invocation verifies authorized `WebContents`, exact main frame, and trusted renderer URL for both sender/frame; authorization begins only after a trusted load and is revoked on untrusted navigation, crash, close, and shutdown. Main-to-renderer agent and provider events repeat the trusted-URL checks. The packaged `prime-work://app/index.html` handler enforces containment and a restrictive CSP. Browser guests remain in `persist:prime-work-browser` with no preload/Node, denied popup/permission paths, and credential-free HTTP(S)-only navigation/redirect/frame admission.

### Provider settings, models, and authentication

Provider model/thinking/fast mutations share a serialized revisioned queue. Older completions cannot roll back or synchronize over a newer selection or different active runtime; the latest failure rolls back and refreshes authoritative runtime state. Provider enablement has one persistence writer in main. Configured ChatGPT subscription accounts retain built-in Codex availability when optional executable discovery is empty/partial; unconfigured Codex and every other provider remain governed by discovered executable keys. API keys are validated/bounded and stored only through Prime `AuthStorage`; catalog tests prove the secret is absent and the auth file is `0600`. OAuth flow count, duplicate-provider flow, timeout, prompt IDs, response size/options, URL scheme, cancellation, and event sizes are bounded.

### Session I/O and catalog admission

Every transcript request is canonicalized and authorized before coalescing. Same-session reads share one scan but return independent deep clones; distinct scans are globally admitted two at a time with FIFO handoff and `finally` release. Existing 256 MiB/file, record, graph, message/part/text/tool/image budgets remain intact. Catalog admission filters and ranks directory names, selects at most the configured limit before per-entry canonicalize/stat/metadata work, then retains containment, file type, deduplication, actual-mtime ordering among admitted files, fingerprint caching, and post-read validation. The 50,000-entry regression proves bounded canonicalize/stat/read calls.

### Native unpack and fail-closed package verification (`ee379cf` residual)

The prior ZeroMQ residual is closed:

- Builder unpack patterns are exactly node-pty `pty.node`, node-pty `spawn-helper`, and `zeromq/build/darwin/${arch}/node/libc-115-Release/addon.node`.
- ASAR verification requires the ZeroMQ loader and manifest.
- Package verification recursively enumerates `app.asar.unpacked`, rejects any missing file, extra file/directory, symlink, or other non-file entry, derives the expected ZeroMQ path from app architecture, and runs `lipo -archs` on **every** allowed native file.
- Unsupported app architectures fail closed. A universal app also fails unless every unpacked native file itself covers every app architecture.
- Tests cover the exact valid tree, missing/extra paths, architecture mismatch, and exact Builder patterns.

The public verifier additionally requires exactly one top-level DMG and ZIP, strict/deep code signing, exact `TeamIdentifier`, a valid staple, successful Gatekeeper assessment, and the new package-size budgets. Documentation now matches the exact three-file architecture-specific unpack policy.

## Exact blockers / external prerequisites

- **Code blockers:** none found.
- **External prerequisite:** a real public release still requires `RELEASE_SIGNING_TEAM_ID` plus `CSC_LINK`/`CSC_KEY_PASSWORD`, and exactly one notarization set: either `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/matching `APPLE_TEAM_ID`, or `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`. Those secrets are intentionally absent here, so no fresh notarized/stapled/Gatekeeper-accepted artifact was produced.
- **Deferred execution by instruction:** Electron/Playwright was not rerun during this acceptance pass.

**Final decision: ACCEPT the post-fix closure for integration.** Public publication remains correctly impossible until external Apple credentials are supplied and the complete fail-closed pipeline passes.
