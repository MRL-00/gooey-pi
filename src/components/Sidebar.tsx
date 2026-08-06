import {
  Archive,
  Bell,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  PackageOpen,
  PanelLeftClose,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ProjectRecord, SessionRecord, WorkspaceView } from '@/types/api'
import { formatRelative } from '@/lib/data'
import { IconButton, Modal, PrimeMark, useFocusTrap } from './ui'

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
  onRenameSession(session: SessionRecord, title: string): Promise<void>
  onArchiveSession(session: SessionRecord): Promise<void>
  overlay?: boolean
}

const statusLabel: Record<SessionRecord['status'], string> = {
  idle: 'Idle', running: 'Running', waiting: 'Waiting for approval', complete: 'Complete', failed: 'Failed', unknown: 'Unknown',
}

export function Sidebar({ projects, sessions, activeProjectId, activeSessionId, activeView, onSelectProject, onSelectSession, onNavigate, onNewSession, onAddProject, onClose, onOpenPalette, onRenameSession, onArchiveSession, overlay = false }: SidebarProps) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const sidebarRef = useFocusTrap<HTMLElement>(overlay, onClose)
  const [sessionMenu, setSessionMenu] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<SessionRecord | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [archiveTarget, setArchiveTarget] = useState<SessionRecord | null>(null)
  const activeSessions = useMemo(() => sessions.filter((session) => !session.archived), [sessions])
  useEffect(() => {
    if (!sessionMenu) return
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest('.session-row-wrap')) setSessionMenu(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setSessionMenu(null) } }
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', escape, true) }
  }, [sessionMenu])
  const normalized = query.trim().toLowerCase()
  const visibleProjects = useMemo(() => projects.filter((project) => !normalized || project.name.toLowerCase().includes(normalized) || activeSessions.some((session) => session.projectPath === project.path && `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized))), [projects, activeSessions, normalized])

  return (
    <aside ref={sidebarRef} className="sidebar" aria-label="Project and session navigation" tabIndex={overlay ? -1 : undefined}>
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
        <button type="button" onClick={() => { setSearchOpen((open) => !open); window.setTimeout(() => document.getElementById('session-search')?.focus(), 0) }} className={searchOpen ? 'is-active' : ''}><Search size={15} /><span>Search</span></button>
        {searchOpen ? (
          <div className="sidebar-search">
            <Search size={13} />
            <input id="session-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Projects, chats, branches" aria-label="Search projects and sessions" />
            {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>×</button> : null}
          </div>
        ) : null}
        <button type="button" className={activeView === 'projects' ? 'is-active' : ''} onClick={() => onNavigate('projects')}><Folder size={15} /><span>Projects</span></button>
        <button type="button" className={activeView === 'activity' ? 'is-active' : ''} onClick={() => onNavigate('activity')}><Bell size={15} /><span>Activity</span>{activeSessions.some((item) => item.unread) ? <span className="nav-count">{activeSessions.filter((item) => item.unread).length}</span> : null}</button>
        <button type="button" className={activeView === 'scheduled' ? 'is-active' : ''} onClick={() => onNavigate('scheduled')}><CalendarClock size={15} /><span>Scheduled</span></button>
        <button type="button" className={activeView === 'plugins' ? 'is-active' : ''} onClick={() => onNavigate('plugins')}><PackageOpen size={15} /><span>Plugins & skills</span></button>
      </nav>

      <div className="sidebar__scroll scroll-area">
        <div className="sidebar__section-heading"><span>Projects</span><IconButton size="small" label="Add project" onClick={onAddProject}><Plus size={13} /></IconButton></div>
        {visibleProjects.length === 0 ? <p className="sidebar__empty">No matching work</p> : null}
        {visibleProjects.map((project) => {
          const projectSessions = activeSessions.filter((session) => session.projectPath === project.path && (!normalized || `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized) || project.name.toLowerCase().includes(normalized)))
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
                    <div key={session.id} className={`session-row-wrap ${activeSessionId === session.id && activeView === 'session' ? 'is-selected' : ''}`}>
                      <button type="button" className="session-row" onClick={() => { setSessionMenu(null); onSelectSession(session) }} onContextMenu={(event) => { event.preventDefault(); setSessionMenu(session.id) }}>
                        <span className={`status-dot status-dot--${session.status}`} title={statusLabel[session.status]} />
                        <span className="session-row__text"><span className="session-row__title">{session.title}</span><span className="session-row__meta">{session.status === 'running' ? 'Working' : session.status === 'waiting' ? 'Needs attention' : formatRelative(session.updatedAt)}</span></span>
                        {session.unread ? <span className="unread-dot" aria-label="Unread" /> : null}
                      </button>
                      <IconButton size="small" className="session-row__archive" label={`Archive ${session.title}`} onClick={() => { setArchiveTarget(session); setSessionMenu(null) }}><Archive size={13}/></IconButton>
                      <IconButton size="small" className="session-row__more" label={`Session options for ${session.title}`} onClick={() => setSessionMenu((current) => current === session.id ? null : session.id)}><MoreHorizontal size={13}/></IconButton>
                      {sessionMenu === session.id ? <div className="session-row__menu" aria-label="Session options"><button type="button" onClick={() => { setRenameTarget(session); setRenameValue(session.title); setSessionMenu(null) }}><SquarePen size={12}/> Rename</button></div> : null}
                    </div>
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
      {renameTarget ? <Modal title="Rename session" onClose={() => setRenameTarget(null)} footer={<><button type="button" className="button" onClick={() => setRenameTarget(null)}>Cancel</button><button type="button" className="button button--primary" disabled={!renameValue.trim()} onClick={() => { const target = renameTarget; const title = renameValue.trim(); setRenameTarget(null); void onRenameSession(target, title) }}>Rename</button></>}><label className="field"><span>Session name</span><input autoFocus value={renameValue} maxLength={200} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && renameValue.trim()) { event.preventDefault(); const target = renameTarget; const title = renameValue.trim(); setRenameTarget(null); void onRenameSession(target, title) } }}/></label></Modal> : null}
      {archiveTarget ? <Modal title="Archive session" onClose={() => setArchiveTarget(null)} footer={<><button type="button" className="button" onClick={() => setArchiveTarget(null)}>Cancel</button><button type="button" className="button button--danger" onClick={() => { const target = archiveTarget; setArchiveTarget(null); void onArchiveSession(target) }}>Archive</button></>}><p className="modal-intro">Archive “{archiveTarget.title}”? Its Prime transcript stays on this Mac and can be restored from Activity.</p></Modal> : null}
    </aside>
  )
}
