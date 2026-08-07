import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentBrowserPointerEvent, AgentBrowserTabRecord, PrimeWorkApi } from '@/types/api'

interface UseAgentBrowserTabsOptions {
  bridge: PrimeWorkApi | null
  reportError(error: unknown): void
}

/** Pointer event stamped with a sequence number so identical coordinates still retrigger animations. */
export type StampedPointerEvent = AgentBrowserPointerEvent & { seq: number }

export interface AgentBrowserApi {
  /** Every agent tab across all sessions; the layer must host them all so background threads keep browsing. */
  tabs: AgentBrowserTabRecord[]
  /** Latest agent pointer movement, for the synthetic cursor overlay. */
  pointerEvent: StampedPointerEvent | null
  attach(tabId: string, webContentsId: number): void
  select(tabId: string): void
  close(tabId: string): void
}

/**
 * Mirrors the main process's agent browser tab registry. Main owns the state;
 * the renderer reports webview attachment and user tab actions back to it.
 */
export function useAgentBrowserTabs({ bridge, reportError }: UseAgentBrowserTabsOptions): AgentBrowserApi {
  const [tabs, setTabs] = useState<AgentBrowserTabRecord[]>([])
  const [pointerEvent, setPointerEvent] = useState<StampedPointerEvent | null>(null)
  const pointerSeqRef = useRef(0)

  useEffect(() => {
    if (!bridge) return
    let live = true
    void bridge.browser.state()
      .then((state) => { if (live) setTabs(state.tabs) })
      .catch((error: unknown) => { if (live) reportError(error) })
    const unsubscribe = bridge.browser.onChanged((state) => setTabs(state.tabs))
    const unsubscribePointer = bridge.browser.onPointer((event) => {
      pointerSeqRef.current += 1
      setPointerEvent({ ...event, seq: pointerSeqRef.current })
    })
    return () => { live = false; unsubscribe(); unsubscribePointer() }
  }, [bridge, reportError])

  // Attach races (a tab closed while the webview was mounting) are expected; they resolve on the next snapshot.
  const attach = useCallback((tabId: string, webContentsId: number) => {
    if (bridge) void bridge.browser.attachTab(tabId, webContentsId).catch(() => undefined)
  }, [bridge])
  const select = useCallback((tabId: string) => {
    if (bridge) void bridge.browser.selectTab(tabId).catch(() => undefined)
  }, [bridge])
  const close = useCallback((tabId: string) => {
    if (bridge) void bridge.browser.closeTab(tabId).catch(() => undefined)
  }, [bridge])

  return { tabs, pointerEvent, attach, select, close }
}
