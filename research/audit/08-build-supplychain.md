# Build, dependency, packaging, and release audit

**Scope:** current working tree of `/Users/am.will/Applications/prime`; dependency metadata/lockfile, npm scripts, Electron Vite, Electron Builder, ASAR/native packaging, macOS entitlements/signing posture, CSP/assets/source maps, update posture, tests, and generated package evidence.  
**Method:** read-only source/lock/test inspection plus `npm audit --json`, `npm test`, `npm run build`, `npm run test:e2e`, ASAR listing/extraction, bundle-size measurement, `electron-fuses read`, `codesign`, and `spctl`. No production source was changed.  
**Result:** 1 High, 4 Medium, 2 Low findings. The build and all tests passed, and npm's audit database reported no known vulnerability for the current lockfile. No CVE claim is made in this report.

## Executive summary

The repository has unusually good Electron package hardening for an early desktop app: a lockfile with registry integrity hashes, a sandboxed renderer, a strict packaged CSP, minimal native ASAR unpacking, and restrictive Electron fuses. The principal release blocker is outside those mechanics: the documented packaging command can produce a locally signed but unnotarized artifact, and the artifact present during the audit was rejected by Gatekeeper. There is also no update client, so a distributed vulnerable version has no in-app patch path.

Performance-wise, the renderer is one eager 1.56 MB JavaScript chunk, and renderer-only libraries are additionally copied into ASAR as production `node_modules`. The latter adds at least 30.75 MB of duplicate direct dependency files to every install. Electron locale packs add another 46.4 MiB installed despite the UI currently being English-only.

## Findings

| ID | Severity | Finding |
|---|---|---|
| BSP-01 | **High — release blocker** | Public macOS artifacts are not required to be Developer-ID signed/notarized or Gatekeeper-accepted |
| BSP-02 | **Medium** | There is no application update/patch-delivery path |
| BSP-03 | **Medium** | The packaging entry point bypasses tests and has no packaged-artifact release gates |
| BSP-04 | **Medium** | Renderer-only dependencies are duplicated into ASAR as runtime modules |
| BSP-05 | **Medium** | All renderer features are eagerly shipped in one 1.56 MB startup chunk |
| BSP-06 | **Low** | Documented/specified Node support contradicts the locked Electron toolchain |
| BSP-07 | **Low** | All Electron locale packs are shipped without an explicit supported-language policy |

---

### BSP-01 — Public macOS artifacts are not required to be Developer-ID signed/notarized or Gatekeeper-accepted

**Severity:** **High — release blocker**

**Exact evidence**

- `package.json:18` defines the distributable command as only `npm run build && electron-builder --mac`.
- `package.json:59-73` defines DMG/ZIP targets, entitlements, output, and `afterPack`, but no repository-controlled notarization or post-build Gatekeeper/stapling verification.
- `README.md:64-72` tells maintainers to use that command and explicitly states that a local unnotarized build will be rejected on another Mac.
- `docs/validation.md:19-24` records packaging and local `codesign` as passing but leaves Apple notarization/public Gatekeeper assessment unrun.
- The checked artifact corroborated the source posture: `codesign -dv` reported the local `BackgroundComputerUse Local Dev` authority and no Team ID; `spctl -a -vv -t exec release/mac-arm64/Prime\ Work.app` exited 3 with `rejected`. The prior package verification records the same result at `research/package-verification.md:169-179`.

**Impact**

A DMG/ZIP built by the documented command can look release-ready and have an internally valid signature while macOS rejects it for public execution. Training users to bypass Gatekeeper destroys the trust boundary that later protects signed updates. A locally selected signing identity also makes the result dependent on the build host rather than a controlled release identity.

**Realistic trigger/failure scenario**

A maintainer tags `0.1.0`, runs the documented `npm run package:mac`, and uploads the generated DMG. It works on the build machine, but a user downloading it on another Mac sees Gatekeeper rejection because the selected local identity is not `Developer ID Application` and no notarization ticket is stapled.

**Concrete remediation**

1. Create a release-only CI job from a clean checkout and `npm ci`, with Apple signing/notary credentials held only in CI secrets (never in the repository).
2. Require Electron Builder to use the intended `Developer ID Application` identity and activate its notarization integration with App Store Connect API credentials (or the supported keychain profile flow).
3. Fail the job unless `codesign --verify --deep --strict`, the expected Team ID/authority check, `xcrun stapler validate` (app and DMG as applicable), and `spctl --assess --type execute` all pass.
4. Publish only artifacts produced by that job; keep local packages explicitly labeled QA-only.

---

### BSP-02 — There is no application update/patch-delivery path

**Severity:** **Medium**

**Exact evidence**

