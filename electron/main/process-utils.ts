import { constants as fsConstants, realpathSync } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { delimiter, posix, win32 } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { createAdmissionQueue } from './lib/async'
import { HARNESSES, type HarnessDescriptor } from './harness'
import {
  NODE_INTERPRETER_CACHE,
  NODE_VERSION_CACHE,
  canAccessPath,
  clearNodeInterpreterCache,
  nodeVersionSatisfies,
  parseNodeEngineRange,
  parseNodeVersion,
  owningNodePackage,
  nodeCandidateExecutables,
  readFilePrefixAsync,
  compareNodeVersions,
  sharedHarnessCandidateDirs,
  type NodeVersionResult,
  versionManagerRuntimeDirs,
} from './node-interpreter-primitives'

import type { ProcessFailureReason, ProcessOutcome } from '../../src/types/api'
export { clearNodeInterpreterCache, nodeVersionSatisfies, parseNodeEngineRange, parseNodeVersion }

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

export type ExecutableCandidateFailureKind = 'missing' | 'rejected'
export interface ExecutableCandidateFailure {
  path: string
  reason: string
  kind: ExecutableCandidateFailureKind
}

/** Classifies a completed subprocess: overflow, then timeout, then exit status. */
export function processFailureReason(result: ProcessResult): Exclude<ProcessFailureReason, 'blocked'> | undefined {
  if (result.outputExceeded) return 'overflow'
  if (result.timedOut) return 'timeout'
  if (result.code !== 0) return 'exit'
  return undefined
}

/** Folds a ProcessResult into the shared `{ ok, output, reason }` outcome shape. */
export function processOutcome(result: ProcessResult, output: string): ProcessOutcome {
  const reason = processFailureReason(result)
  return reason ? { ok: false, output, reason } : { ok: true, output }
}

const PROCESS_CONCURRENCY_LIMIT = 8
const PROCESS_QUEUE_LIMIT = 64

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

/**
 * Makes an absolute executable's own directory available to `/usr/bin/env`
 * shebangs without evaluating a shell profile. Finder-launched macOS apps get
 * a minimal PATH, while npm-installed Pi-family CLIs commonly use
 * `#!/usr/bin/env node` with `node` beside the CLI shim.
 */
