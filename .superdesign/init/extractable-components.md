# Extractable Components

## Sidebar
- Source: `src/components/Sidebar.tsx`
- Category: layout
- Description: macOS navigation rail with global destinations, project/session groups, and footer commands.
- Extractable props: activeView, activeProjectId, activeSessionId, projects, sessions, open
- Hardcoded: Prime mark, destination labels, Lucide icon choices, CSS class names

## TitleToolbar
- Source: `src/components/TitleToolbar.tsx`
- Category: layout
- Description: Window-level session identity, branch state, run control, and panel toggles.
- Extractable props: title, project, running, sidebarOpen, inspectorOpen, terminalOpen
- Hardcoded: icon choices, Run/Stop labels, toolbar structure

## Inspector
- Source: `src/components/Inspector.tsx`
- Category: layout
- Description: Contextual Summary, Changes, Browser, and Files surface.
- Extractable props: activeTab, project, runtime, messages, git, browserHome
- Hardcoded: tab labels, browser chrome icon choices, summary sections

## Composer
- Source: `src/components/Composer.tsx`
- Category: basic
- Description: Multiline agent prompt input with model, effort, environment, permission, voice, and send controls.
- Extractable props: model, effort, environment, busy, disabled
- Hardcoded: placeholder, available choices, Lucide icons

## IconButton / PrimeMark / StatusBadge / EmptyState / SegmentedControl
- Source: `src/components/ui.tsx`
- Category: basic
- Description: Shared focusable controls and identity/status/empty-state primitives.
- Extractable props: label, size, tone, active value, options, disabled
- Hardcoded: CSS classes and Prime mark geometry

## Transcript Activity Cards
- Source: `src/components/Transcript.tsx`
- Category: basic
- Description: User/assistant messages, collapsible reasoning, tool execution cards, and changes summary.
- Extractable props: messages, git, loading
- Hardcoded: activity labels and icon choices

## TerminalDrawer
- Source: `src/components/TerminalDrawer.tsx`
- Category: layout
- Description: Resizable xterm-powered project terminal drawer.
- Extractable props: open, cwd
- Hardcoded: toolbar icon choices and terminal presentation
