# Adversarial security and reliability review

**Target:** `/Users/am.will/Applications/prime`  
**Review date:** 2026-08-05  
**Method:** source review plus isolated runtime, packaging, IPC-adjacent, subprocess, PTY, persistence, and webview repros. No production source file was edited. Temporary helpers/user-data directories were created outside the repository and removed. Build/test output was regenerated during testing. This directory has no `.git` metadata, so findings are pinned to file paths/line ranges rather than a commit.

## Executive summary

Prime Work has a good baseline Electron shape: the main renderer is sandboxed and context-isolated, the preload exposes a narrow frozen API, most IPC inputs are validated, session paths are canonicalized, PTYs normally enforce owner IDs, webview popups and permissions are denied, and state writes are atomic and fsynced. The CommonJS preload **does load successfully** both unpackaged and from `app.asar` under Electron 34; this was tested rather than inferred.

It is not ready for adversarial remote content or a production release, however. The shipped browser engine is Electron 34.5.8 and `npm audit` reports directly relevant, fixed Electron sandbox/context-isolation/navigation vulnerabilities. Shutdown returns before agent children have exited, and a live repro left an RPC child running after the application was gone. Project-controlled plugin settings can read and return the first content line of arbitrary files outside the project. IPC trusts only a `webContents` ID, not its current URL/origin. Packaging produced an artifact rejected by Gatekeeper, with no effective notarization or fuse hardening. There are also unbounded process/RPC surfaces, cross-process state loss, incomplete webview download policy, and authorization-lifecycle gaps.

### Threat model used for severity

The user and an intentionally entered terminal command are trusted. Internet pages in the built-in browser, cloned/project-controlled files, session/RPC output, and package metadata are untrusted. The renderer is treated as a boundary that may be compromised by an XSS or Electron/Chromium bug; defense-in-depth IPC checks matter because the exposed terminal is deliberately a full user shell. A separate process already running as the same OS user is generally outside confidentiality scope, but races, persistence loss, unsigned distribution, and child processes that outlive Quit remain in reliability/release scope.

### Severity summary

| ID | Severity | Finding |
|---|---|---|
| ASR-01 | **Critical** | Electron 34.5.8 is an obsolete, vulnerable browser/runtime exposed to arbitrary web content |
| ASR-02 | **High** | Quit completes before RPC/CLI children exit; verified orphan agent after app shutdown |
| ASR-03 | **High** | Project plugin settings can partially read arbitrary files outside the project |
| ASR-04 | **High** | IPC authorization is tied to a reusable `webContents` ID, not an approved renderer origin |
| ASR-05 | **High** | RPC and PTY creation, buffering, and event forwarding allow process/memory/CPU exhaustion |
| ASR-06 | **High (reliability)** | Multiple app processes silently lose persisted updates |
| ASR-07 | **High (release blocker)** | Test package was not notarized/Gatekeeper-accepted and Electron fuses remain permissive |
| ASR-08 | **Medium** | Historical session metadata silently becomes a filesystem/project authorization grant; removal is stale |
| ASR-09 | **Medium** | PTY ownership has a close/create race and cannot account for surviving descendants |
| ASR-10 | **Medium** | Browser redirect/download/reset policy is incomplete; the download preference is not implemented |
| ASR-11 | **Low** | `revealPath` is an unrestricted absolute-path capability |

## Findings

### ASR-01 — Critical — Vulnerable Electron runtime is directly exposed to remote pages

**Evidence**

- `package.json:35` permits Electron 34; the lock/install resolves to **34.5.8**.
- `electron/main/index.ts:78` enables `<webview>`, and `src/components/Inspector.tsx:193-199` embeds arbitrary `http:`/`https:` content.
- A full `npm audit --json` reported **18 vulnerable packages (2 critical, 13 high, 3 moderate)**. The direct `electron` finding is high and includes advisories directly relevant to this design, including:
  - `GHSA-h7rp-cf8h-j98x` — context-isolation bypass;
  - `GHSA-9f4c-93c8-jc8g` — sandboxed iframe popup restriction bypass;
  - `GHSA-v64r-4m7r-3mvq` — HTTP redirect into the local file loader;
  - `GHSA-p2rr-rvmm-c5fp` — sandboxed iframe external-protocol launch;
  - `GHSA-9wfr-w7mm-pc7f` — renderer command-line-switch injection.
