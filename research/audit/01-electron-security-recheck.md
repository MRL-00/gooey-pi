# Electron security-boundary recheck

**Target:** current working tree of `/Users/am.will/Applications/prime`  
**Date:** 2026-08-05  
**Mode:** audit only; production source was not modified  
**Scope:** BrowserWindow/webPreferences, preload/contextBridge, IPC sender authorization, `<webview>` isolation/navigation/downloads, filesystem grants, Markdown/external URLs, project-authorization concurrency, RPC containment, and macOS packaging.

## Executive summary

The current tree has a strong Electron boundary and closes most issues described by older reviews. Internet content is isolated in a sandboxed no-preload guest; IPC checks an authorized `WebContents`, main-frame identity, and the exact entry URL; packaged content uses a contained custom protocol and strict CSP; project grants are now bound to device/inode identity; session/plugin paths are contained; downloads are owner/gesture/URL/count/byte controlled; and Electron fuses are restrictive.

I found **no Critical issue, no code-level High issue, and no demonstrated remote-webview-to-IPC escape**. Three availability/lifecycle issues remain (one Medium, two Low). Separately, the macOS release path is a **High release blocker** for public distribution because Developer-ID/notarization/Gatekeeper acceptance is not enforced and the checked artifact is rejected.

| ID | Severity | Finding |
|---|---|---|
| ESR-01 | **High — release blocker** | The macOS packaging path can produce a locally signed, unstapled artifact rejected by Gatekeeper |
| ESR-02 | **Medium** | Fatal RPC frame overflow sends one direct `SIGTERM` but bypasses the existing awaited TERM/KILL lifecycle |
| ESR-03 | **Low** | Project removal does not invalidate an authorization already awaiting filesystem identity checks |
| ESR-04 | **Low** | Model-authored fragment links revoke privileged IPC until the document is reloaded |

## Validation performed

- Final `npm test`: **16 files / 61 tests passed** on the final inspected tree, including project identity substitution/recreation regressions.
- Final `npm run typecheck`: **passed**.
- `npm audit --json`: **0 reported vulnerabilities** across the current lock/install.
- Existing artifact checks (corroborative; source was not repackaged): restrictive fuses were confirmed; `codesign` showed `Authority=BackgroundComputerUse Local Dev` and no Team ID; `spctl` rejected the app; `stapler validate` reported no ticket.
- Current security-relevant source was re-read after concurrent edits. The earlier project-root symlink-rebind finding is **not repeated** because the current edit adds stable folder identities and rejects path/identity substitution.

---

## Findings

### ESR-01 — High (release blocker) — Public macOS trust is not enforced by the packaging pipeline

**Exact evidence**

- `package.json:18` defines `package:mac` as only build plus `electron-builder --mac`.
- The macOS builder configuration at `package.json:59-73` selects targets, entitlements, and `afterPack`, but contains no repository-controlled notarization or post-package Gatekeeper/stapling gate.
- The project acknowledges the gap at `docs/security.md:19`: public distribution still needs Developer ID, notarization, and stapling.
- The checked `release/mac-arm64/Prime Work.app` corroborates the failure mode: `codesign -dv --verbose=4` reports local `BackgroundComputerUse Local Dev` authority and no `TeamIdentifier`; `spctl -a -vv -t exec` exits 3/rejects it; `xcrun stapler validate` exits 65 because no ticket is stapled.

**Impact**

A build produced by the package command can look complete and have an internally valid hardened-runtime signature while being rejected on another Mac. Publishing it either prevents normal installation or pressures users to bypass Gatekeeper, undermining the code-origin boundary required for trustworthy releases and updates.

**Realistic trigger / failure scenario**

A maintainer runs `npm run package:mac` on a host with only the local identity and uploads the DMG/ZIP. It works locally, but users receive Gatekeeper rejection because the artifact has no Developer-ID team identity and no stapled Apple ticket.

**Concrete remediation**

Create a clean release-only CI path that requires the intended `Developer ID Application` identity, notarizes and staples, and publishes only after the expected Team ID/authority check, `codesign --verify --deep --strict`, `xcrun stapler validate`, and `spctl --assess --type execute` pass for final artifacts. Keep local packages explicitly QA-only. This is a distribution blocker, not a claim that local development builds need notarization.

### ESR-02 — Medium — RPC frame overflow does not trigger the bounded fatal-shutdown path

**Exact evidence**

