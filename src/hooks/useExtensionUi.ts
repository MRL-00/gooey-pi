import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtensionUiResponse } from '@/components/ExtensionUiModal'
import { parseExtensionUiRequest, type ExtensionUiRequest } from '@/lib/extension-ui'
import type { PrimeWorkApi, SessionRecord } from '@/types/api'

interface UseExtensionUiOptions {
  bridge: PrimeWorkApi | null
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  runtimeIdRef: React.RefObject<string | null>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  reportError(error: unknown): void
}

export function useExtensionUi({
  bridge,
  runtimeSessionsRef,
  runtimeIdRef,
  setSessions,
  reportError,
}: UseExtensionUiOptions) {
  const [extensionUi, setExtensionUi] = useState<{ runtimeId: string; request: ExtensionUiRequest } | null>(null)
  const extensionUiRef = useRef<{ runtimeId: string; request: ExtensionUiRequest } | null>(null)
  const extensionUiTimerRef = useRef<number | null>(null)

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
    const previous = extensionUiRef.current
    if (previous) {
      void bridge.agent.command(previous.runtimeId, {
        type: 'extension_ui_response',
        id: previous.request.id,
        cancelled: true,
      }).catch(() => undefined)
      clearExtensionUi(previous.runtimeId)
    }
    const pending = { runtimeId, request }
    extensionUiRef.current = pending
    setExtensionUi(pending)
    if ('timeout' in request && request.timeout !== undefined) {
      extensionUiTimerRef.current = window.setTimeout(() => {
        if (extensionUiRef.current?.request.id !== request.id) return
        void bridge.agent.command(runtimeId, {
          type: 'extension_ui_response',
          id: request.id,
          cancelled: true,
        }).catch(() => undefined)
        clearExtensionUi(runtimeId)
      }, request.timeout)
    }
  }, [bridge, clearExtensionUi])

  useEffect(() => () => {
    if (extensionUiTimerRef.current !== null) window.clearTimeout(extensionUiTimerRef.current)
  }, [])

  return { extensionUi, clearExtensionUi, respondToExtensionUi, showExtensionUi }
}
