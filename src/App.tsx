import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { TitleToolbar } from '@/components/TitleToolbar'
import { ChangesCard } from '@/components/ChangesCard'
import { Composer } from '@/components/Composer'
import { ResizeHandle } from '@/components/ResizeHandle'
import { createAppKeydownHandler } from '@/lib/app-shortcuts'
import { createSingleFlightAdmission, findProjectForSession, gitStatusForWorkspace, shouldRefreshGitOnSessionTransition, workspaceCwd } from '@/lib/workspace'
import { SAMPLE_GIT, SAMPLE_PROJECTS, SAMPLE_SCHEDULES, SAMPLE_SESSIONS, SAMPLE_SKILLS, SAMPLE_TRANSCRIPT } from '@/lib/data'
import { AgentBrowserLayer, type AgentSlotRect } from '@/components/AgentBrowserLayer'
import { useAgentBrowserTabs } from '@/hooks/useAgentBrowserTabs'
import { useAgentEvents } from '@/hooks/useAgentEvents'
import { useAppSettings } from '@/hooks/useAppSettings'
import { useBootstrap } from '@/hooks/useBootstrap'
import { useBrowserAnnotations } from '@/hooks/useBrowserAnnotations'
import { useExtensionUi } from '@/hooks/useExtensionUi'
import { INSPECTOR_DEFAULT, INSPECTOR_MIN, TERMINAL_DEFAULT, TERMINAL_MIN, usePanelLayout } from '@/hooks/usePanelLayout'
import { usePluginSkills } from '@/hooks/usePluginSkills'
import { useProviderCatalog } from '@/hooks/useProviderCatalog'
import { useSidebarActions } from '@/hooks/useSidebarActions'
import { useStableCallback } from '@/hooks/useStableCallback'
import { useWorkspaceActions } from '@/hooks/useWorkspaceActions'
import { useWorkspaceRuntime } from '@/hooks/useWorkspaceRuntime'
import type { GitStatus, NativeHeartbeatRecord, PrimeModelDescriptor, PrimeProviderDescriptor, ProjectRecord, AutomationScheduleRecord, QueuedPrompt, ScheduleTiming, SessionRecord, WorkspaceView } from '@/types/api'

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
// Stable fallback identities keep memoized children from re-rendering while the catalog loads.
const EMPTY_MODELS: PrimeModelDescriptor[] = []
const EMPTY_PROVIDERS: PrimeProviderDescriptor[] = []
const LoadingPanel = ({ label }: { label: string }) => <div className="empty-state" role="status">Loading {label}…</div>

