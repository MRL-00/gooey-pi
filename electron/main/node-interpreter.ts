import { constants as fsConstants } from 'node:fs'
import { access, open as openAsync, realpath as realpathAsync } from 'node:fs/promises'
import { delimiter, posix } from 'node:path'

const NODE_SHEBANG_BYTES = 4 * 1024
const NODE_PACKAGE_BYTES = 64 * 1024
const NODE_VERSION_TIMEOUT_MS = 2_000
const NODE_VERSION_OUTPUT_BYTES = 1_024

interface NodeVersion {
  major: number
  minor: number
  patch: number
  prerelease: string | undefined
}

interface NodeVersionResult {
  text: string
  parsed: NodeVersion
}

type NodeInterpreterMemo =
  | { interpreter: string }
  | { error: string }

type ResolveOptions = [
  nodeVersionCache: Map<string, NodeVersionResult | null>,
  nodeInterpreterCache: Map<string, NodeInterpreterMemo>,
  nodeShebangCache: Map<string, boolean>,
  runProcess: (
    file: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number },
  ) => Promise<{ stdout: string }>,
  parseNodeVersion: (value: string) => NodeVersion | undefined,
  parseNodeEngineRange: (value: unknown) => NodeVersion | undefined,
  compareNodeVersions: (left: NodeVersion, right: NodeVersion) => number,
  versionManagerRuntimeDirs: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string) => string[],
  sharedHarnessCandidateDirs: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string) => string[],
  canAccessPath: (candidate: string, mode: number) => boolean,
  createError: (detail: string) => Error,
]

