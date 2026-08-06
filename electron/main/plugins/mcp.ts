import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync } from 'node:fs'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpConnectionInput } from '../../../src/types/api'
import { isPathWithin, isRecord, requireString } from '../validation'
import { errorCode, readAtMost } from './file-io'

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
const SETTINGS_LOCK_ATTEMPTS = 40
const SETTINGS_LOCK_RETRY_MS = 50
const SETTINGS_LOCK_OWNER = 'owner.json'
const SETTINGS_UPDATE_ATTEMPTS = 4

interface SettingsLockOwner {
  version: 1
  pid: number
  token: string
  createdAt: number
}

type FingerprintSettings = (path: string) => Promise<string>

export interface ProjectSettingsPath {
  path: string
  verify(): void
}

function parseSettingsLockOwner(value: unknown): SettingsLockOwner | null {
  if (!isRecord(value) || value.version !== 1) return null
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return null
  if (typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 200) return null
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt <= 0) return null
  return { version: 1, pid: value.pid as number, token: value.token, createdAt: value.createdAt }
}

function sameSettingsLockOwner(left: SettingsLockOwner | null, right: SettingsLockOwner): boolean {
  return left?.version === right.version && left.pid === right.pid && left.token === right.token && left.createdAt === right.createdAt
}

async function readSettingsForUpdate(path: string): Promise<{ settings: Record<string, unknown>; fingerprint: string; source: string | null }> {
  let content: string
  try {
    const value = await readAtMost(path, MAX_SETTINGS_BYTES)
    if (value.truncated) throw new TypeError('Prime Agent settings exceed the maximum supported size')
    content = value.content
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { settings: {}, fingerprint: 'missing', source: null }
    if (error instanceof TypeError && error.message.includes('maximum supported size')) throw error
    throw new TypeError('Prime Agent settings are not valid JSON; fix them before connecting an MCP server')
  }
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new TypeError('Prime Agent settings are not valid JSON; fix them before connecting an MCP server') }
  if (!isRecord(value)) throw new TypeError('Prime Agent settings must contain a JSON object')
  return { settings: value, fingerprint: createHash('sha256').update(content).digest('hex'), source: content }
}

export async function settingsFingerprint(path: string): Promise<string> {
  try {
    const value = await readAtMost(path, MAX_SETTINGS_BYTES)
    if (value.truncated) throw new TypeError('Prime Agent settings exceed the maximum supported size')
    return createHash('sha256').update(value.content).digest('hex')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
    throw error
  }
}

async function readSettingsLockOwner(lockPath: string): Promise<SettingsLockOwner | null> {
  try {
    const { content, truncated } = await readAtMost(join(lockPath, SETTINGS_LOCK_OWNER), 4 * 1024)
    if (truncated) return null
    return parseSettingsLockOwner(JSON.parse(content) as unknown)
  } catch { return null }
}

function isProcessProvablyDead(pid: number): boolean {
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return errorCode(error) === 'ESRCH'
  }
}

async function createSettingsLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  try {
    await mkdir(lockPath, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null
    throw error
  }

  const owner: SettingsLockOwner = { version: 1, pid: process.pid, token: randomUUID(), createdAt: Date.now() }
  try {
    await writeFile(join(lockPath, SETTINGS_LOCK_OWNER), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true })
    throw error
  }
  return async () => {
    const current = await readSettingsLockOwner(lockPath)
    if (sameSettingsLockOwner(current, owner)) await rm(lockPath, { recursive: true, force: true })
  }
}

async function recoverStaleSettingsLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  const observed = await readSettingsLockOwner(lockPath)
  if (!observed || !isProcessProvablyDead(observed.pid)) return null

  // The recovery directory serializes competing reapers. The owner is checked
  // again after claiming it, so a replacement lock is never removed by token.
  const recoveryPath = `${lockPath}.recovery`
  try {
    await mkdir(recoveryPath, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null
    throw error
  }
  try {
    const current = await readSettingsLockOwner(lockPath)
    if (!sameSettingsLockOwner(current, observed) || !isProcessProvablyDead(observed.pid)) return null
    await rm(lockPath, { recursive: true, force: true })
    return await createSettingsLock(lockPath)
  } finally {
    await rm(recoveryPath, { recursive: true, force: true })
  }
}

export async function acquireSettingsLock(settingsPath: string, verify?: () => void): Promise<() => Promise<void>> {
  if (verify) verify()
  else await mkdir(dirname(settingsPath), { recursive: true })
  const lockPath = `${settingsPath}.lock`
  for (let attempt = 0; attempt < SETTINGS_LOCK_ATTEMPTS; attempt += 1) {
    verify?.()
    const acquired = await createSettingsLock(lockPath)
    if (acquired) {
      try { verify?.(); return acquired } catch (error) { await acquired(); throw error }
    }
    const recovered = await recoverStaleSettingsLock(lockPath)
    if (recovered) {
      try { verify?.(); return recovered } catch (error) { await recovered(); throw error }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, SETTINGS_LOCK_RETRY_MS))
  }
  throw new Error('Prime Agent settings are busy; try again')
}

