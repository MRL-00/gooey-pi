import { Maximize2, Minimize2, Plus, Terminal as TerminalIcon, Trash2, X } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { boundTerminalText, TERMINAL_CONTEXT_MAX_CHARS, TERMINAL_SELECTION_MAX_CHARS } from '@/lib/terminal-context'
import type { TerminalPromptContext, TerminalSelectionContext } from '@/types/api'
import { IconButton } from './ui'
import { ResizeHandle } from './ResizeHandle'

interface TerminalDrawerProps {
  visible?: boolean
  cwd?: string
  sessionPath?: string
  shell?: string
  height: number
  minHeight: number
  maxHeight: number
  defaultHeight: number
  onHeightChange(height: number): void
  onClose(): void
  onError?(message: string): void
  onSelectionChange?(selection?: TerminalSelectionContext): void
}

interface TerminalTab {
  id: string
  number: number
  shellName: string
  connected: boolean
}

interface TerminalViewHandle {
  clear(): void
  clearSelection(): void
  readSelection(): Pick<TerminalPromptContext, 'text' | 'truncated'>
}

interface TerminalViewProps {
  cwd?: string
  sessionPath?: string
  shell?: string
  label: string
  visible: boolean
  onStateChange(state: Pick<TerminalTab, 'shellName' | 'connected'>): void
  onSelectionChange(text: string, truncated: boolean): void
  onError?(message: string): void
}

export interface TerminalDrawerHandle {
  clearSelection(): void
  readSelectionContext(): TerminalPromptContext | undefined
}

const MAX_TERMINAL_TABS = 8

const terminalTheme = (): ITheme => {
  const computed = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => computed.getPropertyValue(name).trim() || fallback
  return {
    background: read('--terminal-bg', '#ffffff'),
    foreground: read('--terminal-text', '#20201e'),
    cursor: read('--prime', '#6b55e8'),
    selectionBackground: read('--terminal-selection', '#c8beff99'),
    black: read('--terminal-black', '#242423'),
    red: read('--terminal-red', '#b42318'),
    green: read('--terminal-green', '#18794e'),
    yellow: read('--terminal-yellow', '#8a5a00'),
    blue: read('--terminal-blue', '#2768b4'),
    magenta: read('--terminal-magenta', '#7b4bb7'),
    cyan: read('--terminal-cyan', '#197a7d'),
    white: read('--terminal-white', '#686863'),
    brightBlack: read('--terminal-bright-black', '#8b8b83'),
    brightRed: read('--terminal-bright-red', '#b42318'),
    brightGreen: read('--terminal-bright-green', '#18794e'),
    brightYellow: read('--terminal-bright-yellow', '#8a5a00'),
    brightBlue: read('--terminal-bright-blue', '#2768b4'),
    brightMagenta: read('--terminal-bright-magenta', '#7046a3'),
    brightCyan: read('--terminal-bright-cyan', '#177f83'),
    brightWhite: read('--terminal-bright-white', '#20201e'),
  }
}

function readTerminalContent(terminal: Terminal): { content: string; contentTruncated: boolean } {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  let current = ''
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index)
    if (!line) continue
    const text = line.translateToString(true)
    if (line.isWrapped) current += text
    else {
      if (current) lines.push(current)
      current = text
    }
  }
  if (current) lines.push(current)
  const bounded = boundTerminalText(lines.join('\n'), TERMINAL_CONTEXT_MAX_CHARS)
  return { content: bounded.text, contentTruncated: bounded.truncated }
}

