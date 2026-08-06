# Prime Agent Desktop — macOS Architecture Recommendation

**Status:** proposed architecture / implementation roadmap  
**Primary target:** polished Codex-like macOS desktop client  
**Decision:** **Electron + React + TypeScript**, with Prime Agent behind a documented JSONL/RPC process boundary

## 1. Executive recommendation

Build the first production client in **Electron**, not Tauri.

Both stacks are viable on this machine, but Electron is the lower-risk choice for this product because Prime Agent is already a Node/TypeScript application, exposes a documented RPC protocol, and depends on a mature Node ecosystem. Electron lets the team reuse protocol types and utilities, use `xterm.js` + `node-pty` for a real terminal, and create isolated Chromium `WebContentsView` instances for the browser without maintaining a second Rust application layer.

Tauri would reduce shell size and idle memory, and its capability model is attractive, but it would **not remove the privileged Prime Agent runtime**. A Tauri build would still need to bundle or discover a Node runtime plus the 262 MB local Prime Agent installation, supervise that sidecar from Rust, translate its JSONL protocol, package/sign its native modules, and bridge a PTY and multiple WKWebViews. That is extra cross-language and release risk with limited security benefit for this particular application.

Use Electron securely:

- The **renderer is sandboxed and untrusted**: no Node integration, context isolation on, strict CSP.
- A very small preload exposes a **schema-validated, capability-specific API**, never raw Electron IPC.
- The Electron main process is a broker, not the agent runtime.
- Prime Agent runs out of process and communicates through its documented `--mode rpc` LF-delimited JSONL protocol.
- PTYs and remote browser content run in separate processes/web contents.
- Do not target the Mac App Store initially. Ship a Developer ID–signed, hardened-runtime, notarized DMG/ZIP outside the store. Prime Agent, shells, Python kernels, extensions, and arbitrary project access do not fit a useful App Sandbox entitlement model.

The most important architectural rule is to keep the ownership boundary clear:

> Prime Agent owns conversations, agent configuration, auth, skills, and execution. The desktop app owns projects/recents, layout, tabs, browser state, terminal metadata, and presentation caches. Do not create a second conversation database.

## 2. Local environment findings

The repository was empty at inspection start. The local machine is unusually well prepared for either implementation:

| Component | Observed value | Consequence |
|---|---:|---|
| macOS / CPU | macOS 26.5.1, Apple Silicon `arm64` | Build arm64 first; test x64 separately rather than assuming universal native modules work |
| Node | 24.15.0 | Exceeds Prime Agent's Node `>=22.8.0` requirement |
| npm / pnpm | npm 11.12.1, pnpm 10.33.2 | Good Electron/TypeScript toolchain; prefer pnpm for the workspace |
| Rust / Cargo | rustc/cargo 1.95.0 | Tauri is technically available, but not required |
| Xcode / Swift | Xcode 26.6, Swift 6.3.3 | Signing, native modules, and macOS packaging are available |
| Prime Agent | 0.7.0 at `/opt/homebrew/bin/prime-agent` | The desktop can spike against a real local engine immediately |
| Prime Agent daemon | protocol version 7, versioned schema | Useful internally, but v1 should not couple directly to its private socket protocol |
| Prime Agent installed size | about 262 MB; local Node installation about 74 MB | A Tauri shell would not make the distributed product small if the engine is bundled |

Relevant Prime Agent behavior confirmed from the installed 0.7.0 package and docs:

- Persistent sessions are JSONL trees under `~/.prime/agent/sessions/`.
- `prime-agent list --all --json` returns live, passive/saved, root, and subagent summaries.
- `prime-agent status --json` reports daemon and protocol compatibility information.
- `prime-agent --mode rpc` is a documented stdin/stdout integration protocol.
- RPC supports prompts, steering/follow-ups, abort, model/thinking controls, messages/state/stats, session switching/forking/cloning, compaction, schedules/heartbeats, agent observation, and extension UI requests.
- `get_commands` exposes loaded extension commands, prompt templates, and skills.
- Prime packages and extensions have full host access. They are a trust boundary, not a UI customization sandbox.
- Global configuration is under `~/.prime/agent`; project overrides are under `.prime/agent` in a project.

