# Validation status

Last full local validation: 2026-08-06 on Apple Silicon macOS.

| Gate | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm test` | Pass — 4 backend tests |
| `npm run test:e2e` | Pass — 5 Electron tests |
| `npm run build` | Pass — main, CommonJS sandbox preload, renderer |
| Real Prime RPC handshake | Pass against Prime Agent 0.7.0 |
| Real PTY command/cwd | Pass |
| Browser navigation/history | Pass; no `ERR_ABORTED` after controlled-source fix |
| Last-window close/reopen | Pass |
| `npm run package:mac` | Pass — arm64 app, DMG, ZIP |
| `codesign --verify --deep --strict` | Pass |
| Packaged app launch/preload smoke | Pass |
| Apple notarization / public Gatekeeper assessment | Not run — release credentials are not stored in the repository |

The initial adversarial QA report is in `research/functional-qa.md`. Its browser navigation race and misleading terminal controls were fixed and retested in `research/qa-fixes-verified.png` and the committed Electron smoke suite.
