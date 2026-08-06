# Electron security-boundary audit

**Target:** `/Users/am.will/Applications/prime`  
**Focus:** BrowserWindow/webPreferences, navigation and windows, preload/contextBridge, IPC authorization and validation, filesystem capabilities, external URLs, embedded remote content, and renderer trust  
**Audit mode:** Source/test review plus isolated repros; production code was not changed  
**Date:** 2026-08-05

## Executive summary

The Electron boundary is substantially hardened. The privileged renderer and arbitrary Internet content do **not** share a security principal: the main window is sandboxed and context-isolated, remote pages run in a separately partitioned sandboxed `<webview>` with no preload, popups and permissions are denied, and every renderer-to-main IPC call is checked against an authorized `WebContents`, its main frame, and an exact expected URL. The preload exposes fixed typed methods rather than raw IPC. Filesystem and subprocess inputs are generally canonicalized, bounded, and passed as argv rather than through a shell.

I found **no Critical issue** and no demonstrated path from a remote web page directly to privileged IPC. The highest-ranked issue is a real filesystem grant-substitution flaw: a previously authorized project pathname can be replaced with a symlink, after which the main process re-canonicalizes the *grant* to the attacker's new target and accepts that target as authorized. I reproduced the acceptance. Two availability issues remain: a protocol-violating RPC child that ignores `SIGTERM` is not escalated or removed, and an ordinary model-authored fragment link permanently revokes the current renderer's IPC authorization until reload.

### Ranked findings

| Rank | ID | Severity | Finding |
|---:|---|---|---|
| 1 | ESB-01 | **High** | A granted project root can be rebound by symlink substitution to an unrelated filesystem tree |
| 2 | ESB-02 | **Medium** | Oversized RPC output sends one direct `SIGTERM` but leaves an uncooperative child and an ever-growing decoder alive |
| 3 | ESB-03 | **Low** | Model-authored fragment links revoke the renderer bridge for the rest of the document lifetime |

## Threat model and method

Internet pages in the built-in browser, repository contents/configuration, session/agent output, and Prime extensions are treated as untrusted. A deliberately entered terminal command and the OS user are trusted, but an authorization grant must remain bound to the directory the user selected. A compromised privileged renderer is considered for defense in depth; it is not assumed that context isolation protects main-process capabilities from XSS in that same renderer.

Reviewed all files under `electron/main`, the preload, renderer call sites and untrusted-content renderers, API types, build/fuse configuration, and backend/E2E tests. Validation performed:

- `npm test -- --run`: **12 files / 33 tests passed**.
- `npm run typecheck`: **passed**.
- `npm audit --json`: **0 vulnerabilities**.
- Installed/locked Electron is `43.2.0`; the full audit is clean. npm reports `43.3.0` as the current patch, but I found no advisory that makes the one-patch lag a finding.
- An isolated `ProjectService` repro granted a temporary project, renamed it, replaced the original pathname with a symlink to a different directory, and observed `authorizeCwd(originalPath)` return the symlink target.
- An isolated fake RPC agent completed its handshake, emitted a 17 MiB unterminated record, ignored `SIGTERM`, and was still alive and present in `manager.list()` 3.2 seconds later. Explicit `stopAll()` was used to clean it up.
- An isolated Electron run clicked a `#agent-anchor` link. The URL changed from the trusted entry URL to the same URL with a fragment; a subsequent `window.prime.app.getMeta()` failed with `IPC sender is not authorized`.

---

## Findings

### ESB-01 — High — Project grants follow a replacement symlink to a new filesystem target

**Evidence**

- Persisted project folders are canonicalized and inserted into the in-memory grant set at `electron/main/projects.ts:43-48`.
- On every later access, `authorizePath()` **re-canonicalizes each already-granted root** with `requireExistingDirectory(configured)` at `electron/main/projects.ts:209-216`. `requireExistingDirectory()` follows symlinks via `realpath()` at `electron/main/validation.ts:53-59`.
- The requested cwd is also resolved through the replacement symlink before the containment check at `electron/main/projects.ts:220-223`.
- These checks protect all important consumers, so substitution crosses multiple boundaries at once: Git receives `authorizeCwd` at `electron/main/index.ts:162`; agent launch receives it at `electron/main/index.ts:165`; terminal creation receives it at `electron/main/index.ts:171`; recursive filename enumeration calls it at `electron/main/projects.ts:183-205`.
- The renderer can reach those operations through `projects:list-files`, `agent:start`, terminal creation, and Git channels at `electron/main/ipc.ts:79-105`; the normal UI starts an agent with the stored `primaryFolder` at `src/App.tsx:358` and a terminal with that same path at `src/App.tsx:470`.

