# macOS package verification

**Verification time:** 2026-08-06T03:37:49Z  
**Host:** macOS 26.5.1 (25F80), arm64  
**Package:** `release/mac-arm64/Prime Work.app` (`ai.prime.work`, version `0.1.0`)

## Verdict

**PASS for the requested package mechanics and local QA:** the packaged application contains the Prime icon, the exact packaged main bundle executes the runtime Dock-icon path, the configured Electron fuses are present, ASAR unpacking is minimal, strict code-signature integrity passes, the app launches to an on-screen window and quits cleanly, and both distribution artifacts contain an exact file/symlink payload copy of the staged app.

**Not ready for public Gatekeeper distribution:** the app is signed by a machine-local development authority, has no Team ID, is rejected by `spctl`, and neither the app nor DMG has a stapled notarization ticket. See [Notarization limitation](#notarization-limitation).

## Results summary

| Area | Result |
| --- | --- |
| `Info.plist` icon | PASS — `CFBundleIconFile = icon.icns`; plist lint passes |
| Runtime Dock/window icon | PASS — packaged main calls `app.dock?.setIcon(appIconPath())`; packaged path resolves to `process.resourcesPath/icon.png` |
| Icon identity/appearance | PASS — packaged PNG and ICNS exactly match the source assets; no generic Electron icon |
| Electron fuses | PASS — all nine V1 settings match `scripts/afterPack.cjs` |
| ASAR integrity/unpack | PASS — integrity header hash matches plist; only the two requested `node-pty` binaries are unpacked |
| Code-signature integrity | PASS — strict/deep verification passes for staged, DMG, and ZIP app payloads |
| Normal packaged smoke | PASS — normal LaunchServices open produced the Prime Work window; normal quit removed all bundle processes |
| DMG/ZIP integrity/freshness | PASS — containers validate, metadata hashes/sizes match, payload manifests match staging exactly |
| Developer ID/notarization | **LIMITATION** — local-only signature, Gatekeeper rejection, no stapled ticket |

## 1. Icon packaging and appearance

`plutil`/`PlistBuddy` inspection of the final app showed:

- `CFBundleIconFile`: `icon.icns`
- `CFBundleIdentifier`: `ai.prime.work`
- `CFBundleExecutable`: `Prime Work`
- short/build version: `0.1.0`
- `plutil -lint`: `OK`

The final bundle contains both icon resources:

- `Contents/Resources/icon.icns` — 287,710 bytes
- `Contents/Resources/icon.png` — 1,024 × 1,024, 8-bit RGBA

Exact SHA-256 identity with the source assets:

| Asset | Source SHA-256 | Packaged SHA-256 | Result |
| --- | --- | --- | --- |
| `icon.png` | `15bd89952798261de2909c04e44fbcea08415b77f1887d63c78f81b31e07d25f` | same | MATCH |
| `icon.icns` | `5143c8122468eeea7379bde5b2118486324dc96c36aa8e30472f6396801fd90e` | same | MATCH |

`iconutil` successfully decoded the ICNS into all 10 standard representations, from 16 × 16 through 512 × 512 @2x. Visual review of the 16, 32, 128, 512, and 1,024 representations showed the intended near-black rounded-square tile and white Prime mark, with transparent corners and no generic Electron artwork, clipping, or large-size halo. The 16-pixel representation is naturally coarse, but the diagonal mark remains distinguishable; 32 pixels and above are clear. The 1,024-pixel alpha/content bounds stay inside the canvas.

### Runtime icon code in the shipped ASAR

The source uses:

- `electron/main/index.ts:24-25`: packaged icon path is `join(process.resourcesPath, 'icon.png')`
- `electron/main/index.ts:90`: `BrowserWindow` receives `icon: appIconPath()`
- `electron/main/index.ts:167`: macOS calls `app.dock?.setIcon(appIconPath())` after `app.whenReady()`

The main bundle extracted from the **final `app.asar`** contains the same logic at generated lines 2055-2056, 2129, and 2212. Its SHA-256 is identical to the current `out/main/index.js`:

`b9a2a8b554c13544d4cc9a03be370a31167c303d529951b074369f38afdd030a`

Because the packaged `icon.png` is also byte-identical to `assets/icon.png`, the Dock call and the packaged window-icon path both target the verified Prime image.

## 2. Electron fuses

`node_modules/.bin/electron-fuses read --app release/mac-arm64/Prime\ Work.app` reported Fuse V1 and the following final executable state:

| Fuse | Final state | Matches `afterPack.cjs` |
| --- | --- | --- |
| `RunAsNode` | Disabled | Yes |
| `EnableCookieEncryption` | Enabled | Yes |
| `EnableNodeOptionsEnvironmentVariable` | Disabled | Yes |
| `EnableNodeCliInspectArguments` | Disabled | Yes |
| `EnableEmbeddedAsarIntegrityValidation` | Enabled | Yes |
| `OnlyLoadAppFromAsar` | Enabled | Yes |
| `LoadBrowserProcessSpecificV8Snapshot` | Disabled | Yes |
| `GrantFileProtocolExtraPrivileges` | Enabled | Yes |
| `WasmTrapHandlers` | Enabled | Yes |

The `afterPack` hook requests a Darwin signature reset while changing the Electron executable; electron-builder subsequently signed the final result. Strict signature verification after fuse flipping passes, so the final sealed executable—not a prefuse binary—is what was validated.

## 3. ASAR integrity and minimal unpack

The final `Info.plist` includes `ElectronAsarIntegrity` for `Resources/app.asar`:

- algorithm: `SHA256`
- ASAR header hash: `c7ace68256181c2e849bba033d00752e4b7fb56265af57c7963e0cfd7ace129a`

Recomputing the Electron/electron-builder ASAR **header** hash returned that exact value. The whole-file SHA-256 is `f0dc665f1c9cc0f5808c2db68d65d9a279f23f25b8f6043ac12c1dfc0d82ba17`; the difference is expected because the plist records the ASAR header hash rather than a whole-file digest.

Despite 3,968 paths in the archive listing, the unpacked tree contains exactly two regular files, matching `package.json` with `asar.smartUnpack: false`:

1. `node_modules/node-pty/build/Release/pty.node` — 108,352 bytes, `-rwxr-xr-x`, Mach-O arm64 bundle
2. `node_modules/node-pty/build/Release/spawn-helper` — 69,344 bytes, `-rwxr-xr-x`, Mach-O arm64 executable

There are no additional unpacked regular files. Strict `codesign --verify` also passes for each unpacked native binary.

## 4. Code signing

`codesign --verify --deep --strict --verbose=4` on the staged app:

- exits successfully
- validates all Electron helper apps and embedded frameworks
- reports `valid on disk`
- reports `satisfies its Designated Requirement`

Key final signature facts:

- format: thin arm64 app bundle
- identifier: `ai.prime.work`
- CodeDirectory flags: `0x10000(runtime)` (hardened runtime)
- CDHash: `b572afe11fb6d089a4f5093f15702174c01d21ad`
- authority: `BackgroundComputerUse Local Dev` / `BackgroundComputerUse Local Root`
- `TeamIdentifier=not set`

After mounting/extracting the DMG and ZIP, strict/deep verification also passed on both embedded app payloads. This proves package integrity under the present local signature, but it is not a public Developer ID/notarization result.

## 5. Normal packaged launch and quit

Smoke-tested the unmodified staged bundle via normal LaunchServices open:

1. Confirmed there was no pre-existing Prime Work bundle process.
2. Opened `release/mac-arm64/Prime Work.app` normally.
3. Observed main PID `61978` plus the expected Electron GPU, network-service, and renderer processes.
4. After a three-second dwell, the main process remained alive.
5. WindowServer enumeration found an on-screen, current-Space window titled **Prime Work**, owned by PID 61978, sized 1,296 × 829.
6. Sent the application's normal macOS quit Apple event; it returned success.
7. Polled the exact bundle path and confirmed no main or helper process remained (within the 10-second polling window).

Result: **PASS**. The final packaged app reaches a real UI window and follows its normal quit path without leaving bundle processes behind.

## 6. DMG/ZIP freshness and equivalence

Build sequence (UTC mtimes):

- fuse hook source `scripts/afterPack.cjs`: 2026-08-06 03:22:02
- built main `out/main/index.js`: 2026-08-06 03:24:52
- staged app/ASAR: 2026-08-06 03:25:09
- final app executable signature time/mtime: 2026-08-06 03:27:02
- DMG: 2026-08-06 03:27:34
- ZIP: 2026-08-06 03:28:15
- `latest-mac.yml`: 2026-08-06 03:28:23

Thus both distribution artifacts postdate the icon/fuse build and final signing steps.

Container checks:

- `hdiutil verify`: DMG checksum is valid
- `unzip -tq`: no compressed-data errors
- DMG layout contains `Prime Work.app` and the expected `Applications` link
- ZIP root contains `Prime Work.app`

A recursive manifest compared relative path, file type, POSIX mode, symlink target, file size, and SHA-256 for every non-directory app entry:

| Payload | Entries | Only in staging | Only in artifact | Changed |
| --- | ---: | ---: | ---: | ---: |
| staged app | 285 | — | — | — |
| DMG app | 285 | 0 | 0 | 0 |
| ZIP app | 285 | 0 | 0 | 0 |

Artifact SHA-256:

- DMG (124,309,244 bytes): `fb97b40f11477d021654d6a939965cb31141ac537f26e3775e4643555373d50f`
- ZIP (119,641,740 bytes): `00066a0cdec1a8c3785bfcaf822f2071f8e11854a7fdd6f2b8c6ea22548aa629`

`latest-mac.yml` reports release date `2026-08-06T03:28:23.299Z`; both its artifact sizes and base64 SHA-512 values recompute exactly. The critical staged/DMG/ZIP files (`Info.plist`, executable, ICNS, PNG, and ASAR) also have identical SHA-256 values.

## Notarization limitation

This host can validate local code-signature integrity but cannot turn the present artifacts into a notarized public release. The evidence is explicit:

- the signing chain is a local `BackgroundComputerUse` development authority, not `Developer ID Application`
- no Apple Developer Team ID is embedded
- `spctl --assess --type execute --verbose=4` rejects the app (exit 3)
- `xcrun stapler validate` says the app has no stapled ticket (exit 65)
- `xcrun stapler validate` says the DMG has no stapled ticket (exit 65)

Public distribution therefore still requires access to the intended Apple Developer team, a `Developer ID Application` signing identity, and notary credentials. Re-sign/rebuild with that identity, submit the release payload with `notarytool`, staple the accepted ticket (including to the DMG as appropriate), then rerun strict `codesign`, `spctl`, and `stapler validate`. Until then, the current artifacts are suitable for local QA but should not be described as notarized or Gatekeeper-ready.

## Commands used

Read-only/package-smoke commands included `PlistBuddy`, `plutil`, `file`, `shasum`, `iconutil`, `electron-fuses read`, `asar list`/`extract-file`, `codesign --verify`, `codesign -dv`, `spctl --assess`, `xcrun stapler validate`, `hdiutil verify`/read-only mount, `unzip -tq`, LaunchServices open, WindowServer enumeration through Cua Driver, and a normal application quit event. Temporary extraction/mount directories were removed. No production source file was changed as part of verification; this report is the only repository file created.
