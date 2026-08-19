# Safety-critical coverage gate

GooeyPi's coverage denominator is a filesystem inventory, not a hand-maintained list of selected modules. [`coverage-inventory.ts`](../scripts/release/coverage-inventory.ts) recursively enrolls runtime files from these first-party families:

| Family | Current responsibility |
|---|---|
| `electron/main` | IPC, loopback capability brokers, collaboration, schedules, project/store authority, package and MCP execution, process composition, and other main-process services |
| `electron/preload` | The isolated renderer capability bridge |
| `src/app` | Renderer state admission, reconciliation, scoping, and request routing |
| `src/lib` | Shared validation, event reduction, command policy, and bounded rendering logic |
| `src/hooks` | Renderer capability orchestration and live authority state |
| `scripts/release` | Toolchain, dependency, packaging, artifact, extension, and cross-platform release verification |
| `assets/extensions` | Every first-party extension shipped through Electron `extraResources` |

The inventory retains concrete repository-relative filenames and supplies [`vitest.config.ts`](../vitest.config.ts) with one glob-escaped exact include pattern per file. The config derives and fixes the project root from its own `import.meta.url`, so an explicit `--config` invocation has the same inventory and test resolution even when launched from another working directory. A new runtime file below any family root therefore enters the denominator on its first coverage run. Family roots are `lstat`-verified as real, non-symbolic-link directories before traversal; symbolic links below them, overlapping families, missing roots, and malformed inventory entries likewise fail configuration instead of silently removing code from measurement.

Technical exclusions can name only one exact discovered file. Each entry must include a substantive reason and at least one compensating verification; duplicate, undocumented, and stale entries fail the structural test. Directory and glob exclusions are not representable. There are currently **no technical exclusions**.

[`coverage-inventory.test.ts`](../tests/coverage-inventory.test.ts) locks the family roots, required safety modules, shipped extension set, unchanged global thresholds, per-family threshold declarations, automatic new-file enrollment, and exclusion validation. It also launches the explicit config from a foreign working directory and runs a real nested coverage fixture proving that the unexecuted, inventoried files `@(authority).ts`, `{authority,other}.ts`, and `authority[.].ts` all appear in `coverage-summary.json`.

## Per-family thresholds

Global thresholds remain 65% statements, 50% branches, 70% functions, and 75% lines. Because the inventoried denominator is much larger than the previous allowlist, the global gate alone cannot protect individual authority-bearing families, so each family additionally declares its own floors in `coverage-inventory.ts`. The floors are set from measured values on the base commit minus a small margin, and are expected to ratchet upward as characterization tests land family by family.

| Family | Files | Measured st/br/fn/ln (%) | Floor st/br/fn/ln (%) |
|---|---:|---|---|
| `electron/main` | 67 | 79.64 / 73.45 / 78.89 / 85.42 | 77 / 71 / 76 / 83 |
| `electron/preload` | 1 | 16.24 / 12.50 / 11.54 / 14.55 | 14 / 10 / 9 / 12 |
| `src/app` | 6 | 94.15 / 90.20 / 95.35 / 96.69 | 92 / 88 / 93 / 94 |
| `src/lib` | 29 | 92.91 / 87.09 / 94.15 / 94.70 | 90 / 85 / 92 / 92 |
| `src/hooks` | 17 | 58.56 / 48.89 / 61.84 / 66.00 | 56 / 46 / 59 / 64 |
| `scripts/release` | 17 | 65.88 / 60.71 / 81.52 / 68.89 | 63 / 58 / 79 / 66 |
| `assets/extensions` | 6 | 61.52 / 47.87 / 57.02 / 65.20 | 59 / 45 / 54 / 63 |

## Issue #53 impact measurement

Measured on the current base with Node 24.15.0 and npm 12.0.2 via `npm run test:coverage`, the inventory enrolls 143 modules (67 `electron/main`, 1 `electron/preload`, 6 `src/app`, 29 `src/lib`, 17 `src/hooks`, 17 `scripts/release`, 6 `assets/extensions`), against denominators of 15,531 statements, 11,297 branches, 3,044 functions, and 12,279 lines. Aggregate coverage was 75.74% statements, 70.00% branches, 74.73% functions, and 81.09% lines — above every global threshold with zero exclusions and no new characterization tests. Characterization tests are follow-up work per family, starting with `electron/preload/index.ts`.

Some release CLI entry points are deliberately exercised in bounded child-process tests, whose V8 data is not merged into the parent Vitest report. They remain in the denominator as uncovered code instead of receiving exclusions. This makes the aggregate conservative and ensures growth in those entry points consumes coverage headroom.

When changing a family, reporter, threshold, or technical exclusion, repeat the before/after denominator, artifact-size, and wall-clock measurement and place commit-addressed pass evidence in the pull request or release record as described in the [validation guide](validation.md#recording-evidence).
