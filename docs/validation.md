# Validation status

Last full local validation: 2026-08-06 on Apple Silicon macOS.

| Gate | Result |
|---|---|
| `npm run typecheck` | Pass — Node and renderer TypeScript |
| `npm test` | Pass — 33 tests across 12 backend/protocol/security suites |
| `npm run test:e2e` | Pass — 9 Electron tests |
| `npm run build` | Pass — main, CommonJS sandbox preload, renderer |
| Full `npm audit` | Pass — 0 known vulnerabilities |
| Real Prime RPC handshake/default-model discovery | Pass against Prime Agent 0.7.0 |
| RPC response correlation and failure propagation | Pass, including mismatched/negative/failed-handshake cases |
| Real PTY command/project cwd/background-descendant cleanup | Pass |
| Git status/diff/stage/unstage/restore/commit/detached HEAD | Pass in isolated repositories |
| Project file tree/removal/trust boundaries | Pass, including symlink/generated-tree exclusion and inferred dismissal |
| Package/MCP validation and settings locking | Pass |
| Streaming event reconstruction and safe Markdown | Pass |
| Browser navigation/history/isolated guest | Pass; no `ERR_ABORTED` race |
| Download policy | Pass — gesture/protocol, 512 MiB item, 3 concurrent, 1 GiB/hour bounds; guest/reset/quit cancellation |
| Responsive overlays/resizable panels/dark mode/modal focus | Pass |
| Last-window close/reopen | Pass |
| Hostile RPC child TERM/KILL shutdown and admission closure | Pass |
| Agent/PTY event bytes, aggregate bytes, rates, and IPC chunks | Pass |
| `npm run package:mac` | Pass — arm64 app, DMG, ZIP |
| `codesign --verify --deep --strict` | Pass |
| Electron fuse policy | Pass — RunAsNode/NODE_OPTIONS/inspect/file-protocol privilege disabled; ASAR integrity and OnlyLoadAppFromAsar enabled |
| Packaged custom `prime-work://` renderer | Pass — normal on-screen launch and Apple quit |
| Prime Dock/App Switcher icon | Pass — runtime PNG hash equals `assets/icon.png`; bundle uses `icon.icns` |
| Apple notarization / public Gatekeeper assessment | Not run — Developer ID/notarization credentials are not stored in the repository |

Electron 43.3.0 was published roughly one day before this validation, but the host's intentional npm three-day package-age gate does not yet admit it. Electron 43.2.0 has a zero-vulnerability audit; the newly patched API is not used here. Re-run the upgrade and complete Developer-ID notarization before public distribution.