export default function App() {
  const bridge = hasBridge() ? window.prime : null
  const initialProject = bridge ? undefined : SAMPLE_PROJECTS[0]
  const initialSession = bridge ? undefined : SAMPLE_SESSIONS[0]
  const [projects, setProjects] = useState<ProjectRecord[]>(() => bridge ? [] : SAMPLE_PROJECTS)
  const [sessions, setSessions] = useState<SessionRecord[]>(() => bridge ? [] : SAMPLE_SESSIONS)
  const [schedules, setSchedules] = useState<AutomationScheduleRecord[]>(() => bridge ? [] : SAMPLE_SCHEDULES)
  const [heartbeats, setHeartbeats] = useState<NativeHeartbeatRecord[]>([])
  const [scheduleFocusId, setScheduleFocusId] = useState<string | null>(null)
  const [scheduleError, setScheduleError] = useState('')
  const [gitSnapshot, setGitSnapshot] = useState(() => ({ cwd: bridge ? undefined : SAMPLE_PROJECTS[0]?.primaryFolder, status: bridge ? { isRepo: false, files: [] } as GitStatus : SAMPLE_GIT }))
  const [view, setView] = useState<WorkspaceView>('session')
  const [browserGeneration, setBrowserGeneration] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const submissionAdmissionRef = useRef(createSingleFlightAdmission())
  const queuedFlushRef = useRef(false)
  const gitRequestRef = useRef(0)
  const scheduleRequestRef = useRef(0)
  const demoTimerRef = useRef<number[]>([])
  const toastTimerRef = useRef<number | null>(null)

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setToast(message)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null
      setToast((current) => current === message ? null : current)
    }, 4_800)
  }, [])
  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
  }, [])
  const settingsState = useAppSettings({ bridge, reportError })
  const browserAnnotations = useBrowserAnnotations()
  const workspace = useWorkspaceRuntime({
    bridge, initialProject, initialSession, sessions,
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
    sidebarOpen: settingsState.sidebarOpen,
    inspectorOpen: settingsState.inspectorOpen, setInspectorOpen: settingsState.setInspectorOpen,
    terminalOpen: settingsState.terminalOpen, view,
  })
  const extension = useExtensionUi({
    bridge, activeRuntimeId: workspace.runtime?.runtimeId, runtimeSessionsRef: workspace.runtimeSessionsRef,
    setSessions, setRuntime: workspace.setRuntime, reportError,
  })
  const { meta, initialized } = useBootstrap({
    bridge, setProjects, setSessions, setSchedules, setScheduleError,
    runtimeSessionsRef: workspace.runtimeSessionsRef, workspaceRef: workspace.workspaceRef,
    activateWorkspace: workspace.activateWorkspace, attachRuntime: workspace.attachRuntime,
    sessionHasOpenExtensionUi: extension.hasOpenRequestForSession, reportError,
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
    setSessions, setRuntime: workspace.setRuntime, reconcileQueuedPrompts: workspace.reconcileQueuedPrompts,
    clearQueuedPrompts: workspace.clearQueuedPrompts, queueAgentEvent: workspace.queueAgentEvent,
    reconcileTranscriptForEvent: workspace.reconcileTranscriptForEvent,
    showExtensionUi: extension.showExtensionUi, clearExtensionUi: extension.clearExtensionUi,
    refreshGit, refreshGitOnTerminalEvent: Boolean(activeCwd),
    activeSessionVisible: view === 'session',
  })

  useEffect(() => { void refreshGit(); return () => { gitRequestRef.current += 1 } }, [refreshGit])
  const previousSessionStatusRef = useRef<SessionRecord['status'] | undefined>(undefined)
  const activeSessionStatus = activeSession?.status
  const locallyOwnedActiveSession = Boolean(activeSession && workspace.runtime?.sessionFile === activeSession.filePath)
  useEffect(() => {
    const previousStatus = previousSessionStatusRef.current
    previousSessionStatusRef.current = activeSessionStatus
    if (shouldRefreshGitOnSessionTransition(previousStatus, activeSessionStatus, locallyOwnedActiveSession)) void refreshGit()
  }, [activeSessionStatus, locallyOwnedActiveSession, refreshGit])
  const agentBrowser = useAgentBrowserTabs({ bridge, reportError })
  const [agentPreviewSelected, setAgentPreviewSelected] = useState(true)
  const [agentSlotRect, setAgentSlotRect] = useState<AgentSlotRect | null>(null)
  const activeRuntimeSessionFile = workspace.runtime?.sessionFile
  const activeSessionFilePath = activeSession?.filePath
  const activeAgentTabs = useMemo(() => {
    const keys = new Set<string>()
    if (activeRuntimeSessionFile) keys.add(activeRuntimeSessionFile)
    if (activeSessionFilePath) keys.add(activeSessionFilePath)
    return agentBrowser.tabs.filter((tab) => keys.has(tab.sessionFile))
  }, [agentBrowser.tabs, activeRuntimeSessionFile, activeSessionFilePath])
  const activeAgentTabId = activeAgentTabs.find((tab) => tab.active)?.tabId ?? activeAgentTabs[0]?.tabId ?? null
  // Every agent browser action in the active thread surfaces the Browser
  // panel: open the inspector, select the Browser tab, and show the tab being
  // driven (the user's Preview or an agent tab), whatever was showing before.
  useEffect(() => {
    const activity = agentBrowser.activityEvent
    if (!activity) return
    if (activity.sessionFile !== activeRuntimeSessionFile && activity.sessionFile !== activeSessionFilePath) return
    setAgentPreviewSelected(activity.tabId === 'preview')
    settingsState.setInspectorOpen(true)
    settingsState.selectInspectorTab('browser')
  }, [agentBrowser.activityEvent, activeRuntimeSessionFile, activeSessionFilePath, settingsState.setInspectorOpen, settingsState.selectInspectorTab])
  useEffect(() => { if (!activeAgentTabs.length) setAgentPreviewSelected(true) }, [activeAgentTabs.length])
  const agentTabVisible = view === 'session' && settingsState.inspectorOpen && settingsState.inspectorTab === 'browser' && !agentPreviewSelected && activeAgentTabId !== null
  const pluginScope = activeProject?.primaryFolder && !activeProject.inferred ? activeProject.primaryFolder : undefined
  const pluginSkills = usePluginSkills({ bridge, scope: pluginScope, generation: workspace.workspaceGeneration, initialSkills: bridge ? [] : SAMPLE_SKILLS, reportError })
  useEffect(() => () => { demoTimerRef.current.forEach(window.clearTimeout) }, [])

  const refreshSchedules = useCallback(async () => {
    if (!bridge) return
    const requestId = ++scheduleRequestRef.current
    try {
      const next = await bridge.schedules.list()
      if (scheduleRequestRef.current === requestId) { setSchedules(next); setScheduleError('') }
    } catch (error) {
      if (scheduleRequestRef.current === requestId) setScheduleError(error instanceof Error ? error.message : String(error))
      reportError(error)
    }
  }, [bridge, reportError])
  useEffect(() => {
    if (!bridge) return
    return bridge.schedules.onChanged(() => { void refreshSchedules() })
  }, [bridge, refreshSchedules])
  const refreshHeartbeats = useCallback(async () => {
    if (!bridge) return
    try { setHeartbeats(await bridge.heartbeats.list()) } catch (error) { reportError(error) }
  }, [bridge, reportError])
  useEffect(() => {
    if (!bridge) return
    void refreshHeartbeats()
    const interval = window.setInterval(() => { void refreshHeartbeats() }, 30_000)
    return () => window.clearInterval(interval)
  }, [bridge, refreshHeartbeats])
  const {
    toggleSidebar, toggleInspector, toggleTerminal,
    selectProject, selectSession, newSession, navigate, renameSession, setSessionArchived,
    addProject, removeProject, sendPrompt, stopRuntime, installSkill, connectMcp,
    createSchedule, updateSchedule, mutateSchedule, manageHeartbeat, openScheduledSession,
    openBrowser, openChanges,
  } = useWorkspaceActions({
    bridge, initialized, projects, sessions, activeProject,
    workspace, settingsState, layout, provider, pluginSkills,
    submissionAdmissionRef, gitRequestRef, demoTimerRef,
    setProjects, setSessions, setGitSnapshot, setView, setPaletteOpen, setToast, setSubmitting,
    refreshSchedules, refreshHeartbeats, reportError,
  })
  const sidebarActions = useSidebarActions({
    onSelectProject: selectProject,
    onSelectSession: selectSession,
    onNavigate: navigate,
    onNewSession: newSession,
    onAddProject: () => { void addProject() },
    onClose: toggleSidebar,
    onOpenPalette: () => setPaletteOpen(true),
    onRenameSession: renameSession,
    onArchiveSession: (session) => setSessionArchived(session, true),
  })

  const onAppKeyDown = useStableCallback(createAppKeydownHandler({
    'open-palette': () => setPaletteOpen(true),
    'new-session': () => newSession(),
    'open-browser': () => openBrowser(),
    'toggle-sidebar': () => toggleSidebar(),
    'toggle-terminal': () => { void toggleTerminal() },
    'open-settings': () => navigate('settings'),
    'close-palette': () => setPaletteOpen(false),
  }))

  useEffect(() => {
    window.addEventListener('keydown', onAppKeyDown)
    return () => window.removeEventListener('keydown', onAppKeyDown)
  }, [onAppKeyDown])

  const busy = Boolean(workspace.runtime?.isStreaming || workspace.runtime?.isCompacting || workspace.messages.some((message) => message.streaming))
  const externalSessionRunning = Boolean(activeSession?.status === 'running' && workspace.runtime?.sessionFile !== activeSession.filePath)
  const queuedMessages = useMemo<QueuedPrompt[]>(
    () => workspace.pendingQueuedPrompts.filter((pending) => pending.intent === 'queue'),
    [workspace.pendingQueuedPrompts],
  )
  useEffect(() => {
    if (!bridge || busy || externalSessionRunning || submitting || queuedFlushRef.current || workspace.pendingQueuedPrompts.length === 0) return
    const next = workspace.pendingQueuedPrompts[0]
    queuedFlushRef.current = true
    void sendPrompt(next.text, [], 'queue')
      .then(() => workspace.removeQueuedPrompt(next.id))
      .catch(() => undefined)
      .finally(() => { queuedFlushRef.current = false })
  }, [bridge, busy, externalSessionRunning, sendPrompt, submitting, workspace.pendingQueuedPrompts, workspace.removeQueuedPrompt])

  const page = view === 'projects' ? <ProjectsPage projects={projects} onAdd={() => void addProject()} onOpen={selectProject} onRemove={(project) => void removeProject(project)} />
    : view === 'activity' ? <ActivityPage sessions={sessions} projects={projects} onOpen={selectSession} onRestore={(session) => void setSessionArchived(session, false)} />
    : view === 'scheduled' ? <ScheduledPage schedules={schedules} nativeHeartbeats={heartbeats} projects={projects} sessions={sessions} models={provider.catalog?.models ?? EMPTY_MODELS} error={scheduleError} initialProjectId={activeProject?.id} initialSessionId={activeSession?.id} selectedScheduleId={scheduleFocusId} onCreate={createSchedule} onUpdate={updateSchedule} onPause={(id: string) => mutateSchedule(() => bridge!.schedules.pause(id))} onResume={(id: string) => mutateSchedule(() => bridge!.schedules.resume(id))} onDelete={(id: string) => mutateSchedule(() => bridge!.schedules.delete(id))} onRunNow={(id: string) => mutateSchedule(() => bridge!.schedules.runNow(id))} onPreview={async (timing: ScheduleTiming) => bridge ? bridge.schedules.preview(timing, 3) : { timing, occurrences: [] }} onOpenSession={openScheduledSession} onManageHeartbeat={manageHeartbeat} />
    : view === 'plugins' ? <PluginsPage skills={pluginSkills.skills} warnings={pluginSkills.warnings} loading={pluginSkills.loading} activeProjectPath={activeProject?.primaryFolder} onRefresh={pluginSkills.refresh} onInstall={installSkill} onConnectMcp={connectMcp} />
    : view === 'settings' ? <SettingsPage settings={settingsState.settings} meta={meta} providerCatalog={provider.catalog} onUpdate={settingsState.updateSettings} onRefreshProviders={() => provider.refresh(true)} onSaveProviderApiKey={provider.saveApiKey} onLogoutProvider={provider.logout} onSetProviderEnabled={provider.setEnabled} onSetAllProvidersEnabled={provider.setAllEnabled} onSetAllProvidersDisabled={provider.setAllDisabled} onStartProviderOAuth={provider.startOAuth} onResetBrowser={async () => {
        if (!bridge) throw new Error('Browser data can only be cleared in the desktop app.')
        if (!await bridge.settings.resetBrowserData()) { const error = new Error('Prime Work could not clear all browser data. Close active downloads and try again.'); reportError(error); throw error }
        setBrowserGeneration((value) => value + 1)
      }} onOpenDocs={() => { if (bridge) void bridge.app.openExternal('https://github.com/PrimeIntellect-ai/prime-agent') }} /> : null

  return <div className="app-shell" aria-busy={!initialized} data-ready={initialized ? 'true' : 'false'}>
    {settingsState.sidebarOpen && initialized ? <Sidebar projects={projects} sessions={sessions} activeProjectId={activeProject?.id} activeSessionId={workspace.activeSessionId} activeView={view} {...sidebarActions} overlay={layout.compactLayout} /> : null}
    {settingsState.sidebarOpen && initialized ? <button type="button" className="panel-scrim panel-scrim--sidebar" aria-label="Close sidebar" onClick={toggleSidebar} /> : null}
    <div className="workbench" inert={layout.compactLayout && settingsState.sidebarOpen ? true : undefined}>
      <TitleToolbar project={view === 'session' ? activeProject : undefined} view={view} sidebarOpen={settingsState.sidebarOpen} inspectorOpen={settingsState.inspectorOpen} terminalOpen={settingsState.terminalOpen} onToggleSidebar={toggleSidebar} onToggleInspector={toggleInspector} onToggleTerminal={toggleTerminal} onOpenBrowser={openBrowser} />
      <div className="workbench__content">{view === 'session' ? <div ref={layout.sessionWorkspaceRef} className="session-workspace" style={{ '--inspector-width': `${layout.inspectorWidth}px`, '--terminal-height': `${layout.terminalHeight}px` } as CSSProperties}>
        <div ref={layout.workspaceRowRef} className="workspace-row">
          <main className="conversation-pane">
            <Suspense fallback={<LoadingPanel label="conversation" />}><Transcript key={workspace.activeSessionId ?? 'new-session'} messages={workspace.messages} git={git} loading={workspace.loadingSession} active={busy || activeSession?.status === 'running'} showReasoning={settingsState.settings.showReasoningSummaries} showTools={settingsState.settings.showToolCalls} onOpenChanges={openChanges} onSuggestion={(prompt) => { void sendPrompt(prompt).catch(() => undefined) }} suggestionsDisabled={!activeProject || workspace.loadingSession || submitting} showPinnedChanges={false} bottomDockHasChanges={git.files.length > 0} queuedMessageCount={queuedMessages.length} /></Suspense>
            <div className="conversation-bottom-dock">
              {git.files.length ? <ChangesCard git={git} onOpenChanges={openChanges} /> : null}
              <Composer key={workspace.activeSessionId ? `${activeProject?.id ?? 'no-project'}:${workspace.activeSessionId}` : `${activeProject?.id ?? 'no-project'}:new:${workspace.workspaceGeneration}`} busy={busy} submitting={submitting} loading={workspace.loadingSession} disabled={!activeProject} model={provider.model} effort={provider.effort} modelsByProvider={provider.modelsByProvider} providers={provider.catalog?.providers ?? EMPTY_PROVIDERS} reasoningLevels={provider.reasoningLevels} fast={provider.fast} fastSupported={provider.selectedModel?.fastModeSupported ?? false} fastAvailable={workspace.runtime?.fastModeAvailable !== false} imageInputSupported={provider.model === 'auto' || Boolean(provider.selectedModel?.input.includes('image'))} contextUsage={workspace.runtime?.contextUsage} skills={pluginSkills.skills} annotations={browserAnnotations.annotations} queuedMessages={queuedMessages} onDeleteQueuedMessage={(message) => workspace.removeQueuedPrompt(message.id)} onEditQueuedMessage={(message) => workspace.removeQueuedPrompt(message.id)} sendSignal={browserAnnotations.sendSignal} onModelChange={provider.changeModel} onEffortChange={provider.changeEffort} onFastChange={provider.changeFast} onSend={sendPrompt} onStop={stopRuntime} onRemoveAnnotation={browserAnnotations.remove} onClearAnnotations={browserAnnotations.clear} />
            </div>
          </main>
          {settingsState.inspectorOpen ? <ResizeHandle orientation="vertical" label="Resize inspector" value={layout.inspectorWidth} min={INSPECTOR_MIN} max={layout.inspectorMax} defaultValue={INSPECTOR_DEFAULT} onChange={layout.setInspectorWidth} /> : null}
          {settingsState.inspectorOpen ? <Suspense fallback={<LoadingPanel label="inspector" />}><Inspector key={`inspector-${browserGeneration}`} activeTab={settingsState.inspectorTab} onTabChange={settingsState.selectInspectorTab} onClose={toggleInspector} project={activeProject} cwd={activeCwd} runtime={workspace.runtime} messages={workspace.messages} git={git} automations={activeSession ? schedules.filter((task) => task.target.kind === 'session' && task.target.sessionId === activeSession.id) : []} heartbeats={activeSession ? heartbeats.filter((heartbeat) => heartbeat.sessionId === activeSession.id || heartbeat.sessionFile === activeSession.filePath) : []} onOpenAutomation={(id) => { setScheduleFocusId(id); setView('scheduled') }} browserHome={settingsState.settings.browserHome} browserAnnotations={browserAnnotations} agentBrowserTabs={activeAgentTabs} activeAgentTabId={activeAgentTabId} agentPreviewSelected={agentPreviewSelected} onSelectAgentTab={(tabId) => { setAgentPreviewSelected(false); agentBrowser.select(tabId) }} onCloseAgentTab={agentBrowser.close} onShowBrowserPreview={() => setAgentPreviewSelected(true)} onAgentSlotRect={setAgentSlotRect} agentSessionKey={activeRuntimeSessionFile ?? activeSessionFilePath} onPreviewContext={(webContentsId, sessionFile) => { if (bridge) void bridge.browser.setPreviewContext(webContentsId, sessionFile).catch(() => undefined) }} previewPointerEvent={agentBrowser.pointerEvent?.tabId === 'preview' ? agentBrowser.pointerEvent : null} onNavigateAgentTab={(tabId, action) => { if (bridge) void bridge.browser.navigateTab(tabId, action).catch(() => undefined) }} onRefreshGit={refreshGit} onOpenExternal={(url) => { if (bridge) void bridge.app.openExternal(url) }} onRevealPath={(path) => { if (bridge) void bridge.app.revealPath(path) }} overlay={layout.compactLayout} /></Suspense> : null}
          {settingsState.inspectorOpen ? <button type="button" className="panel-scrim panel-scrim--inspector" aria-label="Close inspector" onClick={toggleInspector} /> : null}
        </div>
        {settingsState.terminalOpen ? <Suspense fallback={<LoadingPanel label="terminal" />}><TerminalDrawer cwd={activeCwd} shell={settingsState.settings.terminalShell} height={layout.terminalHeight} minHeight={TERMINAL_MIN} maxHeight={layout.terminalMax} defaultHeight={TERMINAL_DEFAULT} onHeightChange={layout.setTerminalHeight} onClose={toggleTerminal} onError={reportError} /></Suspense> : null}
      </div> : <Suspense fallback={<LoadingPanel label={view} />}>{page}</Suspense>}</div>
    </div>
    {paletteOpen ? <Suspense fallback={null}><CommandPalette open onClose={() => setPaletteOpen(false)} onNavigate={navigate} onNewSession={newSession} onToggleSidebar={toggleSidebar} onToggleTerminal={toggleTerminal} onOpenBrowser={openBrowser} /></Suspense> : null}
    {extension.extensionUi ? <Suspense fallback={<LoadingPanel label="request" />}><ExtensionUiModal request={extension.extensionUi.request} onRespond={(response) => void extension.respondToExtensionUi(response)} /></Suspense> : null}
    {provider.authEvent ? <Suspense fallback={<LoadingPanel label="provider login" />}><ProviderAuthModal event={provider.authEvent} onOpen={(url) => { if (bridge) void bridge.app.openExternal(url) }} onRespond={provider.respondOAuth} onCancel={provider.cancelOAuth} /></Suspense> : null}
    {toast ? <div className="toast" role="status">{toast}<button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>×</button></div> : null}
    {bridge ? <AgentBrowserLayer tabs={agentBrowser.tabs} visibleTabId={agentTabVisible ? activeAgentTabId : null} rect={agentTabVisible ? agentSlotRect : null} pointerEvent={agentBrowser.pointerEvent} onAttach={agentBrowser.attach} /> : null}
  </div>
}
