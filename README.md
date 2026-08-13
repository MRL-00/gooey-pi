# GooeyPi

GooeyPi is a macOS, Linux, and Windows desktop workspace for [OMP](https://github.com/can1357/oh-my-pi) and [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent). It pairs a native-feeling three-pane interface with each harness's real RPC runtime: projects and persistent sessions on the left, the agent transcript and composer in the center, and Summary, Git Changes, Browser, or Files on the right. A real project-scoped PTY is available as a bottom drawer.

<img width="2234" height="1332" alt="CleanShot 2026-08-10 at 12 02 52" src="https://github.com/user-attachments/assets/864ff0e1-71cc-49da-955f-f226710ef890" />


## Features

- Real Prime Agent sessions discovered from `~/.prime/agent/sessions/*.jsonl`
- One isolated `prime-agent --mode rpc` child per active desktop runtime
- Streaming Markdown/GFM, reasoning, tool calls/results, abort, follow-up, resume, and session rename/archive/restore
- `@session` references plus bounded read/send/wait tools so top-level sessions can coordinate by title or copied UUID
- Persisted multi-folder projects, bounded workspace file trees, and display-only projects inferred from Prime sessions
- Git status, diffs, stage/unstage, guarded restore, commit, and surfaced command failures
- Isolated in-app browser with navigation, history, annotations, and external-browser handoff
- Project-scoped `node-pty` terminal with clear, maximize/restore, resize, and clean shutdown
- Skills, extensions, prompts, packages, redacted MCP discovery, and explicit MCP endpoint/command configuration
- Bundled, toggleable `ask_user` question dialogs across Prime, OMP, and Pi
- Agent-backed schedules, activity filters, command palette, settings, light/dark/system themes
- Native keyboard navigation, responsive panel overlays, reduced motion, and accessible labels/focus states

## Requirements

- macOS (Apple Silicon or Intel), a supported Linux distribution, or Windows 10/11 x64
- Node.js 22.12.0 or newer and npm 10.9.0 or newer
- OMP, Pi, and/or Prime Agent installed on `PATH` (`omp.exe`, `pi.exe`, or `prime-agent.exe` on Windows). Custom executable paths can be set in GooeyPi's harness settings.
- A configured Prime Agent provider/login

Verify the harness before launching:

```bash
prime-agent --version
prime-agent model list
prime-agent
# Use /login in the Prime Agent CLI when authentication is required.
```

GooeyPi never stores provider API keys. Authentication remains owned by the active harness.

### Ask the user from an agent turn

GooeyPi includes `ask_user` in every installation and injects it into interactive Prime, OMP, and Pi runtimes by default. Use the **Plugins → Ask user** control to disable or re-enable it universally. GooeyPi restarts idle runtime children immediately; a busy child finishes its current turn before the new setting takes effect. Scheduled tasks never receive this UI-blocking tool.

The standalone [Prime Agent Plugins](https://github.com/am-will/prime-agent-plugins) collection remains available for direct CLI use:

```bash
prime-agent package install https://github.com/am-will/prime-agent-plugins
```

The same collection works with base Pi outside GooeyPi:

```bash
pi install https://github.com/am-will/prime-agent-plugins
```

When GooeyPi launches a runtime, an installed standalone copy automatically defers to GooeyPi's bundled copy, preventing duplicate tool registration. The tool supports one-to-five questions per call, one shared context field per question, a single `Other` choice, and grouped GUI/TUI questionnaire responses. Non-interactive modes such as print/JSON do not have a question UI.

## Develop

```bash
npm install
npm run dev
```

`node-pty` is a native dependency. If a local Python lacks the build tooling used by Electron rebuild, use a Python environment that provides it:

```bash
export npm_config_python=/path/to/python3
npm install --ignore-scripts
npx electron-builder install-app-deps
```

## Quality gates

```bash
npm run typecheck       # Node and renderer TypeScript
npm test                # 33 backend, protocol, security, shutdown, and Git tests
npm run test:e2e        # production build + Playwright Electron smoke suite
npm run build           # main, CommonJS preload, and renderer bundles
```

The twelve Electron smoke tests verify the sandboxed bridge, service-backed boot, primary pages, command palette, modal focus containment, dark mode, keyboard suggestions, extension-question round trips, optimistic setting rollback, compact overlays, resizable panes, isolated browser guest, real PTY, terminal maximize/restore, and last-window app shutdown.

## Build installable packages

Build on the target operating system so `node-pty` is rebuilt for that runtime. Each command produces artifacts in `release/<platform>/<arch>/`.

```bash
npm run package:mac
npm run package:linux
npm run package:win
```

Pass `-- --arch x64` or `-- --arch arm64` when building for a supported non-default native architecture. The default is the build machine's architecture. The macOS release path emits a signed, notarized DMG and ZIP; it needs the Apple credentials described below. Linux emits AppImage, DEB, RPM, and pacman (`.pacman`) packages. Windows emits an NSIS installer and ZIP.

For local unsigned smoke packages, use `npm run package:<platform>:local-qa` instead. macOS local QA packages deliberately do not pass Gatekeeper on another Mac.

For users, ship the conventional installer for their operating system: DMG on macOS; DEB for Debian/Ubuntu-family distributions, RPM for Fedora/RHEL/openSUSE-family distributions, pacman for Arch-family distributions, or the portable AppImage fallback on Linux; and the NSIS setup executable on Windows. The Windows package should be Authenticode-signed before public distribution; macOS remains subject to Developer ID signing and notarization.

Electron Builder uses an available signing identity automatically. Public macOS distribution additionally requires Apple notarization credentials supported by Electron Builder (Apple ID/app-specific password/team ID or App Store Connect API key). A locally signed but unnotarized build will be rejected by Gatekeeper on another Mac; this repository does not contain release credentials.

### Publish a GitHub Release

Public releases are created from semantic version tags by `.github/workflows/release.yml`. The tagged commit must be on `main`, and the tag must exactly match the versions in both `package.json` and `package-lock.json` (for example, version `0.2.0` requires tag `v0.2.0`). The workflow reruns the quality and Electron E2E gates, builds each package on its native operating system, signs and verifies macOS and Windows packages, generates `SHA256SUMS.txt`, creates GitHub build-provenance attestations, and publishes every installer together in one GitHub Release.

Configure these GitHub Actions secrets before publishing:

- macOS: `MAC_CERTIFICATE_P12_BASE64`, `MAC_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
- Windows: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`

Prepare the version change on a branch and merge it only after CI passes:

```bash
npm version 0.2.0 --no-git-tag-version
```

After that version commit is merged to `main`, create and push the annotated tag:

```bash
git switch main
git pull --ff-only
git tag -a v0.2.0 -m "GooeyPi 0.2.0"
git push origin v0.2.0
```

The tag push starts the release automatically. To retry an existing tag after correcting credentials or another external failure, run `gh workflow run release.yml -f tag=v0.2.0`. The workflow will not create or move tags, publish from an unmerged commit, or replace an existing GitHub Release.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘N` | New session |
| `⌘K` | Command palette/search |
| `⌘B` | Toggle project sidebar |
| `⌘J` | Toggle terminal |
| `⌘,` | Settings |
| `Enter` | Queue a message while Prime is working |
| `Ctrl+Enter` | Steer the current turn while Prime is working |
| `Shift+Enter` | Add a new line in the composer |
| `Esc` | Close the active palette/modal/overlay |

The Enter and Ctrl+Enter message actions can be swapped in **Settings → Prime Agent → Message shortcuts**.

## Data and security

Prime and OMP session/auth/config files remain authoritative. GooeyPi stores UI settings, project bookmarks, local archive metadata, and an owner-only collaboration-message signing key in Electron's application data directory. It does not rewrite session JSONL. The packaged renderer retains the secure internal `prime-work://` scheme for compatibility rather than using privileged `file://`. Remote pages run in a dedicated `persist:prime-work-browser` partition with Node disabled, no preload, denied permissions, denied popups, and HTTP(S)-only navigation. Renderer IPC is context-isolated, allowlisted, main-frame checked, and path validated.

Prime Agent tools, extensions, skills, packages, and terminals run with your OS user permissions. Review projects, commands, and third-party packages before running them. See [`docs/security.md`](docs/security.md) for the complete trust boundary.

## Current scope

GooeyPi targets the local agent workflow. The composer checkout picker lists linked Git worktrees for the active repository, switches the workspace to a selected checkout, and can create a new branch worktree at a user-chosen location. Cloud environment creation, voice dictation, file-picker attachments, and multi-terminal split layouts are intentionally not presented as functional controls. Schedules require a live Prime runtime. Browser annotations are kept for the current inspector session rather than written into remote pages.

## Design provenance

The interaction model was researched from publicly available ChatGPT/Codex Work documentation and screenshots, then implemented with original Prime naming, iconography, colors, and code. See [`docs/reference-sources.md`](docs/reference-sources.md).
