import { Maximize2, Minimize2, Terminal as TerminalIcon, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { IconButton } from './ui'
import { ResizeHandle } from './ResizeHandle'

interface TerminalDrawerProps {
  cwd?: string
  shell?: string
  height: number
  minHeight: number
  maxHeight: number
  defaultHeight: number
  onHeightChange(height: number): void
  onClose(): void
  onError?(message: string): void
}

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

export function TerminalDrawer({ cwd, shell, height, minHeight, maxHeight, defaultHeight, onHeightChange, onClose, onError }: TerminalDrawerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [shellName, setShellName] = useState(shell?.split('/').at(-1) ?? 'zsh')
  const [connected, setConnected] = useState(false)
  const [maximized, setMaximized] = useState(false)

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
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminalRef.current = terminal; fitRef.current = fit
    requestAnimationFrame(() => fit.fit())

    const themeObserver = new MutationObserver(() => { terminal.options.theme = terminalTheme() })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    let offData: (() => void) | undefined
    let offExit: (() => void) | undefined
    let cancelled = false
    const inputDisposable = terminal.onData((data) => { const id = terminalIdRef.current; if (id && window.prime) window.prime.terminal.input(id, data) })
    const resizeDisposable = terminal.onResize(({ cols, rows }) => { const id = terminalIdRef.current; if (id && window.prime) window.prime.terminal.resize(id, cols, rows) })

    if (window.prime && cwd) {
      window.prime.terminal.create({ cwd, shell, cols: terminal.cols, rows: terminal.rows }).then(({ terminalId, shell: actualShell }) => {
        if (cancelled) { void window.prime.terminal.kill(terminalId); return }
        terminalIdRef.current = terminalId; setShellName(actualShell.split('/').at(-1) ?? actualShell); setConnected(true)
        offData = window.prime.terminal.onData((event) => { if (event.terminalId === terminalId) terminal.write(event.data) })
        offExit = window.prime.terminal.onExit((event) => { if (event.terminalId === terminalId) { terminal.writeln(`
\x1b[90m[Process exited with code ${event.exitCode}]\x1b[0m`); setConnected(false) } })
      }).catch((error: unknown) => { const message = error instanceof Error ? error.message : 'Unable to start terminal'; terminal.writeln(`\x1b[31m${message}\x1b[0m`); onError?.(message) })
    } else {
      terminal.writeln('\x1b[38;5;141mPrime Work terminal\x1b[0m')
      terminal.writeln('\x1b[90mA live PTY will connect when the desktop bridge and project are available.\x1b[0m')
      terminal.write('\r\n\x1b[32m➜\x1b[0m \x1b[36mprime-work\x1b[0m \x1b[90mgit:(main)\x1b[0m ')
    }

    const observer = new ResizeObserver(() => requestAnimationFrame(() => { try { fit.fit() } catch { /* drawer is transitioning */ } }))
    observer.observe(container)
    return () => {
      cancelled = true; themeObserver.disconnect(); observer.disconnect(); offData?.(); offExit?.(); inputDisposable.dispose(); resizeDisposable.dispose()
      const id = terminalIdRef.current; terminalIdRef.current = null
      if (id && window.prime) void window.prime.terminal.kill(id)
      terminal.dispose(); terminalRef.current = null; fitRef.current = null
    }
  }, [cwd, shell, onError])

  return (
    <section className={`terminal-drawer ${maximized ? 'is-maximized' : ''}`} aria-label="Integrated terminal">
      {!maximized ? <ResizeHandle orientation="horizontal" label="Resize terminal" value={height} min={minHeight} max={maxHeight} defaultValue={defaultHeight} onChange={onHeightChange} /> : null}
      <div className="terminal-toolbar">
        <div className="terminal-tabs"><div className="is-active"><TerminalIcon size={14}/><span>{shellName}</span><span className={`terminal-live-dot ${connected ? 'is-connected' : ''}`}/></div></div>
        <div className="terminal-actions"><span className="terminal-cwd" title={cwd}>{cwd?.split('/').at(-1) ?? 'No project'}</span><IconButton label="Clear terminal" onClick={() => terminalRef.current?.clear()}><Trash2 size={13}/></IconButton><IconButton label={maximized ? 'Restore terminal' : 'Maximize terminal'} onClick={() => setMaximized((value) => !value)}>{maximized ? <Minimize2 size={13}/> : <Maximize2 size={13}/>}</IconButton><IconButton label="Close terminal" onClick={onClose}><X size={14}/></IconButton></div>
      </div>
      <div className="terminal-surface" ref={containerRef}/>
    </section>
  )
}
