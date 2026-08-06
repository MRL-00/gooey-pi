import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalService } from '../../electron/main/terminal'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const waitFor = async (predicate: () => boolean, timeout = 4_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)) }
  throw new Error('Timed out waiting for terminal child')
}

describe('TerminalService', () => {
  it('kills detached background descendants when a terminal closes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-')); dirs.push(cwd)
    const pidFile = join(cwd, 'background.pid')
    const owner = { id: 41, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => '/bin/zsh')
    const created = await service.create(owner, { cwd, shell: '/bin/zsh', cols: 80, rows: 24 })
    service.input(owner, created.terminalId, `nohup sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}\r`)
    await waitFor(() => { try { return Number(readFileSync(pidFile, 'utf8').trim()) > 0 } catch { return false } })
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      expect(await service.kill(owner, created.terminalId)).toBe(true)
      await waitFor(() => { try { process.kill(childPid, 0); return false } catch { return true } })
    } finally { try { process.kill(childPid, 'SIGKILL') } catch { /* test cleanup */ } }
  }, 10_000)
  it('escalates against a PTY leader that ignores HUP and TERM', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-leader-')); dirs.push(cwd)
    const pidFile = join(cwd, 'leader.pid')
    const owner = { id: 42, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => '/bin/zsh')
    const created = await service.create(owner, { cwd, shell: '/bin/zsh', cols: 80, rows: 24 })
    service.input(owner, created.terminalId, `trap '' HUP TERM; echo $$ > ${JSON.stringify(pidFile)}; while true; do sleep 1; done\r`)
    await waitFor(() => { try { return Number(readFileSync(pidFile, 'utf8').trim()) > 0 } catch { return false } })
    const leaderPid = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      expect(await service.kill(owner, created.terminalId)).toBe(true)
      await waitFor(() => { try { process.kill(leaderPid, 0); return false } catch { return true } })
    } finally { try { process.kill(leaderPid, 'SIGKILL') } catch { /* test cleanup */ } }
  }, 10_000)

})