- The complete runtime dependency list at `package.json:21-30` contains neither `electron-updater` nor another updater client.
- The complete development/tool list at `package.json:31-43` also contains no update integration.
- `electron/main/index.ts:1` imports Electron lifecycle APIs but not `autoUpdater`; application bootstrap and ready handling at `electron/main/index.ts:156-221` never check for updates.
- Repository-wide search found no `autoUpdater`, `electron-updater`, `checkForUpdates`, or `update-electron-app` reference. Electron Builder emits `release/latest-mac.yml`, but no shipped code consumes it.

**Impact**

Electron inherits a large Chromium/Node attack surface and needs timely upgrades. Once a vulnerable or broken build is installed, users receive neither an automatic patch nor an in-app notification, so the installed population can remain on an obsolete engine indefinitely. A release feed manifest alone does not provide delivery.

**Realistic trigger/failure scenario**

A security fix lands in a later Electron 43 patch (or a supported successor) and Prime Work publishes a new DMG. Existing users continue launching `0.1.0` because the app never checks a signed channel and gives no indication that a patch exists.

**Concrete remediation**

After BSP-01 establishes a stable signing identity, add an updater appropriate to the chosen distribution channel. Use HTTPS, signed artifacts/manifests, stable and prerelease channels, staged rollout/rollback, explicit user messaging, and tests for download/signature/install/relaunch. If automatic installation is intentionally out of scope, implement a signed version-check plus prominent manual-update flow and document the support/EOL policy. Do not enable unattended update installation before signing and feed ownership are settled.

---

### BSP-03 — The packaging entry point bypasses tests and has no packaged-artifact release gates

**Severity:** **Medium**

**Exact evidence**

- `package.json:12` makes `build` only type-check and bundle.
- Unit and E2E tests are separate commands at `package.json:15-17`.
- `package.json:18` invokes only `build` before Electron Builder; it does not run either test suite or an audit/release-verification script.
- The E2E harness at `tests/e2e/app.spec.ts:18-22` launches Electron with `args: ['.']`; it exercises built output through the project directory, not the final signed `.app`, DMG, ASAR/fuse state, or updater metadata.

**Impact**

A behavior regression that still type-checks can be packaged successfully. Packaging-specific regressions—wrong architecture, missing native binary, widened ASAR unpack, fuse drift, invalid signature, stale/oversized payload, or a Gatekeeper failure—are not automatically release-blocking.

**Realistic trigger/failure scenario**

A change breaks one of the backend security regression tests or causes the rebuilt `node-pty` binary to be omitted for the target architecture. A maintainer runs only the documented package command; Electron Builder exits successfully and the broken DMG is uploaded because the failing unit/E2E test and packaged smoke were never invoked.

**Concrete remediation**

Add a dedicated release pipeline, for example: clean checkout → pinned Node/npm → `npm ci` → lockfile audit/policy check → typecheck → unit tests → E2E → package → packaged-app smoke → ASAR allowlist/size check → fuse check → native architecture check → signing/notarization/Gatekeeper gates → checksums/SBOM/provenance → publish. Keep fast local scripts if desired, but make the publisher depend exclusively on the gated release job.

---

### BSP-04 — Renderer-only dependencies are duplicated into ASAR as runtime modules

**Severity:** **Medium**

**Exact evidence**

- `package.json:21-30` classifies xterm, Lucide, React, React DOM, React Markdown, and Remark GFM as production dependencies alongside the genuinely native runtime dependency `node-pty`.
- `electron.vite.config.ts:17-21` bundles the renderer through Vite.
- In main-process source, the only third-party runtime module import is `node-pty` at `electron/main/terminal.ts:6`; the other direct dependencies are consumed by renderer source and are already compiled into the renderer bundle.
- Electron Builder includes `out/**/*` and `package.json` at `package.json:55-58`, then automatically collects production dependency closure. ASAR extraction during this audit measured 35,404,291 bytes of `node_modules` versus 1,784,676 bytes of all `out` files. The six direct renderer dependency trees alone occupied 30,754,542 bytes: Lucide 20,956,099; React DOM 7,318,210; xterm packages 2,287,894; React 170,356; React Markdown 17,942; Remark GFM 4,041. Their code is also present in the 1.56 MB renderer bundle.

**Impact**

Every install, DMG/ZIP generation, signature traversal, copy, and delta update carries unused source, declarations, maps, and package files. The duplicate direct trees are over seventeen times the size of all compiled app output. They also enlarge the inventory that release verification and license review must reason about.

**Realistic trigger/failure scenario**

Every `npm run package:mac` includes the entire 20.96 MB Lucide package tree and 7.32 MB React DOM tree even though the packaged renderer never `require`s either from `node_modules`. Users pay the disk/download/update cost on every release.

