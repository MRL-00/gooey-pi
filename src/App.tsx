import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { TitleToolbar } from '@/components/TitleToolbar'
import { Composer } from '@/components/Composer'
import { ResizeHandle } from '@/components/ResizeHandle'
import { createSingleFlightAdmission, findProjectForSession, findRuntimeForWorkspace, gitStatusForWorkspace, newSessionProject, projectContainsPath, workspaceCwd } from '@/lib/workspace'
import { DEFAULT_SETTINGS, SAMPLE_GIT, SAMPLE_PROJECTS, SAMPLE_SCHEDULES, SAMPLE_SESSIONS, SAMPLE_SKILLS, SAMPLE_TRANSCRIPT } from '@/lib/data'
import { requestFailureMessage } from '@/app/workspace'
import { createPluginCatalogAdmission } from '@/lib/plugin-catalog'
import { useAgentEvents } from '@/hooks/useAgentEvents'
import { useAppSettings } from '@/hooks/useAppSettings'
import { useBootstrap } from '@/hooks/useBootstrap'
import { useExtensionUi } from '@/hooks/useExtensionUi'
import { INSPECTOR_DEFAULT, INSPECTOR_MIN, TERMINAL_DEFAULT, TERMINAL_MIN, usePanelLayout } from '@/hooks/usePanelLayout'
import { useProviderCatalog } from '@/hooks/useProviderCatalog'
import { useWorkspaceRuntime } from '@/hooks/useWorkspaceRuntime'
import { useStableCallback } from '@/hooks/useStableCallback'
import type { GitStatus, McpConnectionInput, ProjectRecord, ScheduleRecord, SessionRecord, SkillRecord, TranscriptMessage, WorkspaceView } from '@/types/api'