**Impact**

The authorization is attached to a mutable pathname, not the directory identity the user approved. After substitution, the main process treats an unrelated target (for example `~/.ssh`, another checkout, or a mounted/shared directory) as an added Prime Work project. This can disclose its filename tree, run Git there, make it the cwd of a full PTY, or start Prime Agent with that directory and its contents in scope. Agent start is the highest-impact consequence because the agent is designed to inspect, modify, and run tools in an authorized workspace.

**Realistic trigger / exploit scenario**

1. The user adds `/tmp/customer-project` or another directory whose parent is writable by project tooling/a local collaborator.
2. Repository automation, a malicious project task, a removable/mounted workspace transition, or another actor able to modify that parent renames the directory and creates `/tmp/customer-project -> /Users/alice/.ssh`.
3. Prime Work still displays and submits the old stored pathname. `authorizeCwd()` realpaths both the request and the stored grant to `/Users/alice/.ssh`, so the containment test succeeds.
4. The user opens the project/session or starts an agent; no new folder picker or re-authorization occurs.

The isolated repro confirmed step 3. The issue also survives a relaunch: project enumeration canonicalizes the now-rebound stored folder and adds the new target to `authorizedRoots`.

**Concrete remediation**

- Bind a grant to stable identity at approval time. Persist the canonical path plus filesystem identity (`dev`/`ino` on POSIX; an appropriate file ID/volume identity on Windows) and verify it before every privileged operation. If identity changed or the root disappeared, revoke and require a new native folder selection.
- Do not re-`realpath` an existing grant and then use the result as the new authority. Compare each canonical requested target against the originally granted canonical root; separately verify with `lstat`/identity that the root has not become a symlink or replacement directory.
- Never authorize a missing persisted folder using its lexical path. Keep it visible as stale if desired, but leave it out of `authorizedRoots`.
- Add regression tests for (a) rename + symlink replacement while the app is running, (b) the same substitution before app restart, and (c) deletion/recreation with a different inode. Exercise `authorizeCwd`, `listFiles`, Git, agent start, and terminal create.

### ESB-02 — Medium — RPC frame overflow does not terminate an uncooperative child

**Evidence**

- RPC stdout is decoded with a 16 MiB frame cap at `electron/main/agent-rpc.ts:246-247`.
- On decoder failure, the data handler emits an error and calls only `this.child.kill('SIGTERM')` at `electron/main/agent-rpc.ts:248-252`. It does not mark the runtime stopped, detach/pause stdout, clear the decoder, call `stop()`, kill the process group, or await exit.
- The decoder retains the oversized string in `this.buffer`; it appends every next chunk before throwing again at `electron/main/jsonl.ts:29-48`. Thus a child that continues writing causes the main process to retain and repeatedly copy an ever-growing string.
- The correct bounded TERM/KILL and process-group escalation exists, but only behind explicit `stop()` at `electron/main/agent-rpc.ts:292-322`.
- A runtime is removed only on child `close` (`electron/main/agent-rpc.ts:258-263`), and `list()` continues returning it at `electron/main/agent-rpc.ts:467`.
- Existing coverage proves only that the standalone decoder throws (`tests/backend/jsonl.test.ts:16-18`). The agent lifecycle tests cover negative/mismatched responses and handshake failure (`tests/backend/agent-rpc.test.ts:44-67`), not an overflow child that ignores `SIGTERM`.

**Impact**

A buggy or compromised Prime Agent/extension can keep a malformed runtime alive indefinitely and drive unbounded main-process memory growth and CPU churn even though the nominal frame and renderer-event limits appear to cap it. The GUI can become unresponsive or crash; the child remains admitted until the user explicitly stops it or quits. This is an availability boundary failure, not a direct confidentiality escape.

**Realistic trigger / failure scenario**

