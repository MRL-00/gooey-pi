import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join, posix, win32 } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { createAdmissionQueue } from './lib/async'

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
const processAdmission = createAdmissionQueue({
  maxConcurrent: PROCESS_CONCURRENCY_LIMIT,
  maxPending: PROCESS_QUEUE_LIMIT,
  pendingLimitError: () => new Error(`Process queue limit of ${PROCESS_QUEUE_LIMIT} exceeded`),
  closedError: () => new Error('Process admission is closed during shutdown'),
})
let processAdmissionClosed = false

export function beginProcessShutdown(): void {
  if (processAdmissionClosed) return
  processAdmissionClosed = true
  processAdmission.close()
}

export interface KillLadderRung {
  signal: NodeJS.Signals
  /** How long to wait for exit after this rung before escalating to the next one. */
  waitMs: number
}

export interface KillProcessTreeOptions {
  ladder: readonly KillLadderRung[]
  /** True once the target process exited; consulted before every escalation. */
  hasExited?: () => boolean
  /** Waits up to timeoutMs and resolves true when the process exits earlier. Defaults to a plain delay. */
  waitForExit?: (timeoutMs: number) => Promise<boolean>
  /** Extra direct signal for handles that own the process (for example a pty). Defaults to signalling the PID. */
  signalDirect?: (signal: NodeJS.Signals) => void
  /** Descendant PIDs signalled alongside the process group; needed when children detach from it (POSIX only). */
  descendants?: readonly number[]
  /** Test seams. */
  platform?: NodeJS.Platform
  runTaskkill?: (pid: number) => Promise<void>
}

const delay = (milliseconds: number) => new Promise<void>((resolveDelay) => {
  const timer = setTimeout(resolveDelay, milliseconds)
  timer.unref()
})

/** Force-kills a Windows process tree; bounded, awaited, and never throws. */
function runWindowsTaskkill(pid: number): Promise<void> {
  return new Promise((resolveKill) => {
    let child: ChildProcess
    try {
      child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
    } catch { resolveKill(); return }
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveKill()
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* taskkill already exited */ }
      finish()
    }, 5_000)
    timer.unref()
    child.once('error', finish)
    child.once('close', finish)
  })
}

/**
 * The one process-tree terminator: walks the signal ladder over the process
 * group (plus any explicitly listed detached descendants) until the target
 * exits. On win32 there is no graceful tier, so the whole ladder collapses
 * into a single awaited, bounded `taskkill /pid <pid> /T /F`.
 * Resolves true once the target is known to have exited (always true when no
 * exit observer is provided).
 */
export async function killProcessTree(pid: number, options: KillProcessTreeOptions): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const waitForExit = options.waitForExit ?? (async (timeoutMs: number) => { await delay(timeoutMs); return options.hasExited?.() ?? false })
  if (platform === 'win32') {
    await (options.runTaskkill ?? runWindowsTaskkill)(pid)
    try { options.signalDirect?.('SIGKILL') } catch { /* already exited */ }
    if (!options.hasExited) return true
    if (options.hasExited()) return true
    const budget = options.ladder.reduce((total, rung) => total + rung.waitMs, 0)
    return budget > 0 ? waitForExit(budget) : options.hasExited()
  }
  const signalTree = (signal: NodeJS.Signals): void => {
    for (const descendant of options.descendants ?? []) {
      try { process.kill(descendant, signal) } catch { /* already exited */ }
    }
    try { process.kill(-pid, signal) } catch { /* no process group */ }
    try {
      if (options.signalDirect) options.signalDirect(signal)
      else process.kill(pid, signal)
    } catch { /* already exited */ }
  }
  for (const rung of options.ladder) {
    if (options.hasExited?.()) return true
    signalTree(rung.signal)
    if (rung.waitMs > 0 && await waitForExit(rung.waitMs)) return true
  }
  return options.hasExited?.() ?? true
}

/** Resolves true when the child exits within timeoutMs (immediately when it already has). */
export function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveWait) => {
    const onClose = (): void => {
      clearTimeout(timer)
      resolveWait(true)
    }
    const timer = setTimeout(() => {
      child.removeListener('close', onClose)
      resolveWait(false)
    }, timeoutMs)
    timer.unref()
    child.once('close', onClose)
  })
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    try { child.kill(signal) } catch { /* already exited */ }
    return
  }
  void killProcessTree(child.pid, {
    ladder: [{ signal, waitMs: 0 }],
    signalDirect: (rungSignal) => child.kill(rungSignal),
  })
}

function waitForChildren(children: ChildProcess[], timeoutMs: number): Promise<void> {
  return Promise.all(children.map((child) => waitForProcessExit(child, timeoutMs))).then(() => undefined)
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

  return processAdmission.run(() => new Promise((resolve, reject) => {
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
    }
    child.once('error', (error) => {
      if (settled) return
      settled = true
      finish()
      reject(error)
    })
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
  }))
}
