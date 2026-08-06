import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtensionUiResponse } from '@/components/ExtensionUiModal'
import { parseExtensionUiRequest, type ExtensionUiRequest } from '@/lib/extension-ui'
import type { PrimeWorkApi, SessionRecord } from '@/types/api'

interface UseExtensionUiOptions {
  bridge: PrimeWorkApi | null
  activeRuntimeId?: string
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  reportError(error: unknown): void
}

export interface PendingExtensionUi {
  runtimeId: string
  request: ExtensionUiRequest
}

export function pendingExtensionUiForRuntime(
  pending: ReadonlyMap<string, PendingExtensionUi>,
  runtimeId?: string,
): PendingExtensionUi | null {
  return runtimeId ? pending.get(runtimeId) ?? null : null
}

export function useExtensionUi({
  bridge,
  activeRuntimeId,
  runtimeSessionsRef,
  setSessions,
  reportError,
}: UseExtensionUiOptions) {
  const [extensionUi, setExtensionUi] = useState<PendingExtensionUi | null>(null)
  const extensionUiRef = useRef<PendingExtensionUi | null>(null)
  const pendingByRuntimeRef = useRef<Map<string, PendingExtensionUi>>(new Map())
  const timerByRuntimeRef = useRef<Map<string, number>>(new Map())
  const activeRuntimeIdRef = useRef(activeRuntimeId)
  activeRuntimeIdRef.current = activeRuntimeId

  const showPendingForActiveRuntime = useCallback(() => {
    const visible = pendingExtensionUiForRuntime(pendingByRuntimeRef.current, activeRuntimeIdRef.current)
    extensionUiRef.current = visible
    setExtensionUi(visible)
  }, [])

  const clearExtensionUi = useCallback((runtimeId?: string) => {
    const targetRuntimeId = runtimeId ?? extensionUiRef.current?.runtimeId
    if (!targetRuntimeId) return
    const timer = timerByRuntimeRef.current.get(targetRuntimeId)
    if (timer !== undefined) window.clearTimeout(timer)
    timerByRuntimeRef.current.delete(targetRuntimeId)
    pendingByRuntimeRef.current.delete(targetRuntimeId)
    if (extensionUiRef.current?.runtimeId === targetRuntimeId) {
      extensionUiRef.current = null
      setExtensionUi(null)
    }
  }, [])

  const respondToExtensionUi = useCallback(async (response: ExtensionUiResponse) => {
    const pending = extensionUiRef.current
    if (!pending) return
    clearExtensionUi(pending.runtimeId)
    const pendingSession = runtimeSessionsRef.current.get(pending.runtimeId)
    if (pendingSession) {
      setSessions((items) => items.map((session) => session.filePath === pendingSession
        ? { ...session, status: 'running', unread: false }
        : session))
    }
    if (!bridge) return
    try {
      await bridge.agent.command(pending.runtimeId, {
        type: 'extension_ui_response',
        id: pending.request.id,
        ...response,
      })
    } catch (error) {
      if (activeRuntimeIdRef.current === pending.runtimeId) reportError(error)
    }
  }, [bridge, clearExtensionUi, reportError, runtimeSessionsRef, setSessions])

  const showExtensionUi = useCallback((runtimeId: string, rawEvent: Record<string, unknown>) => {
    const request = parseExtensionUiRequest(rawEvent)
    if (!request || !bridge) return
    const previous = pendingByRuntimeRef.current.get(runtimeId)
    if (previous) {
      void bridge.agent.command(runtimeId, {
        type: 'extension_ui_response',
        id: previous.request.id,
        cancelled: true,
      }).catch(() => undefined)
      clearExtensionUi(runtimeId)
    }
    const pending = { runtimeId, request }
    pendingByRuntimeRef.current.set(runtimeId, pending)
    if (activeRuntimeIdRef.current === runtimeId) {
      extensionUiRef.current = pending
      setExtensionUi(pending)
    }
    if ('timeout' in request && request.timeout !== undefined) {
      timerByRuntimeRef.current.set(runtimeId, window.setTimeout(() => {
        if (pendingByRuntimeRef.current.get(runtimeId)?.request.id !== request.id) return
        void bridge.agent.command(runtimeId, {
          type: 'extension_ui_response',
          id: request.id,
          cancelled: true,
        }).catch(() => undefined)
        clearExtensionUi(runtimeId)
      }, request.timeout))
    }
  }, [bridge, clearExtensionUi])

  useEffect(() => { showPendingForActiveRuntime() }, [activeRuntimeId, showPendingForActiveRuntime])

  useEffect(() => () => {
    for (const timer of timerByRuntimeRef.current.values()) window.clearTimeout(timer)
    for (const pending of pendingByRuntimeRef.current.values()) {
      void bridge?.agent.command(pending.runtimeId, {
        type: 'extension_ui_response',
        id: pending.request.id,
        cancelled: true,
      }).catch(() => undefined)
    }
    timerByRuntimeRef.current.clear()
    pendingByRuntimeRef.current.clear()
  }, [bridge])

  return { extensionUi, clearExtensionUi, respondToExtensionUi, showExtensionUi }
}
