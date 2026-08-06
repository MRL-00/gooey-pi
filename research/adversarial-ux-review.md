# Adversarial UI/UX fidelity review

**Final review target:** Prime Work at 1440×920, Electron 43.2.0  
**Runtime captures:** `prime-work-final-light.png`, `prime-work-final-browser.png`, `qa-dark-settings.png`, `qa-terminal.png`

## Verdict

The current desktop shell is visually and behaviorally close to the familiar Codex/ChatGPT Work model while retaining original Prime branding. It reads as a restrained macOS work application rather than a web dashboard: native hidden-inset chrome, a dense 248px work rail, broad transcript, contextual right inspector, bottom PTY drawer, quiet one-pixel separators, system typography, and minimal semantic color. No OpenAI/Codex marks, gradients, glass panels, or ornamental dashboard cards remain.

At the default 1440×920 capture, measured pane boundaries are 248px for the sidebar and approximately 520px for the inspector, leaving approximately 670px for the transcript. This is a materially better match to the official split-work references than the earlier 660px inspector. Both inspector width and terminal height now have pointer and keyboard-accessible separators, persisted defaults, min/max bounds, and double-click reset.

## Resolved adversarial findings

1. **Composer crowding:** container queries hide secondary permission text at narrow center widths and constrain selects. The default 670px conversation surface fits all active controls without overlap.
2. **False/inert controls:** browser race, terminal maximize, prompt suggestions, documentation, and project actions are functional; unavailable voice/multi-terminal/file attachment/environment choices are disabled, removed, or not presented. Local-only plugin enable toggles and empty overflow menus were removed.
3. **Transcript quality:** Prime JSONL tool results are paired with their tool calls and assistant activity is grouped between user turns. Existing sessions open at the recent end without scrolling the document shell.
4. **Panel behavior:** sidebar/inspector switch to fixed overlays with scrims below 980px; compact controls and touch targets apply below 720px. The inspector and terminal can also be resized with mouse, touch/pointer, arrows, Home/End, Shift acceleration, and reset.
5. **Browser fidelity:** real remote pages occupy the full right surface under compact browser chrome; navigation/history, address entry, annotations, external handoff, isolated profile reset, and safe download prompts work.
6. **Terminal fidelity:** real xterm/PTY output, cwd, clear, resize, maximize/restore, close, live state, and teardown work; unfinished split/new-terminal affordances are not advertised.
7. **Misleading data:** the hard-coded context percentage was replaced with an honest Prime-managed state; non-Git workspaces no longer claim to have a clean repository.
8. **Original identity:** the sidebar uses the Prime icon and Prime Workspace lockup; package, BrowserWindow, and Dock/App Switcher all use `assets/icon.png`/`assets/icon.icns`, not Electron branding.
9. **Accessibility:** labeled navigation landmarks, modal semantics, tab roles, live regions, visible focus, full keyboard shortcuts, reduced motion, disabled states, accessible splitters, and high-contrast dark tokens are present.

## Remaining intentional scope boundaries

- Browser and Git annotations are session-local UI aids rather than a collaborative cloud comment service.
- Prime Work exposes the local environment implemented by Prime Agent. It does not pretend to create cloud sandboxes or Git worktrees.
- The terminal is deliberately single-instance until a tested multi-PTY layout is implemented.
- The current transcript renderer supports readable plain text, inline code, thinking, tools, images, and diffs; it is not a full arbitrary Markdown/HTML renderer, reducing remote-content risk.

## Reference comparison

The implementation follows the public reference patterns stored in `research/screenshots/`: sparse top chrome, transcript-first composition, bottom composer, contextual Summary/Changes/Browser/Files tabs, inline tool activity, change review, and integrated terminal. The browser capture particularly matches the official `in-app-browser-light.webp` two-surface composition. Prime-specific naming, iconography, colors, and implementation keep the product visually distinct.

## Post-review remediation

The independent final review found focus containment, contrast, inert-control, compact-terminal, and reduced-motion issues. All listed UX findings were subsequently remediated and regression-tested; see `research/final-ux-verification.md`.
