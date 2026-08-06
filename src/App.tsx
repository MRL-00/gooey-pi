import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { TitleToolbar } from '@/components/TitleToolbar'
import { Transcript } from '@/components/Transcript'
import { Composer } from '@/components/Composer'
import { Inspector } from '@/components/Inspector'
import { TerminalDrawer } from '@/components/TerminalDrawer'
import { CommandPalette } from '@/components/CommandPalette'
import { ResizeHandle } from '@/components/ResizeHandle'
import { ExtensionUiModal, type ExtensionUiResponse } from '@/components/ExtensionUiModal'
import { ProjectsPage } from '@/pages/ProjectsPage'
import { ActivityPage } from '@/pages/ActivityPage'
import { ScheduledPage } from '@/pages/ScheduledPage'
import { PluginsPage } from '@/pages/PluginsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { applyPrimeEvent, createPrimeEventBuffer } from '@/lib/events'
import type { PrimeEventBuffer } from '@/lib/events'
import { parseExtensionUiRequest, type ExtensionUiRequest } from '@/lib/extension-ui'
import { createSingleFlightAdmission, findProjectForSession, findRuntimeForWorkspace, projectContainsPath, selectStartupWorkspace, workspaceCwd } from '@/lib/workspace'
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
  McpConnectionInput,
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

const INSPECTOR_MIN = 340
const INSPECTOR_DEFAULT = 520
const CHAT_MIN = 360
const TERMINAL_MIN = 170
const TERMINAL_DEFAULT = 310
const WORKSPACE_ROW_MIN = 220

