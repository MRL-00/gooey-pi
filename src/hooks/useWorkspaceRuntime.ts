import { useCallback, useEffect, useRef, useState } from 'react'
import {
  admitAgentEvent,
  authoritativeTranscriptReadIsCurrent,
  eventsForWorkspace,
  isTranscriptTerminalEvent,
  needsTranscriptReconciliation,
  reconcileTranscriptMessages,
  reconciliationMatches,
  type PendingAgentEvent,
  type TranscriptReconciliationMarker,
} from '@/app/agent-events'
import { runTranscriptRead } from '@/app/transcript-load'
import { reconcileTranscripts } from '@/app/transcript-reconcile'
import type { WorkspaceSnapshot } from '@/app/workspace'
import { createPrimeEventBuffer, replayPrimeEvents } from '@/lib/events'
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
  const promptAdmissionGenerationRef = useRef<number | null>(null)
  const reconciliationNeededRef = useRef<TranscriptReconciliationMarker | null>(null)
  const deferredReconciliationRef = useRef<TranscriptReconciliationMarker | null>(null)
  const pendingAgentEventsRef = useRef<PendingAgentEvent[]>([])
  const lastTranscriptReadWorkspaceRef = useRef<{ generation: number; sessionFile: string } | null>(null)
  const agentEventFrameRef = useRef<number | null>(null)

  const flushAgentEvents = useCallback(() => {
    agentEventFrameRef.current = null
    const generation = workspaceRef.current.generation
    const pending = pendingAgentEventsRef.current
    pendingAgentEventsRef.current = []
    const admitted = eventsForWorkspace(pending, generation)
    if (admitted.length) {
      setMessages((current) => replayPrimeEvents(current, admitted))
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
    promptAdmissionGenerationRef.current = null
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
    const previousLoad = transcriptLoadRef.current
    const pendingLoad = admittedLoad ?? {
      generation: selected.generation,
      sessionFile: selected.sessionFile,
      eventBuffer: previousLoad?.generation === selected.generation
        && previousLoad.sessionFile === selected.sessionFile
        ? previousLoad.eventBuffer
        : createPrimeEventBuffer(),
      runtimeId,
      reconciliation,
      admissionRevision: promptAdmissionRevisionRef.current,
    }
    transcriptLoadRef.current = pendingLoad

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
        // Post-turn reconciliation reads restore disk authority, but unchanged
        // messages keep their identity so memoized rows do not re-render.
        if (pendingLoad.reconciliation) {
          setMessages((messages) => reconcileTranscripts(messages, pendingLoad.eventBuffer.replay(value)))
          return
        }
        // Background reads (initial and external-sync) merge into the live
        // list so an optimistic message sent while the read was in flight is
        // not replaced away by older on-disk state.
        setMessages((messages) => reconcileTranscriptMessages(messages, pendingLoad.eventBuffer.replay(value)))
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
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'agent_start' || type === 'turn_start' || type === 'compaction_start') {
      const load = transcriptLoadRef.current
      if (load?.generation === selected.generation) {
        transcriptLoadRef.current = null
        deferredReconciliationRef.current = null
        setMessages((current) => load.eventBuffer.replay(current))
      }
    }
    if (promptAdmissionGenerationRef.current === selected.generation) {
      if (type === 'agent_start' || type === 'turn_start') promptAdmissionGenerationRef.current = null
      else if (needsTranscriptReconciliation(event) || isTranscriptTerminalEvent(event)) return
    }
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

  const prepareForPrompt = useCallback((generation: number): boolean => {
    if (workspaceRef.current.generation !== generation) return false
    promptAdmissionRevisionRef.current += 1
    promptAdmissionGenerationRef.current = generation
    reconciliationNeededRef.current = null
    const load = transcriptLoadRef.current
    // Supersede every pending transcript load, not only reconciliations: a
    // background read resolving after the prompt would otherwise replace the
    // optimistic user message with older on-disk state. The reconciliation
    // read after the turn's terminal event restores disk authority.
    if (load?.generation === generation) {
      transcriptLoadRef.current = null
      deferredReconciliationRef.current = null
      setMessages((current) => load.eventBuffer.replay(current))
    }
    return true
  }, [])

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const locallyOwnedActiveSession = Boolean(
    activeSession?.filePath && runtime?.sessionFile === activeSession.filePath,
  )
  const externalSessionUpdatedAt = locallyOwnedActiveSession ? undefined : activeSession?.updatedAt
  const externalSessionSyncRevision = locallyOwnedActiveSession ? undefined : activeSession?.syncRevision

  useEffect(() => {
    if (!bridge || !activeSession?.filePath) {
      if (bridge && !activeSession) {
        transcriptLoadRef.current = null
        lastTranscriptReadWorkspaceRef.current = null
        setMessages([])
      }
      setLoadingSession(false)
      return
    }
    const selected = workspaceRef.current
    if (selected.generation !== workspaceGeneration || selected.sessionFile !== activeSession.filePath) return
    const previousReadWorkspace = lastTranscriptReadWorkspaceRef.current
    const workspaceChanged = previousReadWorkspace?.generation !== selected.generation
      || previousReadWorkspace.sessionFile !== activeSession.filePath
    lastTranscriptReadWorkspaceRef.current = { generation: selected.generation, sessionFile: activeSession.filePath }
    if (!workspaceChanged && locallyOwnedActiveSession) return
    const admittedLoad = transcriptLoadRef.current
    if (admittedLoad?.generation === workspaceGeneration && admittedLoad.sessionFile === activeSession.filePath) {
      if (!admittedLoad.reconciliation) startTranscriptRead(selected, false, undefined, admittedLoad)
    } else {
      startTranscriptRead(selected, false)
    }
  }, [activeSession?.filePath, bridge, externalSessionSyncRevision, externalSessionUpdatedAt, flushAgentEvents, locallyOwnedActiveSession, reportError, startTranscriptRead, workspaceGeneration])

  useEffect(() => () => {
    transcriptLoadRef.current = null
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
    prepareForPrompt,
    queueAgentEvent,
    reconcileTranscriptForEvent,
  }
}