export function executableChildEnvironment(
  executable: string,
  env: NodeJS.ProcessEnv = safeChildEnvironment(),
  platform = process.platform,
): NodeJS.ProcessEnv {
  const result = { ...env }
  if (!isAbsolutePathForPlatform(executable, platform)) return result
  const pathApi = platform === 'win32' ? win32 : posix
  const pathKey = platform === 'win32' && result.Path !== undefined ? 'Path' : 'PATH'
  const executableDirectory = pathApi.dirname(executable)
  const separator = platform === 'win32' ? ';' : delimiter
  const homeValue = platform === 'win32' ? result.USERPROFILE : result.HOME
  const home = homeValue && isAbsolutePathForPlatform(homeValue, platform) ? homeValue : homedir()
  const directories = [
    executableDirectory,
    ...versionManagerRuntimeDirs(result, platform, home),
    ...sharedHarnessCandidateDirs(result, platform, home),
    ...(result[pathKey] ?? '').split(separator),
  ]
  const seen = new Set<string>()
  result[pathKey] = directories.filter((directory) => {
    if (!directory) return false
    const key = platform === 'win32' ? directory.toLowerCase() : directory
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).join(separator)
  return result
}

export interface ExecutableSpawnInvocation {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export class NodeInterpreterResolutionError extends Error {
  constructor(readonly detail: string) {
    super(detail)
  }
}

function lookupNodeInterpreter(resolvedFile: string): string | undefined {
  const cached = NODE_INTERPRETER_CACHE.get(resolvedFile)
  if (!cached) return undefined
  if (typeof cached !== 'string') throw new NodeInterpreterResolutionError(cached.error)
  return cached
}

export interface PrepareExecutableSpawnOptions {
  platform?: NodeJS.Platform
  home?: string
  canAccess?: (candidate: string, mode: number) => boolean
}

/**
 * Resolves the official Windows npm Pi shim without running cmd.exe. npm puts
 * the package entry point below the shim directory, so GooeyPi can invoke that
 * fixed JavaScript file with a validated Node executable and keep shell=false.
 */
export function prepareExecutableSpawn(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = safeChildEnvironment(),
  options: PrepareExecutableSpawnOptions = {},
): ExecutableSpawnInvocation {
  const platform = options.platform ?? process.platform
  const childEnvironment = executableChildEnvironment(file, env, platform)
  if (platform !== 'win32' || win32.basename(file).toLowerCase() !== 'pi.cmd') {
    if (platform === 'win32') return { file, args: [...args], env: childEnvironment }
    let resolvedFile: string
    try {
      resolvedFile = realpathSync(file)
    } catch {
      return { file, args: [...args], env: childEnvironment }
    }
    const node = lookupNodeInterpreter(resolvedFile)
    return node ? { file: node, args: [resolvedFile, ...args], env: childEnvironment } : { file, args: [...args], env: childEnvironment }
  }

  const canAccess = options.canAccess ?? canAccessPath
  const entrypoint = win32.join(win32.dirname(file), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
  if (!canAccess(entrypoint, fsConstants.F_OK)) throw new Error('The Pi npm command shim does not point to an official Pi installation')
  const homeValue = options.home ?? childEnvironment.USERPROFILE
  const home = homeValue && win32.isAbsolute(homeValue) ? homeValue : homedir()
  const pathDirectories = [childEnvironment.Path, childEnvironment.PATH]
    .flatMap((value) => (value ?? '').split(';'))
    .filter((directory) => Boolean(directory && win32.isAbsolute(directory)))
  const nodeDirectories = [
    win32.dirname(file),
    ...versionManagerRuntimeDirs(childEnvironment, platform, home),
    ...pathDirectories,
    childEnvironment.ProgramFiles ? win32.join(childEnvironment.ProgramFiles, 'nodejs') : '',
    childEnvironment.LOCALAPPDATA ? win32.join(childEnvironment.LOCALAPPDATA, 'Programs', 'nodejs') : '',
  ]
  const seen = new Set<string>()
  const node = nodeDirectories
    .filter((directory) => {
      const key = directory.toLowerCase()
      if (!directory || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((directory) => win32.join(directory, 'node.exe'))
    .find((candidate) => canAccess(candidate, fsConstants.X_OK))
  if (!node) throw new Error('Node.js was not found for the Pi npm command shim')
  return { file: node, args: [entrypoint, ...args], env: childEnvironment }
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

export function harnessExecutableCandidates(
  descriptor: HarnessDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  configuredPath?: string,
  home = homedir(),
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix
  const executable = descriptor.executableName(platform)
  const executableNames = platform === 'win32' && descriptor.id === 'pi' ? [executable, 'pi.cmd'] : [executable]
  const candidates: string[] = []
  if (configuredPath && isAbsolutePathForPlatform(configuredPath, platform)) candidates.push(configuredPath)
  const configured = env[descriptor.binaryEnvVar]
  if (configured && isAbsolutePathForPlatform(configured, platform)) candidates.push(configured)
  if (typeof process.resourcesPath === 'string') {
    for (const segments of descriptor.bundledResourceDirs) candidates.push(pathApi.join(process.resourcesPath, ...segments, executable))
  }
  const pathValues = platform === 'win32' ? [env.Path, env.PATH] : [env.PATH]
  for (const directory of pathValues.flatMap((value) => (value ?? '').split(platform === 'win32' ? ';' : delimiter))) {
    if (directory && isAbsolutePathForPlatform(directory, platform)) {
      for (const name of executableNames) candidates.push(pathApi.join(directory, name))
    }
  }
  // Electron E2E fixtures must not silently connect to a developer machine's
  // globally installed harnesses after an explicit fixture binary disappears.
  const fallbackDirs = env.PRIME_WORK_E2E_HIDE_WINDOWS === '1' ? [] : [
    ...descriptor.candidateDirs(platform, home, env),
    ...sharedHarnessCandidateDirs(env, platform, home),
  ]
  for (const directory of fallbackDirs) {
    if (directory && isAbsolutePathForPlatform(directory, platform)) {
      for (const name of executableNames) candidates.push(pathApi.join(directory, name))
    }
  }
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Bounded, shell-free discovery for version-manager installs outside a desktop app's PATH. */
export async function versionManagerHarnessExecutableCandidates(
  descriptor: HarnessDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  home = homedir(),
): Promise<string[]> {
  if (platform === 'win32' || env.PRIME_WORK_E2E_HIDE_WINDOWS === '1') return []
  return versionManagerRuntimeDirs(env, platform, home)
    .map((directory) => posix.join(directory, descriptor.executableName(platform)))
}

export async function findHarnessExecutable(
  descriptor: HarnessDescriptor,
  configuredPath?: string,
  accept: (candidate: string) => Promise<boolean> = async () => true,
  onFailure?: (failure: ExecutableCandidateFailure) => void,
): Promise<string | null> {
  const candidates = [
    ...harnessExecutableCandidates(descriptor, process.env, process.platform, configuredPath),
    ...await versionManagerHarnessExecutableCandidates(descriptor),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK)
      if (await accept(candidate)) return candidate
      onFailure?.({ path: candidate, reason: 'probe failed', kind: 'rejected' })
    } catch {
      try {
        await access(candidate, fsConstants.F_OK)
        onFailure?.({ path: candidate, reason: 'not executable', kind: 'rejected' })
      } catch {
        onFailure?.({ path: candidate, reason: 'path does not exist', kind: 'missing' })
      }
    }
  }
  return null
}

export type ExecutableSource = string | null | (() => string | null)

/** Resolves a startup-fixed path or a live discovery-backed executable source. */
export function resolveExecutable(source: ExecutableSource): string | null {
  return typeof source === 'function' ? source() : source
}

export function primeAgentExecutableName(platform = process.platform): string {
  return HARNESSES.prime.executableName(platform)
}

export function primeAgentCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  return harnessExecutableCandidates(HARNESSES.prime, env, platform)
}

export async function findPrimeAgent(): Promise<string | null> {
  return findHarnessExecutable(HARNESSES.prime)
}

const NODE_VERSION_TIMEOUT_MS = 2_000
const NODE_VERSION_OUTPUT_BYTES = 1_024
const NODE_INTERPRETER_PROBE_LIMIT = 12
const NODE_SHEBANG_BYTES = 4 * 1024

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

  const environment = options.env ?? safeChildEnvironment()
  const startProcess = (invocation: ExecutableSpawnInvocation): Promise<ProcessResult> => processAdmission.run(() => new Promise((resolve, reject) => {
    const child = spawn(invocation.file, invocation.args, {
      cwd: options.cwd,
      env: invocation.env,
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
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      finish()
      reject(error)
    }
    child.once('error', fail)
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
  }))
  return prepareExecutableSpawnAsync(file, args, environment).then(startProcess)
}

async function nodeVersion(candidate: string, env: NodeJS.ProcessEnv): Promise<NodeVersionResult | null> {
  const key = await realpath(candidate)
  const cached = NODE_VERSION_CACHE.get(key)
  if (cached !== undefined) return cached
  const result = await runProcess(key, ['--version'], {
    env,
    timeoutMs: NODE_VERSION_TIMEOUT_MS,
    maxBytes: NODE_VERSION_OUTPUT_BYTES,
  })
  const trimmed = result.stdout.trim()
  const parsed = parseNodeVersion(trimmed)
  const version = parsed ? { text: trimmed, parsed } : null
  NODE_VERSION_CACHE.set(key, version)
  return version
}

export async function resolveNodeInterpreter(
  script: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): Promise<string | undefined> {
  if (platform === 'win32') return undefined
  const resolvedFile = await realpath(script).catch(() => undefined)
  if (!resolvedFile) return undefined
  const cached = NODE_INTERPRETER_CACHE.get(resolvedFile)
  if (cached) {
    if (typeof cached !== 'string') throw new NodeInterpreterResolutionError(cached.error)
    return cached
  }
  const firstLine = (await readFilePrefixAsync(resolvedFile, NODE_SHEBANG_BYTES))?.split(/\r?\n/u, 1)[0]?.trim()
  const nodeShebang = firstLine?.startsWith('#!') && firstLine.match(/^#!\s*\/usr\/bin\/env(?:\s+-S)?\s+(.+)$/u)?.[1].trim().split(/\s+/u)[0] === 'node'
  if (!nodeShebang) {
    NODE_INTERPRETER_CACHE.set(resolvedFile, null)
    return undefined
  }
  const packageJson = await owningNodePackage(resolvedFile)
  const requirement = parseNodeEngineRange(packageJson.enginesNode)
  let newest: { path: string; version: NodeVersionResult } | undefined
  try {
    for (const candidate of nodeCandidateExecutables(env, platform, home).slice(0, NODE_INTERPRETER_PROBE_LIMIT)) {
      let version: NodeVersionResult | null
      try { version = await nodeVersion(candidate, env) } catch { continue }
      if (!version) continue
      if (!newest || compareNodeVersions(version.parsed, newest.version.parsed) > 0) {
        newest = { path: candidate, version }
      }
      if (!requirement || compareNodeVersions(version.parsed, requirement) >= 0) {
        const interpreter = await realpath(candidate)
        NODE_INTERPRETER_CACHE.set(resolvedFile, interpreter)
        return interpreter
      }
    }
  } catch {
    // Candidate probing failures are handled as unavailable interpreters below.
  }
  const detail = requirement
    ? `${packageJson.name ?? 'The harness'} requires Node >=${requirement.major}.${requirement.minor}.${requirement.patch}${requirement.prerelease ? `-${requirement.prerelease}` : ''}${newest ? `; the newest Node GooeyPi can find is ${newest.version.text} at ${newest.path}` : '; no working Node interpreter was found'}`
    : 'Node.js was not found for the env-node harness executable'
  NODE_INTERPRETER_CACHE.set(resolvedFile, { error: detail })
  throw new NodeInterpreterResolutionError(detail)
}

export async function prepareExecutableSpawnAsync(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = safeChildEnvironment(),
  options: PrepareExecutableSpawnOptions = {},
): Promise<ExecutableSpawnInvocation> {
  const platform = options.platform ?? process.platform
  const childEnvironment = executableChildEnvironment(file, env, platform)
  if (platform !== 'win32') {
    const home = childEnvironment.HOME && posix.isAbsolute(childEnvironment.HOME) ? childEnvironment.HOME : homedir()
    const resolutionEnvironment = {
      ...childEnvironment,
      PATH: [env.PATH, childEnvironment.PATH].filter(Boolean).join(delimiter),
    }
    await resolveNodeInterpreter(file, resolutionEnvironment, platform, home)
  }
  return prepareExecutableSpawn(file, args, env, options)
}