const readPanelSize = (key: string, fallback: number) => {
  if (typeof window === 'undefined') return fallback
  const value = Number(window.localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const requestFailureMessage = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim()
  return detail ? `Request failed: ${detail.slice(0, 1_000)}` : 'Prime could not process the request.'
}

interface WorkspaceSnapshot {
  generation: number
  project?: ProjectRecord
  session?: SessionRecord
  cwd?: string
  sessionFile?: string
}

interface TranscriptLoad {
  generation: number
  sessionFile: string
  eventBuffer: PrimeEventBuffer
}

export interface PendingAgentEvent {
  generation: number
  event: Record<string, unknown>
}

export function admitAgentEvent(
  generation: number,
  event: Record<string, unknown>,
  pendingLoad: Pick<TranscriptLoad, 'generation' | 'eventBuffer'> | null,
  frameQueue: PendingAgentEvent[],
): 'transcript' | 'frame' {
  if (pendingLoad?.generation === generation) {
    pendingLoad.eventBuffer.push(event)
    return 'transcript'
  }
  frameQueue.push({ generation, event })
  return 'frame'
}

export function eventsForWorkspace(queue: PendingAgentEvent[], generation: number): Record<string, unknown>[] {
  return queue.filter((entry) => entry.generation === generation).map((entry) => entry.event)
}

export default function App() {
  const bridge = hasBridge() ? window.prime : null
  const initialProject = bridge ? undefined : SAMPLE_PROJECTS[0]
  const initialSession = bridge ? undefined : SAMPLE_SESSIONS[0]
  const [projects, setProjects] = useState<ProjectRecord[]>(() => bridge ? [] : SAMPLE_PROJECTS)
  const [sessions, setSessions] = useState<SessionRecord[]>(() => bridge ? [] : SAMPLE_SESSIONS)
  const [messages, setMessages] = useState<TranscriptMessage[]>(() => bridge ? [] : SAMPLE_TRANSCRIPT)
  const [skills, setSkills] = useState<SkillRecord[]>(() => bridge ? [] : SAMPLE_SKILLS)
  const [schedules, setSchedules] = useState<ScheduleRecord[]>(() => bridge ? [] : SAMPLE_SCHEDULES)
  const [scheduleError, setScheduleError] = useState('')
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
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia('(max-width: 980px)').matches)
  const [inspectorWidth, setInspectorWidth] = useState(() => readPanelSize('prime-work.inspector-width', INSPECTOR_DEFAULT))
  const [terminalHeight, setTerminalHeight] = useState(() => readPanelSize('prime-work.terminal-height', TERMINAL_DEFAULT))
  const [inspectorMax, setInspectorMax] = useState(660)
  const [terminalMax, setTerminalMax] = useState(520)
  const [browserGeneration, setBrowserGeneration] = useState(0)
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [initialized, setInitialized] = useState(!bridge)
  const [submitting, setSubmitting] = useState(false)
  const [loadingSkills, setLoadingSkills] = useState(false)
  const [model, setModel] = useState('auto')
  const [effort, setEffort] = useState('medium')
  const [toast, setToast] = useState<string | null>(null)
  const [extensionUi, setExtensionUi] = useState<{ runtimeId: string; request: ExtensionUiRequest } | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const confirmedSettingsRef = useRef(settings)
  const settingsMutationRef = useRef(0)
  const settingsQueueRef = useRef<Promise<void>>(Promise.resolve())
  const extensionUiRef = useRef<{ runtimeId: string; request: ExtensionUiRequest } | null>(null)
  const pendingExtensionUiRequestsRef = useRef<Map<string, ExtensionUiRequest>>(new Map())
  const extensionUiTimerRef = useRef<number | null>(null)
  const inspectorTabTouchedRef = useRef(false)
  const runtimeIdRef = useRef<string | null>(null)
  const runtimeSessionsRef = useRef<Map<string, string>>(new Map())
  const runtimeOwnerRef = useRef<{ runtimeId: string; generation: number } | null>(null)
  const workspaceRef = useRef<WorkspaceSnapshot>({
    generation: 0,
    project: initialProject,
    session: initialSession,
    cwd: workspaceCwd(initialProject, initialSession),
    sessionFile: initialSession?.filePath,
  })
  const transcriptLoadRef = useRef<TranscriptLoad | null>(null)
  const pendingAgentEventsRef = useRef<PendingAgentEvent[]>([])
  const agentEventFrameRef = useRef<number | null>(null)
  const submissionAdmissionRef = useRef(createSingleFlightAdmission())
  const gitRequestRef = useRef(0)
  const demoTimerRef = useRef<number[]>([])
  const workspaceRowRef = useRef<HTMLDivElement>(null)
  const sessionWorkspaceRef = useRef<HTMLDivElement>(null)
  const compactRestoreRef = useRef<'inspector' | null>(null)

  useEffect(() => {
    const sync = () => setCompactLayout(window.innerWidth <= 980)
    sync(); window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  useEffect(() => {
    if (compactLayout && sidebarOpen && inspectorOpen) { compactRestoreRef.current = 'inspector'; setInspectorOpen(false) }
    else if (!compactLayout && compactRestoreRef.current === 'inspector' && sidebarOpen && !inspectorOpen) { compactRestoreRef.current = null; setInspectorOpen(true) }
  }, [compactLayout, sidebarOpen, inspectorOpen])

  useEffect(() => {
    if (!compactLayout || !inspectorOpen) return
    const targets = [...document.querySelectorAll<HTMLElement>('.title-toolbar, .conversation-pane, .terminal-drawer, .workspace-row > .resize-handle')]
    for (const target of targets) target.inert = true
    return () => { for (const target of targets) target.inert = false }
  }, [compactLayout, inspectorOpen, terminalOpen])

  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId), [sessions, activeSessionId])
  const activeProject = useMemo(() => {
    const containingProject = findProjectForSession(projects, activeSession)
    return containingProject ?? projects.find((project) => project.id === activeProjectId) ?? projects[0]
  }, [projects, activeProjectId, activeSession])
  const busy = Boolean(runtime?.isStreaming || messages.some((message) => message.streaming))

  useEffect(() => {
    const row = workspaceRowRef.current
    const workspace = sessionWorkspaceRef.current
    if (!row || !workspace) return
    const syncBounds = () => {
      if (!window.matchMedia('(max-width: 980px)').matches) setInspectorMax(Math.max(INSPECTOR_MIN, row.clientWidth - CHAT_MIN))
      setTerminalMax(Math.max(TERMINAL_MIN, workspace.clientHeight - WORKSPACE_ROW_MIN))
    }
    syncBounds()
    const observer = new ResizeObserver(syncBounds)
    observer.observe(row)
    observer.observe(workspace)
    return () => observer.disconnect()
  }, [inspectorOpen, terminalOpen, view])

  useEffect(() => setInspectorWidth((value) => Math.min(inspectorMax, Math.max(INSPECTOR_MIN, value))), [inspectorMax])
  useEffect(() => setTerminalHeight((value) => Math.min(terminalMax, Math.max(TERMINAL_MIN, value))), [terminalMax])
  useEffect(() => { window.localStorage.setItem('prime-work.inspector-width', String(inspectorWidth)) }, [inspectorWidth])
  useEffect(() => { window.localStorage.setItem('prime-work.terminal-height', String(terminalHeight)) }, [terminalHeight])

  const reportError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setToast(message)
    window.setTimeout(() => setToast((current) => current === message ? null : current), 4800)
  }, [])

  const clearExtensionUi = useCallback((runtimeId?: string) => {
    const current = extensionUiRef.current
    if (!current || (runtimeId && current.runtimeId !== runtimeId)) return
    if (extensionUiTimerRef.current !== null) window.clearTimeout(extensionUiTimerRef.current)
    extensionUiTimerRef.current = null
    extensionUiRef.current = null
    setExtensionUi(null)
  }, [])

  const respondToExtensionUi = useCallback(async (response: ExtensionUiResponse) => {
    const pending = extensionUiRef.current
    if (!pending) return
    pendingExtensionUiRequestsRef.current.delete(pending.runtimeId)
    clearExtensionUi(pending.runtimeId)
    const pendingSession = runtimeSessionsRef.current.get(pending.runtimeId)
    if (pendingSession) setSessions((items) => items.map((session) => session.filePath === pendingSession ? { ...session, status: 'running', unread: false } : session))
    if (!bridge) return
    try {
      await bridge.agent.command(pending.runtimeId, { type: 'extension_ui_response', id: pending.request.id, ...response })
    } catch (error) {
      if (runtimeIdRef.current === pending.runtimeId) reportError(error)
    }
  }, [bridge, clearExtensionUi, reportError])

  const showExtensionUi = useCallback((runtimeId: string, rawEvent: Record<string, unknown>) => {
    const request = parseExtensionUiRequest(rawEvent)
    if (!request || !bridge) return
    pendingExtensionUiRequestsRef.current.set(runtimeId, request)
    const previous = extensionUiRef.current
    if (previous) {
      void bridge.agent.command(previous.runtimeId, { type: 'extension_ui_response', id: previous.request.id, cancelled: true }).catch(() => undefined)
      clearExtensionUi(previous.runtimeId)
    }
    const pending = { runtimeId, request }
    extensionUiRef.current = pending
    setExtensionUi(pending)
    if ('timeout' in request && request.timeout !== undefined) {
      extensionUiTimerRef.current = window.setTimeout(() => {
        if (extensionUiRef.current?.request.id !== request.id) return
        void bridge.agent.command(runtimeId, { type: 'extension_ui_response', id: request.id, cancelled: true }).catch(() => undefined)
        clearExtensionUi(runtimeId)
      }, request.timeout)
    }
  }, [bridge, clearExtensionUi])

  const flushAgentEvents = useCallback(() => {
    agentEventFrameRef.current = null
    const generation = workspaceRef.current.generation
    const pending = pendingAgentEventsRef.current
    pendingAgentEventsRef.current = []
    const admitted = eventsForWorkspace(pending, generation)
    if (admitted.length) setMessages((current) => admitted.reduce((messages, event) => applyPrimeEvent(messages, event), current))
  }, [])

  const queueAgentEvent = useCallback((event: Record<string, unknown>) => {
    const generation = workspaceRef.current.generation
    const owner = admitAgentEvent(generation, event, transcriptLoadRef.current, pendingAgentEventsRef.current)
    if (owner === 'frame' && agentEventFrameRef.current === null) agentEventFrameRef.current = requestAnimationFrame(flushAgentEvents)
  }, [flushAgentEvents])

  const attachRuntime = useCallback((nextRuntime: RuntimeInfo | undefined, generation: number) => {
    if (workspaceRef.current.generation !== generation) return
    const next = nextRuntime ?? null
    if (next?.sessionFile) runtimeSessionsRef.current.set(next.runtimeId, next.sessionFile)
    runtimeIdRef.current = next?.runtimeId ?? null
    runtimeOwnerRef.current = next ? { runtimeId: next.runtimeId, generation } : null
    setRuntime(next)
  }, [])

  const activateWorkspace = useCallback((project?: ProjectRecord, session?: SessionRecord, nextRuntime?: RuntimeInfo) => {
    pendingAgentEventsRef.current = []
    if (agentEventFrameRef.current !== null) { cancelAnimationFrame(agentEventFrameRef.current); agentEventFrameRef.current = null }
    const generation = workspaceRef.current.generation + 1
    workspaceRef.current = {
      generation,
      project,
      session,
      cwd: workspaceCwd(project, session),
      sessionFile: session?.filePath,
    }
    transcriptLoadRef.current = bridge && session?.filePath
      ? { generation, sessionFile: session.filePath, eventBuffer: createPrimeEventBuffer() }
      : null
    setWorkspaceGeneration(generation)
    setActiveProjectId(project?.id)
    setActiveSessionId(session?.id)
    attachRuntime(nextRuntime, generation)
    if (bridge) {
      setMessages([])
      setLoadingSession(Boolean(session?.filePath))
    }
    return generation
  }, [attachRuntime, bridge])

  const reconcileRuntime = useCallback(async (generation: number) => {
    if (!bridge) return
    const selected = workspaceRef.current
    if (selected.generation !== generation || !selected.sessionFile) return
    try {
      const runtimes = await bridge.agent.list()
      if (workspaceRef.current.generation !== generation) return
      const matchingRuntime = findRuntimeForWorkspace(runtimes, selected.cwd, selected.sessionFile)
      attachRuntime(matchingRuntime, generation)
      const pendingRequest = matchingRuntime ? pendingExtensionUiRequestsRef.current.get(matchingRuntime.runtimeId) : undefined
      if (matchingRuntime && pendingRequest) {
        const pending = { runtimeId: matchingRuntime.runtimeId, request: pendingRequest }
        extensionUiRef.current = pending
        setExtensionUi(pending)
      }
    } catch (error) {
      if (workspaceRef.current.generation === generation) reportError(error)
    }
  }, [attachRuntime, bridge, reportError])

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    const projectPath = activeProject?.primaryFolder && !activeProject.inferred ? activeProject.primaryFolder : undefined
    bridge.plugins.list(projectPath).then((records) => { if (!cancelled) setSkills(records) }).catch(reportError)
    return () => { cancelled = true }
  }, [bridge, activeProject?.primaryFolder, activeProject?.inferred, reportError])

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    const startupGeneration = workspaceRef.current.generation
    const startupSettingsRevision = settingsMutationRef.current
    Promise.allSettled([
      bridge.app.getMeta(), bridge.projects.list(), bridge.sessions.list(undefined, true), bridge.settings.get(), bridge.plugins.list(), bridge.schedules.list(), bridge.agent.list(),
    ]).then(([metaResult, projectsResult, sessionsResult, settingsResult, skillsResult, schedulesResult, runtimesResult]) => {
      if (cancelled) return
      if (metaResult.status === 'fulfilled') setMeta(metaResult.value)
      const nextProjects = projectsResult.status === 'fulfilled' ? projectsResult.value : []
      const nextSessions = sessionsResult.status === 'fulfilled' ? sessionsResult.value : []
      const nextRuntimes = runtimesResult.status === 'fulfilled' ? runtimesResult.value : []
      runtimeSessionsRef.current = new Map(nextRuntimes.flatMap((candidate) => candidate.sessionFile ? [[candidate.runtimeId, candidate.sessionFile] as const] : []))
      if (projectsResult.status === 'fulfilled') setProjects(nextProjects)
      if (sessionsResult.status === 'fulfilled') setSessions(nextSessions.map((session) => session.status === 'waiting' ? { ...session, unread: true } : session))
      if (projectsResult.status === 'fulfilled' && workspaceRef.current.generation === startupGeneration) {
        const selected = selectStartupWorkspace(nextProjects, nextSessions, nextRuntimes)
        activateWorkspace(selected.project, selected.session, selected.runtime)
      }
      if (settingsResult.status === 'fulfilled' && settingsMutationRef.current === startupSettingsRevision) { settingsRef.current = settingsResult.value; confirmedSettingsRef.current = settingsResult.value; setSettings(settingsResult.value); setSidebarOpen(settingsResult.value.sidebarOpen); setInspectorOpen(settingsResult.value.inspectorOpen); setTerminalOpen(settingsResult.value.terminalOpen); if (!inspectorTabTouchedRef.current) setInspectorTab(settingsResult.value.defaultInspectorTab) }
      if (skillsResult.status === 'fulfilled') setSkills(skillsResult.value)
      if (schedulesResult.status === 'fulfilled') { setSchedules(schedulesResult.value); setScheduleError('') }
      else setScheduleError(schedulesResult.reason instanceof Error ? schedulesResult.reason.message : String(schedulesResult.reason))
      const failure = [metaResult, projectsResult, sessionsResult, settingsResult, skillsResult, schedulesResult, runtimesResult].find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') reportError(failure.reason)
      setInitialized(true)
    })
    return () => { cancelled = true }
  }, [activateWorkspace, bridge, reportError])

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
      const type = typeof event.type === 'string' ? event.type : ''
      const pendingRequest = parseExtensionUiRequest(event)
      if (pendingRequest) pendingExtensionUiRequestsRef.current.set(runtimeId, pendingRequest)
      const sessionFile = runtimeSessionsRef.current.get(runtimeId)
        ?? (runtimeIdRef.current === runtimeId ? workspaceRef.current.sessionFile : undefined)
      if (sessionFile) {
        runtimeSessionsRef.current.set(runtimeId, sessionFile)
        const status = type === 'extension_ui_request' ? 'waiting'
          : type === 'agent_start' || type === 'turn_start' ? 'running'
          : type === 'agent_end' ? 'complete'
          : type === 'extension_error' || type === 'error' || type === 'transport_error' ? 'failed'
          : type === 'runtime_exit' ? event.expected === true ? 'complete' : 'failed'
          : undefined
        if (status) {
          const updatedAt = new Date().toISOString()
          setSessions((items) => items.map((session) => session.filePath === sessionFile ? { ...session, status, updatedAt, unread: status === 'waiting' || status === 'complete' ? true : status === 'running' ? false : session.unread } : session))
        }
      }
      if (type === 'runtime_exit') { runtimeSessionsRef.current.delete(runtimeId); pendingExtensionUiRequestsRef.current.delete(runtimeId) }
      if (runtimeIdRef.current !== runtimeId) return
      showExtensionUi(runtimeId, event)
      queueAgentEvent(event)
      if (type === 'agent_start') setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: true } : current)
      if (type === 'runtime_exit') {
        clearExtensionUi(runtimeId)
        runtimeIdRef.current = null
        runtimeOwnerRef.current = null
        setRuntime((current) => current?.runtimeId === runtimeId ? null : current)
      } else if (type === 'agent_end' || type === 'extension_error' || type === 'error' || type === 'transport_error') {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: false } : current)
        if (activeProject?.primaryFolder) window.setTimeout(() => void refreshGit(), 160)
      }
    })
    return off
  }, [activeProject?.primaryFolder, bridge, clearExtensionUi, queueAgentEvent, showExtensionUi])

  useEffect(() => () => {
    demoTimerRef.current.forEach(window.clearTimeout)
    if (agentEventFrameRef.current !== null) cancelAnimationFrame(agentEventFrameRef.current)
  }, [])

  useEffect(() => {
    if (!bridge || !activeSession?.filePath) {
      if (bridge && !activeSession) setMessages([])
      setLoadingSession(false)
      return
    }
    const selected = workspaceRef.current
    if (selected.generation !== workspaceGeneration || selected.sessionFile !== activeSession.filePath) return
    const currentLoad = transcriptLoadRef.current
    const pendingLoad: TranscriptLoad = currentLoad?.generation === workspaceGeneration && currentLoad.sessionFile === activeSession.filePath
      ? currentLoad
      : { generation: workspaceGeneration, sessionFile: activeSession.filePath, eventBuffer: createPrimeEventBuffer() }
    transcriptLoadRef.current = pendingLoad
    setLoadingSession(true)
    bridge.sessions.read(activeSession.filePath).then((value) => {
      if (transcriptLoadRef.current !== pendingLoad || workspaceRef.current.generation !== pendingLoad.generation) return
      transcriptLoadRef.current = null
      setMessages(pendingLoad.eventBuffer.replay(value))
    }).catch((error) => {
      if (transcriptLoadRef.current === pendingLoad && workspaceRef.current.generation === pendingLoad.generation) {
        transcriptLoadRef.current = null
        setMessages((current) => pendingLoad.eventBuffer.replay(current))
        reportError(error)
      }
    }).finally(() => {
      if (workspaceRef.current.generation === pendingLoad.generation) setLoadingSession(false)
    })
    return () => { if (transcriptLoadRef.current === pendingLoad) transcriptLoadRef.current = null }
  }, [bridge, activeSession?.filePath, workspaceGeneration, reportError])

  const refreshGit = useCallback(async () => {
    const requestId = ++gitRequestRef.current
    const cwd = activeProject?.primaryFolder
    if (!bridge || !cwd) {
      setGit({ isRepo: false, files: [] })
      return
    }
    try {
      const next = await bridge.git.status(cwd)
      if (gitRequestRef.current === requestId) setGit(next)
    } catch (error) { if (gitRequestRef.current === requestId) reportError(error) }
  }, [bridge, activeProject?.primaryFolder, reportError])

  useEffect(() => {
    void refreshGit()
    return () => { gitRequestRef.current += 1 }
  }, [refreshGit])

  const applySettings = useCallback((next: AppSettings, panelPatch: Partial<AppSettings>) => {
    settingsRef.current = next
    setSettings(next)
    if ('sidebarOpen' in panelPatch) setSidebarOpen(next.sidebarOpen)
    if ('inspectorOpen' in panelPatch) setInspectorOpen(next.inspectorOpen)
    if ('terminalOpen' in panelPatch) setTerminalOpen(next.terminalOpen)
  }, [])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const mutation = ++settingsMutationRef.current
    const previous = settingsRef.current
    applySettings({ ...previous, ...patch }, patch)
    if (!bridge) { confirmedSettingsRef.current = settingsRef.current; return }
    const operation = settingsQueueRef.current.catch(() => undefined).then(async () => {
      const saved = await bridge.settings.update(patch)
      confirmedSettingsRef.current = saved
      if (settingsMutationRef.current === mutation) applySettings(saved, patch)
    })
    settingsQueueRef.current = operation.catch(() => undefined)
    try { await operation } catch (error) {
      if (settingsMutationRef.current === mutation) applySettings(confirmedSettingsRef.current, patch)
      reportError(error)
    }
  }, [applySettings, bridge, reportError])

  const grantProject = async (project: ProjectRecord): Promise<ProjectRecord> => {
    if (!bridge || !project.inferred) return project
    const granted = await bridge.projects.grantInferred(project.primaryFolder)
    setProjects((items) => items.map((item) => item.id === project.id ? granted : item))
    const selected = workspaceRef.current
    if (selected.project?.id !== project.id) return granted
    workspaceRef.current = { ...selected, project: granted, cwd: workspaceCwd(granted, selected.session) }
    setActiveProjectId(granted.id)
    const requestId = ++gitRequestRef.current
    const nextGit = await bridge.git.status(granted.primaryFolder)
    if (gitRequestRef.current === requestId && workspaceRef.current.generation === selected.generation) setGit(nextGit)
    return granted
  }

  const persistPanel = (patch: Partial<AppSettings>) => { void updateSettings(patch) }
  const toggleSidebar = () => {
    const next = !sidebarOpen
    compactRestoreRef.current = null
    if (compactLayout && next && inspectorOpen) setInspectorOpen(false)
    persistPanel({ sidebarOpen: next })
  }
  const toggleInspector = () => {
    const next = !inspectorOpen
    compactRestoreRef.current = null
    if (compactLayout && next && sidebarOpen) setSidebarOpen(false)
    persistPanel({ inspectorOpen: next })
  }
  const toggleTerminal = async () => {
    if (!terminalOpen && activeProject?.inferred) { try { await grantProject(activeProject) } catch (error) { reportError(error); return } }
    persistPanel({ terminalOpen: !terminalOpen })
  }

  const selectProject = async (project: ProjectRecord) => {
    if (compactLayout) setSidebarOpen(false)
    const session = sessions.find((candidate) => !candidate.archived && projectContainsPath(project, candidate.projectPath))
    const generation = activateWorkspace(project, session)
    setView('session')
    try {
      const granted = await grantProject(project)
      if (bridge && !granted.inferred) await bridge.projects.touch(granted.id)
      await reconcileRuntime(generation)
    } catch (error) { if (workspaceRef.current.generation === generation) reportError(error) }
  }
  const selectSession = async (session: SessionRecord) => {
    if (compactLayout) setSidebarOpen(false)
    setSessions((items) => items.map((item) => item.id === session.id ? { ...item, unread: false } : item))
    const project = findProjectForSession(projects, session)
    if (!project) { reportError('This session is not contained by an available project.'); return }
    const generation = activateWorkspace(project, session)
    setView('session')
    try {
      await grantProject(project)
      await reconcileRuntime(generation)
    } catch (error) { if (workspaceRef.current.generation === generation) reportError(error) }
  }
  const newSession = () => {
    if (compactLayout) setSidebarOpen(false)
    activateWorkspace(workspaceRef.current.project)
    if (!bridge) setMessages([])
    setView('session'); setPaletteOpen(false)
  }
  const navigate = (nextView: WorkspaceView) => { if (compactLayout) setSidebarOpen(false); setView(nextView); setPaletteOpen(false) }

  const renameSession = async (session: SessionRecord, title: string) => {
    if (!bridge) return
    try {
      const renamed = await bridge.sessions.rename(session.filePath, title)
      if (!renamed) throw new Error('Prime Agent could not rename this session.')
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, title } : item))
      setToast('Session renamed.')
    } catch (error) { reportError(error) }
  }
  const setSessionArchived = async (session: SessionRecord, archived: boolean) => {
    if (!bridge) return
    try {
      await bridge.sessions.archive(session.filePath, archived)
      setSessions((items) => items.map((item) => item.id === session.id ? { ...item, archived } : item))
      if (archived && workspaceRef.current.session?.id === session.id) newSession()
      setToast(archived ? 'Session archived. Restore it from Activity.' : 'Session restored.')
    } catch (error) { reportError(error) }
  }

  const addProject = async () => {
    if (!bridge) { setToast('Project picker is available in the desktop app.'); return }
    try {
      const project = await bridge.projects.add()
      if (project) {
        setProjects((items) => [project, ...items.filter((item) => item.id !== project.id)])
        activateWorkspace(project)
        setView('session')
      }
    } catch (error) { reportError(error) }
  }
  const removeProject = async (project: ProjectRecord) => {
    try {
      if (bridge && !await bridge.projects.remove(project.id)) throw new Error('This project could not be removed.')
      setProjects((items) => items.filter((item) => item.id !== project.id))
      if (workspaceRef.current.project?.id === project.id) {
        const fallback = projects.find((item) => item.id !== project.id)
        const session = fallback ? sessions.find((candidate) => !candidate.archived && projectContainsPath(fallback, candidate.projectPath)) : undefined
        activateWorkspace(fallback, session)
      }
      setToast('Project removed. Files and saved sessions were kept.')
    } catch (error) { reportError(error) }
  }

  const sendPrompt = async (prompt: string) => {
    await submissionAdmissionRef.current.run(async () => {
      setSubmitting(true)
      const admittedWorkspace = workspaceRef.current
      const generation = admittedWorkspace.generation
      try {
        if (!admittedWorkspace.project || !admittedWorkspace.cwd) {
          reportError('Add a project before starting a Prime session.')
          return
        }
        const userMessage: TranscriptMessage = { id: `user-${Date.now()}`, role: 'user', timestamp: Date.now(), parts: [{ type: 'text', text: prompt }] }
        setMessages((items) => [...items, userMessage])
        if (!bridge) {
          const assistantId = `assistant-${Date.now()}`
          setMessages((items) => { const startedAt = Date.now(); return [...items, { id: assistantId, role: 'assistant', timestamp: startedAt, startedAt, streaming: true, parts: [{ type: 'thinking', text: 'Reviewing the request and current workspace context.' }] }] })
          demoTimerRef.current.push(window.setTimeout(() => setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, parts: [...item.parts, { type: 'toolCall', id: 'demo-tool', name: 'Inspect project', args: { cwd: admittedWorkspace.cwd } }] } : item)), 450))
          demoTimerRef.current.push(window.setTimeout(() => setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, streaming: false, completedAt: Date.now(), parts: [...item.parts, { type: 'toolResult', name: 'Inspect project', text: 'Project context loaded' }, { type: 'text', text: 'I’ve reviewed the project context and prepared the workspace. Connect the desktop bridge to run this request with Prime Agent.' }] } : item)), 1250))
          return
        }

        await grantProject(admittedWorkspace.project)
        if (workspaceRef.current.generation !== generation) return
        const selected = workspaceRef.current
        if (!selected.cwd) throw new Error('The selected workspace has no working directory.')
        const liveRuntimes = await bridge.agent.list()
        if (workspaceRef.current.generation !== generation) return

        const owner = runtimeOwnerRef.current
        const tracked = runtimeIdRef.current ? liveRuntimes.find((candidate) => candidate.runtimeId === runtimeIdRef.current) : undefined
        const trackedBelongsHere = Boolean(tracked
          && owner?.runtimeId === tracked.runtimeId
          && owner.generation === generation
          && tracked.cwd === selected.cwd
          && (!selected.sessionFile || tracked.sessionFile === selected.sessionFile))
        let activeRuntime = trackedBelongsHere ? tracked : findRuntimeForWorkspace(liveRuntimes, selected.cwd, selected.sessionFile)
        let startedRuntime = false
        if (!activeRuntime) {
          attachRuntime(undefined, generation)
          activeRuntime = await bridge.agent.start({
            cwd: selected.cwd,
            sessionPath: selected.sessionFile,
            model: model === 'auto' ? undefined : model,
            thinking: effort,
          })
          startedRuntime = true
          if (workspaceRef.current.generation !== generation) {
            await bridge.agent.stop(activeRuntime.runtimeId).catch(() => false)
            return
          }
        }
        if (activeRuntime.cwd !== selected.cwd || (selected.sessionFile && activeRuntime.sessionFile !== selected.sessionFile)) {
          if (startedRuntime) await bridge.agent.stop(activeRuntime.runtimeId).catch(() => false)
          throw new Error('Prime returned a runtime for a different workspace or session.')
        }

        attachRuntime(activeRuntime, generation)
        setRuntime({ ...activeRuntime, isStreaming: true })
        setMessages((items) => [...items, { id: `assistant-${Date.now()}`, role: 'assistant', timestamp: Date.now(), streaming: true, parts: [] }])
        await bridge.agent.command(activeRuntime.runtimeId, { type: activeRuntime.isStreaming ? 'follow_up' : 'prompt', message: prompt })
      } catch (error) {
        if (workspaceRef.current.generation !== generation) return
        const failure = requestFailureMessage(error)
        setRuntime((current) => current ? { ...current, isStreaming: false } : current)
        setMessages((items) => {
          const finalized = items.flatMap((item) => item.streaming && item.role === 'assistant' && item.parts.length === 0
            ? []
            : [{ ...item, streaming: false }])
          if (finalized.at(-1)?.role === 'system') return finalized
          return [...finalized, { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: failure }] }]
        })
      } finally {
        setSubmitting(false)
      }
    })
  }

  const stopRuntime = async () => {
    if (!runtime) return
    if (!bridge) { setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item)); setRuntime(null); return }
    try { await bridge.agent.command(runtime.runtimeId, { type: 'abort' }); setRuntime((current) => current ? { ...current, isStreaming: false } : current); setMessages((items) => items.map((item) => item.streaming ? { ...item, streaming: false } : item)) } catch (error) { reportError(error) }
  }

  const refreshSkills = async () => {
    if (!bridge) return
    setLoadingSkills(true)
    try {
      setSkills(await bridge.plugins.list(activeProject?.primaryFolder && !activeProject.inferred ? activeProject.primaryFolder : undefined))
    } catch (error) { reportError(error) } finally { setLoadingSkills(false) }
  }
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
        const project = await grantProject(activeProject)
        connection = { ...input, projectPath: project.primaryFolder }
      }
      const response = await bridge.plugins.connectMcp(connection)
      if (response.ok) {
        const projectPath = connection.scope === 'project'
          ? connection.projectPath
          : activeProject?.primaryFolder && !activeProject.inferred ? activeProject.primaryFolder : undefined
        setSkills(await bridge.plugins.list(projectPath))
      }
      return response
    } catch (error) { reportError(error); return { ok: false, output: error instanceof Error ? error.message : String(error) } }
  }
  const addSchedule = async (schedule: string, prompt: string) => {
    if (!bridge || !runtime) throw new Error('Open a Prime session before creating a schedule.')
    try { await bridge.schedules.add(runtime.runtimeId, schedule, prompt) } catch (error) { reportError(error); throw error }
    try { setSchedules(await bridge.schedules.list()); setScheduleError('') } catch (error) { setScheduleError(error instanceof Error ? error.message : String(error)); reportError(error) }
  }
  const cancelSchedule = async (schedule: ScheduleRecord) => {
    const runtimeId = schedule.runtimeId ?? runtime?.runtimeId
    if (!bridge || !runtimeId) throw new Error('The runtime that owns this schedule is not available.')
    try { await bridge.schedules.cancel(runtimeId, schedule.id) } catch (error) { reportError(error); throw error }
    try { setSchedules(await bridge.schedules.list()); setScheduleError('') } catch (error) { setScheduleError(error instanceof Error ? error.message : String(error)); reportError(error) }
  }

  const selectInspectorTab = (tab: InspectorTab) => { inspectorTabTouchedRef.current = true; setInspectorTab(tab) }
  const openBrowser = () => { inspectorTabTouchedRef.current = true; if (compactLayout && sidebarOpen) setSidebarOpen(false); setView('session'); selectInspectorTab('browser'); if (!inspectorOpen) persistPanel({ inspectorOpen: true }) }
  const openChanges = () => { if (compactLayout && sidebarOpen) setSidebarOpen(false); selectInspectorTab('changes'); if (!inspectorOpen) persistPanel({ inspectorOpen: true }) }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('.modal[role="dialog"][aria-modal="true"]')) {
        if (event.metaKey || event.ctrlKey) event.preventDefault()
        return
      }
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
    : view === 'activity' ? <ActivityPage sessions={sessions} projects={projects} onOpen={selectSession} onRestore={(session) => void setSessionArchived(session, false)} />
    : view === 'scheduled' ? <ScheduledPage schedules={schedules} error={scheduleError} canCreate={Boolean(runtime)} onAdd={addSchedule} onCancel={cancelSchedule} />
    : view === 'plugins' ? <PluginsPage skills={skills} loading={loadingSkills} activeProjectPath={activeProject?.primaryFolder} onRefresh={refreshSkills} onInstall={installSkill} onConnectMcp={connectMcp} />
    : view === 'settings' ? <SettingsPage settings={settings} meta={meta} onUpdate={updateSettings} onResetBrowser={async () => {
        if (!bridge) throw new Error('Browser data can only be cleared in the desktop app.')
        const cleared = await bridge.settings.resetBrowserData()
        if (!cleared) { const error = new Error('Prime Work could not clear all browser data. Close active downloads and try again.'); reportError(error); throw error }
        setBrowserGeneration((value) => value + 1)
      }} onOpenDocs={() => { if (bridge) void bridge.app.openExternal('https://github.com/PrimeIntellect-ai/prime-agent') }} />
    : null

  return (
    <div className="app-shell" aria-busy={!initialized} data-ready={initialized ? 'true' : 'false'}>
      {sidebarOpen ? <Sidebar projects={projects} sessions={sessions} activeProjectId={activeProject?.id} activeSessionId={activeSessionId} activeView={view} onSelectProject={selectProject} onSelectSession={selectSession} onNavigate={navigate} onNewSession={newSession} onAddProject={() => void addProject()} onClose={toggleSidebar} onOpenPalette={() => setPaletteOpen(true)} onRenameSession={renameSession} onArchiveSession={(session) => setSessionArchived(session, true)} overlay={compactLayout} /> : null}
      {sidebarOpen ? <button type="button" className="panel-scrim panel-scrim--sidebar" aria-label="Close sidebar" onClick={toggleSidebar} /> : null}
      <div className="workbench" inert={compactLayout && sidebarOpen ? true : undefined}>
        <TitleToolbar project={view === 'session' ? activeProject : undefined} view={view} sidebarOpen={sidebarOpen} inspectorOpen={inspectorOpen} terminalOpen={terminalOpen} onToggleSidebar={toggleSidebar} onToggleInspector={toggleInspector} onToggleTerminal={toggleTerminal} onOpenBrowser={openBrowser} />
        <div className="workbench__content">
          {view === 'session' ? (
            <div
              ref={sessionWorkspaceRef}
              className="session-workspace"
              style={{ '--inspector-width': `${inspectorWidth}px`, '--terminal-height': `${terminalHeight}px` } as CSSProperties}
            >
              <div ref={workspaceRowRef} className="workspace-row">
                <main className="conversation-pane">
                  <Transcript key={activeSessionId ?? 'new-session'} messages={messages} git={git} loading={loadingSession} showReasoning={settings.showReasoningSummaries} showTools={settings.showToolCalls} onOpenChanges={openChanges} onSuggestion={(prompt) => void sendPrompt(prompt)} suggestionsDisabled={!activeProject || loadingSession || submitting} />
                  <Composer key={activeSessionId ? `${activeProject?.id ?? 'no-project'}:${activeSessionId}` : `${activeProject?.id ?? 'no-project'}:new:${workspaceGeneration}`} busy={busy} submitting={submitting} loading={loadingSession} disabled={!activeProject} model={model} effort={effort} skills={skills} onModelChange={setModel} onEffortChange={setEffort} onSend={sendPrompt} onStop={stopRuntime} />
                </main>
                {inspectorOpen ? <ResizeHandle orientation="vertical" label="Resize inspector" value={inspectorWidth} min={INSPECTOR_MIN} max={inspectorMax} defaultValue={INSPECTOR_DEFAULT} onChange={setInspectorWidth} /> : null}
                {inspectorOpen ? <Inspector key={`inspector-${browserGeneration}`} activeTab={inspectorTab} onTabChange={selectInspectorTab} onClose={toggleInspector} project={activeProject} runtime={runtime} messages={messages} git={git} browserHome={settings.browserHome} onRefreshGit={refreshGit} onOpenExternal={(url) => { if (bridge) void bridge.app.openExternal(url) }} onRevealPath={(path) => { if (bridge) void bridge.app.revealPath(path) }} overlay={compactLayout} /> : null}
                {inspectorOpen ? <button type="button" className="panel-scrim panel-scrim--inspector" aria-label="Close inspector" onClick={toggleInspector} /> : null}
              </div>
              {terminalOpen ? <TerminalDrawer cwd={activeProject?.primaryFolder} shell={settings.terminalShell} height={terminalHeight} minHeight={TERMINAL_MIN} maxHeight={terminalMax} defaultHeight={TERMINAL_DEFAULT} onHeightChange={setTerminalHeight} onClose={toggleTerminal} onError={reportError} /> : null}
            </div>
          ) : page}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={navigate} onNewSession={newSession} onToggleSidebar={toggleSidebar} onToggleTerminal={toggleTerminal} onOpenBrowser={openBrowser} />
      {extensionUi ? <ExtensionUiModal request={extensionUi.request} onRespond={(response) => void respondToExtensionUi(response)} /> : null}
      {toast ? <div className="toast" role="status">{toast}<button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>×</button></div> : null}
    </div>
  )
}