- `npm audit --omit=dev` misleadingly reports zero vulnerabilities because Electron is declared a dev dependency, even though its binary is the runtime shipped in the `.app`.

The app's popup, navigation, permission, sandbox, and context-isolation settings are worthwhile, but they cannot compensate for defects in the old Electron implementation of those controls. A general-purpose persistent webview makes this reachable from internet content, not merely a build-time concern.

**Fix**

1. Upgrade to the latest patched, supported Electron stable. Based on the installed audit data, use **at least 39.8.10**, but re-run advisories at release time rather than treating that number as permanently safe.
2. Add an Electron support/SLA policy and an automated check that rejects unsupported majors and known Electron advisories. Audit the complete lockfile or explicitly include the packaged Electron binary in release scanning; do not rely on `--omit=dev`.
3. Re-run all sandbox, CJS preload, webview, native `node-pty`, signing, and packaged smoke tests after the major upgrade.
4. Prefer `WebContentsView` over `<webview>` when practical and keep remote content in a separate session/process with no preload or privileged IPC.

### ASR-02 — High — Shutdown reports completion while children remain alive

**Evidence**

- `RpcRuntime.stop()` closes stdin, schedules `SIGTERM` after 750 ms and `SIGKILL` two seconds later on **unref'ed timers**, then immediately returns `true` (`electron/main/agent-rpc.ts:205-217`). It does not await the child's `close` event.
- `AgentRpcManager.stopAll()` therefore resolves immediately (`agent-rpc.ts:360`). `before-quit` calls `app.quit()` as soon as that promise resolves (`electron/main/index.ts:159-167`), so the process normally exits before escalation timers fire.
- One-shot children created by `runProcess()` are not in a global shutdown registry (`electron/main/process-utils.ts:36-84`).

**Repro:** a temporary fake Prime RPC executable completed `get_state`, ignored EOF/SIGTERM, and stayed alive. After `window.prime.agent.start({cwd:'/tmp'})`, closing the packaged app took about **400 ms**. The child was still alive **3.5 seconds after the app exited**. Its log showed `STDIN_END` for the RPC process and no shutdown escalation. The test child was then killed explicitly.

This can leave agents, tools, network operations, or local subprocesses running after the user believes Quit stopped them. A handshake failure has the same issue because `start()` awaits `runtime.stop()` but not process exit (`agent-rpc.ts:315-317`).

**Fix**

- Make `stop()` resolve only after `close`: request abort, close stdin, wait a bounded grace period, send `SIGTERM`, wait, send `SIGKILL`, then wait for exit. Do not unref the escalation timers while quit is blocked on them.
- Track every `runProcess` child and cancel/kill/wait for them during shutdown.
- On Unix, start each agent/tool in a dedicated process group and terminate the group; use a Job Object or a tested tree-kill equivalent on Windows. Define the policy for intentionally detached descendants.
- Put an overall shutdown deadline around the aggregate cleanup, log which children failed to exit, dispose IPC before the final quit, and add a packaged E2E test using a child that ignores EOF and `SIGTERM`.

### ASR-03 — High — Project configuration escapes its path grant and reads arbitrary files

**Evidence**

`PluginService` authorizes the project directory at `electron/main/plugins.ts:123-125`, but project `.prime/agent/settings.json` values pass through `resolveConfiguredPath()` and `collectConfigured()` without a containment check (`plugins.ts:61-65, 86-97, 141-151`). Absolute paths and `~/...` paths are accepted. A configured file is added as a candidate regardless of extension; `markdownMetadata()` reads up to 128 KiB and returns a content-derived description (`plugins.ts:17-39, 157-172`).

**Repro:** an isolated project containing:

```json
{"prompts":["/etc/hosts"]}
```

was passed to `PluginService.list(project)`. The returned project `SkillRecord` contained:

```json
{
  "name": "hosts",
  "description": "127.0.0.1\tlocalhost",
  "path": "/private/etc/hosts",
  "location": "project"
}
```

A malicious repository can target single-line token/config files and disclose up to 500 characters from the first eligible content line, as well as canonical paths. This violates the project's path grant even if current UI flows do not automatically call `plugins.list(projectPath)`.

**Fix**

- Treat project settings as untrusted project content. After expansion and `realpath`, require every project-configured file/directory to satisfy `isPathWithin(canonicalProjectRoot, canonicalCandidate)`.
- If outside-project skills are a feature, require an explicit durable user grant selected through a native dialog; do not infer it from repository JSON.
- Validate candidate type and extension before reading it, cap configured entries, avoid returning absolute paths unless needed, and add symlink/outside-root regression tests.

