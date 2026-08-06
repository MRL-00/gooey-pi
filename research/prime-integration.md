# Prime Agent desktop-integration audit (local Mac)

Audit target: the Prime Agent installation currently on this Mac. This was a read-only inspection of installed packages, help text, compiled declarations/code, runtime directories, and existing JSONL structure. No installed package was modified.

## Executive recommendation

Use a **backend adapter in the desktop app**, never the renderer, to own Prime Agent processes and credentials.

1. **Best MVP / strongest isolation:** spawn the absolute `prime-agent` executable in `--mode rpc` and speak strict LF-delimited JSON over pipes. It is rich enough for prompts, streaming, cancellation, models, compaction, session switching/forking, bash, schedules, heartbeats, peer observation, and extension UI requests.
2. **Best full-fidelity local UI:** from a Node/Electron main process, pin the same `prime-agent` package version and program against the exported high-level `AgentConnection` / `DaemonAgentConnection`, not the raw daemon socket. That surface contains snapshots, reconnect, session trees, resources, RLM children, queues, bash streaming, saved-session operations, and extension UI. Hide it behind an app-owned interface because its own type comments call parts of it transitional rather than a stable remote contract.
3. **Best standards-based / non-Node client:** use `--mode acp`. It is JSON-RPC 2.0 over JSONL, but intentionally exposes fewer Prime-specific features than RPC.
4. Use `--mode json` or `-p` only for one-shot jobs. Do **not** build the app around tailing/writing session JSONL or around the raw daemon protocol.

Prime Agent workers, IPython kernels, extensions, skills, terminal commands, and browser automation run with the user's OS permissions. Process separation is lifecycle/failure containment, **not a sandbox**. An untrusted repository needs an external sandbox/VM/container regardless of which integration is chosen.

## What is installed

| Item | Observed value |
|---|---|
| CLI command | `/opt/homebrew/bin/prime-agent` |
| CLI target | `/opt/homebrew/lib/node_modules/prime-agent/dist/bundle/cli.js` |
| Package | `prime-agent` `0.7.0` |
| Package root | `/opt/homebrew/lib/node_modules/prime-agent` |
| Runtime | Node; package requires Node `>=22.8.0`; local Node is `v24.15.0` |
| Main JS/types exports | `dist/index.js`, `dist/index.d.ts` |
| Agent data directory | `~/.prime/agent` |
| Managed Python | `~/.prime/agent/kernel-venv/bin/python` (Python 3.11 environment) |
| Browser automation found | `/opt/homebrew/bin/agent-browser`, version `0.26.0` |
| Shells found | `/bin/zsh` (current `$SHELL`), `/bin/bash` |

`prime` is not a command on this machine. The similarly named `/Users/am.will/.local/bin/agent` is not the Prime Agent executable and should not be used as a fallback. GUI-launched macOS apps often do not inherit Homebrew's PATH, so discover and then persist the validated absolute `prime-agent` path. Check common Apple Silicon and Intel Homebrew paths or let the user choose it; validate with `--version`.

The package exports the SDK from the actual package name `prime-agent`. Some installed SDK/extension documentation still uses the inherited name `@earendil-works/pi-coding-agent`; there is also a separate global package of that name. A new app should depend on/import **`prime-agent` at a pinned version**, not silently bind to the unrelated global inherited package.

## CLI surfaces

### Top-level run options

```text
prime-agent [options] [@files...] [message...]
prime-agent <command> [args...]
```

Important groups from `prime-agent --help`:

- Modes: default TUI, `-p/--print`, `--mode text|json|rpc|acp|daemon`
- Execution: `--cwd`, `--offline`, `--verbose`, `--daemon-socket`
- Model: `--provider`, `--model`, `--api-key`, `--models`, `--thinking`
- Session: `--continue`, `--resume <path|id>`, `--fork <path|id>`, `--session-dir`, `--no-session`, `--goal`, `--goal-token-budget`
- Capability controls: `--tools`, `--no-tools`, `--no-builtin-tools`, repeatable `--extension`, `--skill`, `--prompt-template`, `--theme`, plus discovery-disable flags
- Prompt: `--system-prompt`, repeatable `--append-system-prompt`, `--`
- Autonomous: gate commands, retries/timeouts, continuation/turn/token/wall-clock limits

