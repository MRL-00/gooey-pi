# Harness discovery

GooeyPi discovers Pi-family harnesses without invoking a shell or evaluating shell startup files. This keeps startup bounded and makes detection independent of whether the user prefers bash, zsh, fish, or no interactive shell at all.

## Resolution order

Each refresh checks, in order:

1. The absolute executable override saved in Harness settings.
2. The harness-specific environment override (`PRIME_AGENT_BINARY`, `OMP_BINARY`, or `PI_BINARY`).
3. Packaged application resources, when that harness can be bundled.
4. Absolute directories in the process `PATH`/`Path` snapshot.
5. Official harness-specific installer locations.
6. Shared system and package-manager locations for npm, Bun, pnpm, mise, Volta, Homebrew, and Linuxbrew. NVM version-manager directories are bounded to 64 entries and sorted by descending version.

Candidates are deduplicated and must be executable. GooeyPi then runs a bounded `--version` probe with no shell; only an exit-zero candidate is published to the renderer. A broken override therefore falls through to later automatic candidates, but its own missing, permission, spawn, exit, timeout, or output-limit reason is retained for the settings card. If no candidate works, the card reports the configured override's reason when present, otherwise the last probed candidate's reason. Probe stderr is control-character-stripped and byte-capped before it crosses IPC.

When a resolved POSIX candidate is an actual `#!/usr/bin/env node` (including
`env -S node ...`) script, GooeyPi resolves the script's real path, walks to
its owning `package.json`, and reads `engines.node` asynchronously before the
child is spawned. It probes at most 12 Node executables per resolution (with
results cached). The child environment's PATH retains its existing order:
executable directory, version-manager directories, shared directories, then
inherited PATH. Interpreter resolution instead probes the inherited PATH first,
followed by the augmented child PATH, so a PATH Node is checked before nvm and
shared directories while a Node beside the executable remains available. The
supported lower-bound forms include `>=X`, `>=X.Y`, and `>=X.Y.Z`; a trailing
upper bound such as `>=X.Y.Z <Y` is ignored. Upper bounds are deliberately
ignored because a too-new Node is a less likely failure than a too-old one, and
any actual incompatibility now surfaces as its own discovery reason. Missing or
unrecognizable engine declarations impose no constraint. Native binaries and
every non-node shebang keep their original invocation; Windows Pi shim handling
is unchanged.

The synchronous spawn-preparation path only resolves the file path and looks
up the memoized result from asynchronous resolution. Until that result is
available it leaves the invocation unchanged, so it never blocks the Electron
main thread with a synchronous subprocess probe. Harness discovery warms this
memo while its asynchronous `--version` probe runs, and the same async
preparation is performed before runtime and Pi model-probe spawns.

The relevant upstream install layouts are documented by [Pi](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md), [OMP](https://github.com/can1357/oh-my-pi), [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent#readme), [npm](https://docs.npmjs.com/files/folders.html), [Bun](https://bun.sh/docs/installation), [pnpm](https://pnpm.io/settings/other#globalbindir), [mise](https://mise.jdx.dev/dev-tools/shims.html), and [Volta](https://docs.volta.sh/guide/getting-started).

## Windows and WSL boundaries

OMP's native Windows installer writes `%LOCALAPPDATA%\omp\omp.exe`, which is checked explicitly so Refresh works even when the running GUI still has the old `Path` snapshot. Native `pi.exe` releases are discoverable through `Path` or an explicit override.

Pi's official Windows npm install creates a `pi.cmd` shim instead of a native executable. GooeyPi recognizes only that Pi shim, verifies the fixed `@earendil-works/pi-coding-agent/dist/cli.js` entrypoint beneath the npm prefix, finds a runnable `node.exe`, and launches the entrypoint directly without invoking a command shell. OMP does not document a Windows package-manager install, and Prime Agent documents only its macOS/Linux installer, so GooeyPi does not speculate about corresponding Windows command shims.

A Windows app also does not treat an executable inside a WSL distribution as a native Windows path. WSL execution requires an explicit transport, distribution selection, Windows/Linux cwd conversion, and Linux-owned session roots. If GooeyPi itself runs as a Linux application under WSLg, normal Linux discovery applies.
