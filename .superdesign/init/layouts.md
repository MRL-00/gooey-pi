# Shared Layouts

Prime Work uses a single Electron desktop shell; views are state-based rather than URL-routed.

## `src/App.tsx`

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { TitleToolbar } from '@/components/TitleToolbar'
import { Transcript } from '@/components/Transcript'
import { Composer } from '@/components/Composer'
import { Inspector } from '@/components/Inspector'
import { TerminalDrawer } from '@/components/TerminalDrawer'
import { CommandPalette } from '@/components/CommandPalette'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { ActivityPage } from '@/pages/ActivityPage'
import { ScheduledPage } from '@/pages/ScheduledPage'
import { PluginsPage } from '@/pages/PluginsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { applyPrimeEvent } from '@/lib/events'
import {
  DEFAULT_SETTINGS,
  SAMPLE_GIT,
  SAMPLE_PROJECTS,
  SAMPLE_SCHEDULES,
  SAMPLE_SESSIONS,
  SAMPLE_SKILLS,
  SAMPLE_TRANSCRIPT,
} from '@/lib/data'
import type {
  AppMeta,
  AppSettings,
  GitStatus,
  InspectorTab,
  PrimeWorkApi,
  ProjectRecord,
  RuntimeInfo,
  ScheduleRecord,
  SessionRecord,
  SkillRecord,
  TranscriptMessage,
  WorkspaceView,
} from '@/types/api'

const hasBridge = () => typeof window !== 'undefined' && typeof window.prime !== 'undefined'

