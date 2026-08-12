# CLAUDE.md

@AGENTS.md

The file above is the authoritative project guide: multi-harness architecture (Prime Agent + OMP + Pi), code map, non-negotiable security boundaries, and commands. Keep the two files in sync by editing AGENTS.md only — this file is a pointer so both Claude Code and other agent tooling read the same instructions.

Quick orientation for a new session:

- Harness work starts at `electron/main/harness.ts` (descriptors) and `electron/main/agent-rpc/harness-adapter.ts` (protocol adapters); executable discovery honors per-harness settings overrides (`runtimePaths`) ahead of env/PATH. Design rationale and protocol mapping live in `docs/omp-integration.md` and `docs/pi-integration.md`.
- Trust-boundary rules live in `docs/security.md` — read it before touching IPC, paths, processes, browser, Git, plugins, or terminal code.
- Every change: `npm run typecheck` and `npm test`. Trust-boundary changes also need focused security tests; renderer/IPC/window behavior changes need E2E coverage in `tests/e2e/app.spec.ts`.