`--offline` disables startup network operations such as update/package checks; it does **not** make provider inference offline.

The only default model-facing built-in tool is `ipython`. Shell execution is still available through Python/subprocess or IPython shell cells, and RPC/interactive mode also exposes user-initiated bash surfaces.

### Management commands

| Command | Purpose / relevant flags |
|---|---|
| `agents` | Interactive session/agent search view |
| `list [--all] [--json]` | Live agents; `--all` includes saved sessions |
| `attach <agent>` | Attach TUI to a resident agent |
| `stop <agent> [--json]` | Stop one agent |
| `rename <agent> <name> [--json]` | Rename an agent |
| `send [--from <agent>] [--steer|--follow-up] <agent> <message> [--json]` | Cross-agent message |
| `schedule list [--all] [agent] [--json]` | List scheduled prompts |
| `schedule add <agent> <schedule> -- <message>` | Add cron/one-time prompt |
| `schedule cancel <job-id>` | Cancel scheduled prompt |
| `status [--json]` | Background service status |
| `doctor [--fix] [--json]` | Diagnose; `--fix` mutates/cleans state |
| `shutdown [--force] [--json]` | Stop everything; destructive to live work |
| `package install <source> [--local]` | Install a capability package |
| `package remove <source> [--local]` | Remove it |
| `package list` | List package sources configured in settings |
| `package update [source]` | Update packages |
| `update [--force]` | Update Prime Agent |
| `model list [search]` | Models |
| `session export <file> [output]` | JSONL-to-HTML export |
| `config` | Interactive resource configuration |

Read-only local probes found no installed capability packages (`package list`), although built-in skills and user skills in `~/.agents/skills` are still discovered independently.

**Privacy warning:** `prime-agent list --all --json` is not a renderer-safe summary. In the live installation it included first prompts, complete `spawnCode`, in-flight assistant thinking blocks/signatures, tool/session paths, models, and child metadata. Parse and minimize it in the trusted backend; never forward its raw output or log it wholesale.

### Current built-in TUI commands

The compiled command registry contains:

- Settings/models: `/settings`, `/model`, `/effort` (`/thinking` alias), `/fast`, `/scoped-models`
- Sessions: `/export`, `/import`, `/share`, `/copy`, `/name` (`/rename`), `/session`, `/new` (`/clear`), `/fork`, `/clone`, `/tree`
- Context/work: `/btw` (`/side`), `/system-prompt`, `/context` (`/usage`), `/compact`, `/refine`, `/goal`, `/autonomous`, `/rlm-max-depth`
- Runtime: `/logs`, `/traces`, `/update`, `/heartbeat`, `/heartbeats`, `/reload`, `/fullscreen`, `/hotkeys`, `/changelog`, `/quit`
- Credentials/integrations: `/login`, `/logout`, `/mcp`
- Extensions, prompt templates, and skills add `/command`, `/template`, and `/skill:name` commands.

Many of these are TUI-only. RPC `get_commands` deliberately reports extension/template/skill commands, not built-in TUI commands.

## Programmatic modes

### Prime RPC: recommended subprocess contract

Start one controlled process with an absolute executable and no shell interpolation:

```text
/opt/homebrew/bin/prime-agent --mode rpc --cwd <canonical-project-path> [--resume <session-file>]
```

RPC uses strict JSONL:

- one command JSON object per LF-terminated stdin record;
- `type:"response"` records with optional correlation `id`;
- asynchronous agent events on stdout;
- diagnostics only on stderr;
- split on `\n` only (strip an optional preceding `\r`); Unicode U+2028/U+2029 are valid inside JSON strings and are **not** record separators.

Do not use a generic line reader with Unicode-line splitting. Keep an incremental UTF-8 decoder, cap line/buffer sizes, and retain unknown event fields for forward compatibility.

Current compiled `RpcCommand` types include:

- Prompt/control: `prompt`, `steer`, `follow_up`, `abort`, `new_session`
- State/models: `get_state`, `get_messages`, `get_available_models`, `set_model`, `cycle_model`, `set_thinking_level`, `cycle_thinking_level`, queue-mode setters
- Context: `compact`, `refine`, auto-compaction/retry controls
- Terminal: `bash`, `abort_bash`
- Sessions: stats, HTML export, switch, fork, clone, fork candidates, last assistant text, session name
- Coordination: peer send/status/pause/resume/clear; schedules; user heartbeats; `observe`/`unobserve` another active session
- Resources: `get_commands`