### ASR-04 — High — IPC sender validation omits renderer URL/origin

**Evidence**

- `registerIpc.verify()` checks only membership of `event.sender.id`, destruction state, and that `senderFrame` is the main frame (`electron/main/ipc.ts:32-45`). It never checks `event.senderFrame.url`, `event.sender.getURL()`, or the expected renderer entry point.
- The ID is authorized before the renderer has successfully loaded (`electron/main/index.ts:84-94`) and remains authorized across navigation until the window is closed.
- Agent RPC methods are global rather than owner-bound: unlike terminal methods, IPC does not pass the sender to `AgentRpcManager` (`ipc.ts:73-81`), and any authorized renderer can `list` and control all runtimes.

**Repro:** in development mode, setting `ELECTRON_RENDERER_URL` to a temporary, unrelated HTTP server loaded that server as the main window. Its page saw `window.prime` and successfully invoked `window.prime.app.getMeta()`. It would also have received terminal, Git mutation, package-install, and agent RPC capabilities. The packaged `will-navigate` guard reduces ordinary navigation risk, but ID-only verification removes an important defense if initial load, an error page, DevTools/CDP, a future navigation feature, or an Electron bug changes the main-frame URL.

**Fix**

- For every IPC call, require both the authorized `WebContents` and an exact approved `senderFrame.url`: the packaged app protocol/file entry and, in development, an explicitly parsed loopback origin generated by the dev server. Reject credentials, non-loopback dev hosts, unexpected ports/paths, `about:blank`, and `chrome-error:`.
- Prefer a registered, standard, secure `app://` protocol and compare against that origin instead of broad `file:` rules.
- Authorize only after the expected main-frame `did-finish-load`; revoke on `will-navigate`, `render-process-gone`, and destruction. Route events only after the same check.
- Pass the sender/owner into agent start/command/stop, or implement an explicit broker transfer protocol when a trusted window is reopened.

### ASR-05 — High — Unbounded RPC/PTY work and buffering enables local denial of service

**Evidence**

- There is no global or per-owner limit on `agent:start` or `terminal:create` (`agent-rpc.ts:298-318`; `terminal.ts:51-69`). Each call starts a process; PTYs allow dimensions up to 1000x1000.
- Each runtime permits 256 pending RPCs (`agent-rpc.ts:220-240`) while a command may serialize to 20 MiB (`agent-rpc.ts:37-40`), allowing roughly 5 GiB of queued command bodies per runtime before overhead. `stdin.write()` backpressure is ignored.
- Agent output permits individual 64 MiB JSONL records (`electron/main/jsonl.ts:4, 29-54`), forwards arbitrary event objects immediately to the renderer (`agent-rpc.ts:243-278`; `index.ts:124-126`), and has no event schema, rate limit, or renderer backpressure. Repeated newline-delimited records can flood indefinitely.
- On decoder overflow, the code sends only `SIGTERM`; a child that ignores it can continue producing data (`agent-rpc.ts:162-166`).
- Session listing/reading scans complete JSONL files and retains a full entry map with no total file/catalog bound (`electron/main/sessions.ts:120-140, 148-183, 254-320`).

A compromised renderer, a broken Prime binary, or pathological session files can exhaust processes, file descriptors, memory, IPC queues, and UI responsiveness.

**Fix**

- Enforce small per-owner/global limits (for example, 4 agents and 8 PTYs), deduplicate concurrent starts, and reject work after shutdown begins.
- Reduce command/event/frame limits to the actual protocol need; use a total in-flight byte budget, bounded queues, and honor stream backpressure/drain.
- Validate response/event envelopes and field sizes before mutating state or calling `webContents.send`. Coalesce streaming updates and rate-limit noisy events.
- On transport violation, detach/destroy streams and perform awaited TERM/KILL escalation.
- Cap session file size/record count/catalog count, stream only the active branch where possible, and expose pagination/truncation to the UI.

### ASR-06 — High (reliability) — State updates are only serialized within one process

**Evidence**

`JsonStateStore` has a per-instance promise queue and sound atomic rename/fsync behavior (`electron/main/store.ts:84-131`), but the app never calls `app.requestSingleInstanceLock()` and the store has no inter-process lock or compare-and-swap.

