import { createElement, memo, useEffect, useRef } from 'react'
import type { AgentBrowserTabRecord } from '@/types/api'

export interface AgentSlotRect {
  left: number
  top: number
  width: number
  height: number
}

type AgentWebviewElement = HTMLElement & {
  getWebContentsId(): number
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

interface AgentBrowserLayerProps {
  tabs: AgentBrowserTabRecord[]
  visibleTabId: string | null
  rect: AgentSlotRect | null
  onAttach(tabId: string, webContentsId: number): void
}

/**
 * Hosts one webview guest per agent browser tab, for every session. This
 * layer stays mounted at the app shell so guests survive inspector and view
 * switches while the agent drives them; unmounting a webview destroys its
 * page. It is positioned over the Browser panel's slot when that panel shows
 * an agent tab, and kept laid out but invisible otherwise (display:none would
 * tear down the guest).
 */
export function AgentBrowserLayer({ tabs, visibleTabId, rect, onAttach }: AgentBrowserLayerProps) {
  const style = rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined
  return (
    <div className={`agent-browser-layer ${rect ? 'is-visible' : ''}`} style={style} aria-hidden={rect ? undefined : true}>
      {tabs.map((tab) => (
        <AgentTabView key={tab.tabId} tabId={tab.tabId} visible={rect !== null && tab.tabId === visibleTabId} onAttach={onAttach} />
      ))}
    </div>
  )
}

const AgentTabView = memo(function AgentTabView({ tabId, visible, onAttach }: { tabId: string; visible: boolean; onAttach(tabId: string, webContentsId: number): void }) {
  const viewRef = useRef<AgentWebviewElement | null>(null)
  const reportedRef = useRef(false)
  const onAttachRef = useRef(onAttach)
  onAttachRef.current = onAttach

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // dom-ready is the earliest point where getWebContentsId is valid; it
    // fires again per document, so report only once per mounted guest.
    const report = () => {
      if (reportedRef.current) return
      try {
        const webContentsId = view.getWebContentsId()
        reportedRef.current = true
        onAttachRef.current(tabId, webContentsId)
      } catch { /* guest not attached yet; a later dom-ready will report */ }
    }
    view.addEventListener('dom-ready', report)
    return () => view.removeEventListener('dom-ready', report)
  }, [tabId])

  // src stays about:blank permanently: the main process drives all navigation,
  // and rewriting src on re-render would reload the guest.
  return (
    <div className={`agent-browser-tab ${visible ? 'is-visible' : ''}`}>
      {createElement('webview' as never, {
        ref: (node: AgentWebviewElement | null) => { viewRef.current = node },
        src: 'about:blank',
        className: 'browser-webview',
        partition: 'persist:prime-work-browser',
        webpreferences: 'contextIsolation=yes,sandbox=yes,nodeIntegration=no',
      })}
    </div>
  )
})
