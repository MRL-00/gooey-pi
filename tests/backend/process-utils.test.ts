import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROCESS_CONCURRENCY_LIMIT, isAbsolutePathForPlatform, killProcessTree, primeAgentCandidates, primeAgentExecutableName, runProcess, stopChildProcesses, waitForProcessExit } from '../../electron/main/process-utils'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'prime-work-process-')); dirs.push(dir); return dir }
const waitUntil = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}

describe('runProcess resource bounds', () => {
  it('uses a combined output budget and explicitly reports truncation with independent kill escalation', async () => {
    const started = Date.now()
    const result = await runProcess(process.execPath, ['-e', `
process.on('SIGTERM', () => {})
process.stdout.write('o'.repeat(800))
process.stderr.write('e'.repeat(800))
setInterval(() => {}, 1000)
`], { timeoutMs: 10_000, maxBytes: 1_024 })

    expect(result.outputExceeded).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.stdoutBytes).toBe(800)
    expect(result.stderrBytes).toBe(800)
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_024)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('globally bounds normal one-shot process concurrency', async () => {
    const dir = temp()
    const statePath = join(dir, 'state.json')
    const workerPath = join(dir, 'worker.cjs')
    writeFileSync(statePath, JSON.stringify({ active: 0, max: 0 }))
    writeFileSync(workerPath, `
const fs = require('node:fs')
const statePath = process.argv.at(-1)
const lockPath = statePath + '.lock'
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
const update = (delta) => {
  while (true) { try { fs.mkdirSync(lockPath); break } catch (error) { if (error.code !== 'EEXIST') throw error; pause() } }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    state.active += delta
    state.max = Math.max(state.max, state.active)
    fs.writeFileSync(statePath, JSON.stringify(state))
  } finally { fs.rmdirSync(lockPath) }
}
update(1)
setTimeout(() => update(-1), 250)
`)

    const count = PROCESS_CONCURRENCY_LIMIT + 6
    const results = await Promise.all(Array.from({ length: count }, () => runProcess(process.execPath, [workerPath, statePath], { timeoutMs: 5_000 })))
    expect(results.every((result) => result.code === 0)).toBe(true)
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { active: number; max: number }
    expect(state.active).toBe(0)
    expect(state.max).toBeGreaterThan(1)
    expect(state.max).toBeLessThanOrEqual(PROCESS_CONCURRENCY_LIMIT)
  }, 15_000)

  it('closes queued admission and still terminates every active child during shutdown', async () => {
    const dir = temp()
    const active = Array.from({ length: PROCESS_CONCURRENCY_LIMIT }, (_, index) => runProcess(process.execPath, ['-e', `
const fs = require('node:fs')
process.on('SIGTERM', () => {})
fs.writeFileSync(process.argv.at(-1), String(process.pid))
setInterval(() => {}, 1000)
`, join(dir, `active-${index}`)], { timeoutMs: 30_000 }))
    await waitUntil(() => readdirSync(dir).filter((name) => name.startsWith('active-')).length === PROCESS_CONCURRENCY_LIMIT)

    const deniedMarker = join(dir, 'queued-ran')
    const queued = runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(process.argv.at(-1), 'unexpected')`, deniedMarker])
    const cleanup = stopChildProcesses()
    await expect(queued).rejects.toThrow(/admission is closed/)
    await cleanup
    const completed = await Promise.all(active)

    expect(completed.every((result) => result.signal === 'SIGKILL' || result.signal === 'SIGTERM')).toBe(true)
    expect(readdirSync(dir)).not.toContain('queued-ran')
  }, 15_000)
})

describe('killProcessTree', () => {
  afterEach(() => vi.restoreAllMocks())

  it('escalates through the POSIX ladder over descendants, group, and direct handle until exit', async () => {
    const kills: Array<[number, NodeJS.Signals]> = []
    const direct: NodeJS.Signals[] = []
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: NodeJS.Signals) => {
      kills.push([pid, signal])
      return true
    }) as typeof process.kill)
    let exited = false
    const result = await killProcessTree(4_242, {
      platform: 'linux',
      ladder: [{ signal: 'SIGTERM', waitMs: 5 }, { signal: 'SIGKILL', waitMs: 5 }],
      descendants: [5_001],
      hasExited: () => exited,
      waitForExit: async () => { exited = kills.some(([, signal]) => signal === 'SIGKILL'); return exited },
      signalDirect: (signal) => direct.push(signal),
    })

    expect(result).toBe(true)
    expect(kills).toEqual([[5_001, 'SIGTERM'], [-4_242, 'SIGTERM'], [5_001, 'SIGKILL'], [-4_242, 'SIGKILL']])
    expect(direct).toEqual(['SIGTERM', 'SIGKILL'])
    kill.mockRestore()
  })

  it('stops before the first rung when the process already exited', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
    const result = await killProcessTree(4_242, {
      platform: 'linux',
      ladder: [{ signal: 'SIGTERM', waitMs: 5 }],
      hasExited: () => true,
    })

    expect(result).toBe(true)
    expect(kill).not.toHaveBeenCalled()
  })

  it('collapses the win32 ladder into one awaited taskkill /pid <pid> /T /F', async () => {
    const taskkillPids: number[] = []
    const direct: Array<NodeJS.Signals | undefined> = []
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
    const result = await killProcessTree(7_777, {
      platform: 'win32',
      ladder: [{ signal: 'SIGTERM', waitMs: 350 }, { signal: 'SIGKILL', waitMs: 0 }],
      runTaskkill: async (pid) => { taskkillPids.push(pid) },
      signalDirect: (signal) => direct.push(signal),
    })

    expect(result).toBe(true)
    expect(taskkillPids).toEqual([7_777])
    expect(direct).toEqual(['SIGKILL'])
    expect(kill).not.toHaveBeenCalled()
  })

  it('reports win32 exit through the observer within the ladder budget', async () => {
    let exited = false
    const result = await killProcessTree(7_777, {
      platform: 'win32',
      ladder: [{ signal: 'SIGTERM', waitMs: 100 }],
      runTaskkill: async () => { exited = true },
      hasExited: () => exited,
    })

    expect(result).toBe(true)
  })

  it('terminates a real SIGTERM-resistant process through the ladder', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise((resolveReady) => child.stdout.once('data', resolveReady))

    const result = await killProcessTree(child.pid!, {
      ladder: [{ signal: 'SIGTERM', waitMs: 200 }, { signal: 'SIGKILL', waitMs: 3_000 }],
      hasExited: () => child.exitCode !== null || child.signalCode !== null,
      waitForExit: (timeoutMs) => waitForProcessExit(child, timeoutMs),
      signalDirect: (signal) => child.kill(signal),
    })

    expect(result).toBe(true)
    expect(child.signalCode).toBe('SIGKILL')
  }, 10_000)
})

describe('waitForProcessExit', () => {
  it('resolves immediately for an exited child and observes a later close within the timeout', async () => {
    const exited = spawn(process.execPath, ['-e', ''])
    await new Promise((resolveClose) => exited.once('close', resolveClose))
    await expect(waitForProcessExit(exited, 5)).resolves.toBe(true)

    const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120)'])
    await expect(waitForProcessExit(running, 10)).resolves.toBe(false)
    await expect(waitForProcessExit(running, 5_000)).resolves.toBe(true)
  }, 10_000)
})

describe('Prime Agent discovery candidates', () => {
  it('uses native executable names and absolute paths for every supported desktop platform', () => {
    expect(primeAgentExecutableName('darwin')).toBe('prime-agent')
    expect(primeAgentExecutableName('linux')).toBe('prime-agent')
    expect(primeAgentExecutableName('win32')).toBe('prime-agent.exe')
    expect(isAbsolutePathForPlatform('/opt/prime-agent', 'linux')).toBe(true)
    expect(isAbsolutePathForPlatform('C:\\Tools\\prime-agent.exe', 'win32')).toBe(true)
    expect(isAbsolutePathForPlatform('prime-agent.exe', 'win32')).toBe(false)
  })

  it('accepts explicit Windows binaries and searches the Windows PATH without shell execution', () => {
    const candidates = primeAgentCandidates({
      PRIME_AGENT_BINARY: 'C:\\Tools\\prime-agent.exe',
      Path: 'C:\\Program Files\\Prime Agent;D:\\bin',
      LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
    }, 'win32')
    expect(candidates).toContain('C:\\Tools\\prime-agent.exe')
    expect(candidates).toContain('C:\\Program Files\\Prime Agent\\prime-agent.exe')
    expect(candidates).toContain('D:\\bin\\prime-agent.exe')
    expect(candidates).toContain('C:\\Users\\Ada\\AppData\\Local\\Programs\\Prime Agent\\prime-agent.exe')
  })
})
