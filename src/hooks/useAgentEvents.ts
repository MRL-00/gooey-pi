import { useEffect } from 'react'
import type { WorkspaceSnapshot } from '@/app/workspace'
import type { PrimeWorkApi, RuntimeInfo, SessionRecord } from '@/types/api'

interface UseAgentEventsOptions {
  bridge: PrimeWorkApi | null
  runtimeIdRef: React.RefObject<string | null>
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  runtimeOwnerRef: React.RefObject<{ runtimeId: string; generation: number } | null>
  workspaceRef: React.RefObject<WorkspaceSnapshot>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  setRuntime: React.Dispatch<React.SetStateAction<RuntimeInfo | null>>
  queueAgentEvent(event: Record<string, unknown>): void
  reconcileTranscriptForEvent(runtimeId: string, event: Record<string, unknown>): void
  showExtensionUi(runtimeId: string, event: Record<string, unknown>): void
  clearExtensionUi(runtimeId?: string): void
  refreshGit(): Promise<void>
  refreshGitOnTerminalEvent: boolean
}

export function useAgentEvents({
  bridge,
  runtimeIdRef,
  runtimeSessionsRef,
  runtimeOwnerRef,
  workspaceRef,
  setSessions,
  setRuntime,
  queueAgentEvent,
  reconcileTranscriptForEvent,
  showExtensionUi,
  clearExtensionUi,
  refreshGit,
  refreshGitOnTerminalEvent,
}: UseAgentEventsOptions) {
  useEffect(() => {
    if (!bridge) return
    return bridge.agent.onEvent(({ runtimeId, event }) => {
      const type = typeof event.type === 'string' ? event.type : ''
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
          setSessions((items) => items.map((session) => session.filePath === sessionFile
            ? {
                ...session,
                status,
                unread: status === 'waiting' || status === 'complete'
                  ? true
                  : status === 'running' ? false : session.unread,
              }
            : session))
        }
      }
      showExtensionUi(runtimeId, event)
      if (type === 'runtime_exit') clearExtensionUi(runtimeId)
      if (runtimeIdRef.current !== runtimeId) {
        if (type === 'runtime_exit') runtimeSessionsRef.current.delete(runtimeId)
        return
      }

      queueAgentEvent(event)
      reconcileTranscriptForEvent(runtimeId, event)
      if (type === 'agent_start') {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: true } : current)
      }
      if (type === 'runtime_exit') {
        clearExtensionUi(runtimeId)
        runtimeSessionsRef.current.delete(runtimeId)
        runtimeIdRef.current = null
        runtimeOwnerRef.current = null
        setRuntime((current) => current?.runtimeId === runtimeId ? null : current)
      } else if (type === 'agent_end' || type === 'extension_error' || type === 'error' || type === 'transport_error') {
        setRuntime((current) => current?.runtimeId === runtimeId ? { ...current, isStreaming: false } : current)
        if (refreshGitOnTerminalEvent) window.setTimeout(() => void refreshGit(), 160)
      }
    })
  }, [
    bridge,
    clearExtensionUi,
    workspaceRef,
    queueAgentEvent,
    reconcileTranscriptForEvent,
    refreshGit,
    refreshGitOnTerminalEvent,
    runtimeIdRef,
    runtimeOwnerRef,
    runtimeSessionsRef,
    setRuntime,
    setSessions,
    showExtensionUi,
  ])
}
