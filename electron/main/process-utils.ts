import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join, posix, win32 } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'

export interface ProcessResult {
  code: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputExceeded: boolean
  stdoutBytes: number
  stderrBytes: number
}

export const PROCESS_CONCURRENCY_LIMIT = 8
export const PROCESS_QUEUE_LIMIT = 64

const PROCESS_INPUT_LIMIT = 4 * 1024 * 1024
const activeChildren = new Set<ChildProcess>()
const pendingAdmissions: Array<{ start: () => void; reject: (error: Error) => void }> = []
let processAdmissionClosed = false

export function beginProcessShutdown(): void {
  if (processAdmissionClosed) return
  processAdmissionClosed = true
  const error = new Error('Process admission is closed during shutdown')
  for (const pending of pendingAdmissions.splice(0)) pending.reject(error)
}

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

function drainProcessQueue(): void {
  if (processAdmissionClosed) {
    const error = new Error('Process admission is closed during shutdown')
    for (const pending of pendingAdmissions.splice(0)) pending.reject(error)
    return
  }
  while (activeChildren.size < PROCESS_CONCURRENCY_LIMIT) {
    const pending = pendingAdmissions.shift()
    if (!pending) return
    pending.start()
  }
}

export async function stopChildProcesses(): Promise<void> {
  // Close admission (including queued work) before taking the snapshot so no
  // later one-shot child can escape cleanup.
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

export function restrictedGitEnvironment(): NodeJS.ProcessEnv {
  // Git is invoked for repository-derived work, so inherit only process-location
  // values rather than credentials, provider tokens, signing agents, or Git's
  // many environment-based configuration injection mechanisms.
  const env: NodeJS.ProcessEnv = {
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  }
  for (const key of process.platform === 'win32'
    ? ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export function isAbsolutePathForPlatform(value: string, platform = process.platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value)
}

export function primeAgentExecutableName(platform = process.platform): string {
  return platform === 'win32' ? 'prime-agent.exe' : 'prime-agent'
}

export function primeAgentCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const pathApi = platform === 'win32' ? win32 : posix
  const executable = primeAgentExecutableName(platform)
  const candidates: string[] = []
  if (env.PRIME_AGENT_BINARY && isAbsolutePathForPlatform(env.PRIME_AGENT_BINARY, platform)) candidates.push(env.PRIME_AGENT_BINARY)
  if (typeof process.resourcesPath === 'string') {
    candidates.push(pathApi.join(process.resourcesPath, 'agent', executable))
    candidates.push(pathApi.join(process.resourcesPath, 'agent', 'bin', executable))
  }
  for (const directory of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (directory && isAbsolutePathForPlatform(directory, platform)) candidates.push(pathApi.join(directory, executable))
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    if (localAppData && isAbsolutePathForPlatform(localAppData, platform)) candidates.push(pathApi.join(localAppData, 'Programs', 'Prime Agent', executable))
  } else {
    candidates.push('/opt/homebrew/bin/prime-agent', '/usr/local/bin/prime-agent', join(homedir(), '.local', 'bin', executable))
  }
  return [...new Set(candidates)]
}

export async function findPrimeAgent(): Promise<string | null> {
  const candidates = primeAgentCandidates()
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
  input?: string
} = {}): Promise<ProcessResult> {
  if (processAdmissionClosed) return Promise.reject(new Error('Process admission is closed during shutdown'))
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new TypeError('timeoutMs must be positive'))
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return Promise.reject(new TypeError('maxBytes must be a positive safe integer'))
  if (options.input !== undefined && Buffer.byteLength(options.input) > PROCESS_INPUT_LIMIT) {
    return Promise.reject(new TypeError(`process input must not exceed ${PROCESS_INPUT_LIMIT} bytes`))
  }

  return new Promise((resolve, reject) => {
    const start = (): void => {
      if (processAdmissionClosed) { reject(new Error('Process admission is closed during shutdown')); return }
      const child = spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env ?? safeChildEnvironment(),
        shell: false,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
      activeChildren.add(child)
      if (options.input !== undefined) child.stdin?.on('error', () => { /* child close/error reports the process result */ })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let capturedBytes = 0
      let timedOut = false
      let outputExceeded = false
      let settled = false
      let limitKillTimer: NodeJS.Timeout | undefined
      const timer = setTimeout(() => {
        timedOut = true
        terminateChild(child, 'SIGTERM')
        limitKillTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) terminateChild(child, 'SIGKILL')
        }, 2_000)
        limitKillTimer.unref()
      }, timeoutMs)
      timer.unref()

      const exceedOutputLimit = (): void => {
        if (outputExceeded) return
        outputExceeded = true
        terminateChild(child, 'SIGTERM')
        // Output limits need their own short escalation rather than waiting for
        // the operation timeout while a producer ignores TERM.
        if (limitKillTimer) clearTimeout(limitKillTimer)
        limitKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) terminateChild(child, 'SIGKILL')
        }, 500)
        limitKillTimer.unref()
      }
      const collect = (target: Buffer[], chunk: Buffer): void => {
        const remaining = maxBytes - capturedBytes
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining)
          target.push(retained)
          capturedBytes += retained.length
        }
        if (chunk.length > remaining) exceedOutputLimit()
      }
      child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; collect(stdout, chunk) })
      child.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; collect(stderr, chunk) })

      const finish = (): void => {
        activeChildren.delete(child)
        clearTimeout(timer)
        if (limitKillTimer) clearTimeout(limitKillTimer)
        drainProcessQueue()
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        finish()
        reject(error)
      }
      child.once('error', fail)
      // Read-pipe errors (EPIPE/ECONNRESET from a killed child) would otherwise be
      // uncaught 'error' events that crash the main process.
      const failPipe = (error: Error): void => {
        if (settled) return
        terminateChild(child, 'SIGTERM')
        fail(error)
      }
      child.stdout?.on('error', failPipe)
      child.stderr?.on('error', failPipe)
      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        finish()
        resolve({
          code: code ?? -1,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          outputExceeded,
          stdoutBytes,
          stderrBytes,
        })
      })
      if (options.input !== undefined) child.stdin?.end(options.input)
    }

    if (activeChildren.size < PROCESS_CONCURRENCY_LIMIT) start()
    else if (pendingAdmissions.length >= PROCESS_QUEUE_LIMIT) reject(new Error(`Process queue limit of ${PROCESS_QUEUE_LIMIT} exceeded`))
    else pendingAdmissions.push({ start, reject })
  })
}
