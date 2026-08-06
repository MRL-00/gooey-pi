# Theme and Design Tokens

## Compact token summary

- Framework: React 19 + Electron + Vite; custom components; vanilla global CSS.
- Typeface: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif`; monospace uses `SFMono-Regular, Menlo, Monaco, Consolas`.
- Core palette: warm near-white canvas/surfaces, neutral gray borders/text, Prime violet `#6d4aff`, semantic green/amber/red.
- Dark mode is selected with `[data-theme="dark"]`; system selection is applied in `App.tsx`.
- Corner radii: 5–8px controls, 10–12px cards, 16px composer, full pills for statuses.
- Shadows: restrained macOS shadows (`0 1px 2px`, menu `0 12px 34px`); no gradients or glassmorphism.
- Layout: 248px sidebar; 52px title toolbar; inspector `clamp(420px, 46vw, 660px)`; responsive overlay breakpoint 980px; mobile breakpoint 720px; composer container adjustments at 620/490px.
- Motion: 130–170ms ease-out; disabled by `.reduce-motion` and `prefers-reduced-motion`.

### Light/root tokens
```css
:root {
  color-scheme: light;
  --canvas: #ffffff;
  --sidebar: #f3f3f1;
  --surface-subtle: #f7f7f5;
  --surface-hover: #ececea;
  --surface-selected: #e5e5e2;
  --surface-raised: #ffffff;
  --text: #20201e;
  --text-secondary: #686863;
  --text-tertiary: #92928c;
  --border: #e3e3df;
  --border-strong: #d3d3ce;
  --focus: #6aa9ff;
  --prime: #6b55e8;
  --prime-soft: #efecff;
  --success: #288a5b;
  --success-soft: #eaf5ee;
  --warning: #9a6b17;
  --warning-soft: #faf1dc;
  --danger: #c54b42;
  --danger-soft: #fbeceb;
  --diff-add: #e5f3e8;
  --diff-add-line: #4aa866;
  --diff-remove: #f9e8e6;
  --diff-remove-line: #d4675c;
  --annotation: #2488ff;
  --terminal-bg: #171716;
  --terminal-text: #d8d8d4;
  --shadow-popover: 0 10px 30px rgba(0, 0, 0, .12);
  font-family: "OpenAI Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  font-size: 13px;
  font-synthesis: none;
}
```

### Dark tokens
```css
[data-theme="dark"] {
  color-scheme: dark;
  --canvas: #171716;
  --sidebar: #20201f;
  --surface-subtle: #242423;
  --surface-hover: #2b2b29;
  --surface-selected: #333330;
  --surface-raised: #222220;
  --text: #f1f1ee;
  --text-secondary: #b3b3ad;
  --text-tertiary: #83837d;
  --border: #343431;
  --border-strong: #474743;
  --focus: #82b5ff;
  --prime: #a595ff;
  --prime-soft: #312b51;
  --success: #75c897;
  --success-soft: #20392b;
  --warning: #deb967;
  --warning-soft: #41351f;
  --danger: #ed8a82;
  --danger-soft: #432724;
  --diff-add: #203729;
  --diff-add-line: #75c897;
  --diff-remove: #402625;
  --diff-remove-line: #ed8a82;
  --annotation: #63aaff;
  --terminal-bg: #111110;
  --terminal-text: #deded9;
  --shadow-popover: 0 12px 34px rgba(0, 0, 0, .38);
}
```

## Raw source