A Prime extension accidentally logs a large binary/base64 value to RPC stdout without a newline, or a compromised extension deliberately writes continuously and ignores `SIGTERM`. At 16 MiB the decoder begins throwing. The child ignores the one signal and continues; each chunk is appended to the retained buffer and triggers the same path. In the isolated repro, a fake agent emitted 17 MiB, ignored `SIGTERM`, and remained alive/listed after 3.2 seconds; cleanup required `stopAll()`.

**Concrete remediation**

- Treat any framing/parse transport violation as fatal. Guard with a one-shot `transportFailed` flag, stop reading/destroy stdout, fail pending requests, and invoke the same awaited process-group EOF → TERM → KILL path used by `performStop()`.
- Clear or discard decoder state immediately on failure so no further chunk can grow the retained string.
- Remove the runtime from admission/list state when fatal shutdown begins, while still retaining a private handle until reaping completes.
- Add a test agent that emits an oversized unterminated frame and ignores `SIGTERM`; assert bounded main memory/input handling, group `SIGKILL`, runtime removal, pending-request rejection, and no surviving PID.

### ESB-03 — Low — Fragment links permanently revoke privileged IPC until reload

**Evidence**

- `openMarkdownLink()` returns for `href` values beginning with `#` **before** calling `preventDefault()` at `src/components/MarkdownText.tsx:9-12`; React Markdown renders that live anchor at `src/components/MarkdownText.tsx:20-33`. The content is model/session-authored.
- A same-document fragment navigation changes the main-frame URL. `did-start-navigation` revokes the renderer whenever the URL is not exactly `trustedRendererUrl` at `electron/main/index.ts:143-145`.
- Authorization is restored only by an exact trusted `did-finish-load` at `electron/main/index.ts:140-142`. Same-document fragment navigation does not perform a new document load, so it is not restored.
- Every subsequent call then fails the authorized-set and exact-URL checks at `electron/main/ipc.ts:42-46`; revoke also kills terminals owned by that renderer at `electron/main/ipc.ts:121-124`.

**Impact**

One click on a common Markdown table-of-contents/section link disables all preload-backed application operations in the current window: project/session loads, settings, Git, agents, and terminal IPC fail, and owned terminals are terminated. Reloading the trusted entry document recovers, so the impact is temporary availability rather than privilege escalation.

**Realistic trigger / failure scenario**

An agent replies with `[jump to details](#details)`. The user clicks it. The browser performs an in-page navigation, the main process revokes the sender, and the app begins reporting `IPC sender is not authorized`. The isolated Electron repro observed exactly that result after clicking `#agent-anchor`.

**Concrete remediation**

- In `openMarkdownLink`, call `event.preventDefault()` before returning for fragment links. If headings are not intentionally linkable, render fragments as inert text.
- If fragment navigation is a supported feature, explicitly define trusted same-document URLs (same scheme/host/path/search with only a validated fragment difference) and consistently apply that predicate in navigation, authorization, verification, and event delivery. Do not broadly weaken the exact-origin/path check.
- Add a packaged/E2E test that clicks a model-authored fragment link and verifies both the chosen UX and continued IPC operation.

---

## Positive controls observed

