import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalService } from '../../electron/main/terminal'

const dirs: string[] = []
const testShell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find((shell) => {
  try { accessSync(shell, constants.X_OK); return true } catch { return false }
}) ?? '/bin/sh'
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const waitFor = async (predicate: () => boolean, timeout = 4_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)) }
  throw new Error('Timed out waiting for terminal child')
}

describe('TerminalService', () => {
  it('kills descendant processes when a terminal closes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-')); dirs.push(cwd)
    const pidFile = join(cwd, 'background.pid')
    const owner = { id: 41, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => testShell)
    const created = await service.create(owner, { cwd, shell: testShell, cols: 80, rows: 24 })
    service.input(owner, created.terminalId, `/bin/sh -c ${JSON.stringify(`echo "$$" > ${JSON.stringify(pidFile)}; while true; do /bin/sleep 1; done`)}\r`)
    await waitFor(() => { try { return Number(readFileSync(pidFile, 'utf8').trim()) > 0 } catch { return false } })
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      expect(await service.kill(owner, created.terminalId)).toBe(true)
      await waitFor(() => { try { process.kill(childPid, 0); return false } catch { return true } })
    } finally { try { process.kill(childPid, 'SIGKILL') } catch { /* test cleanup */ } }
  }, 15_000)
  it('escalates against a PTY leader that ignores HUP and TERM', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-leader-')); dirs.push(cwd)
    const pidFile = join(cwd, 'leader.pid')
    const owner = { id: 42, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => testShell)
    const created = await service.create(owner, { cwd, shell: testShell, cols: 80, rows: 24 })
    service.input(owner, created.terminalId, `trap '' HUP TERM; echo $$ > ${JSON.stringify(pidFile)}; while true; do sleep 1; done\r`)
    await waitFor(() => { try { return Number(readFileSync(pidFile, 'utf8').trim()) > 0 } catch { return false } })
    const leaderPid = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      expect(await service.kill(owner, created.terminalId)).toBe(true)
      await waitFor(() => { try { process.kill(leaderPid, 0); return false } catch { return true } })
    } finally { try { process.kill(leaderPid, 'SIGKILL') } catch { /* test cleanup */ } }
  }, 10_000)


  it('kills only terminals whose cwd is inside a removed project root', async () => {
    const project = mkdtempSync(join(tmpdir(), 'prime-work-pty-project-')); dirs.push(project)
    const outside = mkdtempSync(join(tmpdir(), 'prime-work-pty-outside-')); dirs.push(outside)
    const owner = { id: 43, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async (cwd) => cwd, () => testShell)
    const projectTerminal = await service.create(owner, { cwd: project, shell: testShell, cols: 80, rows: 24 })
    const outsideTerminal = await service.create(owner, { cwd: outside, shell: testShell, cols: 80, rows: 24 })

    await service.killForProjectRoots([project])

    expect(await service.kill(owner, projectTerminal.terminalId)).toBe(false)
    expect(await service.kill(owner, outsideTerminal.terminalId)).toBe(true)
  })


  it('short-circuits termination without signalling anything when the pty already exited', async () => {
    const service = new TerminalService(async (cwd) => cwd, () => testShell)
    const killSpy = vi.spyOn(process, 'kill')
    const owned = {
      terminal: { pid: process.pid, kill: vi.fn() },
      owner: { isDestroyed: () => true },
      ownerId: 45,
      cwd: '/',
      shell: testShell,
      outputWindowStartedAt: Date.now(),
      outputWindowBytes: 0,
      pendingOutput: '',
      pendingOutputBytes: 0,
      terminating: true,
      exited: true,
    }
    try {
      const started = Date.now()
      await (service as unknown as { terminateProcess(id: string, owned: unknown): Promise<void> }).terminateProcess('gone', owned)
      expect(Date.now() - started).toBeLessThan(400)
      expect(owned.terminal.kill).not.toHaveBeenCalled()
      expect(killSpy).not.toHaveBeenCalled()
    } finally { killSpy.mockRestore() }
  })

  it('makes concurrent app shutdown await an owner teardown already in progress', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-shutdown-')); dirs.push(cwd)
    const owner = { id: 44, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => testShell)
    const created = await service.create(owner, { cwd, shell: testShell, cols: 80, rows: 24 })

    const ownerTeardown = service.killOwner(owner.id)
    let shutdownFinished = false
    const shutdown = service.killAll().then(() => { shutdownFinished = true })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(shutdownFinished).toBe(false)
    await Promise.all([ownerTeardown, shutdown])
    expect(await service.kill(owner, created.terminalId)).toBe(false)
  })

})