- RPC stdout is limited to 16 MiB per unframed record at `electron/main/agent-rpc.ts:246-247` and `electron/main/jsonl.ts:69-79`.
- When the decoder throws, the data handler emits an error and calls only `this.child.kill('SIGTERM')` at `electron/main/agent-rpc.ts:248-252`. It does not set a fatal-state guard, stop reading, reject pending work, call `stop()`, kill the process group, or wait for exit.
- The correct bounded EOF → process-group TERM → KILL escalation exists at `electron/main/agent-rpc.ts:292-323`, but overflow bypasses it.
- Runtime removal occurs only on child `close` at `electron/main/agent-rpc.ts:258-263`; a child that ignores the direct signal remains listed/admitted.
- `tests/backend/security.test.ts:69-85` proves explicit `manager.stop()` escalates against an ignored `SIGTERM`, while `tests/backend/jsonl.test.ts:16-27` covers decoder rejection/fragmentation only. No integration test joins these behaviors on overflow.

**Impact**

A faulty or hostile Prime Agent/extension can violate framing, ignore one `SIGTERM`, and remain alive indefinitely. Continued stdout is repeatedly decoded/rejected and consumes main-process CPU/I/O; the runtime remains visible and pending requests are not failed until explicit stop or quit. Current fragment and event byte controls bound the earlier memory/IPC concern, but do not reap the offender.

**Realistic trigger / failure scenario**

An extension writes a large base64/blob value to RPC stdout without a newline and continues logging, or deliberately ignores `SIGTERM`. Once 16 MiB is crossed, later chunks repeat the error path, but no `SIGKILL` timer/process-group shutdown starts.

**Concrete remediation**

Treat decoder overflow as a one-shot fatal transport failure: set a guard, pause/destroy stdout, clear decoder state, reject pending requests, remove the runtime from public admission, and invoke/await the same process-group escalation used by `performStop()`. Add an integration test with an oversized unterminated frame and a child that ignores `SIGTERM`; assert bounded input handling, `SIGKILL`, request rejection, runtime removal, and no surviving PID.

### ESR-03 — Low — Concurrent project removal can leave one stale authorization result

**Exact evidence**

- Removal increments `authorizationRevision` and later clears/rebuilds roots at `electron/main/projects.ts:177-223`.
- `authorizePath()` awaits request canonicalization and each root's device/inode verification at `electron/main/projects.ts:263-270`, but does not snapshot/recheck `authorizationRevision` before returning at `electron/main/projects.ts:272-273`.
- Revision checks do prevent an older `list()` from repopulating removed roots (`electron/main/projects.ts:42-75`), and `tests/backend/project-removal.test.ts:59-84` covers that stale-list case; it does not cover authorization suspended inside `verifyFolderIdentity()`.

**Impact**

If removal completes while authorization awaits filesystem I/O, the call can still return a root copied before revocation. Its caller can then proceed to spawn an agent/PTY or begin Git work after removal resolves. This is a narrow revocation-consistency gap; it provides only one in-flight use of a previously granted root and is Low severity.

**Realistic trigger / failure scenario**

The UI removes a project while a concurrent start/refresh request resolves a slow network-mounted root. Removal clears the map, but the in-flight iterator already copied the map entry and later passes identity/containment using its local values. The higher-level operation starts after the UI reports removal complete.

**Concrete remediation**

Make authorization linearizable with grant mutations: capture the revision before canonicalization and reject/retry if it changes before return, or serialize authorization/mutation with a read/write lock. Recheck immediately before consumers spawn/execute. Add a barrier-controlled test in which removal finishes while identity verification is suspended, and assert no privileged work is admitted.

### ESR-04 — Low — A Markdown fragment click revokes IPC for the current document

**Exact evidence**

- `openMarkdownLink()` returns for `href` beginning with `#` before `preventDefault()` at `src/components/MarkdownText.tsx:10-12`; fragments remain live anchors at `src/components/MarkdownText.tsx:22-25`.
- Any main-frame navigation whose URL is not exactly the entry URL revokes the sender at `electron/main/index.ts:140-145`.
- IPC correctly requires the authorized set and exact frame/content URLs at `electron/main/ipc.ts:42-46`.
- A fragment navigation is same-document, so it does not produce the trusted full load needed for `did-finish-load` to authorize again (`electron/main/index.ts:140-142`). Markdown tests cover raw HTML/images/relative links (`tests/backend/markdown.test.ts:19-31`), not fragments.

**Impact**

Clicking a normal model/session-authored table-of-contents link can disable all preload-backed functions in the window and revoke owner-bound terminals until reload. This is temporary availability loss, not privilege escalation.

**Realistic trigger / failure scenario**

An agent replies with `[details](#details)`. The user clicks it; Electron begins an in-place navigation to the entry URL plus fragment, exact-URL policy revokes the renderer, and later project/agent/terminal/settings calls fail with `IPC sender is not authorized`.

**Concrete remediation**

Call `preventDefault()` before returning for fragments and render them inert unless intentionally supported. If supported, define a narrow same-document predicate (same scheme/host/path/search, fragment-only difference) and apply it consistently to navigation, authorization, IPC verification, and event delivery. Add an Electron E2E regression verifying continued IPC after a fragment click.

