# Harness discovery

GooeyPi discovers Pi-family harnesses without invoking a shell or evaluating shell startup files. This keeps startup bounded and makes detection independent of whether the user prefers bash, zsh, fish, or no interactive shell at all.

## Resolution order

Each refresh checks, in order:

1. The absolute executable override saved in Harness settings.
2. The harness-specific environment override (`PRIME_AGENT_BINARY`, `OMP_BINARY`, or `PI_BINARY`).
3. Packaged application resources, when that harness can be bundled.
4. Absolute directories in the process `PATH`/`Path` snapshot.
5. Official harness-specific installer locations.
6. Shared system and package-manager locations for npm, Bun, pnpm, mise, Volta, nvm, Homebrew, and Linuxbrew.

Candidates are deduplicated and must be executable. GooeyPi then runs a bounded `--version` probe with no shell; only an exit-zero candidate is published to the renderer. A broken override therefore falls through to later automatic candidates.

The relevant upstream install layouts are documented by [Pi](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md), [OMP](https://github.com/can1357/oh-my-pi), [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent#readme), [npm](https://docs.npmjs.com/files/folders.html), [Bun](https://bun.sh/docs/installation), [pnpm](https://pnpm.io/settings/other#globalbindir), [mise](https://mise.jdx.dev/dev-tools/shims.html), and [Volta](https://docs.volta.sh/guide/getting-started).

## Windows and WSL boundaries

OMP's native Windows installer writes `%LOCALAPPDATA%\omp\omp.exe`, which is checked explicitly so Refresh works even when the running GUI still has the old `Path` snapshot. Native `pi.exe` releases are discoverable through `Path` or an explicit override.

Pi's official Windows npm install creates a `pi.cmd` shim instead of a native executable. GooeyPi recognizes only that Pi shim, verifies the fixed `@earendil-works/pi-coding-agent/dist/cli.js` entrypoint beneath the npm prefix, finds a runnable `node.exe`, and launches the entrypoint directly without invoking a command shell. OMP does not document a Windows package-manager install, and Prime Agent documents only its macOS/Linux installer, so GooeyPi does not speculate about corresponding Windows command shims.

A Windows app also does not treat an executable inside a WSL distribution as a native Windows path. WSL execution requires an explicit transport, distribution selection, Windows/Linux cwd conversion, and Linux-owned session roots. If GooeyPi itself runs as a Linux application under WSLg, normal Linux discovery applies.