Events cover agent/turn/message/tool lifecycle, queue changes, compaction/retry, observed-session wrappers, and extension errors. Extension UI is a request/response subprotocol: `select`, `confirm`, `input`, and `editor` block for a matching response; notification/status/widget/title/editor-text messages are fire-and-forget.

Behavior important to a GUI:

- A successful `prompt` response means accepted/queued/handled, not that work succeeded. Completion and later failure arrive as events.
- While streaming, new prompts need explicit steering or follow-up behavior.
- Use `toolCallId` to correlate tool events.
- Streaming updates include a partial message plus delta metadata. Choose one rendering strategy; do not append both and duplicate text.
- `bash` returns immediately on completion and stores a `BashExecutionMessage`; that output enters model context on the **next** prompt. It does not emit a normal conversation message event.
- Normal RPC/print/JSON workers are client-owned. Clean EOF removes the live worker but a persisted transcript remains. Adding a schedule/heartbeat can promote the session to resident so it survives RPC stdin closing.
- Multiple concurrently active tabs should use separate processes/connections or attach through the daemon-backed connection layer.

The package also exports a typed `RpcClient` with prompt, event, state, model, compaction/refine, bash, session, schedules/heartbeat, observation, and command helpers. In a Node backend this is preferable to re-declaring every current RPC union, provided the app pins the package version.

### ACP: standards-based but narrower

`prime-agent --mode acp` speaks newline-delimited JSON-RPC 2.0. It supports `initialize`, `session/new`, `session/prompt`, `session/cancel`, and `session/close`, plus streamed ACP updates. Prime-specific information (subagents, goals, gates, continual harness, compaction, rich IPython results) is placed in the reverse-domain `_meta["ai.primeintellect.prime-agent"]` envelope so generic ACP clients can ignore it.

Limits: one session per process/connection, no concurrent turn, cwd fixed at process startup. Use this for interoperability with an ACP-capable editor/client, not for the most feature-complete Prime desktop UI.

### JSON and print modes

- `--mode json <prompt>`: one-shot JSON event stream; first record is a session header, followed by agent events.
- `-p/--print`: one-shot text output and exit; piped stdin is folded into the prompt.

These are suitable for jobs/importers, not a long-lived chat controller.

### SDK and `AgentConnection`

`prime-agent` exports:

- `createAgentSession`, `createAgentSessionRuntime`, `AgentSessionRuntime`
- `SessionManager`, `SettingsManager`, `AuthStorage`, `ModelRegistry`, `DefaultResourceLoader`
- `RpcClient`
- `AgentConnection`, `DaemonAgentConnection`, `InProcessAgentConnection`, `DaemonClient`
- tool/extension/skill types and factories, including IPython/bash/edit definitions
- `InteractiveMode`, `runPrintMode`, and `runRpcMode`

`AgentConnection` is the richest UI-facing abstraction. Its local daemon implementation exposes coherent initial/replacement snapshots; streaming/resync events; messages; current state; saved sessions; session tree/context/stats; resources; tools; queues; cron/heartbeat; RLM child snapshots/cancellation; prompt/steer/follow-up/abort; user bash streaming; models; compaction/refinement; session replace/fork/navigation/import/export/rename/delete; and extension UI responses.

This is the best match for a polished full Prime UI, but isolate it behind an app-owned adapter. The installed declarations explicitly say that reused `AgentMessage`/`AgentEvent` types and local filesystem shapes are not a final hosted/network contract. Pin Prime Agent, feature-detect, and translate to stable desktop DTOs.

Do not import the globally installed package by a hardcoded file URL in production. Add a pinned app dependency or run the validated user CLI as a subprocess. For Tauri/Swift, a Node sidecar using RPC/ACP is simpler and safer than embedding this Node/ZeroMQ SDK directly.

### Raw daemon protocol: do not make it the app contract

The daemon uses a local Unix socket on this Mac at a per-user temp path like:

```text
$TMPDIR/prime-agent-<uid>/daemon.sock
```

