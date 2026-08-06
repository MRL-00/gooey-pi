import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'

export interface ProcessResult { code: number; stdout: string; stderr: string; timedOut: boolean }

const activeChildren = new Set<ChildProcess>()
let processAdmissionClosed = false

export function beginProcessShutdown(): void { processAdmissionClosed = true }

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return } catch { /* fall through */ }
  }
  try { child.kill(signal) } catch { /* already exited */ }
}

function waitForChildren(children: ChildProcess[], timeoutMs: number): Promise<void> {
  return Promise.race([
    Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolveExit) => child.once('close', () => resolveExit())))).then(() => undefined),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ])
}

export async function stopChildProcesses(): Promise<void> {
  // Close admission before taking the snapshot so no later one-shot child can escape cleanup.
  beginProcessShutdown()
  const children = [...activeChildren]
  for (const child of children) terminateChild(child, 'SIGTERM')
  await waitForChildren(children, 1_000)
  const survivors = children.filter((child) => child.exitCode === null && child.signalCode === null)
  for (const child of survivors) terminateChild(child, 'SIGKILL')
  await waitForChildren(survivors, 1_500)
}

export function safeChildEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of [
    'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_ENABLE_STACK_DUMPING',
    'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'LD_PRELOAD', 'FORCE_COLOR',
  ]) delete env[key]
  env.NO_COLOR = '1'
  return env
}

export async function findPrimeAgent(): Promise<string | null> {
  const candidates: string[] = []
  if (process.env.PRIME_AGENT_BINARY?.startsWith('/')) candidates.push(process.env.PRIME_AGENT_BINARY)
  if (typeof process.resourcesPath === 'string') {
    candidates.push(join(process.resourcesPath, 'agent', 'prime-agent'))
    candidates.push(join(process.resourcesPath, 'agent', 'bin', 'prime-agent'))
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.startsWith('/')) candidates.push(join(directory, 'prime-agent'))
  }
  candidates.push('/opt/homebrew/bin/prime-agent', '/usr/local/bin/prime-agent', join(homedir(), '.local', 'bin', 'prime-agent'))
  for (const candidate of [...new Set(candidates)]) {
    try { await access(candidate, fsConstants.X_OK); return candidate } catch { /* continue */ }
  }
  return null
}

export function runProcess(file: string, args: readonly string[], options: {
  cwd?: string
  timeoutMs?: number
  maxBytes?: number
  env?: NodeJS.ProcessEnv
} = {}): Promise<ProcessResult> {
  if (processAdmissionClosed) return Promise.reject(new Error('Process admission is closed during shutdown'))
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? safeChildEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    activeChildren.add(child)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      terminateChild(child, 'SIGTERM')
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) terminateChild(child, 'SIGKILL') }, 2_000)
    }, timeoutMs)
    timer.unref()
    const collect = (target: Buffer[], chunk: Buffer, current: number): number => {
      const remaining = maxBytes - current
      if (remaining > 0) target.push(chunk.subarray(0, remaining))
      if (chunk.length > remaining) terminateChild(child, 'SIGTERM')
      return current + chunk.length
    }
    child.stdout.on('data', (chunk: Buffer) => { stdoutBytes = collect(stdout, chunk, stdoutBytes) })
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes = collect(stderr, chunk, stderrBytes) })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      activeChildren.delete(child)
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      activeChildren.delete(child)
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut })
    })
  })
}
