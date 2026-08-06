# CFR-08 remediation: initial renderer loading

## Finding

`createWindow()` created a hidden `BrowserWindow` and detached `window.loadURL(trustedRendererUrl)` with `void`. A rejected initial navigation therefore bypassed the `app.whenReady()` startup catch, could be reported as an unhandled rejection, and left the application owning a window that never reached `ready-to-show`.

## Remediation

- Added the small, exported `loadInitialRenderer` lifecycle helper. It awaits the exact renderer URL, destroys a still-live hidden window on rejection, and rethrows the original failure.
- Made window creation asynchronous and made `bootstrap()` await it. Startup navigation failures now flow to the existing startup failure path instead of escaping it.
- Gated `show()` on both successful navigation and `ready-to-show`; a renderer that has not successfully loaded is never exposed as an application window.
- Added a single-flight `ensureWindow()` path so an in-progress creation cannot be duplicated.
- Routed macOS activation and single-instance window requests through a rejection-handled async path. A recreation failure destroys that attempt and a later activation can retry.
- Added shutdown checks before construction, before showing, and after navigation. If shutdown wins the race, the new window is destroyed and is not shown.
- Bounded startup/recreation diagnostics to a single sanitized 512-character line.

The renderer URL resolver, `isTrustedRendererUrl` authorization checks, main-frame authorization/revocation events, packaged `prime-work://` protocol handler and CSP, preload/sandbox settings, and shutdown service cleanup were not relaxed or replaced. No remote or `data:` fallback error page was introduced.

## Deterministic coverage

`tests/backend/window-lifecycle.test.ts` verifies that:

1. the helper remains pending until `loadURL` settles and does not destroy a successful window;
2. a rejected load destroys the hidden window exactly once and preserves the original rejection for its caller;
3. a load aborted after another shutdown path already destroyed the window does not destroy it twice.

## Validation

Run on the remediation working tree:

```text
npm test -- --run tests/backend/window-lifecycle.test.ts
  1 file passed; 3 tests passed

npm run typecheck
  tsc --noEmit -p tsconfig.node.json
  tsc --noEmit -p tsconfig.web.json
```
