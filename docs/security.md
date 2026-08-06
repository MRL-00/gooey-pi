# Security model

Prime Work separates remote content and presentation from privileged local execution.

- The React renderer has no Node integration and communicates through a narrow context-isolated preload API.
- Prime Agent runs as a child process over its documented strict-LF JSONL RPC protocol. Credentials remain owned by Prime Agent.
- Terminal processes are owned by Electron main through `node-pty`; the renderer receives opaque IDs and byte streams, not process handles.
- Browser pages use a dedicated persistent webview partition with Node disabled. Main strips any attached preload and blocks privileged schemes and unexpected new windows.
- Git and package mutations use fixed executables and argv arrays, never shell interpolation. Destructive restore and third-party package installation require an explicit UI confirmation.
- Session JSONL is treated as sensitive and read-only. Prime Work never writes directly to Prime Agent transcripts.

Prime Agent extensions, skills, shell commands, Python kernels, and packages execute with the user's OS permissions. A renderer boundary is not a sandbox for those capabilities; review projects and packages before granting access.