---

## Positive controls verified

- **BrowserWindow:** `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, and insecure content disabled (`electron/main/index.ts:125-134`).
- **Preload:** only fixed typed domain methods cross `contextBridge`; raw `ipcRenderer`/arbitrary channels are not exposed, and domain/root objects are frozen (`electron/preload/index.ts:4-75`).
- **IPC:** every call requires an authorized live main frame and exact expected URLs (`electron/main/ipc.ts:36-58`); authorization is post-load and revoked on navigation/crash/close (`electron/main/index.ts:140-150`). Outbound agent events repeat URL checks (`electron/main/index.ts:191-197`).
- **Remote guest:** attach deletes preload and forces no Node, isolation, sandbox, web security, and the dedicated partition; attach/navigation/redirect/frame URLs are uncredentialed HTTP(S), and popups are denied (`electron/main/index.ts:83-102`). Default and guest sessions deny permissions (`electron/main/index.ts:207-212`).
- **Downloads:** owner, URL-chain, gesture, preference, concurrency, per-item, and hourly byte limits are enforced (`electron/main/browser-downloads.ts:17-40`); guest destruction cancels owned downloads (`electron/main/index.ts:101`).
- **Packaged renderer:** `prime-work://app` is secure/standard and validates host, credentials, decoded path, traversal, MIME, CSP, and `nosniff` (`electron/main/index.ts:19,39-57`).
- **Project identity substitution is now blocked:** grants are a canonical path plus device/inode (`electron/main/projects.ts:15,22-35`; `electron/main/store.ts:7-10,44-66`); listing and access authorize only matching identities (`electron/main/projects.ts:60-75,263-273`). Replaced paths are removed from the live map.
- **Markdown/external URLs:** raw HTML and remote images are disabled (`src/components/MarkdownText.tsx:21-31`); external launching accepts only HTTP(S)/mailto and rejects credentialed web URLs (`electron/main/ipc.ts:61-64`, `electron/main/validation.ts:68-77`).
- **Filesystem/process baseline:** session candidates use realpath/containment; project-configured plugins are contained; Git uses argv plus `--`; shutdown closes IPC/process admission before cleanup snapshots (`electron/main/index.ts:240-252`).
- **Packaging mechanics:** fuses disable RunAsNode, `NODE_OPTIONS`, inspect args, browser-specific snapshots, and extra file privileges while enabling cookie encryption, ASAR integrity, and ASAR-only loading (`scripts/afterPack.cjs:8-20`). ASAR unpack is limited to two `node-pty` binaries (`package.json:48-54`).

## Dismissed false alarms / rechecked stale issues

- **No remote guest → privileged IPC path was found.** Guest IDs are never authorized; attach hardening removes preload/Node, and `verify()` rejects guests/subframes.
- **The old ID-only IPC issue is remediated.** Current verification checks main-frame identity and exact URLs as well as authorized ID (`electron/main/ipc.ts:42-46`).
- **The old project-root symlink-rebind issue is remediated in the final inspected tree.** Stable device/inode identity is captured and rechecked, and symlink/path substitution fails (`electron/main/projects.ts:22-35,61-70,248-258`).
- **The old project-configured plugin traversal issue is remediated.** Project candidates are realpathed/discarded outside the root; current tests cover outside and in-project discovery.
- **The old unbounded JSONL-prefix issue is remediated.** `FragmentedLineBuffer` stores fragments separately and checks bytes before append (`electron/main/jsonl.ts:6-42`), with a fragmented-record regression. ESR-02 is limited to process lifecycle after fatal overflow.
- **`webviewTag: true` is not itself a demonstrated escape.** The necessary attach hardening, separate session, popup/permission denial, and IPC-principal separation are present.
- **`style-src 'unsafe-inline'` does not allow script execution.** Packaged `script-src` remains self-only and has no `unsafe-eval` (`electron/main/index.ts:53,218`).
- **`allow-jit` is expected for Chromium.** `disable-library-validation` is broad and should be tested for removal/scoping in a Developer-ID build, but no concrete untrusted dylib load path was demonstrated.
- **Electron 43.2.0 is not reported as vulnerable from version alone.** Current npm audit is clean; maintain patch cadence because arbitrary Internet pages are rendered.

## Coverage notes

The final suite has valuable coverage for child shutdown, event/terminal limits, plugin containment/locking, project removal and directory identity substitution/recreation, downloads, JSONL, Git process hardening, and transcript scaling. Missing adversarial cases map directly to ESR-02 through ESR-04: overflow-child reaping, authorization-vs-removal barriers, and fragment navigation with live IPC. Packaging CI should additionally make Team ID, notarization, stapling, fuse state, ASAR allowlist, and Gatekeeper acceptance release gates.