const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView({ cwd, sessionPath, shell, label, visible, onStateChange, onSelectionChange, onError }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionPathRef = useRef(sessionPath)
  const visibleRef = useRef(visible)
  const onStateChangeRef = useRef(onStateChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onErrorRef = useRef(onError)
  const labelRef = useRef(label)
  const activeContextTimerRef = useRef<number | undefined>(undefined)
  visibleRef.current = visible
  sessionPathRef.current = sessionPath
  onStateChangeRef.current = onStateChange
  onSelectionChangeRef.current = onSelectionChange
  onErrorRef.current = onError
  labelRef.current = label

  useImperativeHandle(ref, () => ({
    clear: () => terminalRef.current?.clear(),
    clearSelection: () => terminalRef.current?.clearSelection(),
    readSelection: () => {
      const terminal = terminalRef.current
      return terminal ? boundTerminalText(terminal.getSelection(), TERMINAL_SELECTION_MAX_CHARS) : { text: '', truncated: false }
    },
  }), [])

  const publishActiveContext = () => {
    const terminal = terminalRef.current
    const terminalId = terminalIdRef.current
    if (!visibleRef.current || !terminal || !terminalId || !window.prime) return
    const content = readTerminalContent(terminal)
    window.prime.terminal.setActiveContext(terminalId, { label: labelRef.current, content: content.content, truncated: content.contentTruncated })
  }

  const scheduleActiveContext = () => {
    if (activeContextTimerRef.current !== undefined) return
    activeContextTimerRef.current = window.setTimeout(() => {
      activeContextTimerRef.current = undefined
      publishActiveContext()
    }, 100)
  }

  useEffect(() => {
    if (!visible) {
      const terminalId = terminalIdRef.current
      if (terminalId && window.prime) window.prime.terminal.clearActiveContext(terminalId)
      return
    }
    requestAnimationFrame(() => {
      try { fitRef.current?.fit() } catch { /* tab is transitioning */ }
      terminalRef.current?.focus()
      scheduleActiveContext()
    })
  }, [visible, label])

  useEffect(() => {
    const terminalId = terminalIdRef.current
    if (!terminalId || !sessionPath || !window.prime) return
    void window.prime.terminal.bindSession(terminalId, sessionPath).then(() => scheduleActiveContext()).catch(() => undefined)
  }, [sessionPath])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.45,
      scrollback: 5000,
      allowProposedApi: false,
      screenReaderMode: true,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminalRef.current = terminal
    fitRef.current = fit
    // Spawn the shell at the drawer's real dimensions. Creating the PTY at
    // xterm's 80x24 default and fitting on the next frame makes zsh redraw its
    // first prompt, leaving its reverse-video `%` end-of-line marker behind.
    try { fit.fit() } catch { /* initial layout is not ready */ }
    requestAnimationFrame(() => { try { fit.fit() } catch { /* initial layout is not ready */ } })

    const themeObserver = new MutationObserver(() => { terminal.options.theme = terminalTheme() })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    let offData: (() => void) | undefined
    let offExit: (() => void) | undefined
    let cancelled = false
    const bufferedData = new Map<string, string>()
    const bufferedExits = new Map<string, number>()
    const announceExit = (exitCode: number) => {
      terminal.writeln(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`)
      onStateChangeRef.current({ shellName: shell?.split('/').at(-1) ?? 'terminal', connected: false })
    }
    const inputDisposable = terminal.onData((data) => {
      const id = terminalIdRef.current
      if (id && window.prime) window.prime.terminal.input(id, data)
    })
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const id = terminalIdRef.current
      if (id && window.prime) window.prime.terminal.resize(id, cols, rows)
    })
    const selectionDisposable = terminal.onSelectionChange(() => {
      const selection = boundTerminalText(terminal.getSelection(), TERMINAL_SELECTION_MAX_CHARS)
      onSelectionChangeRef.current(selection.text, selection.truncated)
    })

    if (window.prime && cwd) {
      // Subscribe before create resolves: a fast shell can emit its prompt or exit before the IPC reply.
      offData = window.prime.terminal.onData((event) => {
        if (event.terminalId === terminalIdRef.current) terminal.write(event.data, scheduleActiveContext)
        else if (!terminalIdRef.current) {
          const next = `${bufferedData.get(event.terminalId) ?? ''}${event.data}`
          bufferedData.set(event.terminalId, next.slice(-256 * 1024))
        }
      })
      offExit = window.prime.terminal.onExit((event) => {
        if (event.terminalId === terminalIdRef.current) announceExit(event.exitCode)
        else if (!terminalIdRef.current) bufferedExits.set(event.terminalId, event.exitCode)
      })
      window.prime.terminal.create({ cwd, shell, cols: terminal.cols, rows: terminal.rows }).then(({ terminalId, shell: actualShell }) => {
        if (cancelled) { void window.prime.terminal.kill(terminalId); return }
        terminalIdRef.current = terminalId
        onStateChangeRef.current({ shellName: actualShell.split('/').at(-1) ?? actualShell, connected: true })
        const initialOutput = bufferedData.get(terminalId)
        const bindCurrentSession = async () => {
          if (sessionPathRef.current) await window.prime.terminal.bindSession(terminalId, sessionPathRef.current)
          scheduleActiveContext()
        }
        if (initialOutput) terminal.write(initialOutput, () => { void bindCurrentSession().catch(() => undefined) })
        else void bindCurrentSession().catch(() => undefined)
        const earlyExit = bufferedExits.get(terminalId)
        bufferedData.clear()
        bufferedExits.clear()
        if (earlyExit !== undefined) announceExit(earlyExit)
      }).catch((error: unknown) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Unable to start terminal'
        terminal.writeln(`\x1b[31m${message}\x1b[0m`)
        onErrorRef.current?.(message)
      })
    } else {
      terminal.writeln('\x1b[38;5;141mPrime Work terminal\x1b[0m')
      terminal.writeln('\x1b[90mA live PTY will connect when the desktop bridge and project are available.\x1b[0m')
      terminal.write('\r\n\x1b[32m➜\x1b[0m \x1b[36mprime-work\x1b[0m \x1b[90mgit:(main)\x1b[0m ')
    }

    const observer = new ResizeObserver(() => {
      if (!visibleRef.current) return
      requestAnimationFrame(() => { try { fit.fit() } catch { /* drawer is transitioning */ } })
    })
    observer.observe(container)
    return () => {
      cancelled = true
      themeObserver.disconnect()
      observer.disconnect()
      offData?.()
      offExit?.()
      inputDisposable.dispose()
      resizeDisposable.dispose()
      selectionDisposable.dispose()
      if (activeContextTimerRef.current !== undefined) window.clearTimeout(activeContextTimerRef.current)
      const id = terminalIdRef.current
      terminalIdRef.current = null
      if (id && window.prime) void window.prime.terminal.kill(id)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [cwd, shell])

  return <div className="terminal-surface" ref={containerRef} hidden={!visible}/>
})

function createTab(number: number, shell?: string): TerminalTab {
  return {
    id: crypto.randomUUID(),
    number,
    shellName: shell?.split('/').at(-1) ?? 'zsh',
    connected: false,
  }
}

export const TerminalDrawer = forwardRef<TerminalDrawerHandle, TerminalDrawerProps>(function TerminalDrawer({ visible = true, cwd, sessionPath, shell, height, minHeight, maxHeight, defaultHeight, onHeightChange, onClose, onError, onSelectionChange }, ref) {
  const nextNumberRef = useRef(2)
  const viewRefs = useRef(new Map<string, TerminalViewHandle>())
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [createTab(1, shell)])
  const [activeTabId, setActiveTabId] = useState(() => tabs[0].id)
  const [maximized, setMaximized] = useState(false)
  const tabsRef = useRef(tabs)
  const activeTabIdRef = useRef(activeTabId)
  const onSelectionChangeRef = useRef(onSelectionChange)
  tabsRef.current = tabs
  activeTabIdRef.current = activeTabId
  onSelectionChangeRef.current = onSelectionChange

  const currentSelection = (tabId: string): TerminalSelectionContext | undefined => {
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId)
    const value = viewRefs.current.get(tabId)?.readSelection()
    if (!tab || !value) return undefined
    return { tabId, label: `${tab.shellName} ${tab.number}`, text: value.text, truncated: value.truncated }
  }

  useImperativeHandle(ref, () => ({
    clearSelection: () => viewRefs.current.get(activeTabIdRef.current)?.clearSelection(),
    readSelectionContext: () => {
      const tabId = activeTabIdRef.current
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId)
      const value = viewRefs.current.get(tabId)?.readSelection()
      if (!tab || !value?.text) return undefined
      return { tabId, label: `${tab.shellName} ${tab.number}`, cwd, ...value }
    },
  }), [cwd])

  useEffect(() => {
    onSelectionChangeRef.current?.(visible ? currentSelection(activeTabId) : undefined)
  }, [activeTabId, visible])

  useEffect(() => () => onSelectionChangeRef.current?.(undefined), [])

  const addTerminal = () => {
    if (tabs.length >= MAX_TERMINAL_TABS) {
      onError?.(`Prime Work supports at most ${MAX_TERMINAL_TABS} concurrent terminals.`)
      return
    }
    const tab = createTab(nextNumberRef.current++, shell)
    setTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
  }

  const closeTerminal = (tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return
    if (tabs.length === 1) {
      onClose()
      return
    }
    const nextTabs = tabs.filter((tab) => tab.id !== tabId)
    setTabs(nextTabs)
    viewRefs.current.delete(tabId)
    if (activeTabId === tabId) setActiveTabId(nextTabs[Math.min(index, nextTabs.length - 1)].id)
  }

  const updateTab = (tabId: string, state: Pick<TerminalTab, 'shellName' | 'connected'>) => {
    setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, ...state } : tab))
  }

  return (
    <section className={`terminal-drawer ${maximized ? 'is-maximized' : ''}`} aria-label="Integrated terminal" hidden={!visible}>
      {!maximized ? <ResizeHandle orientation="horizontal" label="Resize terminal" value={height} min={minHeight} max={maxHeight} defaultValue={defaultHeight} onChange={onHeightChange} /> : null}
      <div className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">
          {tabs.map((tab) => (
            <div className={`terminal-tab ${tab.id === activeTabId ? 'is-active' : ''}`} key={tab.id}>
              <button type="button" role="tab" aria-selected={tab.id === activeTabId} onClick={() => setActiveTabId(tab.id)}>
                <TerminalIcon size={14}/>
                <span>{tab.shellName} {tab.number}</span>
                <span className={`terminal-live-dot ${tab.connected ? 'is-connected' : ''}`}/>
              </button>
              <button type="button" className="terminal-tab__close" aria-label={`Close tab ${tab.number}`} onClick={() => closeTerminal(tab.id)}><X size={11}/></button>
            </div>
          ))}
          <IconButton label="New terminal" size="small" disabled={tabs.length >= MAX_TERMINAL_TABS} onClick={addTerminal}><Plus size={14}/></IconButton>
        </div>
        <div className="terminal-actions">
          <span className="terminal-cwd" title={cwd}>{cwd?.split('/').at(-1) ?? 'No project'}</span>
          <IconButton label="Clear terminal" onClick={() => viewRefs.current.get(activeTabId)?.clear()}><Trash2 size={13}/></IconButton>
          <IconButton label={maximized ? 'Restore terminal' : 'Maximize terminal'} onClick={() => setMaximized((value) => !value)}>{maximized ? <Minimize2 size={13}/> : <Maximize2 size={13}/>}</IconButton>
          <IconButton label="Close terminal" onClick={onClose}><X size={14}/></IconButton>
        </div>
      </div>
      <div className="terminal-views">
        {tabs.map((tab) => (
          <TerminalView
            key={tab.id}
            ref={(handle) => { if (handle) viewRefs.current.set(tab.id, handle); else viewRefs.current.delete(tab.id) }}
            cwd={cwd}
            sessionPath={sessionPath}
            shell={shell}
            label={`${tab.shellName} ${tab.number}`}
            visible={visible && tab.id === activeTabId}
            onStateChange={(state) => updateTab(tab.id, state)}
            onSelectionChange={(text, truncated) => {
              if (activeTabIdRef.current !== tab.id) return
              onSelectionChangeRef.current?.({ tabId: tab.id, label: `${tab.shellName} ${tab.number}`, text, truncated })
            }}
            onError={onError}
          />
        ))}
      </div>
    </section>
  )
})
