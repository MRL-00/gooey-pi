# Final native package gate

## Review finding

`build.asarUnpack` unpacked every `zeromq/build/**/*.node` file, while the post-package verifier inspected only node-pty's `pty.node` and `spawn-helper`. That wildcard could place unused Linux, Windows, x64, or arm64 addons outside the integrity-protected ASAR without either an exact-path gate or architecture validation. The security documentation also described only the two node-pty files.

## Required ZeroMQ runtime

Prime Agent brings in `zeromq` 6.5.0. Its loader reads `zeromq/build/manifest.json` and selects candidates by OS, process architecture, and libc. For a macOS package the preferred shipped candidate is:

- arm64: `node_modules/zeromq/build/darwin/arm64/node/libc-115-Release/addon.node`
- x86_64: `node_modules/zeromq/build/darwin/x64/node/libc-115-Release/addon.node`

The corresponding installed artifacts are arm64 and x86_64 Mach-O shared libraries, respectively. Older ABI candidates and every non-Darwin build are unnecessary for the packaged Electron runtime. The builder pattern now uses `${arch}` so a single-architecture package unpacks only its matching Darwin candidate.

## Gate design

The post-package verifier now:

1. preserves the existing ASAR-required/loose-app rejection, fuse, signing, notarization-staple, and Gatekeeper checks;
2. requires the ZeroMQ JS loader and manifest inside the ASAR;
3. derives a closed file allowlist from the app architecture: node-pty `pty.node`, node-pty `spawn-helper`, and the matching ZeroMQ addon;
4. recursively enumerates `app.asar.unpacked` and rejects missing files, extra files under any prefix, and non-file entries such as symlinks;
5. runs `lipo -archs` for every allowed unpacked native executable/addon and requires coverage of every architecture reported by the app executable.

This deliberately fails closed for an architecture that has no explicit ZeroMQ path mapping. A future universal package will also need genuinely universal native artifacts (or a separately reviewed layout/gate change); two thin addons do not satisfy the rule that each unpacked native binary covers the app.

## Regression tests

Filesystem fixtures cover the exact valid arm64 tree, missing-file rejection, arbitrary extra-prefix rejection, and a ZeroMQ architecture mismatch. A configuration regression test fixes the three builder patterns as an exact list. Existing helper tests continue to cover ASAR layout, fuse-adjacent release helpers, signature Team IDs, credentials, and general architecture coverage.

## Local validation

- `npm test -- --run tests/release-scripts.test.ts` — 18 tests passed.
- `npm run check` — lint and release-script formatting passed.
- `npm run typecheck` — main/preload and renderer TypeScript passed.
- `npm run build:bundle` plus an unsigned arm64 `electron-builder --mac dir` package — passed; the resulting unpacked tree contained exactly the three expected files.
- `node scripts/release/verify-package.mjs --mode qa` against that arm64 package — passed, including ASAR layout, all three Mach-O architecture checks, and Electron fuses.


## CFR-09 size budgets

The release pipeline now runs `release:bundle-size` immediately after `build:bundle`. It parses the generated renderer HTML rather than relying on hashed filenames, measures the module entry and every `modulepreload` once, recursively measures all renderer JS/CSS, and fails closed on missing, escaping, remote, query-bearing, or symlinked build assets. Exact binary-byte budgets are:

| Output | Validated size | Budget |
|---|---:|---:|
| Main bundle | 184,354 bytes | 256 KiB |
| Preload bundle | 4,874 bytes | 16 KiB |
| Initial renderer entry + modulepreloads | 722,023 bytes | 1,280 KiB |
| Largest renderer JS/CSS chunk | 554,693 bytes | 600 KiB |
| Total renderer JS/CSS | 1,766,107 bytes | 2 MiB |
| `app.asar` | about 191.02 MiB | 220 MiB |
| Application bundle regular-file bytes | Electron + ASAR/native payload | 480 MiB |
| DMG | about 146.09 MiB | 170 MiB |
| ZIP | about 140.69 MiB | 165 MiB |

The application-bundle metric recursively sums regular-file sizes without following macOS bundle symlinks, avoiding both symlink double-counting and filesystem-allocation variance. The ASAR, app, DMG, and ZIP caps run inside `verify-package` for both QA and public modes. Exactly one DMG and one ZIP are required; signing, notarization, stapling, Gatekeeper, ASAR, fuse, and native architecture checks are unchanged.

Deterministic sparse-file fixtures verify bundle HTML reference measurement, renderer totals, package directory measurement, exact-boundary acceptance, and one-byte-over rejection for every budget. Post-change validation passed the 18 focused release tests, `npm run check`, `npm run typecheck`, `npm run build`, and `npm run release:bundle-size`. Electron and packaging were not run for this CFR-09 follow-up as requested.
