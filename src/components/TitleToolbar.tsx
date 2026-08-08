import {
  GitBranch,
  PanelLeft,
  PanelRight,
  Terminal,
} from 'lucide-react'
import type { ProjectRecord, WorkspaceView } from '@/types/api'
import { BrowserGlobe, IconButton } from './ui'

const viewTitles: Record<Exclude<WorkspaceView, 'session'>, string> = {
  projects: 'Projects', activity: 'Activity', scheduled: 'Scheduled', plugins: 'Plugins & skills', settings: 'Settings',
}

interface TitleToolbarProps {
  project?: ProjectRecord
  view: WorkspaceView
  /** Active harness product name; the session view's fallback title. */
  productName?: string
  sidebarOpen: boolean
  inspectorOpen: boolean
  terminalOpen: boolean
  onToggleSidebar(): void
  onToggleInspector(): void
  onToggleTerminal(): void
  onOpenBrowser(): void
}

export function TitleToolbar({ project, view, productName = 'Prime Work', sidebarOpen, inspectorOpen, terminalOpen, onToggleSidebar, onToggleInspector, onToggleTerminal, onOpenBrowser }: TitleToolbarProps) {
  return (
    <header className="title-toolbar drag-region">
      {!sidebarOpen ? <div className="traffic-light-clearance traffic-light-clearance--toolbar" aria-hidden="true" /> : null}
      <div className="title-toolbar__nav no-drag">
        {!sidebarOpen ? <IconButton label="Show sidebar (⌘B)" onClick={onToggleSidebar}><PanelLeft size={16} /></IconButton> : null}
      </div>
      <div className="title-toolbar__identity">
        <strong>{project?.name ?? (view === 'session' ? productName : viewTitles[view])}</strong>
        {project?.gitBranch && view === 'session' ? <span className="branch-pill"><GitBranch size={12} />{project.gitBranch}</span> : null}
      </div>
      <div className="title-toolbar__actions no-drag">
        {view === 'session' ? <IconButton className={terminalOpen ? 'is-active' : ''} label="Toggle terminal (⌘J)" onClick={onToggleTerminal}><Terminal size={17} /></IconButton> : null}
        {view === 'session' ? <IconButton label="Open browser (⌘⇧B)" onClick={onOpenBrowser}><BrowserGlobe size={18} /></IconButton> : null}
        {view === 'session' ? <IconButton className={inspectorOpen ? 'is-active' : ''} label="Toggle inspector" onClick={onToggleInspector}><PanelRight size={16} /></IconButton> : null}
        {view !== 'session' && sidebarOpen ? <IconButton label="Hide sidebar (⌘B)" onClick={onToggleSidebar}><PanelLeft size={16} /></IconButton> : null}
      </div>
    </header>
  )
}
