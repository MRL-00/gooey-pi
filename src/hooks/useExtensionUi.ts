import { useCallback, useEffect, useRef, useState } from 'react'
import { createRuntimeQueue } from '@/app/runtime-queue'
import type { ExtensionUiResponse } from '@/components/ExtensionUiModal'
import { parseExtensionUiRequest, type ExtensionUiRequest } from '@/lib/extension-ui'
import type { PrimeWorkApi, SessionRecord } from '@/types/api'

interface UseExtensionUiOptions {
  bridge: PrimeWorkApi | null
  activeRuntimeId: string | null
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  runtimeIdRef: React.RefObject<string | null>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  reportError(error: unknown): void
}

interface PendingExtensionUi {
  runtimeId: string
  request: ExtensionUiRequest
  timer: number | null
}

export function useExtensionUi({
  bridge,
  activeRuntimeId,
  runtimeSessionsRef,
  runtimeIdRef,
  setSessions,
  reportError,
}: UseExtensionUiOptions) {
  const [extensionUi, setExtensionUi] = useState<{ runtimeId: string; request: ExtensionUiRequest } | null>(null)
  const pendingByRuntimeRef = useRef(createRuntimeQueue<PendingExtensionUi>())

  const clearExtensionUi = useCallback((runtimeId?: string) => {
    const target = runtimeId ?? runtimeIdRef.current ?? undefined
    if (!target) return
    const pending = pendingByRuntimeRef.current.get(target)
    if (!pending) return
    if (pending.timer !== null) window.clearTimeout(pending.timer)
    pendingByRuntimeRef.current.delete(target)
    setExtensionUi((current) => current?.runtimeId === target ? null : current)
  }, [runtimeIdRef])

  const respondToExtensionUi = useCallback(async (response: ExtensionUiResponse) => {
    const runtimeId = runtimeIdRef.current
    const pending = runtimeId ? pendingByRuntimeRef.current.get(runtimeId) : undefined
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
      if (runtimeIdRef.current === pending.runtimeId) reportError(error)
    }
  }, [bridge, clearExtensionUi, reportError, runtimeIdRef, runtimeSessionsRef, setSessions])

  const showExtensionUi = useCallback((runtimeId: string, rawEvent: Record<string, unknown>) => {
    const request = parseExtensionUiRequest(rawEvent)
    if (!request || !bridge) return
    const pending: PendingExtensionUi = { runtimeId, request, timer: null }
    const previous = pendingByRuntimeRef.current.put(runtimeId, pending)
    if (previous) {
      if (previous.timer !== null) window.clearTimeout(previous.timer)
      void bridge.agent.command(runtimeId, {
        type: 'extension_ui_response', id: previous.request.id, cancelled: true,
      }).catch(() => undefined)
    }
    if (runtimeIdRef.current === runtimeId) setExtensionUi({ runtimeId, request })
    if ('timeout' in request && request.timeout !== undefined) {
      pending.timer = window.setTimeout(() => {
        if (pendingByRuntimeRef.current.get(runtimeId)?.request.id !== request.id) return
        void bridge.agent.command(runtimeId, {
          type: 'extension_ui_response',
          id: request.id,
          cancelled: true,
        }).catch(() => undefined)
        clearExtensionUi(runtimeId)
      }, request.timeout)
    }
  }, [bridge, clearExtensionUi, runtimeIdRef])

  useEffect(() => {
    const pending = activeRuntimeId ? pendingByRuntimeRef.current.get(activeRuntimeId) : undefined
    setExtensionUi(pending ? { runtimeId: pending.runtimeId, request: pending.request } : null)
  }, [activeRuntimeId])

  useEffect(() => () => {
    for (const pending of pendingByRuntimeRef.current.values()) {
      if (pending.timer !== null) window.clearTimeout(pending.timer)
    }
    pendingByRuntimeRef.current.clear()
  }, [])

  return { extensionUi, clearExtensionUi, respondToExtensionUi, showExtensionUi }
}