const Transcript = lazy(() => import('@/components/Transcript').then((module) => ({ default: module.Transcript })))
const Inspector = lazy(() => import('@/components/Inspector').then((module) => ({ default: module.Inspector })))
const TerminalDrawer = lazy(() => import('@/components/TerminalDrawer').then((module) => ({ default: module.TerminalDrawer })))
const CommandPalette = lazy(() => import('@/components/CommandPalette').then((module) => ({ default: module.CommandPalette })))
const ExtensionUiModal = lazy(() => import('@/components/ExtensionUiModal').then((module) => ({ default: module.ExtensionUiModal })))
const ProviderAuthModal = lazy(() => import('@/components/ProviderAuthModal').then((module) => ({ default: module.ProviderAuthModal })))
const ProjectsPage = lazy(() => import('@/pages/ProjectsPage').then((module) => ({ default: module.ProjectsPage })))
const ActivityPage = lazy(() => import('@/pages/ActivityPage').then((module) => ({ default: module.ActivityPage })))
const ScheduledPage = lazy(() => import('@/pages/ScheduledPage').then((module) => ({ default: module.ScheduledPage })))
const PluginsPage = lazy(() => import('@/pages/PluginsPage').then((module) => ({ default: module.PluginsPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((module) => ({ default: module.SettingsPage })))

const hasBridge = () => typeof window !== 'undefined' && typeof window.prime !== 'undefined'
const LoadingPanel = ({ label }: { label: string }) => <div className="empty-state" role="status">Loading {label}…</div>

export default function App() {
  const bridge = hasBridge() ? window.prime : null
  const initialProject = bridge ? undefined : SAMPLE_PROJECTS[0]
  const initialSession = bridge ? undefined : SAMPLE_SESSIONS[0]
  const [projects, setProjects] = useState<ProjectRecord[]>(() => bridge ? [] : SAMPLE_PROJECTS)
  const [sessions, setSessions] = useState<SessionRecord[]>(() => bridge ? [] : SAMPLE_SESSIONS)
  const [skills, setSkills] = useState<SkillRecord[]>(() => bridge ? [] : SAMPLE_SKILLS)
  const [schedules, setSchedules] = useState<ScheduleRecord[]>(() => bridge ? [] : SAMPLE_SCHEDULES)
  const [scheduleError, setScheduleError] = useState('')
  const [gitSnapshot, setGitSnapshot] = useState(() => ({ cwd: bridge ? undefined : SAMPLE_PROJECTS[0]?.primaryFolder, status: bridge ? { isRepo: false, files: [] } as GitStatus : SAMPLE_GIT }))
  const [view, setView] = useState<WorkspaceView>('session')
  const [browserGeneration, setBrowserGeneration] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const submissionAdmissionRef = useRef(createSingleFlightAdmission())
  const gitRequestRef = useRef(0)
  const pluginCatalogAdmissionRef = useRef(createPluginCatalogAdmission())
  const pluginCatalogScopeRef = useRef<{ workspaceGeneration: number; projectPath?: string }>({ workspaceGeneration: 0 })
  const demoTimerRef = useRef<number[]>([])

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setToast(message)
    window.setTimeout(() => setToast((current) => current === message ? null : current), 4_800)
  }, [])
  const settingsState = useAppSettings({ bridge, reportError })
  const workspace = useWorkspaceRuntime({
    bridge, initialProject, initialSession, projects, sessions,
    initialMessages: bridge ? [] : SAMPLE_TRANSCRIPT, reportError,
  })
  const syncProviderRuntime = useCallback(async (runtimeId: string) => {
    if (!bridge) return
    const generation = workspace.workspaceRef.current.generation
    const next = (await bridge.agent.list()).find((candidate) => candidate.runtimeId === runtimeId)
    if (next && workspace.workspaceRef.current.generation === generation) workspace.attachRuntime(next, generation)
  }, [bridge, workspace.attachRuntime, workspace.workspaceRef])
  const syncDisabledProviders = useCallback((disabledProviders: string[]) => settingsState.updateSettings({ disabledProviders }), [settingsState.updateSettings])
  const provider = useProviderCatalog({ bridge, runtime: workspace.runtime, syncRuntime: syncProviderRuntime, syncDisabledProviders, reportError })
  const activeSession = useMemo(() => sessions.find((session) => session.id === workspace.activeSessionId), [sessions, workspace.activeSessionId])
  const activeProject = useMemo(() => findProjectForSession(projects, activeSession)
    ?? projects.find((project) => project.id === workspace.activeProjectId)
    ?? projects[0], [projects, activeSession, workspace.activeProjectId])
  const activeCwd = workspaceCwd(activeProject, activeSession)
  const git = gitStatusForWorkspace(gitSnapshot, activeCwd)
  const layout = usePanelLayout({
    sidebarOpen: settingsState.sidebarOpen, setSidebarOpen: settingsState.setSidebarOpen,
    inspectorOpen: settingsState.inspectorOpen, setInspectorOpen: settingsState.setInspectorOpen,
    terminalOpen: settingsState.terminalOpen, view,
  })
  const { meta, initialized } = useBootstrap({
    bridge, setProjects, setSessions, setSchedules, setScheduleError,
    runtimeSessionsRef: workspace.runtimeSessionsRef, workspaceRef: workspace.workspaceRef,
    activateWorkspace: workspace.activateWorkspace, reportError,
  })
  const extension = useExtensionUi({
    bridge, activeRuntimeId: workspace.runtime?.runtimeId, runtimeSessionsRef: workspace.runtimeSessionsRef,
    setSessions, reportError,
  })

  const refreshGit = useCallback(async () => {
    const requestId = ++gitRequestRef.current
    const cwd = activeCwd
    if (!bridge || !cwd) { setGitSnapshot({ cwd, status: { isRepo: false, files: [] } }); return }
    try {
      const next = await bridge.git.status(cwd)
      if (gitRequestRef.current === requestId && workspace.workspaceRef.current.cwd === cwd) setGitSnapshot({ cwd, status: next })
    } catch (error) { if (gitRequestRef.current === requestId && workspace.workspaceRef.current.cwd === cwd) reportError(error) }
  }, [activeCwd, bridge, reportError, workspace.workspaceRef])

  useAgentEvents({
    bridge, runtimeIdRef: workspace.runtimeIdRef, runtimeSessionsRef: workspace.runtimeSessionsRef,
    runtimeOwnerRef: workspace.runtimeOwnerRef, workspaceRef: workspace.workspaceRef,
    setSessions, setRuntime: workspace.setRuntime, queueAgentEvent: workspace.queueAgentEvent,
    reconcileTranscriptForEvent: workspace.reconcileTranscriptForEvent,
    showExtensionUi: extension.showExtensionUi, clearExtensionUi: extension.clearExtensionUi,
    refreshGit, refreshGitOnTerminalEvent: Boolean(activeCwd),
    activeSessionVisible: view === 'session',
  })

  useEffect(() => { void refreshGit(); return () => { gitRequestRef.current += 1 } }, [refreshGit])
  useEffect(() => {
    if (activeSession?.syncRevision) void refreshGit()
  }, [activeSession?.syncRevision, refreshGit])
  const pluginProjectPath = activeProject?.primaryFolder && !activeProject.inferred ? activeProject.primaryFolder : undefined
  pluginCatalogScopeRef.current = { workspaceGeneration: workspace.workspaceGeneration, projectPath: pluginProjectPath }
  const loadSkills = useCallback(async (showLoading: boolean) => {
    if (!bridge) return
    const owner = pluginCatalogScopeRef.current
    const request = pluginCatalogAdmissionRef.current.begin(owner.workspaceGeneration, owner.projectPath)
    setLoadingSkills(showLoading)
    try {
      const records = await bridge.plugins.list(owner.projectPath)
      const current = pluginCatalogScopeRef.current
      if (pluginCatalogAdmissionRef.current.isCurrent(request, current.workspaceGeneration, current.projectPath)) setSkills(records)
    } catch (error) {
      const current = pluginCatalogScopeRef.current
      if (pluginCatalogAdmissionRef.current.isCurrent(request, current.workspaceGeneration, current.projectPath)) reportError(error)
    } finally {
      const current = pluginCatalogScopeRef.current
      if (showLoading && pluginCatalogAdmissionRef.current.isCurrent(request, current.workspaceGeneration, current.projectPath)) setLoadingSkills(false)
    }
  }, [bridge, reportError])
  useEffect(() => { void loadSkills(false) }, [loadSkills, pluginProjectPath, workspace.workspaceGeneration])
  useEffect(() => () => { demoTimerRef.current.forEach(window.clearTimeout) }, [])

  const grantProject = async (project: ProjectRecord): Promise<ProjectRecord> => {
    if (!bridge || !project.inferred) return project
    const granted = await bridge.projects.grantInferred(project.primaryFolder)
    setProjects((items) => items.map((item) => item.id === project.id ? granted : item))
    const selected = workspace.workspaceRef.current
    if (selected.project?.id !== project.id) return granted
    workspace.workspaceRef.current = { ...selected, project: granted, cwd: workspaceCwd(granted, selected.session) }
    const requestId = ++gitRequestRef.current
    const cwd = workspaceCwd(granted, selected.session)
    if (!cwd) return granted
    const nextGit = await bridge.git.status(cwd)
    if (gitRequestRef.current === requestId && workspace.workspaceRef.current.generation === selected.generation && workspace.workspaceRef.current.cwd === cwd) setGitSnapshot({ cwd, status: nextGit })
    return granted
  }
  const persistPanel = (patch: Partial<typeof DEFAULT_SETTINGS>) => { void settingsState.updateSettings(patch) }
  const toggleSidebar = () => {
    const next = !settingsState.sidebarOpen
    layout.compactRestoreRef.current = null
    if (layout.compactLayout && next && settingsState.inspectorOpen) settingsState.setInspectorOpen(false)
    persistPanel({ sidebarOpen: next })
  }
  const toggleInspector = () => {
    const next = !settingsState.inspectorOpen
    layout.compactRestoreRef.current = null
    if (layout.compactLayout && next && settingsState.sidebarOpen) settingsState.setSidebarOpen(false)
    persistPanel({ inspectorOpen: next })
  }
  const toggleTerminal = async () => {
    if (!settingsState.terminalOpen && activeProject?.inferred) {
      try { await grantProject(activeProject) } catch (error) { reportError(error); return }
    }
    persistPanel({ terminalOpen: !settingsState.terminalOpen })
  }
  const selectProject = async (project: ProjectRecord) => {
    if (layout.compactLayout) settingsState.setSidebarOpen(false)
    const session = sessions.find((candidate) => !candidate.archived && projectContainsPath(project, candidate.projectPath))
    const generation = workspace.activateWorkspace(project, session)
    setView('session')
    try {
      const granted = await grantProject(project)
      if (bridge && !granted.inferred) await bridge.projects.touch(granted.id)
      await workspace.reconcileRuntime(generation)
    } catch (error) { if (workspace.workspaceRef.current.generation === generation) reportError(error) }
  }
  const selectSession = async (session: SessionRecord) => {
    if (layout.compactLayout) settingsState.setSidebarOpen(false)
    setSessions((items) => items.map((item) => item.id === session.id ? { ...item, unread: false } : item))
    const project = findProjectForSession(projects, session)
    if (!project) { reportError('This session is not contained by an available project.'); return }
    const generation = workspace.activateWorkspace(project, session)
    setView('session')
    try { await grantProject(project); await workspace.reconcileRuntime(generation) }
    catch (error) { if (workspace.workspaceRef.current.generation === generation) reportError(error) }
  }
  const newSession = (requestedProject?: ProjectRecord) => {
    const project = newSessionProject(requestedProject, workspace.workspaceRef.current.project, activeProject)
    if (!project) return
    if (layout.compactLayout) settingsState.setSidebarOpen(false)
    workspace.activateWorkspace(project)
    if (!bridge) workspace.setMessages([])
    setView('session'); setPaletteOpen(false)
  }
  const navigate = (nextView: WorkspaceView) => {
    if (layout.compactLayout) settingsState.setSidebarOpen(false)
    setView(nextView); setPaletteOpen(false)
  }
  const renameSession = async (session: SessionRecord, title: string) => {
    if (!bridge) return
    try {
      if (!await bridge.sessions.rename(session.filePath, title)) throw new Error('Prime Agent could not rename this session.')
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, title } : item)); setToast('Session renamed.')
    } catch (error) { reportError(error) }
  }
  const setSessionArchived = async (session: SessionRecord, archived: boolean) => {
    if (!bridge) return
    try {
      await bridge.sessions.archive(session.filePath, archived)
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, archived } : item))
      if (archived && workspace.workspaceRef.current.session?.id === session.id) newSession()
      setToast(archived ? 'Session archived. Restore it from Activity.' : 'Session restored.')
    } catch (error) { reportError(error) }
  }
  const addProject = async () => {
    if (!bridge) { setToast('Project picker is available in the desktop app.'); return }
    try {
      const project = await bridge.projects.add()
      if (project) { setProjects((items) => [project, ...items.filter((item) => item.id !== project.id)]); workspace.activateWorkspace(project); setView('session') }
    } catch (error) { reportError(error) }
  }
  const removeProject = async (project: ProjectRecord) => {
    try {
      if (bridge && !await bridge.projects.remove(project.id)) throw new Error('This project could not be removed.')
      setProjects((items) => items.filter((item) => item.id !== project.id))
      if (workspace.workspaceRef.current.project?.id === project.id) {
        const fallback = projects.find((item) => item.id !== project.id)
        const session = fallback ? sessions.find((candidate) => !candidate.archived && projectContainsPath(fallback, candidate.projectPath)) : undefined
        workspace.activateWorkspace(fallback, session)
      }
      setToast('Project removed. Files and saved sessions were kept.')
    } catch (error) { reportError(error) }
  }

  const sendPrompt = async (prompt: string) => {
    await submissionAdmissionRef.current.run(async () => {
      setSubmitting(true)
      const admitted = workspace.workspaceRef.current
      const generation = admitted.generation
      try {
        if (!admitted.project || !admitted.cwd) { reportError('Add a project before starting a Prime session.'); return }
        const userMessage: TranscriptMessage = { id: `user-${Date.now()}`, role: 'user', timestamp: Date.now(), parts: [{ type: 'text', text: prompt }] }
        workspace.admitPrompt()
        workspace.setMessages((items) => [...items, userMessage])
        if (!bridge) {
          const assistantId = `assistant-${Date.now()}`
          workspace.setMessages((items) => [...items, { id: assistantId, role: 'assistant', timestamp: Date.now(), startedAt: Date.now(), streaming: true, parts: [{ type: 'thinking', text: 'Reviewing the request and current workspace context.' }] }])
          demoTimerRef.current.push(window.setTimeout(() => workspace.setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, parts: [...item.parts, { type: 'toolCall', id: 'demo-tool', name: 'Inspect project', args: { cwd: admitted.cwd } }] } : item)), 450))
          demoTimerRef.current.push(window.setTimeout(() => workspace.setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, streaming: false, completedAt: Date.now(), parts: [...item.parts, { type: 'toolResult', name: 'Inspect project', text: 'Project context loaded' }, { type: 'text', text: 'I’ve reviewed the project context and prepared the workspace. Connect the desktop bridge to run this request with Prime Agent.' }] } : item)), 1_250))
          return
        }
        await grantProject(admitted.project)
        if (workspace.workspaceRef.current.generation !== generation) return
        const selected = workspace.workspaceRef.current
        if (!selected.cwd) throw new Error('The selected workspace has no working directory.')
        const liveRuntimes = await bridge.agent.list()
        if (workspace.workspaceRef.current.generation !== generation) return
        const owner = workspace.runtimeOwnerRef.current
        const tracked = workspace.runtimeIdRef.current ? liveRuntimes.find((item) => item.runtimeId === workspace.runtimeIdRef.current) : undefined
        const belongsHere = Boolean(tracked && owner?.runtimeId === tracked.runtimeId && owner.generation === generation && tracked.cwd === selected.cwd && (!selected.sessionFile || tracked.sessionFile === selected.sessionFile))
        let activeRuntime = belongsHere ? tracked : findRuntimeForWorkspace(liveRuntimes, selected.cwd, selected.sessionFile)
        let startedRuntime = false
        if (!activeRuntime) {
          workspace.attachRuntime(undefined, generation)
          const selectedSession = selected.sessionFile ? sessions.find((session) => session.filePath === selected.sessionFile) : undefined
          if (selected.sessionFile && selectedSession?.status === 'running'
            && await bridge.sessions.followUp(selected.sessionFile, prompt)) return
          try {
            activeRuntime = await bridge.agent.start({ cwd: selected.cwd, sessionPath: selected.sessionFile, model: provider.model === 'auto' ? undefined : provider.model, thinking: provider.effort, fast: provider.fast })
          } catch (startError) {
            if (selected.sessionFile && await bridge.sessions.followUp(selected.sessionFile, prompt)) return
            throw startError
          }
          startedRuntime = true
          if (workspace.workspaceRef.current.generation !== generation) { await bridge.agent.stop(activeRuntime.runtimeId).catch(() => false); return }
        }
        if (activeRuntime.cwd !== selected.cwd || (selected.sessionFile && activeRuntime.sessionFile !== selected.sessionFile)) {
          if (startedRuntime) await bridge.agent.stop(activeRuntime.runtimeId).catch(() => false)
          throw new Error('Prime returned a runtime for a different workspace or session.')
        }
        workspace.attachRuntime(activeRuntime, generation)
        workspace.setRuntime({ ...activeRuntime, isStreaming: true })
        workspace.setMessages((items) => [...items, { id: `assistant-${Date.now()}`, role: 'assistant', timestamp: Date.now(), streaming: true, parts: [] }])
        await bridge.agent.command(activeRuntime.runtimeId, { type: activeRuntime.isStreaming ? 'follow_up' : 'prompt', message: prompt })
      } catch (error) {
        if (workspace.workspaceRef.current.generation !== generation) return
        const failure = requestFailureMessage(error)
        workspace.setRuntime((current) => current ? { ...current, isStreaming: false } : current)
        workspace.setMessages((items) => {
          const finalized = items.flatMap((item) => item.streaming && item.role === 'assistant' && item.parts.length === 0 ? [] : [{ ...item, streaming: false }])
          return finalized.at(-1)?.role === 'system' ? finalized : [...finalized, { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: failure }] }]
        })
      } finally { setSubmitting(false) }
    })
  }
  const stopRuntime = async () => {
    if (!workspace.runtime) return
    if (!bridge) { workspace.setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item)); workspace.setRuntime(null); return }
    try {
      await bridge.agent.command(workspace.runtime.runtimeId, { type: 'abort' })
      workspace.setRuntime((current) => current ? { ...current, isStreaming: false } : current)
      workspace.setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item))
    } catch (error) { reportError(error) }
  }

  const refreshSkills = async () => { await loadSkills(true) }
  const installSkill = async (source: string) => {
    if (!bridge) return { ok: false, output: 'Package installation is available in the desktop app.' }
    try { return await bridge.plugins.install(source) } catch (error) { reportError(error); return { ok: false, output: error instanceof Error ? error.message : String(error) } }
  }
  const connectMcp = async (input: McpConnectionInput) => {
    if (!bridge) return { ok: false, output: 'MCP connections are available in the desktop app.' }
    try {
      let connection = input
      if (input.scope === 'project') {
        if (!activeProject) return { ok: false, output: 'Open a project before adding a project MCP server.' }
        const project = await grantProject(activeProject); connection = { ...input, projectPath: project.primaryFolder }
      }
      const response = await bridge.plugins.connectMcp(connection)
      if (response.ok) await loadSkills(false)
      return response
    } catch (error) { reportError(error); return { ok: false, output: error instanceof Error ? error.message : String(error) } }
  }
  const addSchedule = async (schedule: string, prompt: string) => {
    if (!bridge || !workspace.runtime) throw new Error('Open a Prime session before creating a schedule.')
    try { await bridge.schedules.add(workspace.runtime.runtimeId, schedule, prompt) } catch (error) { reportError(error); throw error }
    try { setSchedules(await bridge.schedules.list()); setScheduleError('') } catch (error) { setScheduleError(error instanceof Error ? error.message : String(error)); reportError(error) }
  }
  const cancelSchedule = async (schedule: ScheduleRecord) => {
    const runtimeId = schedule.runtimeId ?? workspace.runtime?.runtimeId
    if (!bridge || !runtimeId) throw new Error('The runtime that owns this schedule is not available.')
    try { await bridge.schedules.cancel(runtimeId, schedule.id) } catch (error) { reportError(error); throw error }
    try { setSchedules(await bridge.schedules.list()); setScheduleError('') } catch (error) { setScheduleError(error instanceof Error ? error.message : String(error)); reportError(error) }
  }
  const openBrowser = () => { if (layout.compactLayout && settingsState.sidebarOpen) settingsState.setSidebarOpen(false); setView('session'); settingsState.selectInspectorTab('browser'); if (!settingsState.inspectorOpen) persistPanel({ inspectorOpen: true }) }
  const openChanges = () => { if (layout.compactLayout && settingsState.sidebarOpen) settingsState.setSidebarOpen(false); settingsState.selectInspectorTab('changes'); if (!settingsState.inspectorOpen) persistPanel({ inspectorOpen: true }) }

  // Transcript deltas rerender App on each animation frame. Keep the navigation
  // contract referentially stable so Sidebar's memo boundary can reject them.
  const sidebarSelectProject = useStableCallback(selectProject)
  const sidebarSelectSession = useStableCallback(selectSession)
  const sidebarNavigate = useStableCallback(navigate)
  const sidebarNewSession = useStableCallback(newSession)
  const sidebarAddProject = useStableCallback(() => { void addProject() })
  const sidebarClose = useStableCallback(toggleSidebar)
  const sidebarOpenPalette = useStableCallback(() => setPaletteOpen(true))
  const sidebarRenameSession = useStableCallback(renameSession)
  const sidebarArchiveSession = useStableCallback((session: SessionRecord) => setSessionArchived(session, true))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('.modal[role="dialog"][aria-modal="true"]')) { if (event.metaKey || event.ctrlKey) event.preventDefault(); return }
      const command = event.metaKey || event.ctrlKey
      if (command && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(true) }
      else if (command && event.key.toLowerCase() === 'n') { event.preventDefault(); newSession() }
      else if (command && event.key.toLowerCase() === 'b' && event.shiftKey) { event.preventDefault(); openBrowser() }
      else if (command && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar() }
      else if (command && event.key.toLowerCase() === 'j') { event.preventDefault(); void toggleTerminal() }
      else if (event.metaKey && event.key === ',') { event.preventDefault(); navigate('settings') }
      else if (event.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown)
  })

  const busy = Boolean(workspace.runtime?.isStreaming || workspace.messages.some((message) => message.streaming))
  const page = view === 'projects' ? <ProjectsPage projects={projects} onAdd={() => void addProject()} onOpen={selectProject} onRemove={(project) => void removeProject(project)} />
    : view === 'activity' ? <ActivityPage sessions={sessions} projects={projects} onOpen={selectSession} onRestore={(session) => void setSessionArchived(session, false)} />
    : view === 'scheduled' ? <ScheduledPage schedules={schedules} error={scheduleError} canCreate={Boolean(workspace.runtime)} onAdd={addSchedule} onCancel={cancelSchedule} />
    : view === 'plugins' ? <PluginsPage skills={skills} loading={loadingSkills} activeProjectPath={activeProject?.primaryFolder} onRefresh={refreshSkills} onInstall={installSkill} onConnectMcp={connectMcp} />
    : view === 'settings' ? <SettingsPage settings={settingsState.settings} meta={meta} providerCatalog={provider.catalog} onUpdate={settingsState.updateSettings} onRefreshProviders={() => provider.refresh(true)} onSaveProviderApiKey={provider.saveApiKey} onLogoutProvider={provider.logout} onSetProviderEnabled={provider.setEnabled} onSetAllProvidersEnabled={provider.setAllEnabled} onStartProviderOAuth={provider.startOAuth} onResetBrowser={async () => {
        if (!bridge) throw new Error('Browser data can only be cleared in the desktop app.')
        if (!await bridge.settings.resetBrowserData()) { const error = new Error('Prime Work could not clear all browser data. Close active downloads and try again.'); reportError(error); throw error }
        setBrowserGeneration((value) => value + 1)
      }} onOpenDocs={() => { if (bridge) void bridge.app.openExternal('https://github.com/PrimeIntellect-ai/prime-agent') }} /> : null

  return <div className="app-shell" aria-busy={!initialized} data-ready={initialized ? 'true' : 'false'}>
    {settingsState.sidebarOpen ? <Sidebar projects={projects} sessions={sessions} activeProjectId={activeProject?.id} activeSessionId={workspace.activeSessionId} activeView={view} onSelectProject={sidebarSelectProject} onSelectSession={sidebarSelectSession} onNavigate={sidebarNavigate} onNewSession={sidebarNewSession} onAddProject={sidebarAddProject} onClose={sidebarClose} onOpenPalette={sidebarOpenPalette} onRenameSession={sidebarRenameSession} onArchiveSession={sidebarArchiveSession} overlay={layout.compactLayout} /> : null}
    {settingsState.sidebarOpen ? <button type="button" className="panel-scrim panel-scrim--sidebar" aria-label="Close sidebar" onClick={toggleSidebar} /> : null}
    <div className="workbench" inert={layout.compactLayout && settingsState.sidebarOpen ? true : undefined}>
      <TitleToolbar project={view === 'session' ? activeProject : undefined} view={view} sidebarOpen={settingsState.sidebarOpen} inspectorOpen={settingsState.inspectorOpen} terminalOpen={settingsState.terminalOpen} onToggleSidebar={toggleSidebar} onToggleInspector={toggleInspector} onToggleTerminal={toggleTerminal} onOpenBrowser={openBrowser} />
      <div className="workbench__content">{view === 'session' ? <div ref={layout.sessionWorkspaceRef} className="session-workspace" style={{ '--inspector-width': `${layout.inspectorWidth}px`, '--terminal-height': `${layout.terminalHeight}px` } as CSSProperties}>
        <div ref={layout.workspaceRowRef} className="workspace-row">
          <main className="conversation-pane">
            <Suspense fallback={<LoadingPanel label="conversation" />}><Transcript key={workspace.activeSessionId ?? 'new-session'} messages={workspace.messages} git={git} loading={workspace.loadingSession} active={busy || activeSession?.status === 'running'} showReasoning={settingsState.settings.showReasoningSummaries} showTools={settingsState.settings.showToolCalls} onOpenChanges={openChanges} onSuggestion={(prompt) => void sendPrompt(prompt)} suggestionsDisabled={!activeProject || workspace.loadingSession || submitting} /></Suspense>
            <Composer key={workspace.activeSessionId ? `${activeProject?.id ?? 'no-project'}:${workspace.activeSessionId}` : `${activeProject?.id ?? 'no-project'}:new:${workspace.workspaceGeneration}`} busy={busy} submitting={submitting} loading={workspace.loadingSession} disabled={!activeProject} model={provider.model} effort={provider.effort} models={provider.catalog?.models ?? []} providers={provider.catalog?.providers ?? []} reasoningLevels={provider.reasoningLevels} fast={provider.fast} fastSupported={provider.selectedModel?.fastModeSupported ?? false} fastAvailable={!workspace.runtime || workspace.runtime.fastModeAvailable !== false} skills={skills} onModelChange={provider.changeModel} onEffortChange={provider.changeEffort} onFastChange={provider.changeFast} onSend={sendPrompt} onStop={stopRuntime} />
          </main>
          {settingsState.inspectorOpen ? <ResizeHandle orientation="vertical" label="Resize inspector" value={layout.inspectorWidth} min={INSPECTOR_MIN} max={layout.inspectorMax} defaultValue={INSPECTOR_DEFAULT} onChange={layout.setInspectorWidth} /> : null}
          {settingsState.inspectorOpen ? <Suspense fallback={<LoadingPanel label="inspector" />}><Inspector key={`inspector-${browserGeneration}`} activeTab={settingsState.inspectorTab} onTabChange={settingsState.selectInspectorTab} onClose={toggleInspector} project={activeProject} cwd={activeCwd} runtime={workspace.runtime} messages={workspace.messages} git={git} browserHome={settingsState.settings.browserHome} onRefreshGit={refreshGit} onOpenExternal={(url) => { if (bridge) void bridge.app.openExternal(url) }} onRevealPath={(path) => { if (bridge) void bridge.app.revealPath(path) }} overlay={layout.compactLayout} /></Suspense> : null}
          {settingsState.inspectorOpen ? <button type="button" className="panel-scrim panel-scrim--inspector" aria-label="Close inspector" onClick={toggleInspector} /> : null}
        </div>
        {settingsState.terminalOpen ? <Suspense fallback={<LoadingPanel label="terminal" />}><TerminalDrawer cwd={activeCwd} shell={settingsState.settings.terminalShell} height={layout.terminalHeight} minHeight={TERMINAL_MIN} maxHeight={layout.terminalMax} defaultHeight={TERMINAL_DEFAULT} onHeightChange={layout.setTerminalHeight} onClose={toggleTerminal} onError={reportError} /></Suspense> : null}
      </div> : <Suspense fallback={<LoadingPanel label={view} />}>{page}</Suspense>}</div>
    </div>
    {paletteOpen ? <Suspense fallback={null}><CommandPalette open onClose={() => setPaletteOpen(false)} onNavigate={navigate} onNewSession={newSession} onToggleSidebar={toggleSidebar} onToggleTerminal={toggleTerminal} onOpenBrowser={openBrowser} /></Suspense> : null}
    {extension.extensionUi ? <Suspense fallback={<LoadingPanel label="request" />}><ExtensionUiModal request={extension.extensionUi.request} onRespond={(response) => void extension.respondToExtensionUi(response)} /></Suspense> : null}
    {provider.authEvent ? <Suspense fallback={<LoadingPanel label="provider login" />}><ProviderAuthModal event={provider.authEvent} onOpen={(url) => { if (bridge) void bridge.app.openExternal(url) }} onRespond={provider.respondOAuth} onCancel={provider.cancelOAuth} /></Suspense> : null}
    {toast ? <div className="toast" role="status">{toast}<button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>×</button></div> : null}
  </div>
}
