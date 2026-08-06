# Security remediation verification

**Target:** current source in `/Users/am.will/Applications/prime` and `release/mac-arm64/Prime Work.app`  
**Verification date:** 2026-08-05  
**Method:** source/ASAR inspection plus focused backend and packaged runtime tests. No production source was edited.

## Result

The original critical Electron-34 exposure and the principal path/origin/persistence issues are fixed. The packaged application launches and quits normally, the fake RPC children are now awaited through TERM/KILL, and the high-value Electron fuses/ASAR controls are present. **The artifact is still not distribution-ready:** it is locally signed, not Developer-ID signed/notarized/stapled, and Gatekeeper rejects it. Resource/output controls, PTY descendants, download lifecycle controls, and shutdown admission still have residual gaps.

| ID | Status | Current verification / remaining work |
|---|---|---|
| **ASR-01** | **Mostly resolved** | Source, lock, installed runtime, and app framework are Electron **43.2.0**; full `npm audit --json` is **0/0/0/0**. Remote guests remain sandboxed with no preload/Node. The original obsolete/vulnerable Electron 34 finding is closed. Release-freshness note: npm's current stable is **43.3.0** (released 2026-08-04, with Chromium 150.0.7871.212 and a UAF fix in an API this app does not use), so update/rebuild or explicitly disposition the one-patch lag before shipping arbitrary web content. |
| **ASR-02** | **Resolved for tracked children; admission race remains** | `RpcRuntime.stop()` now awaits EOF → 750 ms → process-group TERM → 2 s → group KILL → bounded exit; `runProcess` children are registered and awaited at quit. The packaged fake-agent test started four children that ignored EOF/TERM; normal Apple Quit took **3.17 s**, exited 0, and left **no surviving PIDs**. Remaining: IPC is disposed only after cleanup and managers have no shutdown/closed state, so an invocation already awaiting authorization (or a hostile renderer racing quit) can create an agent, PTY, or one-shot child after the cleanup snapshots. Stop accepting work and dispose/revoke IPC at shutdown start. |
| **ASR-03** | **Resolved** | Project candidates are realpathed and project-located entries must satisfy `isPathWithin(canonicalProject, candidate)` before metadata is read; extensions/types are restricted and enumeration is capped. The `/etc/hosts` regression test passes, and the extracted final ASAR contains the same containment/type checks. |
| **ASR-04** | **Resolved for renderer → main IPC** | Authorization occurs only after `did-finish-load`; every call requires the authorized `WebContents`, main frame, and **exact** `senderFrame.url` plus `sender.getURL()`, with revoke on navigation/crash/close. A packaged same-document navigation to `#untrusted-fragment` retained the preload object but `app:get-meta` failed with `IPC sender is not authorized`. Dev URLs are limited to uncredentialed loopback HTTP(S). Residual defense-in-depth: `agent:event` main→renderer delivery does not reuse the same trusted-URL predicate, and agent runtimes intentionally transfer to a newly opened trusted macOS window rather than being owner-bound. |
| **ASR-05** | **Partially resolved** | Enforced: 4 agents, 8 PTYs, 32 pending RPCs/runtime, 32 MiB in-flight commands, 16 MiB JSONL frames, 500 events/s/runtime, 5,000 session files, 256 MiB/200,000-record transcript bounds. Packaged calls rejected the 5th agent and 9th PTY. Remaining availability risk: agent events and PTY data have no total byte budget/backpressure/coalescing or strict event-envelope field-size schema; up to 500 near-16-MiB events/s/runtime can still overwhelm serialization/IPC/rendering. Also reject all new work once shutdown begins. |
| **ASR-06** | **Resolved** | `app.requestSingleInstanceLock()` is acquired before `whenReady`; a second direct packaged executable exited 0 in **0.49 s** while the first remained. The primary restores/focuses on `second-instance`, closing the normal multi-process lost-update path. |
| **ASR-07** | **Partial — release blocker remains** | **Fixed:** full audit is clean; electron-builder is 26.15.7; fuses disable RunAsNode, `NODE_OPTIONS`, and Node inspect args and enable cookie encryption, embedded ASAR integrity, and OnlyLoadAppFromAsar. `ELECTRON_RUN_AS_NODE=1 ... -e` did not execute the marker. ASAR header integrity matches Info.plist; only `pty.node` and `spawn-helper` are unpacked. Packaged 1024×1024 PNG/ICNS exactly match assets and Info.plist selects `icon.icns`. `codesign --verify --deep --strict` passes with hardened runtime. **Unfixed:** authority is `BackgroundComputerUse Local Dev`, `TeamIdentifier` is absent, broad `allow-unsigned-executable-memory`/`disable-library-validation` entitlements remain, `GrantFileProtocolExtraPrivileges` remains enabled, no ticket is stapled, `spctl` exits 3/rejects, and `stapler validate` exits 65. Require Developer ID, least-privilege entitlements, notarization/stapling, and passing Gatekeeper gates for final DMG/ZIP. |
| **ASR-08** | **Resolved** | Historical session roots are display-only inferred records, `/` and home inference are rejected, and only an explicit UI selection calls `grantInferred` and persists the grant. Removal immediately deletes every folder from `authorizedRoots`. Root, ungranted-inferred, and removal regression tests pass. |
| **ASR-09** | **Partially resolved** | `TerminalService.create()` rechecks owner destruction after async authorization and immediately after spawn, while revoke kills owner terminals; the create/close race is substantially closed and terminal count is capped. The descendant blind spot remains: a focused current `node-pty` repro confirmed `nohup sleep 60 &` survives `IPty.kill()` (the test PID was killed afterward). Add process-group/job containment or document this exception to “Quit stops everything.” |
| **ASR-10** | **Mostly resolved; download lifecycle gaps remain** | One uncredentialed HTTP(S) validator now covers attach, navigate, redirect, and frame navigation. A packaged HTTP→`file:///etc/passwd` redirect failed with `ERR_UNSAFE_REDIRECT` and stayed HTTP. The isolated browser session has a pre-guest `will-download` handler: deny unless preference, user gesture, safe URL chain, and ≤512 MiB; deny-mode requested the test resource but wrote no file and the app stayed responsive. Reset clears storage/cache/auth and increments a React key, destroying guests and in-memory history. Remaining: no global/concurrent/cumulative download budget, guest attribution, or explicit cancellation when a guest closes; preference-off means deny rather than automatic save. |
| **ASR-11** | **Resolved** | `revealPath` first canonicalizes an existing path, then requires containment in an explicitly granted project, an exact valid session path, or an exact plugin path discovered by the service. The unrestricted absolute-path capability is gone. |