A critical protocol detail: Prime Agent RPC uses **strict LF framing**. Its docs explicitly warn not to use Node's `readline`, because `readline` can split on `U+2028`/`U+2029`, which are legal inside JSON strings. The bridge must use a byte/string decoder and search only for `\n`.

## 3. Electron vs. Tauri decision record

### Weighted comparison

| Criterion | Weight | Electron | Tauri 2 | Notes |
|---|---:|---:|---:|---|
| Prime Agent/Node integration | 25% | 5/5 | 2/5 | Electron can use the published TS package and Node tooling; Tauri needs a Node sidecar anyway |
| Terminal implementation | 15% | 5/5 | 3/5 | `xterm.js` + `node-pty` is well established; Tauri requires Rust PTY plumbing or a plugin bridge |
| Embedded browser/preview | 15% | 5/5 | 3/5 | Electron offers isolated Chromium web contents and consistent devtools; Tauri uses WKWebView on macOS |
| Process isolation and IPC | 15% | 4/5 | 5/5 | Tauri has a stronger default command/capability model; hardened Electron can achieve the needed boundary |
| Packaging complexity for this engine | 10% | 4/5 | 2/5 | Both must sign native code; Tauri additionally carries Node and Rust layers |
| UI ecosystem / delivery speed | 10% | 5/5 | 4/5 | Both can run React; Electron has fewer multi-webview and desktop-terminal surprises |
| Footprint and idle memory | 10% | 2/5 | 5/5 | Tauri wins, but the agent/runtime/browser dominate many real workflows |
| **Weighted result** | | **4.4/5** | **3.1/5** | Electron wins for v1 |

### Why “Tauri is safer” is incomplete here

Tauri narrows the JavaScript-to-native API by default, but the app's actual capability set includes:

- arbitrary local project reads/writes;
- shell and PTY execution;
- long-lived Python kernels;
- downloading/installing Prime Agent packages;
- extensions that execute arbitrary code;
- remote web browsing.

Those powers cannot be made harmless by moving the window shell to Rust. The useful security boundary is between hostile content/renderers and privileged services. Electron supports that boundary when configured correctly. Tauri should be reconsidered only if one of these changes:

1. Prime Agent becomes a stable remote service or native library and no Node runtime must ship;
2. measured Electron memory/download size violates a hard product requirement;
3. the core desktop team is Rust-first and willing to own the protocol/PTY/webview layer long term.

## 4. Target process and trust model

```text
┌────────────────────────────────────────────────────────────────────┐
│ Sandboxed app renderer (React)                                     │
│ chat / projects / terminal canvas / browser chrome / settings      │
└───────────────────────┬────────────────────────────────────────────┘
                        │ tiny typed preload API
                        │ contextBridge + validated IPC / MessagePorts
┌───────────────────────▼────────────────────────────────────────────┐
│ Electron main broker                                               │
│ ProjectService · SessionSupervisor · PtyService · BrowserService   │
│ SettingsService · CapabilityService · Database · UpdateService     │
└──────────┬──────────────────┬──────────────────┬───────────────────┘
           │ strict JSONL     │ PTY bytes        │ WebContentsView
┌──────────▼─────────┐  ┌─────▼──────────┐  ┌────▼─────────────────┐
│ Prime RPC clients  │  │ login shells   │  │ remote/local pages  │
│ (one per actively  │  │ via node-pty   │  │ no preload, no IPC  │
│ controlled session)│  └────────────────┘  └──────────────────────┘
└──────────┬─────────┘
           │ Prime CLI coordinates with its own daemon/runtime
┌──────────▼─────────────────────────────────────────────────────────┐
│ Prime Agent daemon/workers · model providers · IPython kernels     │
│ trusted extensions/skills · filesystem/process/network access      │
└────────────────────────────────────────────────────────────────────┘
```

### Trust zones

1. **Remote browser pages are hostile.** They get their own web contents, no preload, no Node, no app IPC, and no `file:` navigation.
2. **The app renderer is semi-trusted presentation code.** An XSS must not become local code execution. It receives only minimum-purpose methods.
3. **Electron main is privileged but small.** It validates every path, URL, enum, size, and state transition.
4. **Prime Agent, PTYs, and installed extensions are explicitly privileged.** They are allowed to modify the user's projects. Their output is untrusted data when rendered.
5. **Secrets never enter renderer state.** Prime Agent remains the source of truth for provider auth. Any desktop-only secret uses macOS Keychain/Electron `safeStorage`.