**Concrete remediation**

Move renderer-only libraries (`@xterm/*`, `lucide-react`, `react`, `react-dom`, `react-markdown`, `remark-gfm`) to `devDependencies`; keep `node-pty` in production dependencies because main requires it at runtime. Build before packaging, inspect the final ASAR, and run the packaged E2E/smoke suite to prove the renderer is self-contained. Add an ASAR dependency allowlist and size budget so only required main-process runtime modules and transitives can ship.

---

### BSP-05 — All renderer features are eagerly shipped in one 1.56 MB startup chunk

**Severity:** **Medium**

**Exact evidence**

- `src/App.tsx:3-15` statically imports every major pane and page, including Inspector, TerminalDrawer, Plugins, Scheduled, and Settings.
- Those components are conditional UI at `src/App.tsx:441-470`; for example, `TerminalDrawer` is mounted only when `terminalOpen`, but its xterm implementation is nevertheless in the startup chunk because the import is static.
- `electron.vite.config.ts:17-21` provides one renderer input and no lazy boundaries/manual chunk policy.
- A clean audited build transformed 1,855 modules and emitted exactly one renderer JS chunk, `index-DBl-d7e4.js`, at 1,557,830 bytes (291,920 bytes gzip for network comparison). The package loads it locally uncompressed, so Chromium must read and parse the full payload on every app launch. No dynamic-import chunk was emitted.

**Impact**

Cold launch pays parse/compile and memory costs for the terminal emulator, Markdown pipeline, browser inspector, and every settings/page component even when the user opens none of them. This increases startup work and makes future feature additions linearly worsen the launch path.

**Realistic trigger/failure scenario**

A user opens Prime Work only to read a session. Before first paint/interaction, Chromium still parses xterm and all secondary pages because `App` imports them synchronously; slower or memory-constrained machines feel the penalty despite never opening Terminal or Plugins.

**Concrete remediation**

Introduce `React.lazy(() => import(...))`/`Suspense` boundaries for infrequently opened pages and heavyweight conditional panes, especially TerminalDrawer/xterm, Inspector/browser code, Plugins, and Settings. Consider a separate lazy Markdown renderer if transcript startup behavior permits. `manualChunks` can improve caching/diagnostics, but only dynamic imports remove work from initial startup. Add a CI budget for initial renderer bytes/chunk count and measure ready-to-show/first-interaction time before and after.

---

### BSP-06 — Documented/specified Node support contradicts the locked Electron toolchain

**Severity:** **Low**

**Exact evidence**

- `README.md:20-24` promises “Node.js 20 or newer”.
- The locked Electron package is `43.2.0` at `package-lock.json:3233-3236` and declares Node `>= 22.12.0` at `package-lock.json:3248-3250`.
- Vite also narrows Node 20 support to `^20.19.0` at `package-lock.json:7152-7154`.
- `package.json:1-9` has no `engines` or `packageManager` contract, while `package.json:31-43` selects these tools.

**Impact**

A contributor following the documented requirement can receive engine warnings/failures during install or postinstall/native rebuild. Different npm versions can also resolve/interpret the lock and lifecycle behavior differently, weakening reproducibility exactly where native Electron ABI rebuilding matters.

**Realistic trigger/failure scenario**

A contributor uses Node 20.18 because the README says Node 20 is supported. `npm install` encounters an unsupported Electron 43 host runtime and Vite's Node floor, then the `electron-builder install-app-deps` postinstall/native rebuild fails or behaves outside the supported toolchain.

**Concrete remediation**

Set `engines.node` to the actual floor (`>=22.12.0` for the current lock), add a `packageManager` field with the release npm version, update the README, and provide `.nvmrc`/Volta/asdf metadata. Enforce the same version in CI before `npm ci`. If Node 20 support is a requirement, select an Electron/toolchain version that officially supports the chosen Node 20 patch and test it.

---

### BSP-07 — All Electron locale packs are shipped without an explicit supported-language policy

**Severity:** **Low**

**Exact evidence**

- The macOS package configuration at `package.json:59-69` selects targets/icon/entitlements but does not set Electron Builder's `electronLanguages` filter.
- The current app describes and renders its interface in English (`index.html:2` sets `lang="en"`; no application localization system was found).
- The generated `.app` contained 220 `*.lproj` Electron resource directories totaling 48,655,870 bytes (46.4 MiB), including full Chromium locale packs for languages the application UI does not currently offer. This is separate from the duplicate JS modules in BSP-04.

**Impact**

Unsupported locale resources consume installed size and contribute to DMG/ZIP/update transfer and signing/verification work. The overhead is paid by every user and build.

