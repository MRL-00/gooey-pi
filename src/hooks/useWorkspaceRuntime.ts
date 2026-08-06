import { useCallback, useEffect, useRef, useState } from 'react'
import {
  admitAgentEvent,
  authoritativeTranscriptReadIsCurrent,
  eventsForWorkspace,
  isTranscriptTerminalEvent,
  needsTranscriptReconciliation,
  reconciliationMatches,
  type PendingAgentEvent,
  type TranscriptReconciliationMarker,
} from '@/app/agent-events'
import { runTranscriptRead } from '@/app/transcript-load'
import type { WorkspaceSnapshot } from '@/app/workspace'
import { applyPrimeEvent, createPrimeEventBuffer } from '@/lib/events'
import type { PrimeEventBuffer } from '@/lib/events'
import { findRuntimeForWorkspace, workspaceCwd } from '@/lib/workspace'
import type { PrimeWorkApi, ProjectRecord, RuntimeInfo, SessionRecord, TranscriptMessage } from '@/types/api'

interface TranscriptLoad {
  generation: number
  sessionFile: string
  eventBuffer: PrimeEventBuffer
  runtimeId?: string
  reconciliation: boolean
  admissionRevision: number
}

interface UseWorkspaceRuntimeOptions {
  bridge: PrimeWorkApi | null
  initialProject?: ProjectRecord
  initialSession?: SessionRecord
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  initialMessages: TranscriptMessage[]
  reportError(error: unknown): void
}