async function readFilePrefix(path: string, maxBytes: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof openAsync>>
  try {
    handle = await openAsync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function nodeShebangTarget(
  path: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const cached = cache.get(path)
  if (cached !== undefined) return cached
  const firstLine = (await readFilePrefix(path, NODE_SHEBANG_BYTES))?.split(/\r?\n/u, 1)[0]?.trim()
  if (!firstLine?.startsWith('#!')) {
    cache.set(path, false)
    return false
  }
  const match = firstLine.match(/^#!\s*\/usr\/bin\/env(?:\s+-S)?\s+(.+)$/u)
  const result = match?.[1].trim().split(/\s+/u)[0] === 'node'
  cache.set(path, result)
  return result
}

async function owningNodePackage(script: string): Promise<{ name?: string; enginesNode?: unknown }> {
  let directory = posix.dirname(script)
  while (true) {
    const manifest = posix.join(directory, 'package.json')
    try {
      await access(manifest, fsConstants.F_OK)
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
      if (code !== 'ENOENT') return {}
      const parent = posix.dirname(directory)
      if (parent === directory) return {}
      directory = parent
      continue
    }
    const contents = await readFilePrefix(manifest, NODE_PACKAGE_BYTES)
    if (contents === undefined) return {}
    let value: unknown
    try { value = JSON.parse(contents) } catch { return {} }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const packageJson = value as { name?: unknown; engines?: unknown }
    const engines = packageJson.engines && typeof packageJson.engines === 'object' && !Array.isArray(packageJson.engines)
      ? packageJson.engines as { node?: unknown }
      : undefined
    return {
      name: typeof packageJson.name === 'string' ? packageJson.name : undefined,
      enginesNode: engines?.node,
    }
  }
}

function interpreterFailure(
  packageJson: { name?: string; enginesNode?: unknown },
  requirement: NodeVersion | undefined,
  newest: { path: string; version: NodeVersionResult } | undefined,
): string {
  if (requirement) {
    const newestText = newest
      ? `; the newest Node GooeyPi can find is ${newest.version.text} at ${newest.path}`
      : '; no working Node interpreter was found'
    const label = packageJson.name ?? 'The harness'
    return `${label} requires Node >=${nodeRequirementText(requirement)}${newestText}`
  }
  return 'Node.js was not found for the env-node harness executable'
}

function nodeRequirementText(requirement: NodeVersion): string {
  const version = `${requirement.major}.${requirement.minor}.${requirement.patch}`
  return requirement.prerelease ? `${version}-${requirement.prerelease}` : version
}

async function nodeVersion(
  candidate: string,
  env: NodeJS.ProcessEnv,
  options: ResolveOptions,
): Promise<NodeVersionResult | null> {
  const [nodeVersionCache, , , runProcess, parseNodeVersion] = options
  const key = await realpathAsync(candidate)
  const cached = nodeVersionCache.get(key)
  if (nodeVersionCache.has(key)) return cached ?? null
  const result = await runProcess(key, ['--version'], {
    env,
    timeoutMs: NODE_VERSION_TIMEOUT_MS,
    maxBytes: NODE_VERSION_OUTPUT_BYTES,
  })
  const trimmed = result.stdout.trim()
  const parsed = parseNodeVersion(trimmed)
  const version = parsed ? { text: trimmed, parsed } : null
  nodeVersionCache.set(key, version)
  return version
}

function nodeCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  preferredPath: string | undefined,
  versionManagerRuntimeDirs: ResolveOptions[7],
  sharedHarnessCandidateDirs: ResolveOptions[8],
  canAccessPath: ResolveOptions[9],
): string[] {
  if (platform === 'win32') return []
  const directories = [
    ...(preferredPath ?? env.PATH ?? '').split(delimiter),
    ...(env.PATH ?? '').split(delimiter),
    ...versionManagerRuntimeDirs(env, platform, home),
    ...sharedHarnessCandidateDirs(env, platform, home),
  ]
  const seen = new Set<string>()
  return directories
    .filter((directory) => directory && posix.isAbsolute(directory))
    .map((directory) => posix.join(directory, 'node'))
    .filter((candidate) => {
      if (seen.has(candidate)) return false
      seen.add(candidate)
      return canAccessPath(candidate, fsConstants.X_OK)
    })
}

export async function resolveNodeInterpreter(
  script: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  preferredPath: string | undefined,
  options: ResolveOptions,
): Promise<string | undefined> {
  const [nodeVersionCache, nodeInterpreterCache, nodeShebangCache, runProcess, parseNodeVersion, parseNodeEngineRange, compareNodeVersions, versionManagerRuntimeDirs, sharedHarnessCandidateDirs, canAccessPath, createError] = options
  if (platform === 'win32') return undefined
  const resolvedFile = await realpathAsync(script).catch(() => undefined)
  if (!resolvedFile || !(await nodeShebangTarget(resolvedFile, nodeShebangCache))) return undefined
  const cached = nodeInterpreterCache.get(resolvedFile)
  if (cached) {
    if ('error' in cached) throw createError(cached.error)
    return cached.interpreter
  }
  const packageJson = await owningNodePackage(resolvedFile)
  const requirement = parseNodeEngineRange(packageJson.enginesNode)
  let newest: { path: string; version: NodeVersionResult } | undefined
  try {
    for (const candidate of nodeCandidates(env, platform, home, preferredPath, versionManagerRuntimeDirs, sharedHarnessCandidateDirs, canAccessPath).slice(0, 12)) {
      let version: NodeVersionResult | null
      try { version = await nodeVersion(candidate, env, [nodeVersionCache, nodeInterpreterCache, nodeShebangCache, runProcess, parseNodeVersion, parseNodeEngineRange, compareNodeVersions, versionManagerRuntimeDirs, sharedHarnessCandidateDirs, canAccessPath, createError]) } catch { continue }
      if (!version) continue
      if (!newest || compareNodeVersions(version.parsed, newest.version.parsed) > 0) {
        newest = { path: candidate, version }
      }
      if (!requirement || compareNodeVersions(version.parsed, requirement) >= 0) {
        const interpreter = await realpathAsync(candidate)
        nodeInterpreterCache.set(resolvedFile, { interpreter })
        return interpreter
      }
    }
  } catch {
    // Candidate probing failures are handled as unavailable interpreters below.
  }
  const detail = interpreterFailure(packageJson, requirement, newest)
  nodeInterpreterCache.set(resolvedFile, { error: detail })
  throw createError(detail)
}