### Runtime ownership

Use one RPC broker process for each session that is actively controlled or streaming. This avoids head-of-line blocking and lets multiple agents work concurrently. Idle closed sessions do not need a process; they remain durable in Prime Agent's JSONL store and can be reopened.

The Prime CLI already coordinates its persisted invocations with its daemon. In v1, treat that as an implementation detail:

- Use `prime-agent --mode rpc --cwd <canonical-project>` for a new session.
- Use the supported resume/session flags plus RPC for existing sessions.
- Use `prime-agent list --all --json` for the fleet/session catalog.
- Use `prime-agent status --json` for health and compatibility.
- Do **not** open `daemon.sock` or bind to daemon schema 7 directly in v1. The socket API is more powerful but more tightly versioned than the documented RPC surface.

Before relying on resume/attach semantics, add a contract spike against all supported Prime Agent versions. If a live session cannot be safely reattached through documented RPC, keep its original RPC broker alive and use `observe` only for secondary read-only views. Do not reverse-engineer the daemon as a shortcut.

On macOS, closing the last window should leave the app broker alive while agents are working. Explicit **Quit** must show the active count and offer Cancel or “Stop and Quit.” Do not silently kill work. Continuing arbitrary active work after the entire app has exited needs a documented daemon ownership/reattach contract; schedules/heartbeats already promote work into resident daemon sessions, but general background continuation should be treated as a separate validated feature.

## 5. Prime Agent adapter

Create an `AgentEngine` interface so UI code is independent of transport:

```ts
interface AgentEngine {
  catalog(): Promise<SessionSummary[]>;
  open(input: OpenSessionInput): Promise<AgentConnection>;
  health(): Promise<EngineHealth>;
}

interface AgentConnection {
  snapshot(): Promise<SessionSnapshot>;
  command(command: AgentCommand): Promise<CommandReceipt>;
  events(): AsyncIterable<AgentEvent>;
  close(): Promise<void>;
}
```

The first implementation is `PrimeRpcEngine`; a future in-process SDK or direct daemon implementation can satisfy the same interface.

### Process launch

Development lookup order:

1. explicit app preference or `PRIME_AGENT_BINARY`;
2. repository development artifact;
3. login-shell `command -v prime-agent`, resolved once without interpolating user strings;
4. known Homebrew paths (`/opt/homebrew/bin`, `/usr/local/bin`) as diagnostics only.

Production should not depend on Homebrew or the user's Node installation. Bundle a **version-pinned Prime Agent payload and dedicated matching Node runtime** under `Contents/Resources/agent/`, after confirming redistribution terms. Ship per-architecture artifacts initially. A dedicated Node binary permits disabling Electron's `RunAsNode` fuse and avoids coupling sidecar behavior to Electron's embedded Node ABI. Prune unrelated platform prebuilds from the 262 MB development install, but only through a reproducible allowlist and real clean-machine tests.

At startup:

1. resolve and verify the engine binary and bundle checksum;
2. run `prime-agent -v` and enforce a tested semver range;
3. query `status --json` for diagnostics;
4. start the RPC child with `spawn(executable, argv, { shell: false })` and a curated environment;
5. issue `get_state` as the transport handshake;
6. surface incompatibility as a repair/upgrade screen, never as a blank chat.

