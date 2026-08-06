# Prime Work — Desktop Design System

## Product context
Prime Work is a macOS desktop interface for the Prime Agent harness. It lets power users work across local projects, run persistent agent sessions in parallel, inspect every action, browse and annotate local web apps, use an integrated terminal, review file changes, discover skills/plugins, and manage harness settings without leaving one window.

Primary jobs:
1. Return to any project and resume a saved Prime Agent session instantly.
2. Prompt an agent, observe streaming reasoning/tool activity, steer or stop it, and review tangible results.
3. Work in a focused three-zone shell: project/session navigation, conversation, and a contextual inspector (changes/browser/terminal).
4. Discover and manage Prime Agent skills, MCP connections, extensions, prompt templates, packages, schedules, and subagents.

Primary screens: agent workspace, project/session library, browser, terminal drawer, changes review, plugin directory, scheduled work, settings.

## Reference and visual direction
Faithfully follow the current ChatGPT desktop Codex/Work visual language shown in the official reference screenshots: quiet macOS-native chrome, warm-neutral white surfaces, hairline dividers, compact rounded controls, low-contrast sidebar selection, a spacious transcript, and a dense but calm inspector. Match the interaction density, proportions, typography hierarchy, restraint, and component geometry; use the official Prime Intellect mark from `public/prime-intellect-mark.svg` and original Prime copy rather than OpenAI/Codex marks. Never substitute a lightning bolt, sparkle, or generic AI glyph for the product identity.

The app should feel native, precise, familiar, and calm—not a marketing dashboard. No gradients, glassmorphism, decorative hero graphics, oversized display type, colorful cards, or heavy shadows. Color is reserved for status, diff semantics, browser annotation, and the Prime accent.

## Layout architecture
- Full-height macOS desktop window; minimum 960×640, ideal 1440×900.
- Native hidden-inset title bar, 52px visual toolbar with traffic-light clearance on macOS.
- Left navigation/sidebar: 248px default, resizable 220–320px; warm gray surface; project groups and compact thread rows. Collapsible.
- Main conversation: flexible, minimum 480px. Transcript max text measure about 760px; bottom composer floats 16px from edges.
- Context inspector: 44–48% of remaining width when open, minimum 420px; separated by a 1px divider; tabs for Summary, Changes, Browser, Files. Collapsible.
- Integrated terminal: bottom drawer under main/inspector, 260–420px tall, resizable; tab strip and toolbar at top.
- At narrow widths under 980px, sidebar becomes an overlay and inspector becomes a full-height overlay. Under 720px, use a single-pane stack with 44px touch targets.

## Color tokens
Light theme:
- --canvas: #ffffff
- --sidebar: #f3f3f1
- --surface-subtle: #f7f7f5
- --surface-hover: #ececea
- --surface-selected: #e5e5e2
- --surface-raised: #ffffff
- --text: #20201e
- --text-secondary: #686863
- --text-tertiary: #92928c
- --border: #e3e3df
- --border-strong: #d3d3ce
- --focus: #6aa9ff
- --prime: #6b55e8
- --prime-soft: #efecff
- --success: #288a5b
- --success-soft: #eaf5ee
- --warning: #9a6b17
- --warning-soft: #faf1dc
- --danger: #c54b42
- --danger-soft: #fbeceb
- --diff-add: #e5f3e8
- --diff-add-line: #4aa866
- --diff-remove: #f9e8e6
- --diff-remove-line: #d4675c
- --annotation: #2488ff

Dark theme:
- --canvas: #171716
- --sidebar: #20201f
- --surface-subtle: #242423
- --surface-hover: #2b2b29
- --surface-selected: #333330
- --surface-raised: #222220
- --text: #f1f1ee
- --text-secondary: #b3b3ad
- --text-tertiary: #83837d
- --border: #343431
- --border-strong: #474743
- --focus: #82b5ff
- --prime: #a595ff
- --prime-soft: #312b51
- --success: #75c897
- --success-soft: #20392b
- --warning: #deb967
- --warning-soft: #41351f
- --danger: #ed8a82
- --danger-soft: #432724

## Typography
- UI family: "OpenAI Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif.
- Mono family: "SFMono-Regular", "SF Mono", "Cascadia Code", Menlo, monospace.
- Base UI: 13px / 1.45, regular 400.
- Navigation labels: 13px / 18px, 450–500.
- Section labels: 11px / 16px, 500, text-secondary; sentence case, no excessive tracking.
- Conversation prose: 14px / 1.62.
- Page/empty-state heading: 24px / 1.2, 550; use sparingly.
- Toolbar/project title: 12.5–13px, 500.
- Terminal/code: 12.5px / 1.55.

