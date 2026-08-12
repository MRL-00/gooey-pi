# AGENTS.md

## Project

GooeyPi (product name; the codebase and many identifiers retain the earlier "Prime Work" naming) is a macOS Electron desktop client for three agent harnesses: Prime Agent, OMP (oh-my-pi), and base Pi (pi.dev). All three share the same Pi lineage and speak stdio JSONL RPC; the active harness is toggled from the sidebar Harness switcher or Settings → Harness, harnesses can be individually enabled/disabled there (at least one must stay enabled; the active harness auto-normalizes to an enabled one), and each harness has its own projects, sessions, model catalog, and runtimes. Built with strict TypeScript, React 19, electron-vite, and `node-pty`. It expects Node 22.12.0+, npm 10.9.0+, and a configured `prime-agent`, `omp`, and/or `pi` executable on `PATH`. The harness integration designs are documented in `docs/omp-integration.md` and `docs/pi-integration.md`.

## Code map

- `electron/main/index.ts` is the composition root and window/security setup: it loads the state store first, then discovers the harness executables (a saved per-harness `runtimePaths` override from settings is checked before the harness env var, bundled resources, PATH, and standard install dirs) and constructs a per-harness service set (RPC manager, session service, project view, model catalog). Other files in `electron/main/` own privileged filesystem, process, Git, PTY, browser-download, persistence, and RPC work.
- `electron/main/harness.ts` is the harness descriptor registry (executable discovery rules, agent dirs, session roots). `electron/main/agent-rpc/harness-adapter.ts` holds the per-harness RPC adapters: argv construction, handshake (OMP negotiates protocol v2 with chunked-frame reassembly), command translation (`fork`→`branch`, service tier→`set_fast_mode`), and event normalization. Everything downstream — transport, correlation, limits, event forwarding — is shared.
- `electron/main/sessions/` reads all three on-disk formats through injectable readers: Prime's flat UUIDv7 catalog, OMP's bucketed v3 tree format (256-byte mutable title slot, `id`/`parentId` branches) in `sessions/omp.ts`, and pi's cwd-bucketed v3 tree format (`--<cwd>--` dirs, titles from `session_info` entries) in `sessions/pi.ts`.
- `electron/main/providers.ts` (in-process Prime modules), `electron/main/providers-omp.ts` (`omp models --json` CLI, untrusted-output hardened), and `electron/main/providers-pi.ts` (bounded `pi --mode rpc` `get_available_models` probe) all satisfy the `ModelCatalogProvider` interface in `electron/main/model-catalog.ts`.
- `electron/main/plugins.ts` constructs the same catalog/install/MCP surface for each harness. Prime uses `prime-agent package` plus `.prime/agent/settings.json`; OMP uses `omp plugin`, native `.omp`/`.agents` discovery, `~/.omp/plugins`, and user/project `mcp.json` files. Project writes must retain the pinned-directory and atomic-replace protections in `plugins/mcp.ts`.
- `electron/preload/index.ts` exposes the frozen `window.prime` bridge. `src/types/api.ts` is the shared API/domain contract; bridge changes must update it, preload, IPC registration, service validation, and tests together. Harness routing rides the existing channels via trailing optional `HarnessId` arguments validated with a strict enum.
- `src/App.tsx` orchestrates renderer state, workspaces, runtimes, and async race guards; `settings.activeHarness` scopes all fetches, and harness switching rides the workspace-generation reset path. UI lives in `src/components/` and `src/pages/`; pure renderer logic is in `src/lib/` (`src/lib/harness.ts` maps harness ids to product/agent names); global styles are in `src/styles.css`.
- `assets/extensions/` ships the browser-capability extensions for both harnesses plus `omp-work-schedules.ts`, OMP's scheduled-task tool surface. They are self-contained by design and speak loopback-broker env contracts owned by Prime Work.
- Harness-specific surfaces: OMP and pi schedules run through the shared scoped extensions and Prime Work's local executor; Prime schedules retain the Prime Agent heartbeat tools. Provider auth remains CLI-owned for OMP and pi (`~/.omp/agent/agent.db` and `~/.pi/agent/auth.json`/`trust.json` are never touched), daemon-socket follow-up remains Prime-only, and pi has neither a service tier nor an approval mode. Pi MCP config is written to the `pi-mcp-adapter` extension's paths (`~/.pi/agent/mcp.json`, project `.pi/mcp.json`) through the hardened writer.
- `tests/backend/` covers services, protocols, and security (`omp-agent-rpc`, `omp-sessions`, `omp-ipc`, `providers-omp`, `omp-browser-extension` mirror the Prime suites; `pi-agent-rpc`, `pi-sessions`, `pi-ipc`, `providers-pi`, `pi-extension-host`, `extension-environment` mirror them for pi); `tests/frontend/` and `tests/unit/` cover pure renderer logic (`harness-switching` covers the switcher); `tests/e2e/` is the serial Electron smoke suite, including an OMP fixture catalog.
- `out/`, `release/`, `node_modules/`, coverage, and test artifacts are generated; do not edit them.