Strip `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, dynamic-library injection variables, and internal app secrets from child environments. Preserve the user's provider variables only according to an explicit environment policy. Finder-launched apps have a restricted `PATH`; calculate the user shell path/environment deliberately rather than inheriting an accidental development shell.

### RPC correctness

- Parse stdout with `StringDecoder`; split only on byte/LF `0x0A`; accept CRLF by removing one trailing `\r`.
- Treat stderr as diagnostics only. Never parse protocol records from stderr.
- Assign a unique request ID and correlate exactly one command response.
- A successful `prompt` response means **accepted**, not finished. Completion is `agent_end`.
- Never automatically replay a prompt after an ambiguous process disconnect; it might duplicate work. Refresh messages/state and show an “acceptance unknown” recovery action.
- Preserve order. Prime Agent intentionally buffers prompt events until the prompt acceptance response is emitted.
- Validate both commands and inbound events with versioned TypeBox/Zod schemas. Unknown additive event fields are tolerated; unknown event kinds are logged and ignored safely.
- Bound the unframed buffer (for example 64 MiB) and renderer-visible payload sizes. Tool output should be virtualized and collapsed, not copied repeatedly.
- Coalesce `text_delta` and accumulated `tool_execution_update` events to animation frames. Never drop terminal events such as `message_end`, `tool_execution_end`, `agent_end`, or error states.
- On renderer reload, rebuild from `get_state` + `get_messages`; streaming UI state is a cache, not a source of truth.
- Use `abort` first. Escalate to SIGTERM and then SIGKILL only after timeouts and with clear diagnostics.

### Known API gaps

RPC 0.7.0 is strong for sessions but does not expose every built-in TUI workflow. In particular, built-in `/login`, `/settings`, and `/reload` are not returned by `get_commands` and should not be assumed to work as RPC prompts.

For v1:

- Keep Prime Agent's `auth.json` private; do not parse tokens into renderer state.
- If auth is missing, offer “Authenticate with Prime Agent” in a dedicated trusted PTY/terminal flow, or direct the user to the CLI.
- Implement only non-secret, schema-known settings in the desktop.
- Restart/reopen an agent connection after capability changes when hot reload is not available.

Upstream requests worth making early: `auth_status`, `begin_login`, `logout`, schema-based `get_settings`/`patch_settings`, `reload_resources`, and JSON package management. Do not scrape the interactive TUI.

## 6. Electron IPC contracts

### Renderer-to-main boundary

The preload must expose named methods, not a generic channel:

```ts
window.prime.projects.list()
window.prime.projects.openDialog()
window.prime.sessions.create(input)
window.prime.sessions.send({ sessionId, clientMessageId, kind, text, images })
window.prime.sessions.abort({ sessionId })
window.prime.sessions.connectEvents({ sessionId })
window.prime.terminals.create({ projectId, cols, rows })
window.prime.terminals.write({ terminalId, data })
window.prime.browser.navigate({ browserId, url })
window.prime.settings.patch({ scope, baseRevision, patch })
```

Do not expose `ipcRenderer`, `webContents`, `shell`, filesystem primitives, arbitrary command execution, arbitrary environment dictionaries, or arbitrary channel names.

Recommended shared contract package:

- discriminated request/event unions;
- runtime schemas and inferred TS types from the same source;
- payload size limits;
- explicit `contractVersion`;
- opaque branded IDs (`ProjectId`, `SessionId`, `TerminalId`, `BrowserId`);
- exhaustive main handlers.

Use `ipcMain.handle` for bounded request/response operations. Use a dedicated `MessageChannelMain` port for each subscribed session and terminal stream. The preload owns port setup so the renderer never receives broader Electron objects.

### Event envelope

```ts
type DesktopEvent = {
  contractVersion: 1;
  streamId: string;
  seq: number;
  revision: number;
  at: number;
  event: SessionEvent | TerminalEvent | BrowserEvent;
};
```

`seq` detects drops; `revision` lets reducers reject stale snapshots. When the renderer detects a gap, it requests a fresh snapshot instead of guessing. Each subscription has a bounded queue. Intermediate deltas may be coalesced under pressure; state transitions may not.

### Principal IPC methods

| Domain | Requests | Events / safeguards |
|---|---|---|
| Projects | list, choose folder, add, rename display name, remove | Main canonicalizes paths; renderer cannot add an unvalidated path |
| Sessions | catalog, create/open, prompt/steer/follow-up, abort, fork/clone, set name/model/thinking, compact, export | Commands validated against current state; events carry session ID and sequence |
| Terminal | create, write, resize, close | No generic `exec`; IDs map to PTYs owned by the requesting window/project |
| Browser | create, set bounds, navigate, back/forward/reload, destroy | Only `http:`/`https:`; remote contents receive no preload or IPC |
| Capabilities | inventory, inspect, install/remove/update with confirmation | Spawn argv without shell; require trust confirmation and refresh agent resources |
| Settings | get effective settings, patch scope/revision, reset | Optimistic concurrency; redact secrets; preserve unknown engine fields |
| Dialogs | open project, select upload/download/export destination | OS dialog returns the path; renderer cannot forge privileged bookmarks |

## 7. Feature architecture

### Projects

A project is an app-owned reference to a canonical directory, not a copy of a repository. Store display name, canonical path, last-open time, and UI state. Resolve symlinks with `realpath`; retain the user-facing path for display. Detect missing/moved volumes gracefully.

Opening a project creates a workspace context:

- session catalog filtered by session `cwd`;
- project/global Prime settings layers;
- per-project terminal tabs;
- browser tabs/previews;
- project skill/plugin inventory;
- optional later git/file indexing.

Never recursively index large repositories in Electron main on every launch. Use cancellable worker/utility processes, ignore rules, and incremental watchers for future file search.

### Sessions and chat

Prime JSONL remains authoritative. Do not write session JSONL directly. Use RPC operations for names, forks, clones, switching, compaction, and messages. Use `list --all --json` for sidebar summaries and cache only reconstructed metadata.

The renderer should normalize messages by stable message/tool-call IDs. It must support:

- text, thinking, images, tool calls/results, errors, aborted output;
- queued steering and follow-ups;
- agent/subagent hierarchy and observed sessions;
- active/idle/compacting/retrying states;
- context/cost statistics;
- virtualization for long transcripts;
- accessible live-region announcements that do not read every token delta.

Render Markdown with raw HTML disabled, sanitize links, and never inject model/tool output with `innerHTML`.

### Terminal

Use `xterm.js` in the app renderer and `node-pty` in a privileged service (main initially; a utility process if stability demands it). Spawn the user's configured shell as a login/interactive shell in the canonical project directory.

Security and reliability requirements:

- PTY `write`/`resize`/`kill` only by opaque ID;
- do not accept a renderer-provided executable or environment map;
- cap buffered scrollback and apply flow control;
- treat OSC clipboard/window operations conservatively; require user action for clipboard writes;
- sanitize/validate clickable terminal links;
- do not persist terminal output by default because it can contain secrets;
- rebuild and sign `node-pty` for every Electron/CPU target.

A terminal is intentionally full local access. Label it honestly; do not imply the terminal is sandboxed.

### Browser / preview

Use Electron `WebContentsView` (not `<iframe>` and not a renderer `<webview>` tag) controlled by main. Each browser content instance has:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- `sandbox: true`;
- no preload script;
- normal web security enabled;
- a dedicated persistent or ephemeral partition, selected deliberately;
- navigation limited to `http:`/`https:`;
- denied popups by default; explicit external-open behavior;
- a deny-by-default permission handler;
- downloads routed through an OS confirmation/destination flow.

The app renderer draws trusted browser chrome; the remote page occupies only view bounds managed by main. Destroy or hide views when tabs/workspaces change and update bounds on resize. Include a local test server in E2E tests to verify back/forward, reload, downloads, popups, permissions, and that a malicious page cannot see `window.prime`.

Localhost previews are an expected feature, but remote pages can probe local services just as a normal browser can. Isolate cookies/partitions and make the trust distinction visible.

### Plugins, packages, and skills

Prime Agent packages can contain executable extensions and skills can influence tool use. Treat installation like installing code, not enabling a browser theme.

Inventory sources:

- `get_commands` for resources actually loaded in an active session;
- conventional user/project skill directories for read-only metadata;
- Prime package manager/SDK once a structured JSON API exists.

The install UI must show source, scope (global/project), resolved version or commit, and an explicit full-access warning. Prefer pinned versions/commits and keep provenance metadata in the app database. Run `prime-agent package ...` with fixed argv and `shell: false`; never concatenate a source into a command string. A failed/partial install is diagnostics, not success. Do not parse ANSI `package list` output as a stable API.

After install/remove/update, start a new/reloaded agent runtime before claiming the capability is active. Long term, use an upstream JSON package API and signature/provenance checks.

### Settings and auth

Present two clearly separated scopes:

1. **Application settings** — appearance, update channel, browser behavior, terminal preferences, telemetry choice. Owned by the desktop database.
2. **Agent settings** — model, thinking, compaction, delivery modes, resource configuration. Owned by Prime Agent, with global and project scope.

Session-level settings should use RPC. For file-backed Prime settings, patch only schema-known keys:

1. read and validate the latest file;
2. retain unknown keys;
3. compare the base revision/hash to prevent lost updates;
4. acquire a compatible lock where possible;
5. write a same-directory temporary file, `fsync`, chmod appropriately, then atomic rename;
6. retain a backup on migration/failure;
7. watch for external CLI edits and show conflicts.

Do not duplicate provider tokens. `~/.prime/agent/auth.json` observed locally has restrictive `0600` permissions; preserve that ownership model. Desktop-only encrypted values use Keychain-backed `safeStorage`, not plaintext SQLite or logs.

## 8. Persistence model

Use SQLite in Electron main at:

```text
app.getPath("userData")/prime-desktop.sqlite
```

`better-sqlite3` is a reasonable v1 choice because there is a single main-process writer and synchronous transactions are simple; it must be rebuilt/signed for Electron. Enable WAL, foreign keys, and a busy timeout. Keep transactional migrations in source control and back up before destructive migrations.

Suggested app-owned tables:

- `schema_migrations`
- `projects(id, canonical_path UNIQUE, display_path, display_name, last_opened_at, created_at)`
- `workspace_state(project_id, active_session_id, selected_panel, layout_json, revision)`
- `terminal_tabs(id, project_id, title, cwd, ordinal, reopen_policy)` — no scrollback by default
- `browser_tabs(id, project_id, url, title, partition_key, ordinal)`
- `window_state(window_key, bounds_json, is_maximized, updated_at)`
- `preferences(key, value_json, revision, updated_at)`
- `package_provenance(scope, source, resolved_version, installed_at, trusted_at)`
- `session_catalog_cache(session_id, session_file, cwd, name, lifecycle, modified_at, observed_at)` — reconstructible, no full transcript

Data ownership matrix:

| Data | Owner / source of truth | Desktop behavior |
|---|---|---|
| Conversation messages/tree | Prime Agent JSONL | Read through RPC/catalog; never rewrite |
| Session model/name/queue/stats | Prime runtime/session | Update through RPC |
| Global/project agent settings | Prime settings files/runtime | Validated narrow patch, retain unknown keys |
| Provider/MCP credentials | Prime auth store | Never copy to renderer/database |
| Project recents/layout/tabs | Desktop SQLite | Transactional app ownership |
| Browser cookies/storage | Chromium partition | Isolated by chosen partition policy |
| Terminal contents | PTY memory | Not durable by default |

Do not store full messages in SQLite “for speed.” It creates divergence, migration burden, and a second sensitive-data corpus. A short-lived in-memory normalized cache is enough.

## 9. Security baseline

### Electron configuration

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true` for app and remote renderers
- `webviewTag: false`
- strict production CSP with no remote scripts and no `unsafe-eval`
- deny unexpected navigation and window creation in the app renderer
- validate sender frame/origin for every IPC call
- remote browser contents have no preload and no app origin
- open external links only after scheme validation
- sanitize Markdown, filenames, URLs, and terminal links
- no secrets or access tokens in renderer state, analytics, crash dumps, or logs
- redact home paths and command output in opt-in diagnostics exports where possible