**Repro:** two `JsonStateStore` instances opened the same fresh file. Instance A appended `from-A`; instance B, still holding its original snapshot, appended `from-B`. A's snapshot contained A, B's contained B, and the on-disk state contained only `from-B`. The JSON remained valid but one successful update was silently lost.

macOS normally reactivates an app bundle, but `open -n`, direct executable launches, development runs, and automation can create multiple Electron processes.

**Fix**

- Acquire `app.requestSingleInstanceLock()` before `whenReady`; immediately quit a second process and focus/restore the trusted first window from `second-instance`.
- If multi-instance operation is required, add an OS-level lock plus reload/version/CAS semantics; atomic rename alone is not concurrency control.
- Add a two-process persistence test, not just two concurrent updates on one store instance.

### ASR-07 — High (release blocker) — Distribution hardening is incomplete

**Evidence**

- `electron-builder --mac dir` built an app and `codesign --verify --deep --strict` passed, but builder logged **“skipped macOS notarization”** and `spctl --assess --type execute` returned exit 3, **rejected**.
- The available environment caused builder to select a non-Developer-ID local identity with no TeamIdentifier. `package.json:42-64` does not enforce a release identity/notarization workflow or release verification.
- The main executable used hardened runtime but had broad `allow-unsigned-executable-memory` and `disable-library-validation` entitlements.
- Electron fuses are left at permissive defaults. A packaged proof executed successfully as Node with:

```sh
ELECTRON_RUN_AS_NODE=1 'Prime Work.app/Contents/MacOS/Prime Work' -e '...'
```

- `asarUnpack` extracts the **entire** `node-pty` package (`package.json:46-48`), including tests, sources, Windows prebuilds, and unused artifacts, rather than only the required native binary/helper.
- The build toolchain itself is stale: `electron-builder` 25.1.8 brings vulnerable `builder-util-runtime` and `tar` 6.2.1; the full audit reported critical/high build-chain issues. `vitest` 2.1.9 is also affected by a critical UI-server advisory. These are mostly CI/developer risks, but they matter in a release pipeline.

**Fix**

- Release only with an explicit Developer ID Application certificate, hardened runtime, current electron-builder, notarization credentials in CI, ticket stapling, and automated `codesign --verify --deep --strict`, `spctl --assess`, and `stapler validate` gates for both DMG and ZIP outputs.
- Apply Electron fuses during packaging: disable `RunAsNode`, `NODE_OPTIONS`, and CLI inspect arguments; enable embedded ASAR integrity validation and `OnlyLoadAppFromAsar` after testing native modules. Use custom least-privilege entitlements and sign required native code consistently.
- Narrow unpack patterns to the architecture's required `pty.node` and helper, or rely on builder's native-module unpacking. Inspect the final ASAR/unpacked manifest in CI.
- Upgrade electron-builder, tar transitives, Vite/Vitest, and other audited build dependencies; isolate signing/notarization secrets and do not expose dev/test servers to untrusted networks.

### ASR-08 — Medium — Session discovery silently grants project authorization, and removal is stale

**Evidence**

`ProjectService.list()` clears and reconstructs `authorizedRoots`, adding both persisted folders and every existing `cwd` found in historical Prime session metadata (`electron/main/projects.ts:24-63`). No user grant is required for inferred roots. `authorizeCwd()` then authorizes any descendant (`projects.ts:116-124`).

**Repro 1:** an isolated session JSONL with a session header `{"cwd":"/"}` caused `projects.list()` to return an inferred `/` project, after which `authorizeCwd('/etc')` returned `/private/etc`.

**Repro 2:** after listing a persisted project and calling `projects.remove(id)`, `authorizeCwd(removedPath)` still succeeded. It was denied only after another `projects.list()` rebuilt the in-memory set (`projects.ts:96-103`).

This also conflicts with the UI claim that Prime only receives folders attached to a session. Note that the PTY is a full user shell, not an OS sandbox, so cwd checks should be described as application routing/consent boundaries rather than filesystem confinement.

**Fix**

- Separate “discovered for display” from “explicitly granted.” Never add an inferred session cwd to the execution allowlist until the user approves its canonical root.
- Canonicalize and validate persisted grants on load, store grant provenance, and avoid treating `/`, the home directory, or broad ancestors as implicit grants.
- On removal, immediately delete all canonical folders from the authorization set and define whether to stop agents/PTYS using that grant. Add tests for removal without relisting.

### ASR-09 — Medium — PTY ownership cleanup has races and descendant blind spots