## Focused checks

| Check | Result |
|---|---|
| `npm test` | **PASS** — 4 files, 9 tests; includes containment, inferred/removal grants, and ignored-TERM fake RPC shutdown |
| `npm run typecheck` (final rerun) | **PASS** |
| Full `npm audit --json` | **PASS** — 0 vulnerabilities across 470 dependencies |
| Packaged bridge/limits/shutdown | **PASS** — meta/IPC worked; 4-agent and 8-PTY caps enforced; 4 ignored-TERM agents gone after 3.17 s Quit |
| Exact packaged renderer URL | **PASS** — fragment-changed frame rejected by IPC |
| Packaged browser policy | **PASS for tested cases** — unsafe file redirect rejected; download deny-mode created no file |
| Single-instance packaged process | **PASS** — second process exited in 0.49 s |
| Normal packaged launch/quit | **PASS** — `open -n` produced an on-screen `Prime Work` window; normal Apple Quit returned 0 and removed main/helpers |
| Fuses/ASAR/unpack/icon | **PASS** for configured hardening and asset integrity |
| Code-sign structure | **PASS** — deep/strict and hardened runtime |
| Gatekeeper/notarization | **FAIL / RELEASE BLOCKER** — `spctl` rejected; no stapled ticket; no Developer ID team |
| PTY detached descendant | **EXPECTED LIMITATION CONFIRMED** — child survived PTY kill, then was cleaned up by the test |

## Release decision

Do not distribute the current DMG/ZIP as a production macOS release until ASR-07 passes Developer-ID signing, notarization, stapling, and Gatekeeper assessment. Before that rebuild, take Electron 43.3.0 (or record a time-bounded disposition), and strongly prefer closing the shutdown-admission and event/PTY byte-budget gaps. The remaining download-lifecycle and detached-PTY issues should be tracked explicitly if not fixed in this release.