export default function App() {
  const bridge = hasBridge() ? window.prime : null
  const [projects, setProjects] = useState<ProjectRecord[]>(() => bridge ? [] : SAMPLE_PROJECTS)
  const [sessions, setSessions] = useState<SessionRecord[]>(() => bridge ? [] : SAMPLE_SESSIONS)
  const [messages, setMessages] = useState<TranscriptMessage[]>(() => bridge ? [] : SAMPLE_TRANSCRIPT)
  const [skills, setSkills] = useState<SkillRecord[]>(() => bridge ? [] : SAMPLE_SKILLS)
  const [schedules, setSchedules] = useState<ScheduleRecord[]>(() => bridge ? [] : SAMPLE_SCHEDULES)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [git, setGit] = useState<GitStatus>(() => bridge ? { isRepo: false, files: [] } : SAMPLE_GIT)
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(() => bridge ? undefined : SAMPLE_PROJECTS[0]?.id)
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>(() => bridge ? undefined : SAMPLE_SESSIONS[0]?.id)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [view, setView] = useState<WorkspaceView>('session')
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('summary')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [model, setModel] = useState('prime-intellect')
  const [effort, setEffort] = useState('medium')
  const [environment, setEnvironment] = useState('local')
  const [toast, setToast] = useState<string | null>(null)
  const runtimeIdRef = useRef<string | null>(null)
  const demoTimerRef = useRef<number[]>([])

  const activeProject = useMemo(() => projects.find((project) => project.id === activeProjectId) ?? projects.find((project) => project.path === sessions.find((session) => session.id === activeSessionId)?.projectPath) ?? projects[0], [projects, sessions, activeProjectId, activeSessionId])
  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId), [sessions, activeSessionId])
  const busy = Boolean(runtime?.isStreaming || messages.some((message) => message.streaming))

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setToast(message)
    window.setTimeout(() => setToast((current) => current === message ? null : current), 4800)
  }, [])

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    Promise.allSettled([
      bridge.app.getMeta(), bridge.projects.list(), bridge.sessions.list(), bridge.settings.get(), bridge.plugins.list(), bridge.schedules.list(), bridge.agent.list(),
    ]).then(([metaResult, projectsResult, sessionsResult, settingsResult, skillsResult, schedulesResult, runtimesResult]) => {
      if (cancelled) return
      if (metaResult.status === 'fulfilled') setMeta(metaResult.value)
      if (projectsResult.status === 'fulfilled') { setProjects(projectsResult.value); setActiveProjectId((current) => current ?? projectsResult.value[0]?.id) }
      if (sessionsResult.status === 'fulfilled') { setSessions(sessionsResult.value); setActiveSessionId((current) => current ?? sessionsResult.value[0]?.id) }
      if (settingsResult.status === 'fulfilled') { setSettings(settingsResult.value); setSidebarOpen(settingsResult.value.sidebarOpen); setInspectorOpen(settingsResult.value.inspectorOpen); setTerminalOpen(settingsResult.value.terminalOpen); setInspectorTab(settingsResult.value.defaultInspectorTab) }
      if (skillsResult.status === 'fulfilled') setSkills(skillsResult.value)
      if (schedulesResult.status === 'fulfilled') setSchedules(schedulesResult.value)
      if (runtimesResult.status === 'fulfilled') {
        const matching = runtimesResult.value.find((item) => item.sessionFile && item.sessionFile === sessions.find((session) => session.id === activeSessionId)?.filePath) ?? runtimesResult.value.find((item) => item.isStreaming)
        if (matching) { setRuntime(matching); runtimeIdRef.current = matching.runtimeId }
      }
      const failure = [metaResult, projectsResult, sessionsResult, settingsResult].find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') reportError(failure.reason)
    })
    return () => { cancelled = true }
  }, [bridge, reportError])

  useEffect(() => {
    const theme = settings.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : settings.theme
    document.documentElement.dataset.theme = theme
    document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => { if (settings.theme === 'system') document.documentElement.dataset.theme = media.matches ? 'dark' : 'light' }
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [settings.theme, settings.reduceMotion])

  useEffect(() => {
    if (!bridge) return
    const off = bridge.agent.onEvent(({ runtimeId, event }) => {
      if (runtimeIdRef.current !== runtimeId) return
      setMessages((current) => applyPrimeEvent(current, event))
      const type = typeof event.type === 'string' ? event.type : ''
      if (type === 'agent_start') setRuntime((current) => current ? { ...current, isStreaming: true } : current)
      if (type === 'agent_end' || type === 'extension_error' || type === 'error') {
        setRuntime((current) => current ? { ...current, isStreaming: false } : current)
        if (activeProject?.primaryFolder) window.setTimeout(() => void refreshGit(), 160)
      }
    })
    return off
  }, [bridge, activeProject?.primaryFolder])

  useEffect(() => () => demoTimerRef.current.forEach(window.clearTimeout), [])

  useEffect(() => {
    if (!bridge || !activeSession?.filePath) {
      if (bridge && !activeSession) setMessages([])
      return
    }
    let cancelled = false
    setLoadingSession(true)
    bridge.sessions.read(activeSession.filePath).then((value) => { if (!cancelled) setMessages(value) }).catch(reportError).finally(() => { if (!cancelled) setLoadingSession(false) })
    return () => { cancelled = true }
  }, [bridge, activeSession?.filePath, reportError])

  const refreshGit = useCallback(async () => {
    if (!bridge || !activeProject?.primaryFolder) return
    try { setGit(await bridge.git.status(activeProject.primaryFolder)) } catch (error) { reportError(error) }
  }, [bridge, activeProject?.primaryFolder, reportError])

  useEffect(() => { if (bridge && activeProject?.primaryFolder) void refreshGit() }, [bridge, activeProject?.primaryFolder, refreshGit])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
    if ('sidebarOpen' in patch && patch.sidebarOpen !== undefined) setSidebarOpen(patch.sidebarOpen)
    if ('inspectorOpen' in patch && patch.inspectorOpen !== undefined) setInspectorOpen(patch.inspectorOpen)
    if ('terminalOpen' in patch && patch.terminalOpen !== undefined) setTerminalOpen(patch.terminalOpen)
    if (bridge) { try { setSettings(await bridge.settings.update(patch)) } catch (error) { reportError(error) } }
  }, [bridge, reportError])

  const persistPanel = (patch: Partial<AppSettings>) => { void updateSettings(patch) }
  const toggleSidebar = () => persistPanel({ sidebarOpen: !sidebarOpen })
  const toggleInspector = () => persistPanel({ inspectorOpen: !inspectorOpen })
  const toggleTerminal = () => persistPanel({ terminalOpen: !terminalOpen })

  const selectProject = (project: ProjectRecord) => {
    setActiveProjectId(project.id); setActiveSessionId(sessions.find((session) => session.projectPath === project.path)?.id); setView('session')
    if (bridge) void bridge.projects.touch(project.id).catch(reportError)
  }
  const selectSession = (session: SessionRecord) => {
    setActiveSessionId(session.id); setActiveProjectId(projects.find((project) => project.path === session.projectPath)?.id); setView('session')
    const matchingRuntime = runtime?.sessionFile === session.filePath ? runtime : null
    setRuntime(matchingRuntime); runtimeIdRef.current = matchingRuntime?.runtimeId ?? null
  }
  const newSession = () => {
    setView('session'); setActiveSessionId(undefined); setMessages([]); setRuntime(null); runtimeIdRef.current = null; setPaletteOpen(false)
  }
  const navigate = (nextView: WorkspaceView) => { setView(nextView); setPaletteOpen(false) }

  const addProject = async () => {
    if (!bridge) { setToast('Project picker is available in the desktop app.'); return }
    try { const project = await bridge.projects.add(); if (project) { setProjects((items) => [project, ...items.filter((item) => item.id !== project.id)]); setActiveProjectId(project.id); setActiveSessionId(undefined); setMessages([]); setView('session') } } catch (error) { reportError(error) }
  }
  const removeProject = async (project: ProjectRecord) => {
    if (!window.confirm(`Remove “${project.name}” from Prime Work? The folder and saved sessions will not be deleted.`)) return
    if (!bridge || await bridge.projects.remove(project.id)) { setProjects((items) => items.filter((item) => item.id !== project.id)); if (activeProjectId === project.id) { setActiveProjectId(projects.find((item) => item.id !== project.id)?.id); setActiveSessionId(undefined) } }
  }

  const sendPrompt = async (prompt: string) => {
    const userMessage: TranscriptMessage = { id: `user-${Date.now()}`, role: 'user', timestamp: Date.now(), parts: [{ type: 'text', text: prompt }] }
    setMessages((items) => [...items, userMessage])
    if (!bridge) {
      const assistantId = `assistant-${Date.now()}`
      setMessages((items) => [...items, { id: assistantId, role: 'assistant', timestamp: Date.now(), streaming: true, parts: [{ type: 'thinking', text: 'Reviewing the request and current workspace context.' }] }])
      demoTimerRef.current.push(window.setTimeout(() => setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, parts: [...item.parts, { type: 'toolCall', id: 'demo-tool', name: 'Inspect project', args: { cwd: activeProject?.primaryFolder } }] } : item)), 450))
      demoTimerRef.current.push(window.setTimeout(() => setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, streaming: false, parts: [...item.parts, { type: 'toolResult', name: 'Inspect project', text: 'Project context loaded' }, { type: 'text', text: 'I’ve reviewed the project context and prepared the workspace. Connect the desktop bridge to run this request with Prime Agent.' }] } : item)), 1250))
      return
    }
    if (!activeProject?.primaryFolder) { reportError('Add a project before starting a Prime session.'); return }
    try {
      let activeRuntime = runtime
      if (!activeRuntime) {
        activeRuntime = await bridge.agent.start({ cwd: activeProject.primaryFolder, sessionPath: activeSession?.filePath, model, thinking: effort })
        setRuntime(activeRuntime); runtimeIdRef.current = activeRuntime.runtimeId
      }
      setRuntime({ ...activeRuntime, isStreaming: true })
      setMessages((items) => [...items, { id: `assistant-${Date.now()}`, role: 'assistant', timestamp: Date.now(), streaming: true, parts: [] }])
      await bridge.agent.command(activeRuntime.runtimeId, { type: activeRuntime.isStreaming ? 'follow_up' : 'prompt', message: prompt })
    } catch (error) {
      setRuntime((current) => current ? { ...current, isStreaming: false } : current)
      setMessages((items) => [...items.map((item) => item.streaming ? { ...item, streaming: false } : item), { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: 'The request could not be started.' }] }])
      reportError(error)
    }
  }

  const stopRuntime = async () => {
    if (!runtime) return
    if (!bridge) { setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item)); setRuntime(null); return }
    try { await bridge.agent.command(runtime.runtimeId, { type: 'abort' }); setRuntime((current) => current ? { ...current, isStreaming: false } : current); setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item)) } catch (error) { reportError(error) }
  }

  const refreshSkills = async () => {
    if (!bridge) return
    setLoadingSkills(true); try { setSkills(await bridge.plugins.refresh()) } catch (error) { reportError(error) } finally { setLoadingSkills(false) }
  }
  const installSkill = async (source: string) => {
    if (!bridge) return { ok: false, output: 'Plugin installation is available in the desktop app.' }
    try { return await bridge.plugins.install(source) } catch (error) { reportError(error); return { ok: false, output: error instanceof Error ? error.message : String(error) } }
  }
  const addSchedule = async (schedule: string, prompt: string) => {
    if (!bridge || !runtime) return
    try { await bridge.schedules.add(runtime.runtimeId, schedule, prompt); setSchedules(await bridge.schedules.list()) } catch (error) { reportError(error) }
  }
  const cancelSchedule = async (schedule: ScheduleRecord) => {
    if (!bridge || !(schedule.runtimeId ?? runtime?.runtimeId)) { setSchedules((items) => items.map((item) => item.id === schedule.id ? { ...item, status: 'paused' } : item)); return }
    try { await bridge.schedules.cancel(schedule.runtimeId ?? runtime!.runtimeId, schedule.id); setSchedules(await bridge.schedules.list()) } catch (error) { reportError(error) }
  }

  const openBrowser = () => { setView('session'); setInspectorTab('browser'); if (!inspectorOpen) persistPanel({ inspectorOpen: true }) }
  const openChanges = () => { setInspectorTab('changes'); if (!inspectorOpen) persistPanel({ inspectorOpen: true }) }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey
      if (command && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(true) }
      else if (command && event.key.toLowerCase() === 'n') { event.preventDefault(); newSession() }
      else if (command && event.key.toLowerCase() === 'b' && event.shiftKey) { event.preventDefault(); openBrowser() }
      else if (command && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar() }
      else if (command && event.key.toLowerCase() === 'j') { event.preventDefault(); toggleTerminal() }
      else if (event.metaKey && event.key === ',') { event.preventDefault(); navigate('settings') }
      else if (event.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const page = view === 'projects' ? <ProjectsPage projects={projects} onAdd={() => void addProject()} onOpen={selectProject} onRemove={(project) => void removeProject(project)} />
    : view === 'activity' ? <ActivityPage sessions={sessions} projects={projects} onOpen={selectSession} />
    : view === 'scheduled' ? <ScheduledPage schedules={schedules} canCreate={Boolean(runtime)} onAdd={addSchedule} onCancel={cancelSchedule} />
    : view === 'plugins' ? <PluginsPage skills={skills} loading={loadingSkills} onRefresh={refreshSkills} onInstall={installSkill} onToggle={(skill) => setSkills((items) => items.map((item) => item.id === skill.id ? { ...item, enabled: !item.enabled } : item))} />
    : view === 'settings' ? <SettingsPage settings={settings} meta={meta} onUpdate={updateSettings} onResetBrowser={async () => { if (bridge) await bridge.settings.resetBrowserData() }} />
    : null

  return (
    <div className="app-shell">
      {sidebarOpen ? <Sidebar projects={projects} sessions={sessions} activeProjectId={activeProject?.id} activeSessionId={activeSessionId} activeView={view} onSelectProject={selectProject} onSelectSession={selectSession} onNavigate={navigate} onNewSession={newSession} onAddProject={() => void addProject()} onClose={toggleSidebar} onOpenPalette={() => setPaletteOpen(true)} /> : null}
      {sidebarOpen ? <button type="button" className="panel-scrim panel-scrim--sidebar" aria-label="Close sidebar" onClick={toggleSidebar} /> : null}
      <div className="workbench">
        <TitleToolbar project={view === 'session' ? activeProject : undefined} view={view} sidebarOpen={sidebarOpen} inspectorOpen={inspectorOpen} terminalOpen={terminalOpen} onToggleSidebar={toggleSidebar} onToggleInspector={toggleInspector} onToggleTerminal={toggleTerminal} onOpenBrowser={openBrowser} onRun={() => { if (!terminalOpen) toggleTerminal() }} />
        <div className="workbench__content">
          {view === 'session' ? (
            <div className="session-workspace">
              <div className="workspace-row">
                <main className="conversation-pane">
                  <Transcript messages={messages} git={git} loading={loadingSession} onOpenChanges={openChanges} />
                  <Composer busy={busy} disabled={!activeProject} model={model} effort={effort} environment={environment} skills={skills} onModelChange={setModel} onEffortChange={setEffort} onEnvironmentChange={setEnvironment} onSend={sendPrompt} onStop={stopRuntime} />
                </main>
                {inspectorOpen ? <Inspector activeTab={inspectorTab} onTabChange={setInspectorTab} onClose={toggleInspector} project={activeProject} runtime={runtime} messages={messages} git={git} browserHome={settings.browserHome} onRefreshGit={refreshGit} onOpenExternal={(url) => { if (bridge) void bridge.app.openExternal(url) }} onRevealPath={(path) => { if (bridge) void bridge.app.revealPath(path) }} /> : null}
                {inspectorOpen ? <button type="button" className="panel-scrim panel-scrim--inspector" aria-label="Close inspector" onClick={toggleInspector} /> : null}
              </div>
              {terminalOpen ? <TerminalDrawer cwd={activeProject?.primaryFolder} shell={settings.terminalShell} onClose={toggleTerminal} onError={reportError} /> : null}
            </div>
          ) : page}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={navigate} onNewSession={newSession} onToggleSidebar={toggleSidebar} onToggleTerminal={toggleTerminal} onOpenBrowser={openBrowser} />
      {toast ? <div className="toast" role="status">{toast}<button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>×</button></div> : null}
    </div>
  )
}

