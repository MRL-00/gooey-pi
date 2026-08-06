# Routes and Workspace Views

Prime Work is an Electron single-window React application and does not use a URL router. `src/main.tsx` mounts `src/App.tsx`; `App` selects a `WorkspaceView` and renders the corresponding page.

| Logical view | `WorkspaceView` value | Component |
|---|---|---|
| Session workspace | `session` | Inline shell using `Transcript`, `Composer`, `Inspector`, `TerminalDrawer` |
| Projects | `projects` | `src/pages/ProjectsPage.tsx` |
| Activity | `activity` | `src/pages/ActivityPage.tsx` |
| Scheduled | `scheduled` | `src/pages/ScheduledPage.tsx` |
| Plugins & skills | `plugins` | `src/pages/PluginsPage.tsx` |
| Settings | `settings` | `src/pages/SettingsPage.tsx` |

## Entry

### `src/main.tsx`
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Prime Work root element was not found')

createRoot(root).render(<StrictMode><App /></StrictMode>)

```

Routing and navigation state are implemented in the full `src/App.tsx` source included in `layouts.md`.