export function useWorkspaceRuntime({
  bridge,
  initialProject,
  initialSession,
  projects,
  sessions,
  initialMessages,
  reportError,
}: UseWorkspaceRuntimeOptions) {
  const [messages, setMessages] = useState(initialMessages)
  const [activeProjectId, setActiveProjectId] = useState(initialProject?.id)
  const [activeSessionId, setActiveSessionId] = useState(initialSession?.id)
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null)
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0)
  const [loadingSession, setLoadingSession] = useState(false)
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
  const promptAdmissionRevisionRef = useRef(0)
  const reconciliationNeededRef = useRef<TranscriptReconciliationMarker | null>(null)
  const deferredReconciliationRef = useRef<TranscriptReconciliationMarker | null>(null)
  const pendingAgentEventsRef = useRef<PendingAgentEvent[]>([])
  const agentEventFrameRef = useRef<number | null>(null)

  const flushAgentEvents = useCallback(() => {
    agentEventFrameRef.current = null
    const generation = workspaceRef.current.generation
    const pending = pendingAgentEventsRef.current
    pendingAgentEventsRef.current = []
    const admitted = eventsForWorkspace(pending, generation)
    if (admitted.length) {
      setMessages((current) => admitted.reduce(
        (currentMessages, event) => applyPrimeEvent(currentMessages, event),
        current,
      ))
    }
  }, [])

  const queueAgentEvent = useCallback((event: Record<string, unknown>) => {
    const generation = workspaceRef.current.generation
    const owner = admitAgentEvent(generation, event, transcriptLoadRef.current, pendingAgentEventsRef.current)
    if (owner === 'frame' && agentEventFrameRef.current === null) {
      agentEventFrameRef.current = requestAnimationFrame(flushAgentEvents)
    }
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
    promptAdmissionRevisionRef.current = 0
    reconciliationNeededRef.current = null
    deferredReconciliationRef.current = null
    if (agentEventFrameRef.current !== null) {
      cancelAnimationFrame(agentEventFrameRef.current)
      agentEventFrameRef.current = null
    }
    const generation = workspaceRef.current.generation + 1
    workspaceRef.current = {
      generation,
      project,
      session,
      cwd: workspaceCwd(project, session),
      sessionFile: session?.filePath,
    }
    transcriptLoadRef.current = bridge && session?.filePath
      ? { generation, sessionFile: session.filePath, eventBuffer: createPrimeEventBuffer(), reconciliation: false, admissionRevision: 0 }
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
      attachRuntime(findRuntimeForWorkspace(runtimes, selected.cwd, selected.sessionFile), generation)
    } catch (error) {
      if (workspaceRef.current.generation === generation) reportError(error)
    }
  }, [attachRuntime, bridge, reportError])

  const startTranscriptRead = useCallback((
    selected: WorkspaceSnapshot,
    reconciliation: boolean,
    runtimeId?: string,
    admittedLoad?: TranscriptLoad,
  ) => {
    if (!bridge || !selected.sessionFile) return
    const pendingLoad = admittedLoad ?? {
      generation: selected.generation,
      sessionFile: selected.sessionFile,
      eventBuffer: createPrimeEventBuffer(),
      runtimeId,
      reconciliation,
      admissionRevision: promptAdmissionRevisionRef.current,
    }
    transcriptLoadRef.current = pendingLoad
    if (!reconciliation) setLoadingSession(true)

    void runTranscriptRead({
      read: () => bridge.sessions.read(selected.sessionFile!),
      isCurrent: () => transcriptLoadRef.current === pendingLoad
        && workspaceRef.current.generation === pendingLoad.generation
        && workspaceRef.current.sessionFile === pendingLoad.sessionFile,
      onValue: (value) => {
        const current = workspaceRef.current
        const readMarker = pendingLoad.runtimeId ? {
          generation: pendingLoad.generation,
          runtimeId: pendingLoad.runtimeId,
          sessionFile: pendingLoad.sessionFile,
          admissionRevision: pendingLoad.admissionRevision,
        } : null
        if (pendingLoad.reconciliation && readMarker
          && !authoritativeTranscriptReadIsCurrent(readMarker, {
            ...current,
            admissionRevision: promptAdmissionRevisionRef.current,
          }, runtimeIdRef.current)) {
          setMessages((messages) => pendingLoad.eventBuffer.replay(messages))
          return
        }
        setMessages(pendingLoad.eventBuffer.replay(value))
      },
      onError: (error) => {
        setMessages((messages) => pendingLoad.eventBuffer.replay(messages))
        reportError(error)
      },
      onFinally: () => {
        if (transcriptLoadRef.current === pendingLoad) transcriptLoadRef.current = null
        if (workspaceRef.current.generation === pendingLoad.generation && !pendingLoad.reconciliation) {
          setLoadingSession(false)
        }
        const deferred = deferredReconciliationRef.current
        if (!deferred || transcriptLoadRef.current) return
        deferredReconciliationRef.current = null
        const current = workspaceRef.current
        if (reconciliationMatches(deferred, current.generation, deferred.runtimeId, current.sessionFile)) {
          flushAgentEvents()
          startTranscriptRead(current, true, deferred.runtimeId)
        }
      },
    })
  }, [bridge, flushAgentEvents, reportError])

  const reconcileTranscriptForEvent = useCallback((runtimeId: string, event: Record<string, unknown>) => {
    const selected = workspaceRef.current
    if (!selected.sessionFile) return
    const marker: TranscriptReconciliationMarker = {
      generation: selected.generation,
      runtimeId,
      sessionFile: selected.sessionFile,
    }
    if (needsTranscriptReconciliation(event)) {
      reconciliationNeededRef.current = marker
      return
    }
    if (!isTranscriptTerminalEvent(event)) return

    const needed = reconciliationNeededRef.current
    if (needed && !reconciliationMatches(needed, selected.generation, runtimeId, selected.sessionFile)) return
    reconciliationNeededRef.current = null
    if (transcriptLoadRef.current) {
      deferredReconciliationRef.current = marker
      return
    }
    flushAgentEvents()
    startTranscriptRead(selected, true, runtimeId)
  }, [flushAgentEvents, startTranscriptRead])

  const admitPrompt = useCallback(() => {
    promptAdmissionRevisionRef.current += 1
  }, [])

  const activeSession = sessions.find((session) => session.id === activeSessionId)

  useEffect(() => {
    if (!bridge || !activeSession?.filePath) {
      if (bridge && !activeSession) setMessages([])
      setLoadingSession(false)
      return
    }
    const selected = workspaceRef.current
    if (selected.generation !== workspaceGeneration || selected.sessionFile !== activeSession.filePath) return
    const admittedLoad = transcriptLoadRef.current
    if (admittedLoad?.generation === workspaceGeneration && admittedLoad.sessionFile === activeSession.filePath) {
      if (!admittedLoad.reconciliation) startTranscriptRead(selected, false, undefined, admittedLoad)
    } else {
      startTranscriptRead(selected, false)
    }
    return () => {
      const load = transcriptLoadRef.current
      if (load?.generation === selected.generation && !load.reconciliation) transcriptLoadRef.current = null
    }
  }, [activeSession?.filePath, activeSession?.updatedAt, bridge, flushAgentEvents, reportError, startTranscriptRead, workspaceGeneration])

  useEffect(() => () => {
    if (agentEventFrameRef.current !== null) cancelAnimationFrame(agentEventFrameRef.current)
  }, [])

  return {
    messages,
    setMessages,
    activeProjectId,
    activeSessionId,
    runtime,
    setRuntime,
    workspaceGeneration,
    loadingSession,
    runtimeIdRef,
    runtimeSessionsRef,
    runtimeOwnerRef,
    workspaceRef,
    activateWorkspace,
    attachRuntime,
    reconcileRuntime,
    queueAgentEvent,
    reconcileTranscriptForEvent,
    admitPrompt,
  }
}
