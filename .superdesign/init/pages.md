# Page Dependency Trees

All views share `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/TitleToolbar.tsx`, `src/components/ui.tsx`, `src/types/api.ts`, and `src/styles.css`.

## Session Workspace
Entry: `src/App.tsx`
Dependencies:
- `src/components/Sidebar.tsx`
  - `src/components/ui.tsx`
  - `src/lib/data.ts`
  - `src/types/api.ts`
- `src/components/TitleToolbar.tsx`
  - `src/components/ui.tsx`
  - `src/types/api.ts`
- `src/components/Transcript.tsx`
  - `src/components/ui.tsx`
  - `src/types/api.ts`
- `src/components/Composer.tsx`
  - `src/components/ui.tsx`
- `src/components/Inspector.tsx`
  - `src/components/ui.tsx`
  - `src/types/api.ts`
- `src/components/TerminalDrawer.tsx`
  - `src/components/ui.tsx`
  - `src/types/api.ts`
- `src/components/CommandPalette.tsx`
- `src/components/ResizeHandle.tsx`
- `src/components/MarkdownText.tsx`
  - `src/components/ui.tsx`
  - `src/types/api.ts`
- `src/lib/events.ts`
- `src/lib/data.ts`
- `src/types/api.ts`

## Projects
Entry: `src/pages/ProjectsPage.tsx`
Dependencies:
- `src/components/ui.tsx`
- `src/types/api.ts`
- `src/App.tsx` (view state, actions, and shared shell)

## Activity
Entry: `src/pages/ActivityPage.tsx`
Dependencies:
- `src/components/ui.tsx`
- `src/types/api.ts`
- `src/App.tsx` (view state, actions, and shared shell)

## Scheduled
Entry: `src/pages/ScheduledPage.tsx`
Dependencies:
- `src/components/ui.tsx`
- `src/types/api.ts`
- `src/App.tsx` (view state, actions, and shared shell)

## Plugins & Skills
Entry: `src/pages/PluginsPage.tsx`
Dependencies:
- `src/components/ui.tsx`
- `src/types/api.ts`
- `src/App.tsx` (view state, actions, and shared shell)

## Settings
Entry: `src/pages/SettingsPage.tsx`
Dependencies:
- `src/components/ui.tsx`
- `src/types/api.ts`
- `src/App.tsx` (view state, actions, and shared shell)