Set Electron fuses during packaging:

- disable `RunAsNode` (possible because production uses a dedicated agent Node runtime);
- disable `NODE_OPTIONS` and CLI inspect arguments for the Electron executable;
- enable cookie encryption;
- enable embedded ASAR integrity validation;
- require loading app code from ASAR.

### Host execution

- Always use `spawn(file, argv, { shell: false })`.
- Canonicalize project paths in main and bind opaque IDs to them.
- Keep a curated child environment; strip dynamic loader and Node injection variables.
- Rate-limit/size-limit IPC and protocol streams.
- Verify the bundled engine against a signed/checksummed manifest.
- Make extension/package risk explicit and record user trust decisions.
- Keep automatic updates signed, HTTPS-only, and rollback-capable.

### Distribution posture

Use hardened runtime but **not App Sandbox** for the first Developer ID build. This is a deliberate trade-off. The renderer is sandboxed; the host agent is not, because its product function is local automation. Document that distinction in security/help UI.

## 10. Testing strategy

### Unit tests

Use Vitest for shared/main/renderer code and Testing Library for React:

- strict LF JSONL decoder across arbitrary chunk boundaries;
- `U+2028`/`U+2029` inside JSON strings;
- CRLF acceptance and malformed/oversized records;
- request correlation, timeout, acceptance vs. completion;
- reducer ordering, duplicate/gapped sequence handling, delta coalescing;
- settings merge/revision/atomic-write behavior;
- path canonicalization and missing projects;
- URL/scheme and popup/permission policy;
- database migrations and rollback;
- secret redaction.