The directory is forced to `0700` and the socket to `0600`. Supervisor/worker traffic uses a separate authenticated private binary framing. Worker descriptor files contain bearer-like authentication tokens and are `0600`.

A live `status --json` reported package `0.7.0`, daemon protocol **7**, schema revision **13**, schema id `protocol-7-schema-13-816309b1cd50`. The installed `docs/daemon.md` still says “protocol v4.” This concrete mismatch is a strong reason not to hand-code the socket protocol. Use `DaemonClient`/`DaemonAgentConnection` from the exact same pinned package if daemon attachment is required.

The daemon provides useful guarantees that a desktop app should preserve through the high-level adapter: stable client/command IDs, idempotent mutations, generation-aware event cursors, reconnect/replay, coherent snapshot fallback, backpressure, and session leases. Do not bypass them by editing files.

## Process model and persistence

Normal interactive roots run as resident daemon workers. Closing the TUI detaches; it does not stop the root. Each root worker owns its runtime, session, scheduler, persistent kernel, and RLM descendants. One-shot/RPC/ACP-style clients normally get client-owned workers. Workers/kernels are separate processes for lifecycle and crash containment only.

Observed global layout:

```text
~/.prime/agent/
  auth.json                         # credentials; 0600 in this install
  settings.json                     # global settings
  sessions/<root-session-id>.jsonl
  session-artifacts/<root-session-id>/
    kernel-state.dill
    kernel-state.json
    scheduled-jobs.json             # only when used
    harness/harness_state.json       # only when local harness used
    sub-xxxxxxxx/<child-id>.jsonl
    session-artifacts/<child-id>/... # child kernel artifacts
  session-leases/<sha256>.lock/owner.json
  daemon-workers/<supervisor>/<worker>.json
  daemon-workers/.../*.recovery.jsonl
  logs/*.log and agent.jsonl
  kernel-venv/
```

Files appear only when their feature is used. The current installation also has daemon command/recovery journals and snapshot caches.

Never deserialize `kernel-state.dill` in the desktop app; pickle/dill loading can execute code. Let Prime Agent own kernel revival. Never read `auth.json` in the renderer. Never copy worker authentication tokens out of descriptors.

### Projects

There is no separate project database. A project is primarily a canonical `cwd`:

- each session header records `cwd`;
- session pickers/listing filter/group by that cwd;
- current releases keep all default sessions in the **flat** global `~/.prime/agent/sessions` directory;
- old per-project layouts are migrated on load;
- `SessionManager.list(cwd)` filters current-project sessions; `listAll()` returns all.

Project-specific resources/settings live under `<project>/.prime/agent/`. `.agents/skills` is also discovered in the cwd and ancestors (up to the git root, or filesystem root when outside a repo). Context files such as `AGENTS.md` are walked from cwd. Global equivalents live under `~/.prime/agent` and `~/.agents/skills`.

Settings merge global `~/.prime/agent/settings.json` with project `.prime/agent/settings.json`; nested objects merge and project values win. Session-directory precedence is:

1. `--session-dir`
2. `PRIME_AGENT_SESSION_DIR`
3. legacy `PRIME_AGENT_CODING_AGENT_SESSION_DIR`
4. `sessionDir` in settings
5. default global sessions directory

Changing `PRIME_AGENT_CODING_AGENT_DIR` isolates the entire agent data/config root. That is useful for an explicit “isolated app profile,” but it will no longer automatically share the user's normal credentials, settings, packages, skills, and sessions. Default to the user's existing Prime profile for a GUI “for Prime Agent”; make isolation an informed option.

### Session file format

Sessions are append-only JSON Lines. Every line is a JSON object.

1. First record: a versioned `session` header, currently version 3, with UUID-like session `id`, ISO timestamp, `cwd`, and optional `parentSession`, `rlmDepth`, and git metadata.
2. Later records: `id` (currently eight hex characters), `parentId`, ISO outer `timestamp`, and a `type` payload.
3. `parentId` forms a tree, not a simple linear transcript. The current leaf selects the active branch.

Current documented/compiled entry kinds include:

| Type | Meaning |
|---|---|
| `message` | User, assistant, tool result, bash, custom, branch-summary, or compaction-summary message |
| `model_change`, `thinking_level_change`, `service_tier_change` | Runtime selection history |
| `compaction`, `branch_summary` | Context summaries and branch changes |
| `custom` | Extension/harness bookkeeping not included in LLM context |
| `custom_message` | Extension or agent message that participates in context |
| `child_usage_attributed` | Child usage/cost folded into a parent assistant entry |
| `label`, `session_info` | Bookmark/name metadata |
| `session_state`, `agent_status`, `git_state` | Daemon/status/recovery metadata |

Message content is a tagged block array: `text`, `image` (base64), `thinking` (possibly with opaque provider signatures), and `toolCall` with ID/name/arguments. Assistant records include provider/model/API, token/cost usage, stop reason, response ID, and millisecond inner timestamp. Tool results can contain stdout/stderr, file paths, diffs, full-output paths, images, and arbitrary tool-specific `details`.

Treat a transcript as highly sensitive: prompts, source code, shell output, absolute paths, images, model reasoning/signatures, credentials accidentally printed by tools, and extension data can all be present. The observed default session files were mode `0644` under the user's home directory, so the app should not assume transcript content is cryptographically protected just because daemon tokens are `0600`.

**Read/write rule:**

- For live display, use RPC/AgentConnection snapshots and events.
- For offline import/export, use `SessionManager` or `prime-agent session export` rather than a homemade parser when possible.
- A read-only indexer may parse header/metadata with version checks and tolerate a trailing incomplete line, but it must not write.
- Never append, branch, rename, delete, or compact JSONL directly. Use session APIs/CLI so leases, active ownership, tree pointers, artifacts, and recovery journals remain coherent.
- Deleting a transcript does not automatically mean every artifact or retained child file has disappeared; use Prime's session actions and make deletion behavior explicit.

## Capability packages, extensions, skills, and MCP

Prime calls the plugin-equivalent unit a **capability package**. A package can bundle extensions, skills, prompt templates, and themes. Sources can be npm, git/URL, or local paths. Global install/remove edits `~/.prime/agent/settings.json`; `--local` edits project `.prime/agent/settings.json`. Git packages clone below the relevant `git/` directory; project npm packages go below `.prime/agent/npm/`.

Packages and their resources run with full user access. Installation/update must be an explicit, confirmed backend action that displays source and scope. Do not auto-install a package merely because a repository settings file mentions it without surfacing the trust boundary.

### Extensions

Extensions are TypeScript/JavaScript loaded via `jiti` from:

```text
~/.prime/agent/extensions/*.ts
~/.prime/agent/extensions/*/index.ts
<project>/.prime/agent/extensions/*.ts
<project>/.prime/agent/extensions/*/index.ts
```

They can also come from settings, CLI `--extension`, or packages. Important APIs:

- lifecycle/resource/session/agent/model/tool/input/bash/provider event hooks;
- `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, custom renderers;
- block or mutate tool calls; mutate results/context/provider payloads;
- serializable UI (`select`, `confirm`, `input`, `editor`, notification/status/widget/title) and full TUI-only custom components;
- `appendEntry` for branch-aware persistence; session names/labels;
- `sendMessage`, `sendUserMessage`; model/thinking/tool selection;
- `exec`; provider registration; shared extension event bus; resource discovery.

Extensions are the correct place to add a controlled browser tool, permission policy, custom desktop command, or project integration. They are trusted code. In RPC mode, implement the extension UI subprotocol so security confirmations do not silently degrade. In print/JSON modes, `ctx.hasUI` is false.

### Skills

Prime implements the Agent Skills `SKILL.md` format plus Python-backed skills. Discovery includes:

- `~/.prime/agent/skills`, `~/.agents/skills`
- project `.prime/agent/skills` and ancestor `.agents/skills`
- package/settings paths, explicit `--skill`, and bundled lowest-precedence skills

A Python-backed skill has `SKILL.md`, `pyproject.toml`, and `src/<import_name>/__init__.py`. It is installed editable into the managed kernel venv and preloaded/importable in the persistent IPython namespace. A module with `run()` becomes an awaitable callable; an optional console script can expose the same function to shell mode. New/changed Python skills normally require a fresh session/kernel setup.

Bundled files in this installation include `agent-message`, `agent-observe`, `attach-image`, `compact`, `edit`, `goal`, `linear`, `notion`, `prime-intellect`, `refine`, `rlm-heartbeat`, `skill-creator`, and `websearch` (some integrations are credential-gated). User skills include `agent-browser` among others.

A GUI can discover active skills/resources through `AgentConnection.getResourceSnapshot()` or RPC `get_commands`; this is safer than recursively scraping all directories and guessing precedence/collisions.

### MCP

Prime MCP integrations are Python-backed skills rather than separate model tools. Built-in Linear/Notion are enabled by login; credentials live under `mcp:<name>` in `auth.json`. Custom MCP definitions live in global/project settings. The current integration layer supports remote HTTP MCP endpoints; stdio servers are not wired through this Python skill host path.

OAuth/login should remain a backend/TUI-owned flow. Never expose bearer tokens or `auth.json` to the web renderer. A custom endpoint must not receive a credential originally minted for a different endpoint.

## Continual harness and RLM APIs

The RLM host gives each session a persistent IPython kernel. The Python `rlm` object is a thin typed bridge; the TypeScript session owns child execution, credentials, persistence, usage, and lifecycle.

### Recursive agents

Kernel API:

```python
handle = await rlm("sub-task", name="optional-readable-name", model="provider/model")
models = await rlm.find_models("query")
children = await rlm.list_subagents()
await rlm.delete_subagent(selector)
```

The spawn result confirms **admission only** (`rlm_child_id`, name, session directory, model); it never contains the answer. Children reply via `agent_message` or files. Default max depth is 1. Child transcripts/artifacts live below the parent artifact directory. Usage is asynchronously attributed into `child_usage_attributed` entries.

`agent_message` is family-scoped (parent, sibling, direct child) and daemon-derived sender identity prevents spoofing. `agent_observe` gives read-only, bounded family status/message previews. The desktop's global agent list/attach is a separate supervisor surface; do not pretend kernel family APIs are global discovery.

### Continual harness store

The harness is a persisted ledger, not a second execution engine.

- Local: `<session-artifact>/harness/harness_state.json`
- Explicit global: `~/.prime/agent/harness/harness_state.json`
- Current JSON schema: `schema: 1`
- Entry kinds: `prompt`, `memory`, `skill`, `subagent`; plus `refinements`

Each entry carries ID, kind, title, content, path, local/global scope, reference, argument contract, metadata, source, created/updated timestamps, and version. Skill entries require a Python reference (`type:"python"`, an import name, and callable/call pattern).

Current Python CRUD includes generic `create/update/upsert/get/list/delete` and convenience methods:

```text
create/update/delete_memory
create/update/delete_prompt_note
create/update/delete_skill
create/update/delete_subagent
record_refinement, plan_refinement, overview, snapshot
```

Use `global_=True` for explicit cross-session writes. The store reloads if an external host-side `/refine` changed it, reducing stale overwrite risk.

**Desktop policy:**

- Use `AgentConnection.refine(...)` or RPC `refine` / `/refine` for writes and rollback. Surface a second confirmation for `global:true`.
- Render `refine_complete` / `refine_failed` events and returned before/after changes.
- Do not build a generic JSON editor over `harness_state.json`.
- If a read-only harness browser is required before a formal host API exists, parse only in the trusted backend, require `schema===1`, sanitize content, and disable editing on unknown schema. Prefer an app-owned, versioned extension/adapter endpoint over direct file coupling.
- Do not confuse a continual harness skill entry (a reusable description/reference) with an installed Python-backed skill package (actual executable code on disk).

The base system prompt is immutable; refinements are supplemental.

## Terminal opportunity

There are three distinct terminal concepts and the GUI should label them clearly:

1. **Agent IPython cells**: model-generated Python and shell magics, persistent namespace, tool events in transcript.
2. **Prime user bash**: interactive `!`/`!!`, RPC `bash`, or `AgentConnection.executeBash`; can be recorded into the next model context or transient depending on the high-level API.
3. **A human PTY panel**: an app-owned shell such as zsh. It is not automatically part of the Prime session.

Recommended implementation:

- Put a PTY in the trusted backend (for Electron, `node-pty` or equivalent) and stream a narrow terminal DTO to the renderer.
- Start it in the canonical project cwd with a deliberate environment; never send terminal input through `sh -c` constructed strings.
- Keep human terminal history separate. Offer an explicit “send selected output to chat” action with truncation/redaction instead of silently injecting all terminal output.
- For a command meant to become Prime context, call RPC `bash`/`AgentConnection.executeBash`, show the exact command, cwd, recording/transient choice, and completion status.
- Require confirmation for destructive/elevated commands; an extension `tool_call`/`user_bash` gate can enforce the same policy for model-generated work.
- Bound output and use the returned `fullOutputPath` only from the backend after canonical-path validation.

## Browser opportunity

Prime Agent has no default browser tool in the provider tool list, but this machine has both:

- an auto-discovered user `agent-browser` skill; and
- `/opt/homebrew/bin/agent-browser` 0.26.0, a JSON-capable browser automation CLI with sessions, accessibility snapshots/refs, screenshots, network/storage, CDP, tabs, and headed mode.

This means browser automation can already be invoked by the model through IPython/shell when the skill is selected. It is not a stable desktop browser API by itself.

Recommended browser integration:

- For user browsing, embed an isolated app browser/webview with navigation controls and a separate profile/partition.
- For agent automation, wrap `agent-browser` in a trusted Prime extension or backend service that returns structured, bounded JSON and screenshots. Use a per-Prime-session browser session/profile and an explicit domain/action permission policy.
- Observe-act-verify: snapshot, execute one structured action, snapshot again. Show agent actions in the UI.
- Require confirmation for login, uploads/downloads, purchases, messages/posts, permissions, credential entry, or cross-origin sensitive actions.
- Never connect agent automation to the user's real Chrome/default profile by default. CDP access effectively grants the process the user's authenticated browser state and CDP endpoints usually have no application-level authorization. Use loopback-only ephemeral debugging with an isolated user-data directory if CDP is needed.
- Treat `~/.agent-browser` state, cookies, downloads, screenshots, and HAR files as sensitive. Do not forward them wholesale to the renderer or telemetry.
- Keep normal page content untrusted: it must not be allowed to invoke privileged desktop IPC or rewrite agent policy.

## Concrete desktop adapter design

A useful backend-owned interface is:

```text
PrimeService
  discoverInstallation() -> { executable, version, sdkVersion?, capabilities }
  listSessions(scope) -> SanitizedSessionSummary[]
  open({cwd, sessionId?}) -> connectionId
  attach(activeSessionId) -> connectionId
  prompt/steer/followUp/abort(connectionId, ...)
  getSnapshot(connectionId) -> DesktopSessionSnapshot
  subscribe(connectionId) -> typed, sequenced events
  models/resources/stats/tree/queue/schedules/heartbeats(...)
  bash(...), browserAction(...)
  refine(...)
  close(connectionId)
