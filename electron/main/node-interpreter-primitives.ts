import { accessSync, constants as fsConstants, readdirSync } from 'node:fs'
import { open as openAsync } from 'node:fs/promises'
import { delimiter, posix, win32 } from 'node:path'

export interface NodeVersion {
  major: number
  minor: number
  patch: number
  prerelease: string | undefined
}

export interface NodeVersionResult {
  text: string
  parsed: NodeVersion
}

type NodeInterpreterMemo = string | null | { error: string }

export const NODE_VERSION_CACHE = new Map<string, NodeVersionResult | null>()
export const NODE_INTERPRETER_CACHE = new Map<string, NodeInterpreterMemo>()

const NODE_PACKAGE_BYTES = 64 * 1024

export function clearNodeInterpreterCache(): void {
  NODE_VERSION_CACHE.clear()
  NODE_INTERPRETER_CACHE.clear()
}

export function parseNodeVersion(value: string): NodeVersion | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(-([0-9A-Za-z.-]+))?$/)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[5],
  }
}

export function parseNodeEngineRange(value: unknown): NodeVersion | undefined {
  if (typeof value !== 'string') return undefined
  const range = value.trim()
  if (!range) return undefined
  const match = range.match(/^>=\s*(\d+)(?:\.(\d+)(?:\.(\d+)(?:-([0-9A-Za-z.-]+))?)?)?(?:\s+<\s*\S+)?$/)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4],
  }
}

export function compareNodeVersions(left: NodeVersion, right: NodeVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.prerelease === right.prerelease) return 0
  return left.prerelease ? -1 : 1
}

export function nodeVersionSatisfies(version: string, range: unknown): boolean {
  const parsedVersion = parseNodeVersion(version)
  if (!parsedVersion) return false
  const minimum = parseNodeEngineRange(range)
  return minimum ? compareNodeVersions(parsedVersion, minimum) >= 0 : true
}

export async function readFilePrefixAsync(path: string, maxBytes: number): Promise<string | null | undefined> {
  let handle: Awaited<ReturnType<typeof openAsync>>
  try {
    handle = await openAsync(path, 'r')
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
    return code === 'ENOENT' ? undefined : null
  }
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function owningNodePackage(script: string): Promise<{ name?: string; enginesNode?: unknown }> {
  let directory = posix.dirname(script)
  while (true) {
    const manifest = posix.join(directory, 'package.json')
    const contents = await readFilePrefixAsync(manifest, NODE_PACKAGE_BYTES)
    if (contents === undefined) {
      const parent = posix.dirname(directory)
      if (parent === directory) return {}
      directory = parent
      continue
    }
    if (contents === null) return {}
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

export function canAccessPath(candidate: string, mode: number): boolean {
  try { accessSync(candidate, mode); return true } catch { return false }
}

export function versionManagerRuntimeDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  if (platform === 'win32') {
    return [env.NVM_SYMLINK, env.NVM_HOME]
      .filter((directory): directory is string => Boolean(directory && win32.isAbsolute(directory)))
  }
  const root = env.NVM_DIR && posix.isAbsolute(env.NVM_DIR) ? env.NVM_DIR : posix.join(home, '.nvm')
  const versionsRoot = posix.join(root, 'versions', 'node')
  try {
    return readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name[0] !== '.')
      .sort((left, right) => right.name.localeCompare(left.name, 'en', { numeric: true }))
      .slice(0, 64)
      .map((entry) => posix.join(versionsRoot, entry.name, 'bin'))
  } catch { return [] }
}

export function sharedHarnessCandidateDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix
  const fromRoot = (root: string | undefined, ...segments: string[]) => root ? pathApi.join(root, ...segments) : ''
  const compact = (values: Array<string | undefined>): string[] => values.filter((value): value is string => Boolean(value))
  const environmentDirs = [
    env.NVM_BIN,
    fromRoot(env.NPM_CONFIG_PREFIX, 'bin'),
    fromRoot(env.BUN_INSTALL, 'bin'),
    fromRoot(env.VOLTA_HOME, 'bin'),
    env.PNPM_HOME,
    fromRoot(env.PNPM_HOME, 'bin'),
  ]
  if (platform === 'win32') {
    return compact([
      ...environmentDirs,
      env.NPM_CONFIG_PREFIX,
      fromRoot(env.APPDATA, 'npm'),
      fromRoot(env.LOCALAPPDATA, 'pnpm'),
      fromRoot(env.LOCALAPPDATA, 'pnpm', 'bin'),
      fromRoot(env.LOCALAPPDATA, 'mise', 'shims'),
      win32.join(home, '.bun', 'bin'),
      win32.join(home, '.volta', 'bin'),
    ])
  }
  const dataHome = env.XDG_DATA_HOME ?? posix.join(home, '.local', 'share')
  return compact([
    ...environmentDirs,
    posix.join(home, '.local', 'bin'),
    posix.join(home, '.bun', 'bin'),
    posix.join(home, '.volta', 'bin'),
    posix.join(dataHome, 'pnpm'),
    posix.join(dataHome, 'pnpm', 'bin'),
    posix.join(dataHome, 'mise', 'shims'),
    ...(platform === 'darwin'
      ? [posix.join(home, 'Library', 'pnpm'), posix.join(home, 'Library', 'pnpm', 'bin')]
      : ['/home/linuxbrew/.linuxbrew/bin']),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ])
}

export function nodeCandidateExecutables(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string[] {
  if (platform === 'win32') return []
  const directories = [
    ...(env.PATH ?? '').split(delimiter),
    ...versionManagerRuntimeDirs(env, platform, home),
    ...sharedHarnessCandidateDirs(env, platform, home),
  ]
  return [...new Set(directories
    .filter((directory) => directory && posix.isAbsolute(directory))
    .map((directory) => posix.join(directory, 'node')))]
    .filter((candidate) => canAccessPath(candidate, fsConstants.X_OK))
}