**Evidence**

Normal terminal operations correctly compare `owner.id` (`electron/main/terminal.ts:72-108`), and window close calls `killOwner` through IPC revocation (`ipc.ts:103-105`). There are two lifecycle gaps:

1. `create()` awaits cwd authorization before spawning/storing the terminal (`terminal.ts:51-61`). If the owner closes during that await, `killOwner` can run before the terminal enters the map. The continuation never re-checks `owner.isDestroyed()`, so it can leave an unowned PTY in the headless macOS app.
2. `node-pty.kill()` primarily terminates the shell/session; deliberately detached descendants are not tracked. A direct repro started `nohup sleep 60 &`, killed the PTY, and verified that the background PID was still alive. The test process was then killed.

**Fix**

- Check `owner.isDestroyed()` and current authorization after every await and immediately before/after spawn; subscribe directly to owner destruction and kill a just-created terminal on any race.
- Add terminal count limits and an explicit state machine (`creating`, `active`, `closing`, `closed`). Make cleanup idempotent and await observable exit where the library permits.
- Run the shell in an owned process group/job and terminate the group at owner close/app quit. Document that a process which deliberately escapes the group may outlive the terminal, or add OS-specific containment if “Quit stops everything” is a requirement.

### ASR-10 — Medium — Webview navigation/download/privacy policy is incomplete

**What works:** `will-attach-webview` removes preload, disables Node/subframe Node, and forces context isolation, sandbox, and web security (`electron/main/index.ts:35-51`). Popups are denied; only the fixed persistent partition is accepted; both default and browser sessions deny permissions (`index.ts:130-136`). In a packaged adversarial smoke test, guest `process`, `require`, and `window.electron` were undefined, microphone access returned `NotAllowedError`, `window.open()` returned null, an HTTP redirect stayed in HTTP, and a redirect to `file:///etc/passwd` failed with `ERR_UNSAFE_REDIRECT`.

**Gaps**

- There is no `will-redirect`/frame-navigation policy, only `will-navigate`. This matters especially with the old Electron redirect/iframe advisories in ASR-01.
- `isAllowedBrowserUrl()` accepts credential-bearing HTTP(S) URLs, unlike the settings validator (`index.ts:30-33` versus `validation.ts:68-77`).
- Neither session registers `will-download`. `browserAskForDownloads` is persisted and presented to the user (`store.ts:23-24`, `settings-schedules.ts:15-30`, `SettingsPage.tsx`) but is never read by main-process download code. Behavior is therefore Electron/platform default rather than the selected policy; there is no guest attribution, size/count control, safe destination policy, or cancellation on guest destruction.
- “Clear browsing data” clears session stores/cache/auth (`settings-schedules.ts:34-42`) but does not destroy/recreate active guests or clear the React in-memory navigation history, so the UI can still show/navigate old entries immediately afterward.

**Fix**

- Apply one strict URL validator to initial attach, navigation, redirects, and frame navigation; reject credentials and all non-HTTP(S) final URLs. Add `will-redirect` and applicable frame events, and regression-test redirect chains after upgrading Electron.
- Register `browserProfile.on('will-download', ...)` before creating guests. Default-deny or show an app-owned Save dialog according to `browserAskForDownloads`; sanitize filenames, cap concurrent/total bytes, cancel on owner destruction, and surface progress/failure.
- On data reset, destroy/recreate browser guests and clear UI history as well as storage. Keep the browser profile separate from `defaultSession`; do not clear app renderer state as a side effect.

### ASR-11 — Low — File reveal bypasses application path grants

`app:reveal-path` accepts any existing absolute path and calls `shell.showItemInFolder()` (`electron/main/ipc.ts:59-61`; `validation.ts:62-65`). It is not limited to an explicit project, known session, or enumerated plugin path. This is mostly defense-in-depth because a legitimately created PTY is already a full shell, but it unnecessarily expands the IPC capability and lets compromised UI probe/reveal arbitrary paths.

**Fix:** authorize the canonical target against explicit project roots or exact known session/plugin paths and require a visible user action. Keep separate methods for project-file reveal and session-file reveal rather than a generic absolute-path primitive.

## Positive controls verified

