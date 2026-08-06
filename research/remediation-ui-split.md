# UI split remediation

## Scope

This refactor only reorganizes the session inspector and renderer styles. Component bodies and CSS rules were moved without changing behavior, markup, class names, props, trust boundaries, or render limits.

## Inspector split

Sizes were measured from the working tree immediately before the split. Byte counts are UTF-8 bytes.

| File | Before | After |
| --- | ---: | ---: |
| `src/components/Inspector.tsx` | 329 lines / 23,618 bytes | 52 lines / 3,291 bytes |
| `src/components/inspector/SummaryPanel.tsx` | — | 19 lines / 2,416 bytes |
| `src/components/inspector/ChangesPanel.tsx` | — | 99 lines / 8,138 bytes |
| `src/components/inspector/BrowserPanel.tsx` | — | 92 lines / 6,288 bytes |
| `src/components/inspector/FilesPanel.tsx` | — | 53 lines / 4,198 bytes |
| **Inspector source total** | **329 lines / 23,618 bytes** | **315 lines / 24,331 bytes** |

The top-level inspector now owns only tab semantics, keyboard navigation, focus trapping, and panel composition. The focused modules retain the original panel implementations, including:

- diff caps of 2 MiB and 4,000 rendered lines;
- Git diff request cancellation and mutation error handling;
- isolated webview partition and sandbox preferences;
- project-file multi-root handling, 1,000-row paging, and stale-load token cancellation;
- existing labels, tab roles, focus behavior, and modal confirmations.

## Stylesheet split

`src/styles.css` is now a 12-import entry point. The original stylesheet content can be reconstructed exactly by concatenating the feature files in import order; no selector or declaration was edited.

| File | Before | After |
| --- | ---: | ---: |
| `src/styles.css` | 797 lines / 73,903 bytes | 12 lines / 393 bytes |
| `src/styles/base.css` | — | 138 lines / 5,059 bytes |
| `src/styles/workbench.css` | — | 45 lines / 4,977 bytes |
| `src/styles/sidebar.css` | — | 62 lines / 6,425 bytes |
| `src/styles/transcript.css` | — | 75 lines / 7,982 bytes |
| `src/styles/composer.css` | — | 25 lines / 3,247 bytes |
| `src/styles/inspector.css` | — | 126 lines / 14,909 bytes |
| `src/styles/terminal.css` | — | 17 lines / 1,939 bytes |
| `src/styles/pages.css` | — | 68 lines / 7,040 bytes |
| `src/styles/plugins.css` | — | 49 lines / 5,582 bytes |
| `src/styles/settings.css` | — | 53 lines / 5,667 bytes |
| `src/styles/overlays.css` | — | 52 lines / 6,256 bytes |
| `src/styles/responsive.css` | — | 87 lines / 4,820 bytes |
| **CSS source total** | **797 lines / 73,903 bytes** | **809 lines / 74,296 bytes** |

The small total-size increase is the import entry point. Import order matches the former cascade order, and responsive/container rules remain last.

## Validation

- `npm run typecheck` — passed
- `npm test` — passed (19 files, 75 tests)
- `npm run build` — passed, including the renderer/Vite CSS build
- `git diff --check` — passed

No focused test was added because this is a verbatim extraction: existing Git cap/security tests and the complete Vitest suite continue to exercise the behavior, while TypeScript and the production build validate the new module/import boundaries.