### Protocol contract tests

Maintain two adapters:

1. a deterministic fake `prime-agent` executable that emits scripted chunked JSONL, crashes, delays, requests extension UI, and violates schemas;
2. a real-engine smoke suite pinned to every supported Prime Agent version.

Real-engine tests should run without an LLM call where possible: version, `status --json`, `list --all --json`, start RPC, `get_state`, `get_messages`, `get_commands`, new/switch session, and clean shutdown. Authenticated prompt tests belong in a protected nightly job, not every PR.

Store sanitized golden event fixtures per supported protocol version. Compatibility is declared only after the suite passes.

### Desktop integration/E2E

Use Playwright's Electron automation rather than Spectron. Required flows:

- first launch and engine-missing/incompatible repair screens;
- add/remove/reopen project;
- create session, stream response/tool output, steer/follow-up, abort, resume after app reload;
- extension confirm/input modal round trip;
- sidecar crash and state recovery without duplicate prompt;
- multiple concurrent sessions and subagent observation;
- terminal create/write/resize/close and large-output backpressure;
- browser local server navigation, popups, permissions, downloads, and no `window.prime` exposure;
- settings persistence and conflict after an external edit;
- upgrade database migrations;
- keyboard-only navigation, VoiceOver labels, reduced motion, contrast, and large text.

