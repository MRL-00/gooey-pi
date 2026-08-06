import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import * as pty from 'node-pty'
import type { TerminalDataEvent, TerminalExitEvent } from '../../src/types/api'
import { safeChildEnvironment } from './process-utils'
import { rejectUnknownKeys, requireInteger, requireRecord, requireString } from './validation'

interface OwnedTerminal { terminal: pty.IPty; owner: WebContents; ownerId: number; shell: string }

function systemShells(): Set<string> {
  const shells = new Set<string>(['/bin/zsh', '/bin/bash', '/bin/sh'])
  try {
    for (const line of readFileSync('/etc/shells', 'utf8').split(/\r?\n/)) {
      const candidate = line.trim()
      if (candidate.startsWith('/')) shells.add(candidate)
    }
  } catch { /* use conservative defaults */ }
  if (process.env.SHELL?.startsWith('/')) shells.add(process.env.SHELL)
  return shells
}

export class TerminalService {
  private readonly terminals = new Map<string, OwnedTerminal>()
  private readonly allowedShells = systemShells()

  constructor(
    private readonly authorizeCwd: (cwd: string) => Promise<string>,
    private readonly configuredShell: () => string,
  ) {}

  validateShell(value: unknown): string {
    const requested = requireString(value, 'shell', { min: 1, max: 4096 })
    if (!requested.startsWith('/')) throw new TypeError('shell must be an absolute path')
    let canonical: string
    try {
      canonical = realpathSync(requested)
      accessSync(canonical, constants.X_OK)
      if (!statSync(canonical).isFile()) throw new Error('not a file')
    } catch { throw new TypeError('shell is not executable') }
    const allowedCanonical = new Set<string>()
    for (const shell of this.allowedShells) {
      if (!shell?.startsWith('/') || !existsSync(shell)) continue
      try { allowedCanonical.add(realpathSync(shell)) } catch { /* ignore */ }
    }
    if (!allowedCanonical.has(canonical)) throw new TypeError('shell is not listed in /etc/shells')
    return canonical
  }

  async create(owner: WebContents, raw: unknown): Promise<{ terminalId: string; shell: string }> {
    const options = requireRecord(raw, 'terminal options')
    rejectUnknownKeys(options, ['cwd', 'shell', 'cols', 'rows'], 'terminal options')
    const cwd = await this.authorizeCwd(requireString(options.cwd, 'cwd', { min: 1, max: 4096 }))
    if (owner.isDestroyed()) throw new Error('Terminal owner was closed')
    if (this.terminals.size >= 8) throw new Error('Prime Work supports at most eight concurrent terminals')
    const shell = this.validateShell(options.shell ?? this.configuredShell())
    const cols = options.cols === undefined ? 100 : requireInteger(options.cols, 'cols', 2, 1_000)
    const rows = options.rows === undefined ? 30 : requireInteger(options.rows, 'rows', 1, 1_000)
    const env = Object.fromEntries(Object.entries(safeChildEnvironment({ TERM: 'xterm-256color', COLORTERM: 'truecolor' })).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    const terminal = pty.spawn(shell, ['-l'], { cwd, cols, rows, name: 'xterm-256color', env })
    if (owner.isDestroyed()) { try { terminal.kill() } catch { /* owner closed during spawn */ }; throw new Error('Terminal owner was closed') }
    const terminalId = randomUUID()
    this.terminals.set(terminalId, { terminal, owner, ownerId: owner.id, shell })
    terminal.onData((data) => {
      if (!owner.isDestroyed()) owner.send('terminal:data', { terminalId, data } satisfies TerminalDataEvent)
    })
    terminal.onExit(({ exitCode, signal }) => {
      this.terminals.delete(terminalId)
      if (!owner.isDestroyed()) owner.send('terminal:exit', { terminalId, exitCode, signal } satisfies TerminalExitEvent)
    })
    return { terminalId, shell }
  }

  input(owner: WebContents, idValue: unknown, dataValue: unknown): void {
    const terminal = this.owned(owner, idValue)
    const data = requireString(dataValue, 'terminal data', { max: 64 * 1024 })
    terminal.terminal.write(data)
  }

  resize(owner: WebContents, idValue: unknown, colsValue: unknown, rowsValue: unknown): void {
    const terminal = this.owned(owner, idValue)
    terminal.terminal.resize(requireInteger(colsValue, 'cols', 2, 1_000), requireInteger(rowsValue, 'rows', 1, 1_000))
  }

  async kill(owner: WebContents, idValue: unknown): Promise<boolean> {
    const id = requireString(idValue, 'terminalId', { min: 1, max: 128 })
    const owned = this.terminals.get(id)
    if (!owned || owned.ownerId !== owner.id) return false
    this.terminals.delete(id)
    try { owned.terminal.kill(); return true } catch { return false }
  }

  killOwner(ownerId: number): void {
    for (const [id, terminal] of this.terminals) {
      if (terminal.ownerId !== ownerId) continue
      this.terminals.delete(id)
      try { terminal.terminal.kill() } catch { /* already exited */ }
    }
  }

  killAll(): void {
    for (const terminal of this.terminals.values()) { try { terminal.terminal.kill() } catch { /* already exited */ } }
    this.terminals.clear()
  }

  private owned(owner: WebContents, idValue: unknown): OwnedTerminal {
    const id = requireString(idValue, 'terminalId', { min: 1, max: 128 })
    const terminal = this.terminals.get(id)
    if (!terminal || terminal.ownerId !== owner.id) throw new Error('Terminal was not found')
    return terminal
  }
}