## Non-negotiable boundaries

- Treat renderer, CLI, and filesystem values as untrusted. Validate `unknown`, bound payloads, canonicalize paths, and authorize them through project/session services before side effects. `omp` CLI output (model catalog, version probes) is untrusted input.
- The renderer stays sandboxed and Node-free. Keep IPC fixed and narrow; never expose `ipcRenderer`, dynamic channels, or privileged objects. Preserve exact main-frame authorization and the packaged custom-scheme CSP. Harness arguments are validated against the strict `'prime' | 'omp' | 'pi'` enum; session paths route by each service's own canonicalizing containment, never substring checks.
- Session JSONL under `~/.prime/agent/sessions/`, `~/.omp/agent/sessions/`, and `~/.pi/agent/sessions/` is sensitive and read-only. Each harness is authoritative for its own sessions. `~/.omp/agent/agent.db` and `~/.pi/agent/auth.json`/`trust.json` (credentials/trust) are never read or written. Inferred projects are display-only until an action needs a grant; grants are harness-scoped and never authorize across harnesses.
- Prime behavior must stay byte-for-byte identical when the harness settings are untouched: the Prime RPC adapter, argv order, sanitization, and error text are parity-locked against the pre-OMP behavior.
- Spawn fixed executables with argv arrays and sanitized environments; never interpolate shell commands. Preserve process/output/time/concurrency limits, Git hardening, PTY ownership, and shutdown TERM/KILL cleanup — for both harness managers.
- Keep remote pages isolated in `persist:prime-work-browser` with no Node/preload, denied popups/permissions, and credential-free HTTP(S)-only navigation.
- Preserve `App.tsx` race defenses: workspace generations, runtime ownership/ID filtering, transcript event buffering, request IDs, single-flight submission, and serialized optimistic-setting rollback. Harness switching must keep riding the same generation-guard path, and prompts derive their harness from the workspace's own project, not global settings.
- Persist desktop state via `JsonStateStore.update` (state version 3: harness-scoped projects, `activeHarness`, `enabledHarnesses` (non-empty, deduped, strict enum), `runtimePaths` (per-harness absolute executable overrides, blank = automatic discovery), `messageEnterAction` (Enter's primary queue/steer action; the Ctrl/⌘ modifier always selects the opposite), `ompApprovalMode`, `ompDisabledProviders`/`piDisabledProviders`); do not rewrite agent settings outside the hardened plugin MCP writer, and never rewrite session files. Read `docs/security.md` before changing IPC, paths, processes, browser, Git, plugins, or terminal code, and `docs/omp-integration.md` plus `docs/pi-integration.md` before changing harness adapters, per-harness readers, or the switcher.
- Accepted naming drift (do not "fix" piecemeal): the product is GooeyPi but `Prime*`-named shared types (`PrimeModelCatalog`, `PrimeEventEnvelope`, `PrimeContextUsage`), the `window.prime` bridge, the `HARNESS_PRODUCT_NAMES` "* Work" labels, and the `PRIME_WORK_BROWSER_*` env contract remain and serve all harnesses.
- Preserve unrelated working-tree changes. Follow the existing style: 2 spaces, single quotes, no semicolons, trailing commas, and `import type` where applicable.

## Commands

```bash
npm install          # dependencies/native module setup
npm run dev          # Electron development app
npm run typecheck    # main/preload and renderer TypeScript
npm test             # Vitest suite
npm run test:e2e     # production build + Playwright Electron tests
npm run build        # typecheck + production bundles
```

Run typecheck and Vitest for every code change. Add E2E coverage for renderer/IPC/window/browser/terminal behavior and focused security tests when changing a trust boundary. No lint or formatter command is configured.