### Security/package tests

- malicious Markdown and remote-page fixtures;
- IPC calls from the wrong frame/origin;
- CSP and Electron security-warning assertions;
- dependency/license/SBOM scan;
- packaged-app smoke tests on clean arm64 and x64 machines;
- signature verification with `codesign --verify --deep --strict` and Gatekeeper assessment;
- notarization/stapling verification;
- updater rejects unsigned or wrong-channel payloads.

## 11. Packaging and release

Recommended stack:

- pnpm workspace;
- current stable Electron pinned exactly;
- React + TypeScript + Vite;
- `electron-builder` for per-architecture DMG and ZIP artifacts;
- `@electron/rebuild` for `node-pty` and `better-sqlite3`;
- Electron fuses set after packaging and before final signing;
- Developer ID Application signing, hardened runtime, notarization with `notarytool`, staple ticket;
- signed HTTPS update feed with staged rollout and rollback.

Packaging rules:

- Keep UI/application JavaScript in ASAR.
- Unpack only native Electron modules that must be loaded from disk.
- Place the dedicated Node runtime and pinned Prime Agent distribution in `extraResources`; sign every nested Mach-O and native module.
- Build arm64 first because that is the available host. Build x64 on an x64 runner or validated cross-build pipeline. Prefer separate arm64/x64 downloads in v1 over a “universal” app containing mismatched sidecars.
- Update app and bundled engine atomically; never silently combine an old UI contract with a new engine.
- Produce checksums, SBOM, license notices, and a compatibility manifest.
- Confirm Prime Agent redistribution/licensing terms before embedding release tarballs.

A development “external engine” setting is useful for Prime Agent contributors, but production defaults to the bundled engine. If external engines are allowed in stable builds, show their path/version prominently and enforce a supported range.

## 12. Phased build plan

### Phase 0 — Risk spikes and ADRs (2–4 days)

Deliverables:

- Electron/Vite/React shell with hardened BrowserWindow and tiny preload.
- Shared runtime-validated IPC contract package.
- Real `prime-agent --mode rpc` spike using strict LF parsing.
- `list --all --json` catalog and one real session snapshot.
- Fake-agent fixture.
- `xterm.js` + `node-pty` packaged smoke test.
- isolated `WebContentsView` showing a local test page.
- architecture decisions for engine bundling, auth gap, app sandbox, and updater.

Exit criteria: a packaged development app passes the “renderer cannot access Node,” RPC framing, PTY, and remote-page isolation tests. Validate resume/reattach and process-exit behavior empirically before scheduling background work.

### Phase 1 — Core vertical slice (1–2 weeks)

- Project picker and recent projects.
- SQLite migrations and window/workspace state.
- Session catalog, create/open/resume/name.
- Chat transcript, Markdown, streaming/thinking/tool cards.
- Prompt, steer/follow-up, abort, model/thinking controls.
- Session process supervisor, crash diagnostics, reload recovery.
- Engine health/compatibility screen.