- **BrowserWindow isolation:** `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, and insecure mixed execution disabled at `electron/main/index.ts:125-134`.
- **Popup/navigation policy:** the main window denies new windows and prevents document navigation at `electron/main/index.ts:83-107`. The remote guest separately denies popups and rejects non-HTTP(S) navigation, redirects, and frame navigation at `electron/main/index.ts:85-102`.
- **Remote guest separation:** `will-attach-webview` deletes any preload and forcibly reapplies no-Node, isolation, sandbox, web security, and the single expected persistent partition at `electron/main/index.ts:85-95`. Remote pages therefore do not inherit `window.prime`.
- **Permissions and downloads:** both the default and browser partitions deny permission requests/checks at `electron/main/index.ts:205-210`. Downloads require a live owner, safe URL chain, user gesture, enabled preference, concurrency and byte budgets (`electron/main/browser-downloads.ts:17-40`) and are cancelled with their guest (`electron/main/index.ts:101`).
- **Secure packaged origin:** the standard/secure `prime-work` protocol validates host, credentials, query/fragment, decoded path, backslashes/NULs, and containment before reading, and supplies a restrictive CSP/nosniff (`electron/main/index.ts:19,39-57`).
- **Exact IPC sender authorization:** handlers require an authorized, live `WebContents`, the main frame, and exact URLs for both sender frame and contents (`electron/main/ipc.ts:36-58`). Authorization occurs only after trusted load and is revoked on untrusted navigation, crash, and close (`electron/main/index.ts:140-150`). Main-to-renderer agent events repeat exact URL checks (`electron/main/index.ts:189-195`).
- **Narrow preload:** only fixed domain methods are exposed; no `ipcRenderer`, arbitrary channel, Electron event, or filesystem primitive crosses the bridge. Domain objects and the root API are frozen (`electron/preload/index.ts:4-75`).
- **Input/path validation:** shared validators enforce types, sizes, IDs, absolute/relative path form, realpath, and containment (`electron/main/validation.ts:6-85`). Session reads are constrained to the real session root and `.jsonl` files (`electron/main/sessions.ts:238-243`). Git uses argv with `--` and disables external diff (`electron/main/git.ts:91-140`).
- **External URLs:** `shell.openExternal` is limited to validated HTTP(S)/mailto and rejects credentialed web URLs (`electron/main/ipc.ts:61-64`, `electron/main/validation.ts:68-77`). `revealPath` requires a granted project, valid session, or discovered plugin path (`electron/main/ipc.ts:65-76`).
- **Untrusted rendering:** React Markdown skips raw HTML and replaces remote images (`src/components/MarkdownText.tsx:20-33`); no `dangerouslySetInnerHTML` was found. Ordinary React text rendering escapes session, tool, plugin, and Git strings.
- **Release/runtime hardening:** single-instance locking is established before startup (`electron/main/index.ts:200-227`); fuses disable RunAsNode, `NODE_OPTIONS`, inspect args, and file-protocol extra privileges while enabling ASAR integrity/only-load-from-ASAR (`scripts/afterPack.cjs:8-20`).

## Dismissed false alarms and residual assumptions

- **`webviewTag: true` is not by itself a demonstrated IPC escape.** The attach handler strips renderer-provided preload/preferences and requires the isolated partition, while privileged IPC rejects guest/subframe senders. Retaining `<webview>` still increases attack surface, but current source provides the controls required to keep it a separate principal.
- **The main renderer's broad API is an intentional high-value capability, not a standalone finding without an injection path.** A successful XSS in the trusted entry document could create/input a PTY or start/control an agent because those operations are intentionally exposed. I found no executable HTML sink: raw Markdown is skipped, React escapes strings, CSP disallows inline script, and remote pages are isolated. Continue treating any future HTML/URL rendering change as security-critical.
- **`shell.openExternal` is not an arbitrary protocol launcher.** Both renderer-side Markdown routing and main-side validation restrict schemes; `file:`, custom application protocols, and credentialed HTTP URLs are rejected.
- **Project-configured plugin traversal appears fixed.** Candidates are realpathed and project entries outside the authorized root are discarded before metadata reads at `electron/main/plugins.ts:164-177`; `tests/backend/security.test.ts:23-32` covers `/etc/hosts`.
- **The development `file:` fallback is not the packaged trust model.** Packaged builds use the secure custom protocol. Development URLs are restricted to uncredentialed loopback HTTP(S) (`electron/main/index.ts:60-67`), and IPC still requires the exact configured URL. A malicious process that controls the configured dev server can receive the preload object, so developers must still treat the dev server as trusted.
- **Style CSP `unsafe-inline` does not enable script execution.** It is restricted to `style-src`; `script-src` remains self-only (`electron/main/index.ts:53` and `index.html:7`).

## Test coverage notes

The backend suite has valuable regression coverage for project removal/inference, project-configured traversal, bounded event forwarding, child shutdown, terminal ownership/tree killing, download policy, Git argv behavior, and JSONL framing. The E2E suite confirms preload shape and an isolated browser guest (`tests/e2e/app.spec.ts:32-42,96-105`).

The three findings expose precise missing adversarial cases: root identity substitution, fatal RPC transport shutdown, and fragment navigation under exact IPC authorization. Add those tests before treating the corresponding controls as complete. A future security suite should also exercise packaged main-window redirect/reload/crash authorization, guest external-protocol attempts, guest popup attempts, and verify that no remote guest can see or invoke `window.prime`.
