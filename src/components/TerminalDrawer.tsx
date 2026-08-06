import { Maximize2, Minimize2, Plus, Split, Terminal as TerminalIcon, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
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
    const computed = getComputedStyle(document.documentElement)
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.45,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: computed.getPropertyValue('--terminal-bg').trim() || '#171716',
        foreground: computed.getPropertyValue('--terminal-text').trim() || '#d8d8d4',
        cursor: computed.getPropertyValue('--prime').trim() || '#a595ff',
        selectionBackground: '#4d456c88',
        black: '#20201f', red: '#ed8a82', green: '#75c897', yellow: '#deb967', blue: '#82b5ff', magenta: '#a595ff', cyan: '#6dc8ca', white: '#d8d8d4',
        brightBlack: '#777772', brightRed: '#f29a93', brightGreen: '#91d6ac', brightYellow: '#e8ca87', brightBlue: '#9bc4ff', brightMagenta: '#b8adff', brightCyan: '#8ad9da', brightWhite: '#f1f1ee',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminalRef.current = terminal; fitRef.current = fit
    requestAnimationFrame(() => fit.fit())

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
      cancelled = true; observer.disconnect(); offData?.(); offExit?.(); inputDisposable.dispose(); resizeDisposable.dispose()
      const id = terminalIdRef.current; terminalIdRef.current = null
      if (id && window.prime) void window.prime.terminal.kill(id)
      terminal.dispose(); terminalRef.current = null; fitRef.current = null
    }
  }, [cwd, shell, onError])

  return (
    <section className={`terminal-drawer ${maximized ? 'is-maximized' : ''}`} aria-label="Integrated terminal">
      {!maximized ? <ResizeHandle orientation="horizontal" label="Resize terminal" value={height} min={minHeight} max={maxHeight} defaultValue={defaultHeight} onChange={onHeightChange} /> : null}
      <div className="terminal-toolbar">
        <div className="terminal-tabs"><button type="button" className="is-active"><TerminalIcon size={14}/><span>{shellName}</span><span className={`terminal-live-dot ${connected ? 'is-connected' : ''}`}/><X size={11}/></button><IconButton size="small" label="New terminal (single-terminal mode)" disabled><Plus size={13}/></IconButton></div>
        <div className="terminal-actions"><span className="terminal-cwd" title={cwd}>{cwd?.split('/').at(-1) ?? 'No project'}</span><IconButton label="Split terminal (single-terminal mode)" disabled><Split size={13}/></IconButton><IconButton label="Clear terminal" onClick={() => terminalRef.current?.clear()}><Trash2 size={13}/></IconButton><IconButton label={maximized ? 'Restore terminal' : 'Maximize terminal'} onClick={() => setMaximized((value) => !value)}>{maximized ? <Minimize2 size={13}/> : <Maximize2 size={13}/>}</IconButton><IconButton label="Close terminal" onClick={onClose}><X size={14}/></IconButton></div>
      </div>
      <div className="terminal-surface" ref={containerRef}/>
    </section>
  )
}
