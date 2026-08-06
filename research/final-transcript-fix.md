# Final transcript performance and architecture fix

## Scope

The transcript renderer was decomposed without changing its public `Transcript` API or renderer trust boundary:

- `src/components/Transcript.tsx` is now the small composition layer.
- `src/components/transcript/messages.tsx` owns user, assistant, agent, and goal message presentation plus the clipboard fallback and changes card.
- `src/components/transcript/timeline.tsx` owns work disclosures, tool/result pairing, duration formatting, and tool classification.
- `src/components/transcript/syntax.tsx` owns inline text and the bounded syntax tokenizer.
- `src/components/transcript/scroll.ts` owns transcript windowing, pinned-scroll tracking, streaming announcements, and earlier-message controls.

No changes were made to `App.tsx`, `MarkdownText.tsx`, or global styles for this work. Existing Markdown rendering and safety remain delegated to `MarkdownText`.

## Tokenizer correction

The former `SyntaxText` split its input and then called `text.indexOf(token)` for every token. Besides repeated rescans that could become quadratic, `indexOf` always returned the first equal token, so a repeated JSON string value could inherit the classification of an earlier key.

`tokenizeSyntax` now uses one monotonically advancing cursor. It consumes quoted strings (including escapes), the following whitespace needed for key detection, JSON keywords, and numbers directly at the current position. It never searches from the beginning. The source text is reconstructed exactly from emitted tokens.

Tool output remains capped with the existing 200,000-character admission before tokenization. Independently, syntax highlighting stops after 10,000 highlighted fragments and emits the remaining admitted text as plain text. This bounds React element creation for adversarial token-dense output while preserving all admitted output.

## Preserved behavior

- Safe Markdown rendering for narrative and reasoning text
- 200k tool output admission and explicit truncation marker
- Clipboard API with `document.execCommand('copy')` fallback
- Running and completed work disclosures
- Tool/result pairing and reasoning/tool visibility settings
- Streaming status announcements and thinking indicators
- Pinned-bottom behavior and 250-message window expansion
- Disclosure labels, live regions, busy state, and existing button accessibility

## Verification

- `npx vitest run tests/frontend/transcript-activity.test.ts tests/frontend/transcript-rendering.test.ts tests/frontend/transcript-reconciliation.test.ts tests/frontend/transcript-syntax.test.ts tests/frontend/streaming-performance.test.ts` — passed (20 tests).
- `npx biome lint --config-path=scripts/release/biome.json src/components/Transcript.tsx src/components/transcript tests/frontend/transcript-syntax.test.ts` — passed.
- `npm run build:bundle` — passed for main, preload, and renderer bundles.
- `npm run typecheck` — currently blocked by unrelated concurrent `App.tsx` work with unresolved `loadSkills` and `pluginScopeRef` names.
- `npm run build` — reaches the same unrelated typecheck blocker; its underlying `npm run build:bundle` step passes when run directly.
- `npm test` — transcript and 27/29 suites passed. Unrelated failures remain in `tests/backend/terminal.test.ts` (`node-pty` `posix_spawnp failed`) and one provider discovery expectation in `tests/backend/providers.test.ts` while provider code is concurrently modified.

The new regression tests verify positional classification of repeated key/value text, exact reconstruction of a large repeated input, the absence of `indexOf` rescans, and the styled-fragment bound.