## Spacing and geometry
- 4px micro-grid. Core spacing: 4, 6, 8, 10, 12, 16, 20, 24, 32.
- Sidebar row: 32–36px high, 8px horizontal padding, 7px radius.
- Icon buttons: 28px desktop, minimum 44px hit area through invisible padding on touch.
- Regular buttons: 30–34px high, 8px radius; primary near-black/light or light/dark depending theme.
- Input/select: 32px high, 8px radius.
- Pills/tabs: 26–30px high, 999px radius only for true pills.
- Composer: 14px radius, 1px border, subtle 0 1px 2px rgba(0,0,0,.05); 94–136px typical height.
- Cards: 10–12px radius, 1px border, no shadow unless floating.
- Menus/popovers: 10px radius, 1px border, 0 10px 30px rgba(0,0,0,.12).
- Window corners/shadows are native; do not fake them inside the app.

## Components
### Sidebar
Top icon rail includes new thread, search, projects, scheduled, plugins, and settings affordances. Below, group saved sessions under projects with project folder icons, active/running indicators, pinned rows, relative timestamps, and a restrained selected background. Truncate long titles. Use hover-only row actions.

### Conversation transcript
User prompts appear in compact right-leaning light-gray message blocks where helpful; assistant work is mostly unboxed prose. Tool activity uses collapsible timeline rows: status icon, concise action label, duration, optional chevron; show code/command output in bordered mono blocks only when expanded. A result card summarizes changed files with green/red counts. Keep generous vertical rhythm and left alignment.

### Composer
Large rounded rectangle anchored at bottom. Placeholder: “Ask Prime anything, @ to add files, / for commands”. Top is multiline text; footer contains add/attach, skill/preset selector, model selector, effort selector, environment selector, voice, and circular send/stop button. Streaming changes send to stop; queued prompts get status chips.

### Inspector
Compact tab strip with Summary, Changes, Browser and optional new-tab plus button. Browser toolbar has back/forward/reload, centered address field, comment mode toggle and overflow. Changes includes file list and diff, stage/revert controls, inline comments, branch and commit actions. Empty inspector states are subtle, centered, and useful.

### Terminal
Native-feeling xterm surface with a compact tab/header row, shell label, close button and full monospace ANSI output. Terminal input must be real and focusable. Keep toolbar background aligned with canvas.

### Plugin directory
A spacious content page inside the same titlebar. Header “Make Prime work your way”, tabs for Plugins and Skills, filters, search, Manage and Create buttons, a restrained editorial feature banner, followed by two-column category rows. Each plugin row has a small distinct icon, title, one-line description, installed check or plus button. Avoid marketplace card grids.

### Modals and approvals
Centered max-width 520px, clear single purpose, close affordance, title + short supporting copy, form control, full-width primary action. Risk approvals use explicit action/domain/path context and Cancel/Allow buttons. Use backdrop blur only at 2px if supported.

## Motion
- 120–180ms ease-out for hover, panel and popover transitions.
- Sidebar/inspector open with opacity + 8px translation; terminal drawer uses height/translate, 180ms.
- Streaming cursor and running indicator may pulse subtly at 1.6s.
- Respect reduced motion; no page-load spectacle.

## Accessibility and macOS behavior
- WCAG AA contrast for text and controls.
- Visible 2px focus ring using --focus, offset 1px.
- Full keyboard navigation; Cmd+K search, Cmd+N new session, Cmd+Shift+B browser, Cmd+J terminal, Cmd+, settings.
- Native draggable titlebar regions, no-drag on controls.
- Tooltips on icon-only buttons.
- aria-live for streaming status and terminal/session errors.

## Implementation constraints
- React + TypeScript renderer in an Electron macOS shell.
- Use CSS variables and lightweight primitives. Use the official Prime Intellect mark for all assistant/product identity; never use a lightning bolt or generic AI glyph as the avatar. Use Lucide only for functional actions, with consistent 1.5px stroke and 14–16px size.
- No remote font dependency is required; use the macOS-native fallback stack.
- Functional, not a static mock: projects/sessions persist, Prime Agent streams over RPC, terminal uses a PTY, browser uses a dedicated Electron webview/view with safety controls, plugins/skills enumerate actual harness resources.