- **Sandbox/preload:** both unpackaged and packaged smoke tests saw a frozen `window.prime` API while `window.process` and `window.require` were undefined. `app.getMeta()` worked from the packaged ASAR. The current CJS output (`out/preload/index.js`) therefore works under Electron 34's sandboxed preload loader despite root `"type":"module"`. Keep the packaged test because adding an external runtime dependency to preload would fail under the sandbox's limited `require`.
- **Main renderer:** `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`, and insecure content disabled are explicitly set (`electron/main/index.ts:73-81`). Top-level popups and navigations are denied.
- **IPC validation:** handlers use a fixed channel list, reject subframes, and most downstream methods enforce record shapes, unknown-key rejection, length bounds, IDs, canonical directories, or relative Git paths.
- **Prime RPC command surface:** renderer commands are allowlisted and command-specific fields are validated; subprocess spawning uses argument arrays with `shell:false`; stderr is not forwarded to the renderer.
- **Session paths:** reads/rename/archive canonicalize with `realpath`, require containment in the Prime session directory, and require `.jsonl`.
- **Webview isolation:** the fixed partition, deleted guest preload, popup denial, and universal permission denial behaved as intended in the tested cases.
- **CSP:** a packaged main-renderer fetch to `https://example.com` generated a `connect-src` security-policy violation, confirming the packaged response-header CSP was active.
- **Persistence:** within one process, the store's queue prevents lost concurrent updates. Writes use a 0600 temporary file, fsync the file, atomic rename, and attempt to fsync the directory. Corrupt JSON is backed up and replaced with defaults.
- **Dependencies:** `npm audit --omit=dev` found no vulnerabilities in the nine conventional production dependency entries. This does **not** clear Electron, because Electron is packaged while declared in devDependencies.

## Tests and repros run

| Check | Result |
|---|---|
| `npm test` | **PASS** — 2 files, 4 backend tests |
| `npm run build` | **PASS** — node/web typecheck plus main, preload, renderer builds |
| `playwright test` (latest run) | **FAIL** — 3 passed; PTY maximize/restore test timed out because another workspace element intercepted the Restore button; lifecycle test did not run |
| Unpackaged preload smoke | **PASS** — bridge loaded, sandbox hid Node globals |
| Packaged preload/native smoke | **PASS** — bridge loaded from ASAR and `node-pty` created a PTY |
| Packaged webview adversarial smoke | **PASS for tested controls** — sandbox/no Node, popup denied, media permission denied, unsafe file redirect rejected |
| Packaged CSP smoke | **PASS** — external main-renderer connection blocked |
| `electron-builder --mac dir` | Built and code-sign verification passed; **Gatekeeper assessment failed/rejected**, notarization skipped |
| Full `npm audit` | **FAIL** — 18 packages: 2 critical, 13 high, 3 moderate |
| `npm audit --omit=dev` | PASS/0, but excludes packaged Electron and build-chain risks |
| Shutdown fake-agent repro | **FAIL** — RPC child alive 3.5 seconds after app closed |
| Inferred-root repro | **FAIL** — session cwd `/` authorized `/private/etc` |
| Removed-root repro | **FAIL** — removed project stayed authorized until relist |
| Project plugin path repro | **FAIL** — `/etc/hosts` first content line returned as project prompt metadata |
| Two-store repro | **FAIL** — last writer silently erased the other successful update |
| `node-pty` detached-child repro | **Expected limitation exposed** — `nohup sleep` survived PTY kill |
| Dev-origin IPC repro | **FAIL** — unrelated HTTP main page received full preload bridge and invoked IPC |

The Playwright failure is also a concrete reliability regression: in maximized terminal layout, the visible Restore control is overlapped/intercepted by a workspace “plus” element. Fix stacking/pointer-event layout and keep this test in the release gate. The packaged lifecycle test should be made independent of the user's real Prime sessions/projects and should always exercise PTY creation and last-window recreation rather than skipping after an earlier failure.

## Recommended remediation order

1. **Stop shipping Electron 34:** upgrade Electron and rebuild native modules; re-run remote-content security tests.
2. **Fix child shutdown and resource limits:** awaited termination, process groups/jobs, caps, byte budgets, and flood handling.
3. **Close trust-boundary escapes:** project plugin path containment and URL-aware IPC authorization.
4. **Make persistence single-instance-safe** and correct project grant/removal semantics.
5. **Complete browser policy:** redirects/frames, deterministic downloads, and real privacy reset.
6. **Harden and verify packaging:** current builder/toolchain, fuses, minimal unpack, Developer ID, notarization, Gatekeeper/stapler CI gates.
7. Turn all repros above into automated unit/integration/packaged tests before release.
