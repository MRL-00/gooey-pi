import { useEffect, useRef, useState } from 'react'
import type { WorkspaceView } from '@/types/api'

export const INSPECTOR_MIN = 340
export const INSPECTOR_DEFAULT = 520
export const CHAT_MIN = 360
export const TERMINAL_MIN = 170
export const TERMINAL_DEFAULT = 310
export const WORKSPACE_ROW_MIN = 220

const readPanelSize = (key: string, fallback: number) => {
  if (typeof window === 'undefined') return fallback
  const value = Number(window.localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

interface UsePanelLayoutOptions {
  sidebarOpen: boolean
  inspectorOpen: boolean
  setInspectorOpen(value: boolean): void
  terminalOpen: boolean
  view: WorkspaceView
}

export function usePanelLayout({
  sidebarOpen,
  inspectorOpen,
  setInspectorOpen,
  terminalOpen,
  view,
}: UsePanelLayoutOptions) {
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia('(max-width: 980px)').matches)
  const [inspectorWidth, setInspectorWidth] = useState(() => readPanelSize('prime-work.inspector-width', INSPECTOR_DEFAULT))
  const [terminalHeight, setTerminalHeight] = useState(() => readPanelSize('prime-work.terminal-height', TERMINAL_DEFAULT))
  const [inspectorMax, setInspectorMax] = useState(660)
  const [terminalMax, setTerminalMax] = useState(520)
  const workspaceRowRef = useRef<HTMLDivElement>(null)
  const sessionWorkspaceRef = useRef<HTMLDivElement>(null)
  const compactRestoreRef = useRef<'inspector' | null>(null)

  useEffect(() => {
    const sync = () => setCompactLayout(window.innerWidth <= 980)
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  useEffect(() => {
    if (compactLayout && sidebarOpen && inspectorOpen) {
      compactRestoreRef.current = 'inspector'
      setInspectorOpen(false)
    } else if (!compactLayout && compactRestoreRef.current === 'inspector' && sidebarOpen && !inspectorOpen) {
      compactRestoreRef.current = null
      setInspectorOpen(true)
    }
  }, [compactLayout, inspectorOpen, setInspectorOpen, sidebarOpen])

  useEffect(() => {
    if (!compactLayout || !inspectorOpen) return
    const targets = [...document.querySelectorAll<HTMLElement>('.title-toolbar, .conversation-pane, .terminal-drawer, .workspace-row > .resize-handle')]
    for (const target of targets) target.inert = true
    return () => { for (const target of targets) target.inert = false }
  }, [compactLayout, inspectorOpen, terminalOpen])

  useEffect(() => {
    const row = workspaceRowRef.current
    const workspace = sessionWorkspaceRef.current
    if (!row || !workspace) return
    const syncBounds = () => {
      if (!window.matchMedia('(max-width: 980px)').matches) {
        setInspectorMax(Math.max(INSPECTOR_MIN, row.clientWidth - CHAT_MIN))
      }
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

  return {
    compactLayout,
    compactRestoreRef,
    inspectorWidth,
    setInspectorWidth,
    terminalHeight,
    setTerminalHeight,
    inspectorMax,
    terminalMax,
    workspaceRowRef,
    sessionWorkspaceRef,
  }
}