**Realistic trigger/failure scenario**

An English-only `0.1.0` release ships Chromium strings for the complete Electron locale set; most users use one locale while roughly 46.4 MiB of locale resources remain unused on disk.

**Concrete remediation**

Define the product's actual localization policy. If `0.1.x` officially supports only English, set Electron Builder `electronLanguages` to the required English locale(s) and test browser dialogs/context UI on a non-English macOS account. If multilingual Chromium UI is intended, retain the corresponding packs deliberately and document them. Add installed-size and compressed-artifact budgets so this tradeoff is visible.

## Positives and verified controls

1. **Dependency integrity is strong.** `package-lock.json` is lockfile v3; every remote package resolves from `registry.npmjs.org` and every resolved tarball has an integrity hash. `package.json:4` is `private: true`, preventing accidental npm publication.
2. **No verified dependency advisory was found.** `npm audit --json` exited 0 with 0 info/low/moderate/high/critical findings for the current tree. This is a point-in-time npm advisory result, not proof that no undisclosed or non-npm vulnerability exists.
3. **Build/tests pass.** `npm test` passed 12 files/33 tests; `npm run build` passed typechecking and all three bundles; `npm run test:e2e` passed 9/9 Electron tests.
4. **Packaged CSP is substantially stronger than the development HTML meta policy.** `electron/main/index.ts:51-55` serves packaged assets with self-only script/connect/image policy, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, and `nosniff`; `electron/main/index.ts:211-219` reinforces it at response-header level. There is no `unsafe-eval` or remote script source.
5. **Renderer isolation is explicitly configured.** `electron/main/index.ts:125-134` disables Node integration, enables context isolation/sandbox/web security, and disallows insecure content.
6. **ASAR and fuse hardening are good.** `package.json:48-54` disables smart unpack and allowlists only the two required `node-pty` binaries. `scripts/afterPack.cjs:8-19` disables RunAsNode, `NODE_OPTIONS`, CLI inspect, and file-protocol extra privilege while enabling cookie encryption, embedded ASAR integrity, and ASAR-only app loading. `electron-fuses read` confirmed the configured state in the audited package.
7. **Production source maps are not exposed.** The built main, preload, and renderer output contained no `.map` files. Open-source dependency maps found inside ASAR are another symptom of BSP-04, not a leak of application source.
8. **Asset loading is local and packaged.** `package.json:55-58` narrowly selects compiled output/package metadata, and `electron/main/index.ts:39-57` constrains the custom `prime-work://app` protocol to the renderer root with traversal and MIME checks.

## Dismissed false alarms / non-findings

- **The broad CSP in `index.html:7` is not the effective packaged policy.** It permits HTTPS images/connections and WebSockets for development, but the packaged custom-protocol response applies the stricter headers at `electron/main/index.ts:53` and `:216`. I therefore did not report the development meta tag as a production remote-code finding.
- **`allow-jit` is expected for Chromium.** Both entitlement files enable JIT at `build/entitlements.mac.plist:5-6` and `build/entitlements.mac.inherit.plist:5-6`; disabling it blindly can break Electron under hardened runtime.
- **`disable-library-validation` is broader than ideal, but no concrete untrusted dylib load path was found.** It appears at `build/entitlements.mac.plist:7-8` and the inherited file's `:7-8`. The packaged `node-pty` binary is itself signed and links only system libraries. This deserves a Developer-ID build test with the entitlement removed (and scoping if genuinely necessary), but evidence did not justify claiming a directly exploitable library-injection vulnerability.
- **Native ASAR unpacking is not broad.** Although unpacked executable files warrant scrutiny, the current patterns are exact (`package.json:51-54`) and the artifact contains only `pty.node` and `spawn-helper`; both were signed in the audited package.
- **No unsupported-Electron/CVE claim is made.** The lock selects Electron `43.2.0`, the current npm audit was clean, and this audit found no verified advisory evidence warranting a CVE assertion. The operational concern is the absence of an update path, not a claimed present CVE.
- **No secret-bearing source maps or `.env` payload were packaged.** `.gitignore:9-10` excludes environment files, Builder's `files` list is compiled-output-only, and final app-output inspection found no application maps.

## Recommended order

1. **Before any public release:** implement BSP-01 and make Gatekeeper/notarization verification mandatory.
2. Make BSP-03 the sole path allowed to publish artifacts.
3. Establish BSP-02 while the signing/update trust model is being designed.
4. Fix BSP-04; it is low-risk and yields an immediate package-size reduction.
5. Add lazy boundaries and budgets for BSP-05, then decide the locale policy in BSP-07.
6. Pin and document the actual toolchain per BSP-06.
