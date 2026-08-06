# AGENTS.md

## Project

Prime Work is a macOS Electron desktop client for Prime Agent, built with strict TypeScript, React 19, electron-vite, and `node-pty`. It expects Node 22.12.0+, npm 10.9.0+, and a configured `prime-agent` executable on `PATH`.

## Code map

- `electron/main/index.ts` is the composition root and window/security setup. Other files in `electron/main/` own privileged filesystem, process, Git, PTY, browser-download, persistence, and Prime RPC work.
- `electron/preload/index.ts` exposes the frozen `window.prime` bridge. `src/types/api.ts` is the shared API/domain contract; bridge changes must update it, preload, IPC registration, service validation, and tests together.
- `src/App.tsx` orchestrates renderer state, workspaces, runtimes, and async race guards. UI lives in `src/components/` and `src/pages/`; pure renderer logic is in `src/lib/`; global styles are in `src/styles.css`.
- `tests/backend/` covers services, protocols, and security; `tests/frontend/` and `tests/unit/` cover pure renderer logic; `tests/e2e/` is the serial Electron smoke suite.
- `out/`, `release/`, `node_modules/`, coverage, and test artifacts are generated; do not edit them.

## Non-negotiable boundaries

- Treat renderer, CLI, and filesystem values as untrusted. Validate `unknown`, bound payloads, canonicalize paths, and authorize them through project/session services before side effects.
- The renderer stays sandboxed and Node-free. Keep IPC fixed and narrow; never expose `ipcRenderer`, dynamic channels, or privileged objects. Preserve exact main-frame authorization and the packaged custom-scheme CSP.
- Session JSONL under `~/.prime/agent/sessions/` is sensitive and read-only. Prime Agent is authoritative. Inferred projects are display-only until explicitly granted.
- Spawn fixed executables with argv arrays and sanitized environments; never interpolate shell commands. Preserve process/output/time/concurrency limits, Git hardening, PTY ownership, and shutdown TERM/KILL cleanup.
- Keep remote pages isolated in `persist:prime-work-browser` with no Node/preload, denied popups/permissions, and credential-free HTTP(S)-only navigation.
- Preserve `App.tsx` race defenses: workspace generations, runtime ownership/ID filtering, transcript event buffering, request IDs, single-flight submission, and serialized optimistic-setting rollback.
- Persist desktop state via `JsonStateStore.update`; do not directly rewrite Prime settings or session files. Read `docs/security.md` before changing IPC, paths, processes, browser, Git, plugins, or terminal code.
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
