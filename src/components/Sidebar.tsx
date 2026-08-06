import {
  Bell,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  PackageOpen,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ProjectRecord, SessionRecord, WorkspaceView } from '@/types/api'
import { formatRelative } from '@/lib/data'
import { IconButton, PrimeMark } from './ui'

interface SidebarProps {
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  activeProjectId?: string
  activeSessionId?: string
  activeView: WorkspaceView
  onSelectProject(project: ProjectRecord): void
  onSelectSession(session: SessionRecord): void
  onNavigate(view: WorkspaceView): void
  onNewSession(): void
  onAddProject(): void
  onClose(): void
  onOpenPalette(): void
}

const statusLabel: Record<SessionRecord['status'], string> = {
  idle: 'Idle', running: 'Running', waiting: 'Waiting for approval', complete: 'Complete', failed: 'Failed', unknown: 'Unknown',
}

export function Sidebar({ projects, sessions, activeProjectId, activeSessionId, activeView, onSelectProject, onSelectSession, onNavigate, onNewSession, onAddProject, onClose, onOpenPalette }: SidebarProps) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const normalized = query.trim().toLowerCase()
  const visibleProjects = useMemo(() => projects.filter((project) => !normalized || project.name.toLowerCase().includes(normalized) || sessions.some((session) => session.projectPath === project.path && `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized))), [projects, sessions, normalized])

  return (
    <aside className="sidebar" aria-label="Project and session navigation">
      <div className="sidebar__titlebar drag-region">
        <div className="traffic-light-clearance" aria-hidden="true" />
        <div className="sidebar__brand" aria-label="Prime Work by Prime Intellect">
          <PrimeMark size={24} />
          <span><strong>Prime</strong><small>Workspace</small></span>
        </div>
        <div className="sidebar__title-actions no-drag">
          <IconButton label="New session (⌘N)" onClick={onNewSession}><SquarePen size={16} /></IconButton>
          <IconButton label="Hide sidebar (⌘B)" onClick={onClose}><PanelLeftClose size={16} /></IconButton>
        </div>
      </div>

      <nav className="sidebar__primary" aria-label="Primary">
        <button type="button" onClick={onNewSession}><Plus size={15} /><span>New session</span><kbd>⌘N</kbd></button>
        <button type="button" onClick={() => { setSearchOpen((open) => !open); window.setTimeout(() => document.getElementById('session-search')?.focus(), 0) }} className={searchOpen ? 'is-active' : ''}><Search size={15} /><span>Search</span><kbd>⌘K</kbd></button>
        {searchOpen ? (
          <div className="sidebar-search">
            <Search size={13} />
            <input id="session-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Projects, chats, branches" aria-label="Search projects and sessions" />
            {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>×</button> : null}
          </div>
        ) : null}
        <button type="button" className={activeView === 'projects' ? 'is-active' : ''} onClick={() => onNavigate('projects')}><Folder size={15} /><span>Projects</span></button>
        <button type="button" className={activeView === 'activity' ? 'is-active' : ''} onClick={() => onNavigate('activity')}><Bell size={15} /><span>Activity</span>{sessions.some((item) => item.unread) ? <span className="nav-count">{sessions.filter((item) => item.unread).length}</span> : null}</button>
        <button type="button" className={activeView === 'scheduled' ? 'is-active' : ''} onClick={() => onNavigate('scheduled')}><CalendarClock size={15} /><span>Scheduled</span></button>
        <button type="button" className={activeView === 'plugins' ? 'is-active' : ''} onClick={() => onNavigate('plugins')}><PackageOpen size={15} /><span>Plugins & skills</span></button>
      </nav>

      <div className="sidebar__scroll scroll-area">
        <div className="sidebar__section-heading"><span>Projects</span><IconButton size="small" label="Add project" onClick={onAddProject}><Plus size={13} /></IconButton></div>
        {visibleProjects.length === 0 ? <p className="sidebar__empty">No matching work</p> : null}
        {visibleProjects.map((project) => {
          const projectSessions = sessions.filter((session) => session.projectPath === project.path && (!normalized || `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized) || project.name.toLowerCase().includes(normalized)))
          const isCollapsed = collapsed[project.id] ?? false
          const running = projectSessions.some((session) => session.status === 'running')
          return (
            <div className="project-group" key={project.id}>
              <div className={`project-row ${activeProjectId === project.id && activeView === 'session' ? 'is-selected' : ''}`}>
                <button className="project-row__collapse" type="button" aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${project.name}`} onClick={() => setCollapsed((value) => ({ ...value, [project.id]: !isCollapsed }))}>
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
                <button className="project-row__main" type="button" onClick={() => onSelectProject(project)} title={project.path}>
                  {activeProjectId === project.id ? <FolderOpen size={14} /> : <Folder size={14} />}
                  <span>{project.name}</span>
                </button>
                {running ? <span className="status-dot status-dot--running" title="Agent running" /> : null}
              </div>
              {!isCollapsed ? (
                <div className="session-list">
                  {projectSessions.slice(0, 7).map((session) => (
                    <button type="button" key={session.id} className={`session-row ${activeSessionId === session.id && activeView === 'session' ? 'is-selected' : ''}`} onClick={() => onSelectSession(session)}>
                      <span className={`status-dot status-dot--${session.status}`} title={statusLabel[session.status]} />
                      <span className="session-row__text"><span className="session-row__title">{session.title}</span><span className="session-row__meta">{session.status === 'running' ? 'Working' : session.status === 'waiting' ? 'Needs attention' : formatRelative(session.updatedAt)}</span></span>
                      {session.unread ? <span className="unread-dot" aria-label="Unread" /> : null}
                    </button>
                  ))}
                  {projectSessions.length === 0 ? <button type="button" className="session-row session-row--empty" onClick={onNewSession}><Plus size={12} /> New session</button> : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="sidebar__footer">
        <button type="button" onClick={onOpenPalette}><Search size={15} /><span>Commands</span><kbd>⌘K</kbd></button>
        <button type="button" className={activeView === 'settings' ? 'is-active' : ''} onClick={() => onNavigate('settings')}><Settings size={15} /><span>Settings</span><kbd>⌘,</kbd></button>
      </div>
    </aside>
  )
}