### `src/styles.css`
```css
:root {
  color-scheme: light;
  --canvas: #ffffff;
  --sidebar: #f3f3f1;
  --surface-subtle: #f7f7f5;
  --surface-hover: #ececea;
  --surface-selected: #e5e5e2;
  --surface-raised: #ffffff;
  --text: #20201e;
  --text-secondary: #686863;
  --text-tertiary: #92928c;
  --border: #e3e3df;
  --border-strong: #d3d3ce;
  --focus: #6aa9ff;
  --prime: #6b55e8;
  --prime-soft: #efecff;
  --success: #288a5b;
  --success-soft: #eaf5ee;
  --warning: #9a6b17;
  --warning-soft: #faf1dc;
  --danger: #c54b42;
  --danger-soft: #fbeceb;
  --diff-add: #e5f3e8;
  --diff-add-line: #4aa866;
  --diff-remove: #f9e8e6;
  --diff-remove-line: #d4675c;
  --annotation: #2488ff;
  --terminal-bg: #171716;
  --terminal-text: #d8d8d4;
  --shadow-popover: 0 10px 30px rgba(0, 0, 0, .12);
  font-family: "OpenAI Sans", ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  font-size: 13px;
  font-synthesis: none;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --canvas: #171716;
  --sidebar: #20201f;
  --surface-subtle: #242423;
  --surface-hover: #2b2b29;
  --surface-selected: #333330;
  --surface-raised: #222220;
  --text: #f1f1ee;
  --text-secondary: #b3b3ad;
  --text-tertiary: #83837d;
  --border: #343431;
  --border-strong: #474743;
  --focus: #82b5ff;
  --prime: #a595ff;
  --prime-soft: #312b51;
  --success: #75c897;
  --success-soft: #20392b;
  --warning: #deb967;
  --warning-soft: #41351f;
  --danger: #ed8a82;
  --danger-soft: #432724;
  --diff-add: #203729;
  --diff-add-line: #75c897;
  --diff-remove: #402625;
  --diff-remove-line: #ed8a82;
  --annotation: #63aaff;
  --terminal-bg: #111110;
  --terminal-text: #deded9;
  --shadow-popover: 0 12px 34px rgba(0, 0, 0, .38);
}

* { box-sizing: border-box; }
html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body { color: var(--text); background: var(--canvas); font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
button, input, textarea, select { color: inherit; font: inherit; }
button { border: 0; }
button, select { cursor: default; }
button:disabled { opacity: .38; pointer-events: none; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
input::placeholder, textarea::placeholder { color: var(--text-tertiary); }
code, pre, .mono { font-family: "SFMono-Regular", "SF Mono", "Cascadia Code", Menlo, monospace; }
code { font-size: .92em; background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 4px; padding: 1px 4px; }
kbd { color: var(--text-tertiary); font: 10.5px/1.2 "SFMono-Regular", "SF Mono", Menlo, monospace; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drag-region { -webkit-app-region: drag; }
.no-drag, .drag-region button, .drag-region input { -webkit-app-region: no-drag; }
.prime-color { color: var(--prime); }

.scroll-area { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
.scroll-area::-webkit-scrollbar { width: 7px; height: 7px; }
.scroll-area::-webkit-scrollbar-track { background: transparent; }
.scroll-area::-webkit-scrollbar-thumb { background: var(--border-strong); border: 2px solid transparent; background-clip: padding-box; border-radius: 10px; }

.app-shell { display: flex; width: 100%; height: 100%; min-width: 0; background: var(--canvas); isolation: isolate; }
.workbench { display: flex; flex: 1 1 auto; min-width: 0; height: 100%; flex-direction: column; }
.title-toolbar { display: flex; flex: 0 0 52px; min-width: 0; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid var(--border); background: var(--canvas); position: relative; z-index: 15; }
.traffic-light-clearance { width: 66px; flex: 0 0 66px; }
.traffic-light-clearance--toolbar { width: 62px; flex-basis: 62px; }
.title-toolbar__nav, .title-toolbar__actions { display: flex; align-items: center; gap: 2px; }
.title-toolbar__identity { min-width: 0; flex: 1; display: flex; align-items: center; justify-content: flex-start; gap: 8px; }
.title-toolbar__identity strong { max-width: 28vw; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12.5px; font-weight: 540; }
.title-toolbar__actions { justify-content: flex-end; }
.toolbar-divider { width: 1px; height: 16px; background: var(--border); margin: 0 5px; }
.branch-pill { height: 24px; max-width: 180px; display: inline-flex; align-items: center; gap: 5px; padding: 0 7px; color: var(--text-secondary); background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 6px; font-size: 11.5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.workbench__content { flex: 1; min-height: 0; min-width: 0; }
.session-workspace { display: flex; height: 100%; min-height: 0; flex-direction: column; }
.workspace-row { display: flex; min-height: 0; min-width: 0; flex: 1; }
.conversation-pane { position: relative; min-width: 440px; min-height: 0; flex: 1 1 auto; background: var(--canvas); overflow: hidden; container-type: inline-size; }

.icon-button { position: relative; display: inline-grid; place-items: center; flex: 0 0 auto; width: 28px; height: 28px; padding: 0; border-radius: 6px; color: var(--text-secondary); background: transparent; transition: color 130ms ease-out, background 130ms ease-out; }
.icon-button:hover { color: var(--text); background: var(--surface-hover); }
.icon-button.is-active { color: var(--text); background: var(--surface-selected); }
.icon-button--small { width: 23px; height: 23px; border-radius: 5px; }
.button { min-height: 30px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 8px; color: var(--text); background: var(--surface-raised); font-size: 12.5px; font-weight: 520; transition: background 130ms ease-out, border-color 130ms ease-out; }
.button:hover { background: var(--surface-hover); }
.button--compact { min-height: 28px; border-radius: 7px; padding-inline: 9px; }
.button--primary { color: var(--canvas); background: var(--text); border-color: var(--text); }
.button--primary:hover { color: var(--canvas); background: var(--text-secondary); border-color: var(--text-secondary); }
.button--danger { color: #fff; background: var(--danger); border-color: var(--danger); }
.button--danger:hover { background: var(--danger); filter: brightness(.94); }

.prime-mark { display: inline-grid; place-items: center; flex: 0 0 auto; border-radius: 7px; color: white; background: var(--prime); }
.prime-mark svg { width: 72%; height: 72%; }

/* Sidebar */
.sidebar { position: relative; z-index: 30; width: 248px; flex: 0 0 248px; height: 100%; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--sidebar); user-select: none; }
.sidebar__titlebar { height: 52px; flex: 0 0 52px; display: flex; align-items: center; gap: 7px; padding-right: 8px; }
.sidebar__titlebar .traffic-light-clearance { width: 70px; flex-basis: 70px; }
.sidebar__titlebar strong { font-size: 12.5px; font-weight: 570; }
.sidebar__title-actions { display: flex; margin-left: auto; gap: 1px; }
.sidebar__primary { padding: 5px 8px 7px; display: flex; flex-direction: column; gap: 1px; border-bottom: 1px solid var(--border); }
.sidebar__primary > button, .sidebar__footer > button { width: 100%; height: 32px; display: flex; align-items: center; gap: 9px; padding: 0 8px; border-radius: 7px; color: var(--text-secondary); background: transparent; text-align: left; }
.sidebar__primary > button:hover, .sidebar__footer > button:hover, .sidebar__primary > button.is-active, .sidebar__footer > button.is-active { color: var(--text); background: var(--surface-hover); }
.sidebar__primary > button span:not(.nav-count), .sidebar__footer > button span { flex: 1; }
.sidebar__primary kbd, .sidebar__footer kbd { opacity: 0; transition: opacity 130ms ease-out; }
.sidebar__primary button:hover kbd, .sidebar__footer button:hover kbd { opacity: 1; }
.nav-count { min-width: 18px; height: 18px; display: grid; place-items: center; padding: 0 5px; border-radius: 9px; color: var(--prime); background: var(--prime-soft); font-size: 10.5px; font-weight: 650; }
.sidebar-search { height: 31px; display: flex; align-items: center; gap: 6px; margin: 3px 0 5px; padding: 0 7px; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--canvas); color: var(--text-tertiary); }
.sidebar-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; font-size: 12px; }
.sidebar-search button { width: 18px; height: 18px; padding: 0; color: var(--text-tertiary); background: transparent; }
.sidebar__scroll { flex: 1; min-height: 0; overflow: auto; padding: 8px; }
.sidebar__section-heading { height: 28px; display: flex; align-items: center; justify-content: space-between; padding: 0 4px 0 8px; color: var(--text-tertiary); font-size: 11px; font-weight: 540; }
.sidebar__empty { margin: 12px 8px; color: var(--text-tertiary); font-size: 12px; }
.project-group { margin-bottom: 5px; }
.project-row { height: 34px; display: flex; align-items: center; padding: 0 3px; border-radius: 7px; color: var(--text-secondary); }
.project-row:hover { background: var(--surface-hover); }
.project-row.is-selected { color: var(--text); background: var(--surface-selected); }
.project-row__collapse { width: 21px; height: 28px; display: grid; place-items: center; padding: 0; color: var(--text-tertiary); background: transparent; }
.project-row__main { min-width: 0; height: 100%; flex: 1; display: flex; align-items: center; gap: 7px; padding: 0; color: inherit; background: transparent; text-align: left; }
.project-row__main span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 510; }
.row-action { opacity: 0; }
.project-row:hover .row-action { opacity: 1; }
.session-list { padding-left: 20px; margin-top: 1px; }
.session-row { width: 100%; min-height: 37px; display: flex; align-items: flex-start; gap: 7px; padding: 5px 6px; border-radius: 7px; color: var(--text-secondary); background: transparent; text-align: left; }
.session-row:hover { background: var(--surface-hover); }
.session-row.is-selected { color: var(--text); background: var(--surface-selected); }
.session-row > .status-dot { margin-top: 5px; }
.session-row__text { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.session-row__title, .session-row__meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-row__title { color: var(--text); font-size: 12px; }
.session-row__meta { color: var(--text-tertiary); font-size: 10.5px; }
.session-row--empty { min-height: 30px; align-items: center; color: var(--text-tertiary); font-size: 11.5px; }
.status-dot { width: 7px; height: 7px; display: inline-block; flex: 0 0 auto; border-radius: 50%; background: var(--text-tertiary); }
.status-dot--running { background: var(--prime); animation: status-pulse 1.6s ease-in-out infinite; }
.status-dot--waiting { background: var(--warning); }
.status-dot--complete, .status-dot--idle { background: var(--success); }
.status-dot--failed { background: var(--danger); }
.status-dot--unknown { background: var(--text-tertiary); }
.unread-dot { width: 5px; height: 5px; flex: 0 0 auto; margin-top: 6px; border-radius: 50%; background: var(--prime); }
.sidebar__footer { flex: 0 0 auto; padding: 7px 8px 9px; border-top: 1px solid var(--border); }

/* Transcript */
.transcript { position: absolute; inset: 0; overflow-y: auto; padding: 30px 0 170px; }
.transcript__inner { width: min(100%, 760px); min-height: 100%; margin: 0 auto; padding: 0 24px; }
.transcript-loading { display: flex; align-items: center; justify-content: center; gap: 7px; padding: 40px; color: var(--text-tertiary); }
.session-welcome { max-width: 520px; margin: min(18vh, 140px) auto 0; display: flex; flex-direction: column; align-items: center; text-align: center; }
.session-welcome h1 { margin: 17px 0 7px; font-size: 24px; line-height: 1.2; font-weight: 560; letter-spacing: -.018em; }
.session-welcome p { max-width: 460px; margin: 0; color: var(--text-secondary); font-size: 13.5px; line-height: 1.55; }
.prompt-suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: 7px; margin-top: 22px; }
.prompt-suggestions button { min-height: 31px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-secondary); background: var(--surface-raised); }
.prompt-suggestions button:hover { color: var(--text); background: var(--surface-hover); }
.message { width: 100%; margin-bottom: 26px; }
.message--user { display: flex; justify-content: flex-end; padding-left: 14%; }
.user-bubble { max-width: 88%; padding: 9px 13px; border-radius: 15px; border-bottom-right-radius: 5px; background: var(--surface-subtle); color: var(--text); font-size: 14px; line-height: 1.55; }
.message--assistant { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 12px; }
.assistant-mark { padding-top: 1px; }
.message__content { min-width: 0; font-size: 14px; line-height: 1.62; }
.prose { margin: 0 0 15px; white-space: normal; }
.prose:last-child { margin-bottom: 0; }
.thinking-block { margin: 5px 0 10px; color: var(--text-secondary); }
.thinking-block > button { min-height: 27px; display: inline-flex; align-items: center; gap: 6px; padding: 0 4px; border-radius: 5px; color: var(--text-secondary); background: transparent; font-size: 12px; }
.thinking-block > button:hover { color: var(--text); background: var(--surface-hover); }
.thinking-block__body { margin: 3px 0 8px 5px; padding: 5px 10px; border-left: 2px solid var(--border-strong); color: var(--text-tertiary); font-size: 12.5px; line-height: 1.55; }
.tool-card { margin: 6px 0; border: 1px solid var(--border); border-radius: 9px; background: var(--surface-subtle); overflow: hidden; }
.tool-card__summary { width: 100%; min-height: 34px; display: flex; align-items: center; gap: 7px; padding: 0 9px; color: var(--text-secondary); background: transparent; text-align: left; }
.tool-card__summary:hover { background: var(--surface-hover); }
.tool-card__status { width: 16px; height: 16px; display: grid; place-items: center; flex: 0 0 auto; border-radius: 50%; }
.tool-card__status.is-done { color: var(--success); background: var(--success-soft); }
.tool-card__status.is-running { color: var(--prime); }
.tool-card__status.is-error { color: var(--danger); background: var(--danger-soft); }
.tool-card__label { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text); font-size: 12px; font-weight: 520; }
.tool-card__duration { color: var(--text-tertiary); font: 10.5px/1.2 "SFMono-Regular", "SF Mono", Menlo, monospace; }
.tool-card__output, .standalone-output { max-height: 230px; margin: 0; padding: 9px 12px; overflow: auto; border-top: 1px solid var(--border); background: var(--canvas); color: var(--text-secondary); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.standalone-output { border: 1px solid var(--border); border-radius: 8px; }
.standalone-output.is-error { color: var(--danger); background: var(--danger-soft); }
.image-part { padding: 20px; border: 1px solid var(--border); border-radius: 10px; color: var(--text-tertiary); text-align: center; }
.changes-card { width: 100%; min-height: 57px; display: flex; align-items: center; gap: 10px; margin: 12px 0 9px; padding: 9px 11px; border: 1px solid var(--border); border-radius: 10px; color: var(--text); background: var(--surface-raised); text-align: left; }
.changes-card:hover { background: var(--surface-subtle); border-color: var(--border-strong); }
.changes-card__icon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 7px; color: var(--success); background: var(--success-soft); }
.changes-card__text { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.changes-card__text strong { font-size: 12.5px; font-weight: 560; }
.changes-card__text small { color: var(--text-tertiary); font-size: 10.5px; }
.diff-count { padding: 1px 5px; border-radius: 4px; font: 10.5px/1.5 "SFMono-Regular", Menlo, monospace; }
.diff-count--add { color: var(--success); background: var(--diff-add); }
.diff-count--remove { color: var(--danger); background: var(--diff-remove); }
.streaming-state { display: flex; align-items: center; gap: 7px; margin-top: 10px; color: var(--text-tertiary); font-size: 11.5px; }
.streaming-cursor { width: 6px; height: 14px; border-radius: 1px; background: var(--prime); animation: cursor-blink 1s steps(2) infinite; }
.message-actions { min-height: 26px; display: flex; align-items: center; gap: 4px; margin-top: 5px; opacity: 0; transition: opacity 130ms ease-out; }
.message:hover .message-actions { opacity: 1; }
.message-actions button, .message-actions span { min-height: 23px; display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; border-radius: 5px; color: var(--text-tertiary); background: transparent; font-size: 10.5px; }
.message-actions button:hover { color: var(--text-secondary); background: var(--surface-hover); }
.message-actions span { margin-left: auto; }
.message--system { margin: 13px auto; padding: 8px 11px; border-radius: 8px; color: var(--danger); background: var(--danger-soft); font-size: 12px; }

/* Composer */
.composer-wrap { position: absolute; z-index: 10; left: 24px; right: 24px; bottom: 13px; width: min(calc(100% - 48px), 760px); margin: 0 auto; }
.composer { position: relative; min-height: 104px; display: flex; flex-direction: column; padding: 7px; border: 1px solid var(--border-strong); border-radius: 14px; background: var(--surface-raised); box-shadow: 0 1px 3px rgba(0,0,0,.06); }
.composer:focus-within { border-color: color-mix(in srgb, var(--border-strong) 65%, var(--focus)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--focus) 30%, transparent); }
.composer--busy { border-color: color-mix(in srgb, var(--prime) 33%, var(--border-strong)); }
.composer > textarea { width: 100%; min-height: 55px; max-height: 150px; flex: 1; resize: none; padding: 6px 9px; border: 0; outline: 0; background: transparent; font-size: 14px; line-height: 1.5; }
.composer__footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.composer__controls, .composer__actions { display: flex; align-items: center; gap: 3px; min-width: 0; }
.select-control { height: 28px; display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; border: 1px solid var(--border); border-radius: 7px; color: var(--text-secondary); background: var(--surface-subtle); }
.select-control:hover { color: var(--text); background: var(--surface-hover); }
.select-control select { max-width: 122px; border: 0; outline: 0; color: inherit; background: transparent; appearance: none; font-size: 11px; font-weight: 520; }
.select-control--compact { height: 26px; border-radius: 999px; }
.permissions-chip { height: 26px; display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-secondary); background: var(--surface-subtle); font-size: 10.5px; }
.send-button { width: 30px; height: 30px; display: grid; place-items: center; flex: 0 0 auto; padding: 0; border-radius: 50%; color: var(--canvas); background: var(--text); }
.send-button:hover { opacity: .88; }
.send-button:disabled { color: var(--text-tertiary); background: var(--surface-selected); opacity: 1; }
.send-button--stop { color: white; background: var(--danger); }
.composer-note { margin: 5px 0 0; color: var(--text-tertiary); font-size: 9.5px; text-align: center; }
.composer-menu { position: absolute; z-index: 50; left: 7px; bottom: 47px; width: min(360px, calc(100% - 14px)); max-height: 260px; padding: 5px; overflow: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-raised); box-shadow: var(--shadow-popover); }
.composer-menu button { width: 100%; min-height: 44px; display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 7px; color: var(--text-secondary); background: transparent; text-align: left; }
.composer-menu button:hover { background: var(--surface-hover); }
.composer-menu button > span { min-width: 0; display: flex; flex-direction: column; }
.composer-menu strong { color: var(--text); font-size: 12px; font-weight: 540; }
.composer-menu small { overflow: hidden; color: var(--text-tertiary); font-size: 10.5px; white-space: nowrap; text-overflow: ellipsis; }

/* Inspector */
.inspector { position: relative; z-index: 10; width: clamp(420px, 46vw, 660px); min-width: 420px; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--canvas); animation: panel-in 150ms ease-out; }
.inspector__tabs { height: 42px; flex: 0 0 42px; display: flex; align-items: stretch; gap: 2px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--border); background: var(--canvas); }
.inspector__tabs > button:not(.icon-button) { position: relative; min-width: 58px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 0 8px; color: var(--text-secondary); background: transparent; font-size: 11.5px; }
.inspector__tabs > button:not(.icon-button):hover { color: var(--text); }
.inspector__tabs > button.is-active { color: var(--text); font-weight: 550; }
.inspector__tabs > button.is-active::after { position: absolute; left: 8px; right: 8px; bottom: -1px; height: 1.5px; content: ""; background: var(--text); }
.inspector__tabs > button span { min-width: 16px; height: 16px; display: grid; place-items: center; padding: 0 4px; border-radius: 8px; color: var(--text-secondary); background: var(--surface-hover); font-size: 9.5px; }
.inspector__tab-spacer { flex: 1; }
.inspector__tabs > .icon-button { align-self: center; }
.inspector__body { flex: 1; min-height: 0; overflow: hidden; }
.inspector-scroll { height: 100%; overflow: auto; }
.summary-panel { padding: 22px; }
.summary-hero { padding-bottom: 22px; border-bottom: 1px solid var(--border); }
.run-state { min-height: 24px; display: inline-flex; align-items: center; gap: 5px; padding: 0 7px; border-radius: 6px; color: var(--success); background: var(--success-soft); font-size: 10.5px; font-weight: 550; }
.run-state.is-running { color: var(--prime); background: var(--prime-soft); }
.summary-hero h2 { margin: 14px 0 6px; font-size: 18px; line-height: 1.25; font-weight: 560; letter-spacing: -.01em; }
.summary-hero p { margin: 0; color: var(--text-secondary); font-size: 12.5px; line-height: 1.55; }
.summary-section { padding: 19px 0; border-bottom: 1px solid var(--border); }
.summary-section h3 { margin: 0 0 10px; color: var(--text-secondary); font-size: 11px; font-weight: 550; }
.detail-list { margin: 0; }
.detail-list > div { min-height: 30px; display: grid; grid-template-columns: 116px minmax(0, 1fr); align-items: center; gap: 12px; }
.detail-list dt { color: var(--text-tertiary); font-size: 11.5px; }
.detail-list dd { min-width: 0; display: flex; align-items: center; gap: 5px; margin: 0; font-size: 11.5px; text-align: right; justify-content: flex-end; }
.progress-list { display: flex; flex-direction: column; gap: 9px; }
.progress-list div { display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 12px; }
.progress-list div svg { color: var(--success); }
.progress-list div.is-current svg { color: var(--prime); }
.context-meter > div { display: flex; justify-content: space-between; margin-bottom: 6px; color: var(--text-secondary); font-size: 11px; }
.context-meter progress { width: 100%; height: 5px; display: block; overflow: hidden; border: 0; border-radius: 3px; background: var(--surface-selected); appearance: none; }
.context-meter progress::-webkit-progress-bar { background: var(--surface-selected); }
.context-meter progress::-webkit-progress-value { background: var(--prime); border-radius: 3px; }
.context-meter small { display: block; margin-top: 7px; color: var(--text-tertiary); font-size: 10.5px; }

/* Changes */
.changes-panel { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.changes-toolbar { min-height: 45px; display: flex; align-items: center; justify-content: space-between; padding: 0 10px 0 14px; border-bottom: 1px solid var(--border); }
.changes-toolbar > div { display: flex; align-items: center; gap: 8px; min-width: 0; }
.changes-toolbar strong { display: flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 550; }
.changes-toolbar small { padding-left: 8px; border-left: 1px solid var(--border); color: var(--text-tertiary); font-size: 10.5px; }
.changes-scopes { min-height: 43px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.segmented { height: 28px; display: inline-flex; align-items: center; padding: 2px; border-radius: 7px; background: var(--surface-hover); }
.segmented button { height: 24px; padding: 0 8px; border-radius: 5px; color: var(--text-secondary); background: transparent; font-size: 11px; }
.segmented button.is-active { color: var(--text); background: var(--surface-raised); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
.changes-body { min-height: 0; flex: 1; display: grid; grid-template-columns: 190px minmax(0, 1fr); }
.file-changes { overflow: auto; border-right: 1px solid var(--border); }
.file-changes__header { height: 35px; display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 10px; border-bottom: 1px solid var(--border); color: var(--text-tertiary); font-size: 10px; }
.file-changes__header button { padding: 4px; color: var(--text-secondary); background: transparent; font-size: 10px; }
.file-changes > button { width: 100%; min-height: 33px; display: grid; grid-template-columns: 14px minmax(0, 1fr) auto auto 16px; align-items: center; gap: 5px; padding: 0 7px 0 9px; color: var(--text-secondary); background: transparent; text-align: left; }
.file-changes > button:hover, .file-changes > button.is-selected { color: var(--text); background: var(--surface-hover); }
.file-changes > button span:nth-of-type(1) { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 10.5px; }
.file-changes small { font: 9px/1.2 "SFMono-Regular", Menlo, monospace; }
.file-changes .additions { color: var(--success); }
.file-changes .deletions { color: var(--danger); }
.file-status { color: var(--text-tertiary); font: 9px/1.2 "SFMono-Regular", Menlo, monospace; }
.file-changes__empty { margin: 16px 10px; color: var(--text-tertiary); font-size: 11px; text-align: center; }
.diff-pane { min-width: 0; overflow: auto; background: var(--canvas); }
.diff-header { position: sticky; z-index: 2; top: 0; height: 36px; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 8px; border-bottom: 1px solid var(--border); background: var(--surface-subtle); }
.diff-header > div { min-width: 0; display: flex; align-items: center; gap: 5px; }
.diff-header > div:first-child span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font: 10.5px/1.2 "SFMono-Regular", Menlo, monospace; }
.diff-header button { height: 24px; display: inline-flex; align-items: center; gap: 4px; padding: 0 5px; border-radius: 5px; color: var(--text-secondary); background: transparent; font-size: 9.5px; }
.diff-header button:hover { background: var(--surface-hover); }
.diff-header button.danger-action:hover { color: var(--danger); background: var(--danger-soft); }
.diff-view { min-width: max-content; margin: 0; padding: 7px 0 20px; font-size: 10.5px; line-height: 1.55; }
.diff-line { min-height: 17px; display: grid; grid-template-columns: 34px 18px minmax(360px, 1fr); }
.diff-line > i { padding-right: 7px; color: var(--text-tertiary); font-style: normal; text-align: right; user-select: none; opacity: .6; }
.diff-line > button { display: grid; place-items: center; padding: 0; color: transparent; background: transparent; }
.diff-line:hover > button { color: var(--text-tertiary); }
.diff-line > code { padding: 0 12px 0 4px; border: 0; border-radius: 0; background: transparent; white-space: pre; }
.diff-line--add { background: var(--diff-add); box-shadow: inset 2px 0 var(--diff-add-line); }
.diff-line--remove { background: var(--diff-remove); box-shadow: inset 2px 0 var(--diff-remove-line); }
.diff-line--hunk { color: var(--text-secondary); background: var(--surface-subtle); }
.diff-placeholder, .diff-loading { min-height: 180px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 9px; color: var(--text-tertiary); font-size: 11.5px; }

/* Browser */
.browser-panel { position: relative; height: 100%; display: flex; flex-direction: column; min-height: 0; }
.browser-toolbar { height: 43px; flex: 0 0 43px; display: flex; align-items: center; gap: 2px; padding: 0 7px; border-bottom: 1px solid var(--border); background: var(--surface-subtle); }
.address-field { min-width: 80px; height: 29px; flex: 1; display: flex; align-items: center; gap: 6px; margin: 0 4px; padding: 0 6px 0 9px; border: 1px solid var(--border); border-radius: 7px; color: var(--text-tertiary); background: var(--canvas); }
.address-field:focus-within { border-color: var(--focus); }
.address-field input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; font-size: 11px; text-align: center; }
.address-field button { width: 20px; height: 20px; display: grid; place-items: center; padding: 0; color: var(--text-tertiary); background: transparent; }
.annotation-active { color: var(--annotation) !important; background: color-mix(in srgb, var(--annotation) 13%, transparent) !important; }
.browser-viewport { position: relative; min-height: 0; flex: 1; overflow: hidden; background: #fff; }
.browser-webview { width: 100%; height: 100%; display: flex; border: 0; }
.browser-history { position: absolute; z-index: 30; top: 40px; left: 46px; right: 46px; max-height: 310px; overflow: auto; padding: 6px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-raised); box-shadow: var(--shadow-popover); }
.browser-history > div { height: 28px; display: flex; align-items: center; justify-content: space-between; padding: 0 7px; }
.browser-history strong { font-size: 11px; }
.browser-history > div button { color: var(--text-tertiary); background: transparent; font-size: 10px; }
.browser-history > button { width: 100%; height: 31px; display: flex; align-items: center; gap: 7px; padding: 0 7px; border-radius: 6px; color: var(--text-secondary); background: transparent; text-align: left; }
.browser-history > button:hover { background: var(--surface-hover); }
.browser-history > button span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 10.5px; }
.annotation-layer { position: absolute; inset: 0; z-index: 20; background: rgba(36,136,255,.035); cursor: crosshair; }
.annotation-target { position: absolute; left: 19%; top: 25%; width: 57%; height: 22%; border: 1.5px solid var(--annotation); border-radius: 3px; background: color-mix(in srgb, var(--annotation) 7%, transparent); }
.annotation-target > span { position: absolute; right: -10px; top: -10px; width: 20px; height: 20px; display: grid; place-items: center; border: 2px solid white; border-radius: 50%; color: white; background: var(--annotation); font-size: 10px; font-weight: 700; }
.annotation-popover { position: absolute; z-index: 3; top: calc(47% + 10px); left: 22%; width: min(310px, 66%); padding: 8px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-raised); box-shadow: var(--shadow-popover); cursor: default; }
.annotation-popover > div:first-child { display: flex; align-items: center; gap: 6px; height: 24px; color: var(--annotation); }
.annotation-popover > div:first-child strong { flex: 1; color: var(--text); font-size: 11px; }
.annotation-popover > div:first-child button { width: 20px; height: 20px; display: grid; place-items: center; color: var(--text-secondary); background: transparent; }
.annotation-popover textarea { width: 100%; min-height: 60px; margin-top: 4px; padding: 7px; resize: vertical; border: 1px solid var(--border); border-radius: 7px; outline: 0; background: var(--canvas); font-size: 11px; }
.annotation-popover > div:last-child { display: flex; justify-content: flex-end; gap: 5px; margin-top: 7px; }
.annotation-popover .button { min-height: 26px; font-size: 10.5px; }
.annotation-count { position: absolute; z-index: 10; left: 9px; bottom: 9px; height: 25px; display: flex; align-items: center; gap: 5px; padding: 0 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--annotation); background: var(--surface-raised); box-shadow: 0 2px 8px rgba(0,0,0,.1); font-size: 10px; }

/* Files */
.files-panel { height: 100%; display: flex; flex-direction: column; }
.files-search { height: 43px; flex: 0 0 43px; display: flex; align-items: center; gap: 6px; padding: 0 12px; border-bottom: 1px solid var(--border); color: var(--text-tertiary); }
.files-search input { width: 100%; height: 28px; border: 0; outline: 0; background: transparent; font-size: 11.5px; }
.file-tree { flex: 1; overflow: auto; padding: 7px; }
.tree-root, .file-tree > button { width: 100%; height: 30px; display: flex; align-items: center; gap: 6px; padding: 0 7px; border-radius: 6px; color: var(--text-secondary); background: transparent; text-align: left; }
.tree-root { color: var(--text); }
.tree-root strong { font-size: 11.5px; }
.file-tree > button { padding-left: 23px; }
.file-tree > button:hover { color: var(--text); background: var(--surface-hover); }
.file-tree > button span { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font: 10.5px/1.2 "SFMono-Regular", Menlo, monospace; }
.file-tree > button small { color: var(--text-tertiary); font-size: 9.5px; }
.tree-section { margin: 10px 7px 4px; color: var(--text-tertiary); font-size: 10px; font-weight: 550; }
.file-tree > p { padding: 20px; color: var(--text-tertiary); text-align: center; font-size: 11px; }

/* Terminal */
.terminal-drawer { height: clamp(260px, 34vh, 390px); flex: 0 0 clamp(260px, 34vh, 390px); display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--border-strong); background: var(--terminal-bg); animation: drawer-in 180ms ease-out; }
.terminal-toolbar { height: 37px; flex: 0 0 37px; display: flex; align-items: center; justify-content: space-between; padding: 0 7px; border-bottom: 1px solid #2e2e2c; color: #a8a8a3; background: #1e1e1d; }
.terminal-tabs, .terminal-actions { height: 100%; display: flex; align-items: center; gap: 2px; }
.terminal-tabs > button:not(.icon-button) { height: 29px; display: flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 6px; color: #a8a8a3; background: transparent; font-size: 11px; }
.terminal-tabs > button.is-active { color: #e3e3de; background: #2a2a28; }
.terminal-live-dot { width: 5px; height: 5px; border-radius: 50%; background: #777772; }
.terminal-live-dot.is-connected { background: #75c897; }
.terminal-toolbar .icon-button { color: #9a9a95; }
.terminal-toolbar .icon-button:hover { color: #eee; background: #2d2d2b; }
.terminal-cwd { max-width: 150px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding: 0 6px; font-size: 10px; }
.terminal-surface { flex: 1; min-height: 0; padding: 8px 7px 4px; overflow: hidden; }
.terminal-surface .xterm { height: 100%; }
.terminal-surface .xterm-viewport { scrollbar-width: thin; }

/* Shared pages */
.page { width: 100%; height: 100%; overflow: auto; background: var(--canvas); }
.page-container { width: min(100%, 1030px); margin: 0 auto; padding: 38px 34px 70px; }
.page-container--narrow { width: min(100%, 860px); }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 28px; }
.page-header h1 { margin: 0 0 5px; font-size: 24px; line-height: 1.2; font-weight: 560; letter-spacing: -.02em; }
.page-header p { margin: 0; color: var(--text-secondary); font-size: 13px; }
.page-tools { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
.page-tools > span { color: var(--text-tertiary); font-size: 10.5px; }
.page-search { width: min(360px, 100%); height: 31px; display: flex; align-items: center; gap: 7px; padding: 0 9px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-tertiary); background: var(--surface-subtle); }
.page-search:focus-within { border-color: var(--focus); background: var(--canvas); }
.page-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; font-size: 11.5px; }
.page-search--small { width: 220px; }
.page-tools--activity { align-items: center; }
.empty-state { height: 100%; min-height: 280px; display: flex; align-items: center; justify-content: center; flex-direction: column; padding: 32px; text-align: center; }
.empty-state__icon { width: 48px; height: 48px; display: grid; place-items: center; margin-bottom: 13px; border: 1px solid var(--border); border-radius: 12px; color: var(--text-secondary); background: var(--surface-subtle); }
.empty-state h2 { margin: 0 0 5px; font-size: 15px; font-weight: 560; }
.empty-state p { max-width: 380px; margin: 0; color: var(--text-tertiary); font-size: 12px; }
.empty-state__action { margin-top: 14px; }
.project-library { display: flex; flex-direction: column; }
.project-item { min-height: 90px; display: flex; align-items: center; gap: 13px; padding: 13px 9px; border-bottom: 1px solid var(--border); }
.project-item:hover { background: var(--surface-subtle); }
.project-item__icon { width: 40px; height: 40px; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--border); border-radius: 9px; color: var(--prime); background: var(--surface-raised); }
.project-item__body { min-width: 0; flex: 1; }
.project-item__body > div:first-child { display: flex; align-items: center; gap: 6px; }
.project-item h2 { margin: 0; font-size: 13.5px; font-weight: 560; }
.project-item p { margin: 2px 0 6px; overflow: hidden; color: var(--text-tertiary); font: 10.5px/1.4 "SFMono-Regular", Menlo, monospace; white-space: nowrap; text-overflow: ellipsis; }
.project-item__body > div:last-child { display: flex; flex-wrap: wrap; gap: 12px; color: var(--text-secondary); font-size: 10.5px; }
.project-item__body > div:last-child span { display: flex; align-items: center; gap: 4px; }
.project-item__actions { display: flex; opacity: 0; }
.project-item:hover .project-item__actions { opacity: 1; }
.activity-list { display: flex; flex-direction: column; }
.activity-list > button { width: 100%; min-height: 78px; display: flex; align-items: flex-start; gap: 12px; padding: 13px 8px; border-bottom: 1px solid var(--border); color: inherit; background: transparent; text-align: left; }
.activity-list > button:hover { background: var(--surface-subtle); }
.activity-icon { width: 30px; height: 30px; display: grid; place-items: center; flex: 0 0 auto; border-radius: 8px; color: var(--success); background: var(--success-soft); }
.activity-icon--running { color: var(--prime); background: var(--prime-soft); }
.activity-icon--waiting, .activity-icon--failed { color: var(--warning); background: var(--warning-soft); }
.activity-main { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.activity-main > span:first-child { display: flex; align-items: center; gap: 7px; }
.activity-main strong { font-size: 12.5px; font-weight: 550; }
.activity-main i { padding: 1px 5px; border-radius: 4px; color: var(--prime); background: var(--prime-soft); font-size: 9px; font-style: normal; }
.activity-main small { margin: 2px 0 6px; overflow: hidden; color: var(--text-secondary); white-space: nowrap; text-overflow: ellipsis; font-size: 11px; }
.activity-main > span:last-child { display: flex; gap: 12px; color: var(--text-tertiary); font-size: 10px; }
.activity-main > span:last-child span { display: flex; align-items: center; gap: 3px; }
.activity-status { align-self: center; padding: 2px 6px; border-radius: 5px; color: var(--text-secondary); background: var(--surface-hover); font-size: 9.5px; text-transform: capitalize; }
.activity-status--running { color: var(--prime); background: var(--prime-soft); }
.activity-status--waiting, .activity-status--failed { color: var(--warning); background: var(--warning-soft); }
.schedule-list { display: flex; flex-direction: column; }
.schedule-list article { min-height: 100px; display: flex; align-items: flex-start; gap: 13px; padding: 15px 8px; border-bottom: 1px solid var(--border); }
.schedule-icon { width: 34px; height: 34px; display: grid; place-items: center; flex: 0 0 auto; border-radius: 8px; color: var(--prime); background: var(--prime-soft); }
.schedule-icon--paused { color: var(--text-tertiary); background: var(--surface-hover); }
.schedule-main { min-width: 0; flex: 1; }
.schedule-main > div:first-child { display: flex; align-items: center; gap: 7px; }
.schedule-main h2 { margin: 0; font-size: 12.5px; font-weight: 560; }
.schedule-state { padding: 1px 5px; border-radius: 4px; color: var(--success); background: var(--success-soft); font-size: 9px; text-transform: capitalize; }
.schedule-state--paused { color: var(--text-tertiary); background: var(--surface-hover); }
.schedule-main p { margin: 4px 0 8px; color: var(--text-secondary); font-size: 11.5px; }
.schedule-main > div:last-child { display: flex; flex-wrap: wrap; gap: 13px; color: var(--text-tertiary); font-size: 10px; }
.schedule-main > div:last-child span { display: flex; align-items: center; gap: 4px; }
.schedule-actions { display: flex; opacity: 0; }
.schedule-list article:hover .schedule-actions { opacity: 1; }

/* Plugin directory */
.plugin-container { width: min(100%, 1080px); }
.plugin-header { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
.plugin-header .eyebrow { color: var(--prime); font-size: 10.5px; font-weight: 600; }
.plugin-header h1 { margin: 5px 0 6px; font-size: 24px; line-height: 1.2; font-weight: 560; letter-spacing: -.02em; }
.plugin-header p { margin: 0; color: var(--text-secondary); }
.plugin-header > div:last-child { display: flex; gap: 6px; }
.directory-tabs { display: flex; gap: 18px; height: 46px; margin-top: 24px; border-bottom: 1px solid var(--border); }
.directory-tabs button { position: relative; padding: 0 1px; color: var(--text-secondary); background: transparent; font-size: 12px; }
.directory-tabs button.is-active { color: var(--text); font-weight: 550; }
.directory-tabs button.is-active::after { position: absolute; left: 0; right: 0; bottom: -1px; height: 1.5px; content: ""; background: var(--text); }
.feature-strip { min-height: 150px; display: grid; grid-template-columns: 44px minmax(0, 1fr) minmax(220px, .65fr); gap: 16px; margin: 22px 0; padding: 21px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface-subtle); }
.feature-strip__mark { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 9px; color: var(--prime); background: var(--canvas); }
.feature-strip > div:nth-child(2) > span { color: var(--text-tertiary); font-size: 10px; }
.feature-strip h2 { margin: 3px 0 5px; font-size: 16px; font-weight: 560; }
.feature-strip p { max-width: 520px; margin: 0 0 9px; color: var(--text-secondary); font-size: 11.5px; }
.feature-strip button { display: inline-flex; align-items: center; gap: 4px; padding: 0; color: var(--text); background: transparent; font-size: 10.5px; font-weight: 550; }
.feature-strip__steps { display: flex; justify-content: center; flex-direction: column; gap: 9px; padding-left: 19px; border-left: 1px solid var(--border); }
.feature-strip__steps span { display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 10.5px; }
.feature-strip__steps i { width: 18px; height: 18px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 50%; color: var(--text-tertiary); background: var(--canvas); font-size: 8px; font-style: normal; }
.directory-tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 7px; }
.directory-tools select { height: 31px; padding: 0 26px 0 9px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-secondary); background: var(--surface-subtle); font-size: 11px; }
.directory-heading { display: flex; align-items: center; justify-content: space-between; margin-top: 27px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.directory-heading h2 { margin: 0; font-size: 13px; font-weight: 560; }
.directory-heading span { color: var(--text-tertiary); font-size: 10px; }
.directory-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 22px; }
.directory-list article { min-width: 0; min-height: 82px; display: flex; align-items: center; gap: 11px; padding: 11px 5px; border-bottom: 1px solid var(--border); }
.directory-icon { width: 34px; height: 34px; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--border); border-radius: 8px; color: var(--prime); background: var(--surface-subtle); }
.directory-icon--mcp { color: var(--annotation); }
.directory-icon--prompt { color: var(--warning); }
.directory-list article > div { min-width: 0; flex: 1; }
.directory-list article > div > div { display: flex; align-items: center; gap: 6px; }
.directory-list h3 { margin: 0; font-size: 12px; font-weight: 560; }
.directory-list article > div > div span { padding: 1px 4px; border-radius: 3px; color: var(--text-tertiary); background: var(--surface-hover); font-size: 8.5px; text-transform: capitalize; }
.directory-list p { margin: 3px 0 0; display: -webkit-box; overflow: hidden; color: var(--text-secondary); font-size: 10.5px; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.plugin-toggle { width: 27px; height: 27px; display: grid; place-items: center; flex: 0 0 auto; border: 1px solid var(--border-strong); border-radius: 7px; color: var(--text-secondary); background: var(--surface-raised); }
.plugin-toggle:hover { background: var(--surface-hover); }
.plugin-toggle.is-enabled { color: var(--success); border-color: transparent; background: var(--success-soft); }
.install-output { max-height: 140px; overflow: auto; margin: 12px 0 0; padding: 9px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface-subtle); font-size: 10.5px; white-space: pre-wrap; }

/* Settings */
.settings-page { height: 100%; display: grid; grid-template-columns: 190px minmax(0, 1fr); }
.settings-nav { padding: 20px 10px; border-right: 1px solid var(--border); background: var(--surface-subtle); }
.settings-nav button { width: 100%; height: 33px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border-radius: 7px; color: var(--text-secondary); background: transparent; text-align: left; }
.settings-nav button:hover, .settings-nav button.is-active { color: var(--text); background: var(--surface-hover); }
.settings-nav button span { flex: 1; }
.settings-nav button > svg:last-child { opacity: 0; }
.settings-nav button.is-active > svg:last-child { opacity: 1; color: var(--text-tertiary); }
.settings-content { overflow: auto; }
.settings-content__inner { width: min(100%, 720px); margin: 0 auto; padding: 36px 32px 70px; }
.settings-content header { margin-bottom: 28px; }
.settings-content header h1 { margin: 0 0 5px; font-size: 22px; line-height: 1.2; font-weight: 560; letter-spacing: -.015em; }
.settings-content header p { margin: 0; color: var(--text-secondary); }
.settings-group { margin-bottom: 25px; border-top: 1px solid var(--border); }
.settings-group > h2 { margin: -8px 0 4px; display: table; padding-right: 8px; color: var(--text-secondary); background: var(--canvas); font-size: 10.5px; font-weight: 560; }
.settings-toggle, .settings-row, .danger-row { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--border); }
.settings-toggle > span, .settings-row > span, .danger-row > span { min-width: 0; display: flex; flex-direction: column; }
.settings-toggle strong, .settings-row strong, .danger-row strong { font-size: 12px; font-weight: 540; }
.settings-toggle small, .settings-row small, .danger-row small { margin-top: 2px; color: var(--text-tertiary); font-size: 10.5px; }
.settings-toggle input { position: absolute; opacity: 0; pointer-events: none; }
.settings-toggle > i { width: 34px; height: 20px; position: relative; flex: 0 0 auto; border-radius: 10px; background: var(--surface-selected); transition: background 150ms ease-out; }
.settings-toggle > i span { position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--surface-raised); box-shadow: 0 1px 2px rgba(0,0,0,.18); transition: transform 150ms ease-out; }
.settings-toggle input:checked + i { background: var(--prime); }
.settings-toggle input:checked + i span { transform: translateX(14px); }
.settings-toggle input:focus-visible + i { outline: 2px solid var(--focus); outline-offset: 2px; }
.settings-row select, .settings-row input, .field input, .field textarea, .field select { height: 32px; min-width: 180px; padding: 0 8px; border: 1px solid var(--border-strong); border-radius: 7px; outline: 0; background: var(--surface-raised); font-size: 11.5px; }
.settings-row--stack { align-items: flex-start; flex-direction: column; gap: 9px; padding: 13px 0; }
.settings-row--stack input { width: 100%; }
.theme-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding-top: 12px; }
.theme-options button { min-height: 84px; display: grid; grid-template-columns: 1fr auto; grid-template-rows: 1fr auto; gap: 5px; padding: 9px; border: 1px solid var(--border); border-radius: 9px; color: var(--text-secondary); background: var(--surface-subtle); text-align: left; }
.theme-options button > span { grid-column: 1 / -1; display: grid; place-items: center; border-radius: 6px; color: var(--text-secondary); background: var(--canvas); }
.theme-options button strong { font-size: 10.5px; font-weight: 520; }
.theme-options button.is-active { color: var(--text); border-color: var(--prime); }
.theme-options button.is-active > svg { color: var(--prime); }
.runtime-card { min-height: 74px; display: flex; align-items: center; gap: 10px; padding: 11px 0; border-bottom: 1px solid var(--border); }
.runtime-card > span { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 8px; color: var(--danger); background: var(--danger-soft); }
.runtime-card > span.is-online { color: var(--success); background: var(--success-soft); }
.runtime-card > div { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.runtime-card strong { font-size: 12px; font-weight: 540; }
.runtime-card small { overflow: hidden; color: var(--text-tertiary); font: 9.5px/1.4 "SFMono-Regular", Menlo, monospace; white-space: nowrap; text-overflow: ellipsis; }
.runtime-card code { font-size: 9.5px; }
.info-row { display: flex; align-items: flex-start; gap: 9px; padding: 15px 0; border-bottom: 1px solid var(--border); color: var(--text-secondary); }
.info-row > div { display: flex; flex-direction: column; }
.info-row strong { color: var(--text); font-size: 12px; font-weight: 540; }
.info-row small { margin-top: 2px; color: var(--text-tertiary); font-size: 10.5px; }
.shortcut-row { min-height: 52px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); }
.shortcut-row span { display: flex; align-items: center; gap: 7px; }
.shortcut-row kbd { padding: 4px 7px; border: 1px solid var(--border); border-bottom-color: var(--border-strong); border-radius: 5px; background: var(--surface-subtle); }
.about-card { display: flex; align-items: center; gap: 12px; margin-bottom: 30px; }
.about-mark { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 11px; color: white; background: var(--prime); }
.about-card h2 { margin: 0; font-size: 15px; font-weight: 560; }
.about-card p { margin: 2px 0 0; color: var(--text-tertiary); font-size: 10.5px; }

/* Modal and palette */
.modal-backdrop, .palette-backdrop { position: fixed; z-index: 200; inset: 0; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(12,12,11,.32); backdrop-filter: blur(2px); animation: fade-in 130ms ease-out; }
.modal { width: min(100%, 500px); overflow: hidden; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--surface-raised); box-shadow: var(--shadow-popover); animation: modal-in 150ms ease-out; }
.modal__header { height: 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px 0 16px; border-bottom: 1px solid var(--border); }
.modal__header h2 { margin: 0; font-size: 14px; font-weight: 560; }
.modal__body { padding: 16px; color: var(--text-secondary); font-size: 12px; }
.modal__body > p:first-child { margin-top: 0; }
.modal__body > p:last-child { margin-bottom: 0; }
.modal__footer { min-height: 53px; display: flex; align-items: center; justify-content: flex-end; gap: 7px; padding: 9px 12px; border-top: 1px solid var(--border); background: var(--surface-subtle); }
.modal-intro, .muted-copy { color: var(--text-secondary); font-size: 11.5px; line-height: 1.55; }
.field { display: flex; flex-direction: column; gap: 6px; margin-top: 13px; }
.field > span { color: var(--text); font-size: 11px; font-weight: 540; }
.field input, .field textarea, .field select { width: 100%; min-width: 0; }
.field textarea { height: auto; padding: 8px; resize: vertical; }
.command-palette { width: min(100%, 580px); align-self: flex-start; margin-top: min(14vh, 110px); overflow: hidden; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--surface-raised); box-shadow: var(--shadow-popover); animation: palette-in 150ms ease-out; }
.command-search { height: 48px; display: flex; align-items: center; gap: 9px; padding: 0 12px; border-bottom: 1px solid var(--border); color: var(--text-tertiary); }
.command-search input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; font-size: 13px; }
.command-search > button { padding: 0; background: transparent; }
.command-search kbd { padding: 3px 5px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-subtle); }
.command-results { max-height: min(420px, 60vh); overflow: auto; padding: 6px; }
.command-section-label { height: 24px; display: flex; align-items: center; padding: 0 7px; color: var(--text-tertiary); font-size: 9.5px; }
.command-results > button { width: 100%; min-height: 44px; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 7px; padding: 4px 7px; border-radius: 7px; color: var(--text-secondary); background: transparent; text-align: left; }
.command-results > button.is-active { color: var(--text); background: var(--surface-hover); }
.command-results > button > span:first-child { width: 26px; height: 26px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-raised); }
.command-results > button > span:nth-child(2) { min-width: 0; display: flex; flex-direction: column; }
.command-results strong { font-size: 11.5px; font-weight: 540; }
.command-results small { overflow: hidden; color: var(--text-tertiary); font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }
.command-results > p { padding: 26px; color: var(--text-tertiary); text-align: center; }
.command-palette footer { height: 33px; display: flex; align-items: center; gap: 13px; padding: 0 12px; border-top: 1px solid var(--border); color: var(--text-tertiary); background: var(--surface-subtle); font-size: 9.5px; }
.toast { position: fixed; z-index: 300; left: 50%; bottom: 18px; max-width: min(520px, calc(100% - 32px)); min-height: 36px; display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 12px; transform: translateX(-50%); border: 1px solid var(--border-strong); border-radius: 9px; color: var(--text); background: var(--surface-raised); box-shadow: var(--shadow-popover); font-size: 11.5px; }
.toast button { width: 22px; height: 22px; border-radius: 5px; color: var(--text-tertiary); background: transparent; }
.toast button:hover { background: var(--surface-hover); }
.panel-scrim { display: none; }

.spin { animation: spin .9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes status-pulse { 0%,100% { opacity: 1; } 50% { opacity: .42; } }
@keyframes cursor-blink { 0%,45% { opacity: 1; } 50%,100% { opacity: .15; } }
@keyframes panel-in { from { opacity: 0; transform: translateX(8px); } }
@keyframes drawer-in { from { opacity: .7; transform: translateY(8px); } }
@keyframes fade-in { from { opacity: 0; } }
@keyframes modal-in { from { opacity: 0; transform: translateY(5px) scale(.99); } }
@keyframes palette-in { from { opacity: 0; transform: translateY(-5px) scale(.995); } }
.reduce-motion *, .reduce-motion *::before, .reduce-motion *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; scroll-behavior: auto !important; }

@container (max-width: 620px) {
  .permissions-chip { display: none; }
  .composer__controls { min-width: 0; }
  .select-control select { max-width: 106px; }
}

@container (max-width: 490px) {
  .select-control select { max-width: 84px; }
  .composer-note { display: none; }
}

@media (max-width: 1180px) {
  .inspector { width: 46%; min-width: 390px; }
  .conversation-pane { min-width: 400px; }
  .changes-body { grid-template-columns: 155px minmax(0, 1fr); }
  .file-changes small { display: none; }
  .permissions-chip { display: none; }
  .feature-strip { grid-template-columns: 42px minmax(0,1fr); }
  .feature-strip__steps { display: none; }
}

@media (max-width: 980px) {
  .sidebar { position: fixed; inset: 0 auto 0 0; width: 268px; flex-basis: 268px; box-shadow: 12px 0 30px rgba(0,0,0,.13); animation: sidebar-in 160ms ease-out; }
  .panel-scrim { position: fixed; z-index: 20; inset: 52px 0 0; display: block; padding: 0; background: rgba(10,10,9,.18); }
  .panel-scrim--sidebar { inset: 0; z-index: 19; }
  .inspector { position: fixed; z-index: 80; top: 52px; right: 0; bottom: 0; width: min(620px, 88vw); min-width: 0; box-shadow: -12px 0 30px rgba(0,0,0,.14); }
  .panel-scrim--inspector { z-index: 70; }
  .conversation-pane { min-width: 0; }
  .title-toolbar__identity { justify-content: center; }
  .directory-list { grid-template-columns: 1fr; }
  @keyframes sidebar-in { from { opacity: 0; transform: translateX(-8px); } }
}

@media (max-width: 720px) {
  .title-toolbar { padding-inline: 6px; }
  .title-toolbar__nav .icon-button:not(:first-child) { display: none; }
  .traffic-light-clearance--toolbar { width: 64px; flex-basis: 64px; }
  .title-toolbar__identity strong { max-width: 24vw; }
  .branch-pill, .title-toolbar__actions .button, .toolbar-divider { display: none; }
  .icon-button { width: 36px; height: 36px; }
  .sidebar .icon-button { width: 32px; height: 32px; }
  .inspector { top: 52px; left: 0; width: 100vw; max-width: none; }
  .inspector__tabs { height: 45px; padding-left: 6px; overflow-x: auto; }
  .inspector__tabs > button:not(.icon-button) { min-width: 60px; min-height: 44px; padding-inline: 5px; }
  .transcript { padding-top: 20px; padding-bottom: 184px; }
  .transcript__inner { padding-inline: 15px; }
  .message--assistant { grid-template-columns: 24px minmax(0, 1fr); gap: 9px; }
  .message__content, .user-bubble { font-size: 13.5px; }
  .composer-wrap { left: 9px; right: 9px; bottom: 8px; width: calc(100% - 18px); }
  .composer { min-height: 118px; }
  .composer__footer { align-items: flex-end; }
  .composer__controls { max-width: calc(100% - 76px); flex-wrap: wrap; }
  .select-control { min-height: 28px; }
  .select-control select { max-width: 91px; }
  .composer__controls > .icon-button { width: 32px; height: 32px; }
  .composer__actions .icon-button { display: none; }
  .composer-note { display: none; }
  .terminal-drawer { height: 46vh; flex-basis: 46vh; }
  .terminal-toolbar .icon-button { width: 32px; height: 32px; }
  .terminal-actions .icon-button:nth-of-type(-n+3), .terminal-cwd { display: none; }
  .page-container, .settings-content__inner { padding: 25px 18px 55px; }
  .page-header { align-items: stretch; flex-direction: column; margin-bottom: 18px; }
  .page-header .button { align-self: flex-start; min-height: 38px; }
  .page-tools { align-items: stretch; flex-direction: column; padding-bottom: 8px; }
  .page-search, .page-search--small { width: 100%; min-height: 38px; }
  .page-tools--activity .segmented { align-self: flex-start; }
  .activity-status { display: none; }
  .project-item__actions { opacity: 1; }
  .project-item__actions .icon-button:last-child { display: none; }
  .plugin-header { align-items: flex-start; flex-direction: column; }
  .plugin-header > div:last-child { flex-wrap: wrap; }
  .feature-strip { grid-template-columns: 34px minmax(0,1fr); padding: 15px; }
  .feature-strip__mark { width: 32px; height: 32px; }
  .directory-tools { align-items: stretch; flex-direction: column; }
  .directory-tools select { min-height: 38px; }
  .settings-page { display: flex; flex-direction: column; }
  .settings-nav { flex: 0 0 46px; display: flex; overflow-x: auto; padding: 5px 7px; border-right: 0; border-bottom: 1px solid var(--border); }
  .settings-nav button { width: auto; min-width: 44px; height: 36px; flex: 0 0 auto; }
  .settings-nav button span { white-space: nowrap; }
  .settings-nav button > svg:last-child { display: none; }
  .theme-options { gap: 5px; }
  .modal-backdrop, .palette-backdrop { padding: 10px; }
  .command-palette { margin-top: 7vh; }
}

```
