# Security model

Prime Work separates remote presentation from privileged local execution.

- The React renderer has no Node integration, is sandboxed and context-isolated, and communicates through a frozen narrow preload API. Packaged assets are served by a path-contained, MIME-fixed, CSP-protected `prime-work://app/` handler, allowing Electron's extra `file://` privileges fuse to remain disabled.
- Every IPC call must come from the authorized main frame at the exact packaged renderer URL (or an explicitly validated loopback development URL). Authorization is revoked on navigation, renderer loss, close, and shutdown; outbound agent events repeat the exact URL check.
- Prime Agent runs out of process over strict-LF JSONL RPC. Credentials remain owned by Prime Agent. Commands and response-command correlations are validated. Runtimes, requests, in-flight bytes, record sizes, event counts, per-envelope bytes, and aggregate event bytes are capped.
- Quit closes IPC/process admission before taking cleanup snapshots. It then awaits RPC groups, one-shot utilities, PTYs, and captured PTY descendants through TERM/KILL escalation. Regression tests cover hostile children and background terminal jobs.
- Terminal processes are main-owned through `node-pty`; the renderer receives opaque IDs and bounded/coalesced byte streams. PTYs are project-authorized, owner-bound, count limited, and closed with their window/app.
- Persisted folders are explicit grants. Session-derived projects are display-only until the user selects them. Broad `/` and home roots are rejected; removal immediately revokes access and inferred dismissals persist.
- Project configuration and file trees cannot escape canonical project roots. Symlinks and generated trees are excluded. Git/package/MCP mutations use validated fixed executables and argv arrays, never shell interpolation; settings writes are locked and atomic.
- Remote pages use `persist:prime-work-browser` with Node/preloads disabled. Popups and permissions are denied; URLs, redirects, frames, and downloads are credential-free HTTP(S). Downloads require a gesture and preference, are limited to 512 MiB each, three concurrent, and 1 GiB/hour, and are canceled with their guest, browser reset, or app quit.
- Session JSONL is sensitive and read-only. Prime Work never rewrites transcripts; file paths, sizes, record counts, and catalog size are bounded. Model Markdown disables raw HTML and remote image loads.
- A single-instance lock and atomic/fsynced persistence prevent competing desktop processes from losing state.
- Packaged fuses disable RunAsNode, `NODE_OPTIONS`, debug CLI arguments, browser-specific snapshot loading, and extra file-protocol privileges; cookie encryption, ASAR integrity, and OnlyLoadAppFromAsar are enabled. Only `pty.node` and `spawn-helper` are unpacked. Signing entitlements retain only JIT and library-validation exceptions required by the Electron/native-module runtime; unsigned executable memory is not allowed.

Prime Agent packages, tools, terminals, and configured MCP bridges execute with the user's OS permissions. The desktop boundary protects the renderer and remote browser; it is not an OS sandbox for intentionally launched capabilities. Review projects, commands, and third-party integrations before granting access.

Public distribution still requires an external Developer ID Application identity plus Apple notarization and stapling. Local builds use `BackgroundComputerUse Local Dev` and are not represented as Gatekeeper-ready.