```

## `src/components/Sidebar.tsx`

```tsx
import {
  Bell,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MoreHorizontal,
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
        <PrimeMark size={22} />
        <strong>Work</strong>
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
                <IconButton size="small" className="row-action" label={`More options for ${project.name}`}><MoreHorizontal size={13} /></IconButton>
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

```

## `src/components/TitleToolbar.tsx`

```tsx
import {
  ChevronLeft,
  ChevronRight,
  GitBranch,
  Globe2,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Play,
  SquareTerminal,
} from 'lucide-react'
import type { ProjectRecord, WorkspaceView } from '@/types/api'
import { IconButton } from './ui'

const viewTitles: Record<WorkspaceView, string> = {
  session: 'Prime Work', projects: 'Projects', activity: 'Activity', scheduled: 'Scheduled', plugins: 'Plugins & skills', settings: 'Settings',
}

interface TitleToolbarProps {
  project?: ProjectRecord
  view: WorkspaceView
  sidebarOpen: boolean
  inspectorOpen: boolean
  terminalOpen: boolean
  onToggleSidebar(): void
  onToggleInspector(): void
  onToggleTerminal(): void
  onOpenBrowser(): void
  onRun(): void
}

export function TitleToolbar({ project, view, sidebarOpen, inspectorOpen, terminalOpen, onToggleSidebar, onToggleInspector, onToggleTerminal, onOpenBrowser, onRun }: TitleToolbarProps) {
  return (
    <header className="title-toolbar drag-region">
      {!sidebarOpen ? <div className="traffic-light-clearance traffic-light-clearance--toolbar" aria-hidden="true" /> : null}
      <div className="title-toolbar__nav no-drag">
        {!sidebarOpen ? <IconButton label="Show sidebar (⌘B)" onClick={onToggleSidebar}><PanelLeft size={16} /></IconButton> : null}
        <IconButton label="Back" disabled><ChevronLeft size={16} /></IconButton>
        <IconButton label="Forward" disabled><ChevronRight size={16} /></IconButton>
      </div>
      <div className="title-toolbar__identity">
        <strong>{project?.name ?? viewTitles[view]}</strong>
        {project?.gitBranch && view === 'session' ? <span className="branch-pill"><GitBranch size={12} />{project.gitBranch}</span> : null}
      </div>
      <div className="title-toolbar__actions no-drag">
        {view === 'session' ? <button type="button" className="button button--primary button--compact" onClick={onRun}><Play size={13} fill="currentColor" /> Run</button> : null}
        {view === 'session' ? <span className="toolbar-divider" /> : null}
        {view === 'session' ? <IconButton className={terminalOpen ? 'is-active' : ''} label="Toggle terminal (⌘J)" onClick={onToggleTerminal}><SquareTerminal size={16} /></IconButton> : null}
        {view === 'session' ? <IconButton label="Open browser (⌘⇧B)" onClick={onOpenBrowser}><Globe2 size={16} /></IconButton> : null}
        {view === 'session' ? <IconButton className={inspectorOpen ? 'is-active' : ''} label="Toggle inspector" onClick={onToggleInspector}><PanelRight size={16} /></IconButton> : null}
        {view !== 'session' && sidebarOpen ? <IconButton label="Hide sidebar (⌘B)" onClick={onToggleSidebar}><PanelLeft size={16} /></IconButton> : null}
        <IconButton label="More options"><MoreHorizontal size={16} /></IconButton>
      </div>
    </header>
  )
}

```