Exit criteria: quit/relaunch restores projects and sessions without message duplication; two sessions can stream concurrently; fake-sidecar fault suite passes.

### Phase 2 — Complete session workspace (1–2 weeks)

- fork/clone/export/compaction/stats;
- subagent hierarchy and observation;
- queue/retry/compaction UI;
- terminal tabs with resize/backpressure and project cwd;
- responsive split panes, command palette, keyboard shortcuts;
- accessibility baseline.

Exit criteria: long transcripts/tool outputs remain responsive; PTY cannot be controlled across the wrong window/project; all session state rebuilds from Prime Agent.

### Phase 3 — Browser and preview (about 1 week)

- trusted browser chrome and `WebContentsView` controller;
- local preview URL detection/manual open;
- back/forward/reload, tabs, inspect/open externally;
- permission, popup, download, cookie-partition policy;
- malicious-page E2E suite.

Exit criteria: remote content cannot access app IPC or local file URLs, and browser lifecycle has no orphaned web contents.

### Phase 4 — Skills, plugins, settings, and onboarding (1–2 weeks)

- loaded command/skill inventory and source badges;
- package install/remove/update with full-access confirmation and provenance;
- app settings and validated global/project agent settings;
- engine/auth onboarding fallback;
- capability refresh/restart flow;
- schedules/heartbeats if product-priority validated.

Exit criteria: no auth token enters renderer/SQLite/logs; package operations are argv-based and failure-safe; project/global scope is unambiguous.

### Phase 5 — Production hardening and beta (1–2 weeks)

- bundle pinned Prime Agent + dedicated Node runtime;
- fuses, signing, hardened runtime, notarization, updater;
- arm64 and x64 clean-machine CI;
- crash recovery, support bundle/redaction, performance budgets;
- security review, dependency/license/SBOM review;
- staged internal → invited beta → stable rollout.

Suggested initial budgets measured on a representative project:

- first useful window under 2 seconds on warm launch;
- typing/scrolling at 60 fps while agent streams;
- no unbounded event, PTY, or transcript buffers;
- app renderer idle memory and each browser tab tracked separately;
- zero lost accepted prompts and zero automatically duplicated ambiguous prompts.

## 13. Suggested repository shape

```text
prime/
  apps/desktop/
    src/main/           # windows, services, IPC handlers, lifecycle
    src/preload/        # narrow contextBridge implementation
    src/renderer/       # React UI only
    resources/          # icons/entitlements; generated engine payload excluded
  packages/contracts/   # schemas + inferred TS types
  packages/agent-bridge/# PrimeRpcEngine, JSONL decoder, process supervisor
  packages/ui/          # reusable accessible components/tokens
  packages/test-agent/  # deterministic fake Prime Agent executable
  tests/e2e/
  scripts/package-agent/
  research/
  pnpm-workspace.yaml
```

Keep domain services independent of Electron where practical. `SessionSupervisor`, the JSONL decoder, catalog mapper, and settings merger should be testable as plain Node modules. Electron-specific code should mainly adapt app lifecycle, windows, MessagePorts, dialogs, WebContentsView, signing, and updates.

## 14. Highest-risk items to close first

1. **Bundling rights and artifact size:** confirm the legal/technical distribution contract for Prime Agent and prune its cross-platform payload reproducibly.
2. **Auth/settings RPC gaps:** avoid a polished UI that silently depends on unsupported TUI commands.
3. **Live-session ownership on detach/quit:** prove resume/reattach/background semantics against supported engine versions.
4. **Native module matrix:** `node-pty`, SQLite, Prime native dependencies, Node ABI, arm64/x64 signing/notarization.
5. **Remote browser isolation:** make it impossible for browsed content to inherit app preload or privileged IPC.
6. **Package trust:** extensions have full access; the UI must not imply a permission sandbox that does not exist.
7. **Protocol compatibility:** pin and test; do not bind to undocumented daemon internals merely because they are locally inspectable.

With these constraints, Electron provides the fastest path to a polished desktop experience while preserving a clean future migration boundary: the renderer speaks only desktop contracts, and all Prime-specific behavior lives behind `AgentEngine`.