```

Renderer DTOs should use opaque IDs and ISO strings, not local daemon socket paths, auth tokens, raw `Date` objects, arbitrary extension callbacks, or host filesystem objects. Sanitize session listing to fields actually displayed: IDs, name, canonical project label, lifecycle/activity, timestamps, message count, RLM depth/parent, and a deliberately truncated first-message preview.

### Startup and compatibility sequence

1. Discover absolute executable; run `--version` with a short timeout.
2. Probe `status --json` and `list --json` only in the backend. Do not assume a daemon already exists.
3. Compare supported version range. If using SDK/AgentConnection, require matching pinned package version and inspect daemon hello/capabilities through the library.
4. Start a new RPC/ACP process with `spawn(executable, argv, { shell:false, cwd, env, stdio:"pipe" })`, or attach via pinned `DaemonAgentConnection`.
5. Wait for initial state/snapshot before enabling input.
6. Maintain a connection state machine: starting, connected, working, reconnecting/resynced, closed/error. On generation change, replace from snapshot instead of comparing bare sequence values.
7. On app close, distinguish detach from stop. Never call global `shutdown`; prompt before stopping a working resident root. For client-owned RPC, close stdin, wait, then bounded TERM/KILL of the process group.

### Renderer/security boundary

For Electron or any web-rendered desktop shell:

- `nodeIntegration:false`, `contextIsolation:true`, sandbox renderer, strict CSP;
- expose a small validated preload API; no generic “run command,” filesystem, socket, or environment IPC;
- validate every IPC payload, session ownership, cwd, path, URL, and response ID in the main process;
- use argv arrays with `shell:false`; canonicalize cwd and prevent unexpected path escape where the action should be project-scoped;
- keep credentials and provider refresh in Prime's backend/AuthStorage;
- never pass `--api-key` (visible in process arguments and easy to log);
- keep stdout protocol and stderr diagnostics separate; redact secrets and provider thinking signatures from app logs;
- rate/size-limit prompts, images, RPC records, terminal output, screenshots, extension UI, and session previews;
- treat extension UI confirmations as security prompts with timeout/cancellation; fail closed on malformed/unknown requests;
- do not trust extensions or project `.prime/agent` merely because they are local files. Show discovered resource provenance and allow a safe mode (`--no-extensions --no-skills --no-prompt-templates --no-context-files`, then explicit allowlisting).

## Suggested implementation order

1. **MVP:** RPC subprocess; project cwd selection; persisted sessions; streaming chat/tool cards; prompt queue; abort; models/thinking; sanitized `list --all --json` indexing; strict backend/renderer IPC.
2. **Continuity:** session switch/new/fork/clone/name/export, stats/context, reconnect/error UI, client-owned cleanup.
3. **Prime-specific:** schedules/heartbeats, observation, RLM child cards, refinement results, extension UI protocol, resource provenance.
4. **Terminal/browser:** backend PTY and isolated browser automation with approval gates.
5. **Full resident multi-client support:** migrate the adapter to pinned `AgentConnection`/`DaemonAgentConnection` for attach, snapshots/replay, full tree/resources/children/queues. Retain RPC/ACP as fallback.
6. **Hardening:** untrusted-project safe mode, external sandbox option, permission policy extension, audit logging with redaction, upgrade compatibility tests.

## Key evidence paths

Installed documentation:

```text
/opt/homebrew/lib/node_modules/prime-agent/docs/architecture.md
/opt/homebrew/lib/node_modules/prime-agent/docs/agent-connection.md
/opt/homebrew/lib/node_modules/prime-agent/docs/daemon.md
/opt/homebrew/lib/node_modules/prime-agent/docs/rpc.md
/opt/homebrew/lib/node_modules/prime-agent/docs/acp.md
/opt/homebrew/lib/node_modules/prime-agent/docs/sdk.md
/opt/homebrew/lib/node_modules/prime-agent/docs/session-format.md
/opt/homebrew/lib/node_modules/prime-agent/docs/sessions.md
/opt/homebrew/lib/node_modules/prime-agent/docs/settings.md
/opt/homebrew/lib/node_modules/prime-agent/docs/extensions.md
/opt/homebrew/lib/node_modules/prime-agent/docs/skills.md
/opt/homebrew/lib/node_modules/prime-agent/docs/packages.md
/opt/homebrew/lib/node_modules/prime-agent/docs/rlm-runtime.md
/opt/homebrew/lib/node_modules/prime-agent/docs/mcp-integrations.md
```

Compiled declarations/code used to resolve doc drift:

```text
/opt/homebrew/lib/node_modules/prime-agent/dist/index.d.ts
/opt/homebrew/lib/node_modules/prime-agent/dist/modes/rpc/rpc-types.d.ts
/opt/homebrew/lib/node_modules/prime-agent/dist/modes/rpc/rpc-client.d.ts
/opt/homebrew/lib/node_modules/prime-agent/dist/modes/agent-connection/types.d.ts
/opt/homebrew/lib/node_modules/prime-agent/dist/modes/agent-connection/daemon-agent-connection.d.ts
/opt/homebrew/lib/node_modules/prime-agent/dist/modes/daemon/daemon-protocol.js
/opt/homebrew/lib/node_modules/prime-agent/dist/core/slash-commands.js
~/.prime/agent/kernel-venv/lib/python3.11/site-packages/rlm/harness.py
```

Known local documentation drift to account for in tests:

- `daemon.md` says protocol v4; compiled/runtime report v7/schema 13.
- SDK examples use the inherited package import; the audited package's actual export name is `prime-agent`.
- RPC prose omits at least the current compiled `refine` command, and a few prose signatures differ from compiled Python/TypeScript APIs.

Therefore treat CLI help + pinned compiled declarations + runtime capability negotiation as authoritative for the exact installed build, and keep Prime-version compatibility logic in one adapter module.