interface FileIdentity {
  dev: string
  ino: string
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function regularFileIdentity(path: string): Promise<FileIdentity> {
  const stat = await lstat(path, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isFile()) throw new TypeError('Prime Agent settings staging file changed during update')
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

async function removeOwnedFile(path: string, expected: FileIdentity): Promise<boolean> {
  try {
    if (!sameFileIdentity(await regularFileIdentity(path), expected)) return false
    await rm(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function rollbackSettingsRename(
  path: string,
  temporary: string,
  temporaryIdentity: FileIdentity,
  backup: string,
  backupIdentity: FileIdentity | null,
): Promise<void> {
  if (!sameFileIdentity(await regularFileIdentity(path), temporaryIdentity)) {
    throw new Error('The staged settings file could not be located for rollback')
  }
  if (backupIdentity) {
    if (!sameFileIdentity(await regularFileIdentity(backup), backupIdentity)) {
      throw new Error('The original settings backup could not be located for rollback')
    }
    await rename(backup, path)
    if (!sameFileIdentity(await regularFileIdentity(path), backupIdentity)) throw new Error('The original settings backup was not restored')
    return
  }
  await rename(path, temporary)
  if (!sameFileIdentity(await regularFileIdentity(temporary), temporaryIdentity)) throw new Error('The new settings file was not removed')
}

async function writeSettingsAtomically(
  path: string,
  settings: Record<string, unknown>,
  expectedFingerprint: string,
  source: string | null,
  fingerprint: FingerprintSettings,
  verify?: () => void,
): Promise<boolean> {
  const token = `${process.pid}.${randomUUID()}`
  const temporary = `${path}.${token}.tmp`
  const backup = `${path}.${token}.bak`
  let temporaryIdentity: FileIdentity | null = null
  let backupIdentity: FileIdentity | null = null
  let renamed = false
  try {
    verify?.()
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    temporaryIdentity = await regularFileIdentity(temporary)
    if (source !== null) {
      await writeFile(backup, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      backupIdentity = await regularFileIdentity(backup)
    }
    // Both recovery files must have been staged in the still-pinned directory.
    verify?.()
    if (await fingerprint(path) !== expectedFingerprint) return false
    verify?.()
    if (!sameFileIdentity(await regularFileIdentity(temporary), temporaryIdentity)) {
      throw new TypeError('Prime Agent settings staging file changed during update')
    }
    if (backupIdentity && !sameFileIdentity(await regularFileIdentity(backup), backupIdentity)) {
      throw new TypeError('Prime Agent settings backup changed during update')
    }
    // There is no renameat-style API in Node on macOS. Keep this synchronous
    // verification immediately adjacent to rename, then prove which inode won.
    verify?.()
    // Invoke the final filesystem operation synchronously so no libuv worker-pool
    // admission window separates the identity check from the rename syscall.
    renameSync(temporary, path)
    renamed = true
    if (!sameFileIdentity(await regularFileIdentity(path), temporaryIdentity)) {
      throw new TypeError('Prime Agent settings target changed during update')
    }
    verify?.()
    if (backupIdentity && !await removeOwnedFile(backup, backupIdentity)) {
      throw new TypeError('Prime Agent settings backup changed during update')
    }
    backupIdentity = null
    return true
  } catch (error) {
    if (renamed && temporaryIdentity) {
      try {
        await rollbackSettingsRename(path, temporary, temporaryIdentity, backup, backupIdentity)
        renamed = false
      } catch (rollbackError) {
        const message = error instanceof Error ? error.message : 'Prime Agent settings update failed'
        throw new AggregateError([error, rollbackError], `${message}; settings rollback could not be completed`)
      }
    }
    throw error
  } finally {
    if (!renamed && temporaryIdentity) await removeOwnedFile(temporary, temporaryIdentity).catch(() => false)
    if (backupIdentity) await removeOwnedFile(backup, backupIdentity).catch(() => false)
  }
}

export function validateMcpConnection(value: unknown): McpConnectionInput {
  if (!isRecord(value)) throw new TypeError('MCP connection must be an object')
  const name = requireString(value.name, 'MCP server name', { min: 1, max: 64, trim: true })
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new TypeError('MCP server name contains unsupported characters')
  const scope = value.scope
  if (scope !== 'user' && scope !== 'project') throw new TypeError('MCP scope must be user or project')
  const projectPath = scope === 'project' ? requireString(value.projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
  if (value.type === 'http') {
    const urlValue = requireString(value.url, 'MCP server URL', { min: 1, max: 2_048, trim: true })
    let url: URL
    try { url = new URL(urlValue) } catch { throw new TypeError('MCP server URL is invalid') }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('MCP server URL must use http or https')
    if (url.username || url.password) throw new TypeError('MCP server URL credentials are not allowed')
    return { name, scope, projectPath, type: 'http', url: url.toString() }
  }
  if (value.type === 'stdio') {
    const command = requireString(value.command, 'MCP command', { min: 1, max: 2_048, trim: true })
    if (command.startsWith('-') || /[\0\r\n\u2028\u2029]/.test(command)) throw new TypeError('MCP command is invalid')
    if (value.args !== undefined && !Array.isArray(value.args)) throw new TypeError('MCP arguments must be a list')
    const args = (value.args ?? []).map((arg, index) => {
      const parsed = requireString(arg, `MCP argument ${index + 1}`, { max: 2_048 })
      if (/[\0\r\n\u2028\u2029]/.test(parsed)) throw new TypeError(`MCP argument ${index + 1} is invalid`)
      return parsed
    })
    if (args.length > 64) throw new TypeError('MCP arguments exceed the maximum count')
    return { name, scope, projectPath, type: 'stdio', command, args }
  }
  throw new TypeError('MCP transport must be http or stdio')
}

export function prepareProjectSettingsPath(projectPath: string): ProjectSettingsPath {
  const projectRoot = realpathSync(projectPath)
  const pinnedDirectories = new Map<string, { dev: string; ino: string }>()
  const pin = (path: string): void => {
    const stat = lstatSync(path, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError('Project MCP configuration path must remain a real directory')
    pinnedDirectories.set(path, { dev: stat.dev.toString(), ino: stat.ino.toString() })
  }
  pin(projectRoot)
  let directory = projectRoot
  for (const segment of ['.prime', 'agent']) {
    const candidate = join(directory, segment)
    if (existsSync(candidate)) {
      const stat = lstatSync(candidate)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError(`Project ${segment} configuration path must be a real directory`)
    } else {
      mkdirSync(candidate, { mode: 0o700 })
    }
    directory = realpathSync(candidate)
    if (!isPathWithin(projectRoot, directory)) throw new TypeError('Project MCP configuration path escapes the project')
    pin(directory)
  }
  const settingsPath = join(directory, 'settings.json')
  const verify = (): void => {
    for (const [path, expected] of pinnedDirectories) {
      let stat
      try { stat = lstatSync(path, { bigint: true }) } catch { throw new TypeError('Project MCP configuration directory changed during update') }
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev.toString() !== expected.dev || stat.ino.toString() !== expected.ino) {
        throw new TypeError('Project MCP configuration directory changed during update')
      }
    }
    if (existsSync(settingsPath)) {
      const stat = lstatSync(settingsPath)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new TypeError('Project MCP settings must be a regular file')
    }
  }
  verify()
  return { path: settingsPath, verify }
}

export async function updateMcpSettings(
  target: string | ProjectSettingsPath,
  input: McpConnectionInput,
  fingerprint: FingerprintSettings = settingsFingerprint,
): Promise<{ ok: boolean; output: string }> {
  const settingsPath = typeof target === 'string' ? target : target.path
  const verify = typeof target === 'string' ? undefined : target.verify
  const release = await acquireSettingsLock(settingsPath, verify)
  try {
    for (let attempt = 0; attempt < SETTINGS_UPDATE_ATTEMPTS; attempt += 1) {
      verify?.()
      const snapshot = await readSettingsForUpdate(settingsPath)
      verify?.()
      const settings = snapshot.settings
      if (settings.mcpServers !== undefined && !isRecord(settings.mcpServers)) throw new TypeError('Prime Agent mcpServers setting must contain a JSON object')
      const currentServers = isRecord(settings.mcpServers) ? settings.mcpServers : {}
      if (Object.prototype.hasOwnProperty.call(currentServers, input.name)) {
        return { ok: false, output: `An MCP server named “${input.name}” already exists in this scope.` }
      }
      const config = input.type === 'http'
        ? { type: 'http', url: input.url, enabled: true }
        : { type: 'stdio', command: input.command, ...(input.args?.length ? { args: input.args } : {}), enabled: true }
      settings.mcpServers = { ...currentServers, [input.name]: config }
      if (await writeSettingsAtomically(settingsPath, settings, snapshot.fingerprint, snapshot.source, fingerprint, verify)) {
        return { ok: true, output: `Saved MCP server definition “${input.name}”. Install or add a matching integration skill, then start a new Prime session.` }
      }
    }
    throw new Error('Prime Agent settings changed repeatedly; no MCP configuration was overwritten')
  } finally {
    await release()
  }
}
