import {
  Archive,
  Bell,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  LoaderCircle,
  MessageCircleQuestion,
  PackageOpen,
  PanelLeftClose,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react'
import { memo, useEffect, useMemo, useState } from 'react'
import type { ProjectRecord, SessionRecord, WorkspaceView } from '@/types/api'
import { formatRelative } from '@/lib/data'
import { IconButton, Modal, PrimeMark, useFocusTrap } from './ui'

export interface SidebarProps {
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  activeProjectId?: string
  activeSessionId?: string
  activeView: WorkspaceView
  onSelectProject(project: ProjectRecord): void
  onSelectSession(session: SessionRecord): void
  onNavigate(view: WorkspaceView): void
  onNewSession(project?: ProjectRecord): void
  onAddProject(): void
  onClose(): void
  onOpenPalette(): void
  onRenameSession(session: SessionRecord, title: string): Promise<void>
  onArchiveSession(session: SessionRecord): Promise<void>
  overlay?: boolean
}

const statusLabel: Record<SessionRecord['status'], string> = {
  idle: 'Idle', running: 'Running', waiting: 'Waiting for input', complete: 'Finished', failed: 'Failed', unknown: 'Unknown',
}


const attentionSignature = (session: SessionRecord): string | undefined => {
  if (session.status === 'waiting') return `waiting:${session.updatedAt}`
  if (session.status === 'complete' && session.unread) return `complete:${session.updatedAt}`
  return session.unread ? `unread:${session.updatedAt}` : undefined
}

function readClearedAttention(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try { return JSON.parse(window.localStorage.getItem('prime-work.cleared-session-attention') ?? '{}') as Record<string, string> } catch { return {} }
}

function SessionStatusMark({ status }: { status: SessionRecord['status'] }) {
  if (status === 'running') return <span className="session-status-mark session-status-mark--running" title={statusLabel[status]}><LoaderCircle className="spin" size={13} /></span>
  if (status === 'waiting') return <span className="session-status-mark session-status-mark--waiting" title={statusLabel[status]}><MessageCircleQuestion size={12} /></span>
  if (status === 'complete') return <span className="session-status-mark session-status-mark--complete" title={statusLabel[status]}><CheckCircle2 size={12} /></span>
  return <span className={`session-status-mark session-status-mark--${status}`} title={statusLabel[status]}><span /></span>
}

function SidebarView({ projects, sessions, activeProjectId, activeSessionId, activeView, onSelectProject, onSelectSession, onNavigate, onNewSession, onAddProject, onClose, onOpenPalette, onRenameSession, onArchiveSession, overlay = false }: SidebarProps) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const sidebarRef = useFocusTrap<HTMLElement>(overlay, onClose)
  const [sessionMenu, setSessionMenu] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<SessionRecord | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [archiveTarget, setArchiveTarget] = useState<SessionRecord | null>(null)
  const [clearedAttention, setClearedAttention] = useState<Record<string, string>>(readClearedAttention)
  const activeSessions = useMemo(() => sessions.filter((session) => !session.archived), [sessions])
  const needsAttention = (session: SessionRecord) => {
    const signature = attentionSignature(session)
    return Boolean(signature && clearedAttention[session.id] !== signature)
  }
  const clearAttention = (session: SessionRecord) => {
    const signature = attentionSignature(session)
    if (!signature) return
    setClearedAttention((current) => ({ ...current, [session.id]: signature }))
  }
  useEffect(() => { window.localStorage.setItem('prime-work.cleared-session-attention', JSON.stringify(clearedAttention)) }, [clearedAttention])
  const sessionsByProject = useMemo(() => {
    const owners = new Map<string, string[]>()
    const grouped = new Map(projects.map((project) => [project.id, [] as SessionRecord[]]))
    for (const project of projects) for (const path of new Set([project.path, ...project.folders])) {
      const entries = owners.get(path) ?? []; entries.push(project.id); owners.set(path, entries)
    }
    for (const session of activeSessions) for (const projectId of owners.get(session.projectPath) ?? []) grouped.get(projectId)?.push(session)
    return grouped
  }, [activeSessions, projects])
  const unreadCount = activeSessions.reduce((count, session) => count + Number(needsAttention(session)), 0)
  useEffect(() => {
    if (!sessionMenu) return
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest('.session-row-wrap')) setSessionMenu(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setSessionMenu(null) } }
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', escape, true) }
  }, [sessionMenu])
  const normalized = query.trim().toLowerCase()
  const visibleProjects = useMemo(() => projects.filter((project) => !normalized || project.name.toLowerCase().includes(normalized) || (sessionsByProject.get(project.id) ?? []).some((session) => `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized))), [projects, sessionsByProject, normalized])

  return (
    <aside ref={sidebarRef} className="sidebar" aria-label="Project and session navigation" tabIndex={overlay ? -1 : undefined}>
      <div className="sidebar__titlebar drag-region">
        <div className="traffic-light-clearance" aria-hidden="true" />
        <div className="sidebar__brand" aria-label="Prime Work by Prime Intellect">
          <PrimeMark size={24} />
          <span><strong>Prime</strong><small>Work</small></span>
        </div>
        <div className="sidebar__title-actions no-drag">
          <IconButton label="New session (⌘N)" onClick={() => onNewSession()}><SquarePen size={16} /></IconButton>
          <IconButton label="Hide sidebar (⌘B)" onClick={onClose}><PanelLeftClose size={16} /></IconButton>
        </div>
      </div>

      <nav className="sidebar__primary" aria-label="Primary">
        <button type="button" onClick={() => onNewSession()}><Plus size={15} /><span>New session</span><kbd>⌘N</kbd></button>
        <button type="button" onClick={() => { setSearchOpen((open) => !open); window.setTimeout(() => document.getElementById('session-search')?.focus(), 0) }} className={searchOpen ? 'is-active' : ''}><Search size={15} /><span>Search</span></button>
        {searchOpen ? (
          <div className="sidebar-search">
            <Search size={13} />
            <input id="session-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Projects, chats, branches" aria-label="Search projects and sessions" />
            {query ? <button type="button" aria-label="Clear search" onClick={() => setQuery('')}>×</button> : null}
          </div>
        ) : null}
        <button type="button" className={activeView === 'projects' ? 'is-active' : ''} onClick={() => onNavigate('projects')}><Folder size={15} /><span>Projects</span></button>
        <button type="button" className={activeView === 'activity' ? 'is-active' : ''} onClick={() => onNavigate('activity')}><Bell size={15} /><span>Activity</span>{unreadCount ? <span className="nav-count">{unreadCount}</span> : null}</button>
        <button type="button" className={activeView === 'scheduled' ? 'is-active' : ''} onClick={() => onNavigate('scheduled')}><CalendarClock size={15} /><span>Scheduled</span></button>
        <button type="button" className={activeView === 'plugins' ? 'is-active' : ''} onClick={() => onNavigate('plugins')}><PackageOpen size={15} /><span>Plugins & skills</span></button>
      </nav>

      <div className="sidebar__scroll scroll-area">
        <div className="sidebar__section-heading"><span>Projects</span><IconButton size="small" label="Add project" onClick={onAddProject}><Plus size={13} /></IconButton></div>
        {visibleProjects.length === 0 ? <p className="sidebar__empty">No matching work</p> : null}
        {visibleProjects.map((project) => {
          const projectSessions = (sessionsByProject.get(project.id) ?? []).filter((session) => !normalized || `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized) || project.name.toLowerCase().includes(normalized))
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
                <IconButton size="small" className="project-row__new-session row-action" label={`New session in ${project.name}`} onClick={() => onNewSession(project)}><Plus size={13} /></IconButton>
                {running ? <span className="project-working" title="Agent working"><LoaderCircle className="spin" size={13} /></span> : null}
              </div>
              {!isCollapsed ? (
                <div className="session-list">
                  {projectSessions.slice(0, 7).map((session) => (
                    <div key={session.id} className={`session-row-wrap session-row-wrap--${session.status} ${needsAttention(session) ? 'has-attention' : ''} ${activeSessionId === session.id && activeView === 'session' ? 'is-selected' : ''}`}>
                      <button type="button" className="session-row" onClick={() => { setSessionMenu(null); clearAttention(session); onSelectSession(session) }} onContextMenu={(event) => { event.preventDefault(); setSessionMenu(session.id) }}>
                        <SessionStatusMark status={session.status} />
                        <span className="session-row__text"><span className="session-row__title">{session.title}</span><span className="session-row__meta">{session.status === 'running' ? 'Working' : session.status === 'waiting' ? 'Needs attention' : session.status === 'complete' ? 'Finished' : formatRelative(session.updatedAt)}</span></span>
                      </button>
                      <IconButton size="small" className="session-row__archive" label={`Archive ${session.title}`} onClick={() => { setArchiveTarget(session); setSessionMenu(null) }}><Archive size={13}/></IconButton>
                      <IconButton size="small" className="session-row__more" label={`Session options for ${session.title}`} onClick={() => setSessionMenu((current) => current === session.id ? null : session.id)}><MoreHorizontal size={13}/></IconButton>
                      {sessionMenu === session.id ? <div className="session-row__menu" aria-label="Session options"><button type="button" onClick={() => { setRenameTarget(session); setRenameValue(session.title); setSessionMenu(null) }}><SquarePen size={12}/> Rename</button></div> : null}
                    </div>
                  ))}
                  {projectSessions.length === 0 ? <button type="button" className="session-row session-row--empty" onClick={() => onNewSession(project)}><Plus size={12} /> New session</button> : null}
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

export function areSidebarPropsEqual(previous: SidebarProps, next: SidebarProps): boolean {
  return previous.projects === next.projects
    && previous.sessions === next.sessions
    && previous.activeProjectId === next.activeProjectId
    && previous.activeSessionId === next.activeSessionId
    && previous.activeView === next.activeView
    && previous.onSelectProject === next.onSelectProject
    && previous.onSelectSession === next.onSelectSession
    && previous.onNavigate === next.onNavigate
    && previous.onNewSession === next.onNewSession
    && previous.onAddProject === next.onAddProject
    && previous.onClose === next.onClose
    && previous.onOpenPalette === next.onOpenPalette
    && previous.onRenameSession === next.onRenameSession
    && previous.onArchiveSession === next.onArchiveSession
    && previous.overlay === next.overlay
}

export const Sidebar = memo(SidebarView, areSidebarPropsEqual)
