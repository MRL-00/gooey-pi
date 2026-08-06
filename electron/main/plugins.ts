import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { McpConnectionInput, SkillRecord } from '../../src/types/api'
import { runProcess } from './process-utils'
import { isPathWithin, isRecord, requireString, stripAnsi } from './validation'

type Kind = SkillRecord['kind']
type Location = SkillRecord['location']
interface Candidate { path: string; kind: Exclude<Kind, 'package' | 'mcp'>; location: Location }
interface PluginServiceOptions { agentDir?: string }

function idFor(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
}

const MAX_DISCOVERY_CANDIDATES = 2_000
const MAX_DISCOVERY_DIRECTORIES = 1_000
const MAX_DISCOVERY_ENTRIES = 20_000
const MAX_DISCOVERY_RECORDS = 2_500
const MAX_METADATA_BYTES = 128 * 1024
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
const METADATA_CONCURRENCY = 16
const SETTINGS_LOCK_ATTEMPTS = 40
const SETTINGS_LOCK_RETRY_MS = 50
const SETTINGS_LOCK_OWNER = 'owner.json'

interface DiscoveryBudget {
  candidates: number
  directories: number
  entries: number
  seenCandidates: Set<string>
}

interface SettingsLockOwner {
  version: 1
  pid: number
  token: string
  createdAt: number
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : ''
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

async function readAtMost(path: string, max: number): Promise<{ content: string; truncated: boolean }> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(max + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return { content: buffer.subarray(0, Math.min(offset, max)).toString('utf8'), truncated: offset > max }
  } finally {
    await file.close()
  }
}

async function readSmall(path: string, max = MAX_METADATA_BYTES): Promise<string> {
  try { return (await readAtMost(path, max)).content } catch { return '' }
}

function scalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  if (!match) return undefined
  const value = match[1].trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')
  if (value === '|' || value === '>') return undefined
  return value.slice(0, 500)
}

async function markdownMetadata(path: string): Promise<{ name?: string; description: string }> {
  const content = await readSmall(path)
  const frontmatterEnd = content.indexOf('\n---', 3)
  const frontmatter = content.startsWith('---') ? content.slice(3, frontmatterEnd >= 0 ? frontmatterEnd : 0) : ''
  const name = scalar(frontmatter, 'name')
  const description = scalar(frontmatter, 'description')
    ?? content.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('---') && !line.startsWith('#'))
    ?? ''
  return { name, description: description.slice(0, 500) }
}

function safeSource(source: string): string {
  try {
    const parsed = new URL(source.replace(/^git:/, ''))
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''
      return parsed.origin
    }
    if (parsed.protocol === 'ssh:' || parsed.protocol === 'git:') return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`
  } catch { /* npm, shorthand, or local source */ }
  return source.slice(0, 1_000)
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  try {
    const { content, truncated } = await readAtMost(path, MAX_SETTINGS_BYTES)
    if (truncated) return {}
    const value: unknown = JSON.parse(content)
    return isRecord(value) ? value : {}
  } catch { return {} }
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}

function resolveConfiguredPath(value: string, base: string): string | null {
  if (!value || /^[!+*-]/.test(value) || value.includes('*') || value.includes('?')) return null
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  return resolve(base, expanded)
}

function discoveryExhausted(budget: DiscoveryBudget): boolean {
  return budget.candidates >= MAX_DISCOVERY_CANDIDATES
    || budget.directories >= MAX_DISCOVERY_DIRECTORIES
    || budget.entries >= MAX_DISCOVERY_ENTRIES
}

function addCandidate(candidate: Candidate, output: Candidate[], budget: DiscoveryBudget): void {
  if (budget.candidates >= MAX_DISCOVERY_CANDIDATES) return
  const key = `${candidate.kind}:${candidate.path}`
  if (budget.seenCandidates.has(key)) return
  budget.seenCandidates.add(key)
  budget.candidates += 1
  output.push(candidate)
}

async function collectDirectory(
  root: string,
  kind: Candidate['kind'],
  location: Location,
  output: Candidate[],
  budget: DiscoveryBudget,
  options: { skillRoot?: boolean; depth?: number; containmentRoot?: string } = {},
): Promise<void> {
  if (discoveryExhausted(budget)) return
  const depth = options.depth ?? 0
  if (depth === 0 && options.containmentRoot) {
    try {
      const canonicalRoot = await realpath(root)
      if (!isPathWithin(options.containmentRoot, canonicalRoot)) return
    } catch { return }
  }

  let directory
  try {
    directory = await opendir(root)
    budget.directories += 1
  } catch { return }

  try {
    for await (const entry of directory) {
      if (discoveryExhausted(budget)) break
      budget.entries += 1
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(root, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isFile()) {
        if (kind === 'skill' && (entry.name === 'SKILL.md' || (depth === 0 && options.skillRoot && extname(entry.name) === '.md'))) addCandidate({ path, kind, location }, output, budget)
        else if (kind === 'prompt' && depth === 0 && extname(entry.name) === '.md') addCandidate({ path, kind, location }, output, budget)
        else if (kind === 'extension' && (depth === 0 || /^index\.(?:[cm]?[jt]s)$/.test(entry.name)) && ['.ts', '.js', '.mjs', '.cjs'].includes(extname(entry.name))) addCandidate({ path, kind, location }, output, budget)
      } else if (entry.isDirectory() && depth < 6) {
        await collectDirectory(path, kind, location, output, budget, { ...options, depth: depth + 1 })
      }
    }
  } catch { /* directory changed while it was being traversed */ }
}

async function collectConfigured(
  value: unknown,
  base: string,
  kind: Candidate['kind'],
  location: Location,
  output: Candidate[],
  budget: DiscoveryBudget,
  containmentRoot?: string,
): Promise<void> {
  if (!Array.isArray(value)) return
  for (const raw of value) {
    if (discoveryExhausted(budget)) break
    if (typeof raw !== 'string') continue
    const path = resolveConfiguredPath(raw, base)
    if (!path) continue
    try {
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) continue
      const canonicalPath = await realpath(path)
      if (containmentRoot && !isPathWithin(containmentRoot, canonicalPath)) continue
      if (stat.isFile()) addCandidate({ path: canonicalPath, kind, location }, output, budget)
      else if (stat.isDirectory()) await collectDirectory(canonicalPath, kind, location, output, budget, { skillRoot: kind === 'skill', containmentRoot })
    } catch { /* stale configured path */ }
  }
}

async function collectAncestorSkills(start: string, output: Candidate[], budget: DiscoveryBudget): Promise<void> {
  let current = resolve(start)
  while (!discoveryExhausted(budget)) {
    await collectDirectory(join(current, '.agents', 'skills'), 'skill', 'project', output, budget, { containmentRoot: start })
    if (await pathExists(join(current, '.git'))) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

function displayName(candidate: Candidate, metadata: { name?: string }): string {
  if (metadata.name) return metadata.name
  const file = basename(candidate.path)
  if (file === 'SKILL.md' || /^index\.(?:[cm]?[jt]s)$/.test(file)) return basename(dirname(candidate.path))
  return basename(file, extname(file))
}

export class PluginService {
  private lastProjectPath: string | undefined
  private knownPaths = new Set<string>()
  private settingsMutation = Promise.resolve()
  private readonly discoveryInFlight = new Map<string, Promise<SkillRecord[]>>()
  private readonly agentDir: string

  constructor(
    private readonly primeAgentPath: string | null,
    private readonly authorizeProject: (path: string) => Promise<string>,
    options: PluginServiceOptions = {},
  ) {
    this.agentDir = options.agentDir ?? join(homedir(), '.prime', 'agent')
  }

  list(projectPath?: string): Promise<SkillRecord[]> {
    const key = projectPath ? `project:${projectPath}` : 'user'
    const active = this.discoveryInFlight.get(key)
    if (active) return active

    const discovery = this.discover(projectPath)
    this.discoveryInFlight.set(key, discovery)
    const clear = () => {
      if (this.discoveryInFlight.get(key) === discovery) this.discoveryInFlight.delete(key)
    }
    void discovery.then(clear, clear)
    return discovery
  }

  private async discover(projectPath?: string): Promise<SkillRecord[]> {
    const safeProjectPath = projectPath ? await this.authorizeProject(requireString(projectPath, 'projectPath', { min: 1, max: 4096 })) : undefined
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    const candidates: Candidate[] = []
    const budget: DiscoveryBudget = { candidates: 0, directories: 0, entries: 0, seenCandidates: new Set() }
    const agentDir = this.agentDir
    const globalSettings = await readSettings(join(agentDir, 'settings.json'))

    await collectDirectory(join(agentDir, 'skills'), 'skill', 'user', candidates, budget, { skillRoot: true })
    await collectDirectory(join(homedir(), '.agents', 'skills'), 'skill', 'user', candidates, budget)
    await collectDirectory(join(agentDir, 'extensions'), 'extension', 'user', candidates, budget)
    await collectDirectory(join(agentDir, 'prompts'), 'prompt', 'user', candidates, budget)
    await collectConfigured(globalSettings.skills, agentDir, 'skill', 'user', candidates, budget)
    await collectConfigured(globalSettings.extensions, agentDir, 'extension', 'user', candidates, budget)
    await collectConfigured(globalSettings.prompts, agentDir, 'prompt', 'user', candidates, budget)

    const bundled = await this.bundledSkillsDirectory()
    if (bundled) await collectDirectory(bundled, 'skill', 'bundled', candidates, budget)

    let projectSettings: Record<string, unknown> = {}
    if (safeProjectPath && isAbsolute(safeProjectPath) && await pathExists(safeProjectPath)) {
      const projectAgentDir = join(safeProjectPath, '.prime', 'agent')
      projectSettings = await readSettings(join(projectAgentDir, 'settings.json'))
      await collectDirectory(join(projectAgentDir, 'skills'), 'skill', 'project', candidates, budget, { skillRoot: true, containmentRoot: safeProjectPath })
      await collectAncestorSkills(safeProjectPath, candidates, budget)
      await collectDirectory(join(projectAgentDir, 'extensions'), 'extension', 'project', candidates, budget, { containmentRoot: safeProjectPath })
      await collectDirectory(join(projectAgentDir, 'prompts'), 'prompt', 'project', candidates, budget, { containmentRoot: safeProjectPath })
      await collectConfigured(projectSettings.skills, projectAgentDir, 'skill', 'project', candidates, budget, safeProjectPath)
      await collectConfigured(projectSettings.extensions, projectAgentDir, 'extension', 'project', candidates, budget, safeProjectPath)
      await collectConfigured(projectSettings.prompts, projectAgentDir, 'prompt', 'project', candidates, budget, safeProjectPath)
    }

    const result = await this.buildCandidateRecords(candidates, safeProjectPath)
    this.addSettingsMetadata(globalSettings, 'user', result)
    this.addSettingsMetadata(projectSettings, 'project', result)
    this.knownPaths = new Set(result.flatMap((item) => item.path ? [item.path] : []))
    return result.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  }

  authorizeReveal(pathValue: unknown): string {
    const requested = requireString(pathValue, 'plugin path', { min: 1, max: 4096 })
    let path: string
    try { path = realpathSync(requested) } catch { throw new TypeError('plugin path does not exist') }
    if (!this.knownPaths.has(path)) throw new TypeError('plugin path was not discovered')
    return path
  }

  async install(sourceValue: unknown): Promise<{ ok: boolean; output: string }> {
    if (!this.primeAgentPath) return { ok: false, output: 'Prime Agent executable was not found' }
    const source = this.validatePackageSource(sourceValue)
    const result = await runProcess(this.primeAgentPath, ['package', 'install', source], { timeoutMs: 10 * 60_000, maxBytes: 8 * 1024 * 1024 })
    return { ok: result.code === 0, output: stripAnsi(`${result.stdout}${result.stderr}`).trim() }
  }

  async connectMcp(inputValue: unknown): Promise<{ ok: boolean; output: string }> {
    const input = this.validateMcpConnection(inputValue)
    let settingsPath: string
    if (input.scope === 'project') {
      const projectPath = await this.authorizeProject(requireString(input.projectPath, 'projectPath', { min: 1, max: 4096 }))
      this.lastProjectPath = projectPath
      settingsPath = this.prepareProjectSettingsPath(projectPath)
    } else {
      settingsPath = join(this.agentDir, 'settings.json')
    }

    let response = { ok: true, output: `Saved MCP server definition “${input.name}”. Install or add a matching integration skill, then start a new Prime session.` }
    const mutation = this.settingsMutation.then(async () => {
      const release = await this.acquireSettingsLock(settingsPath)
      try {
        const settings = await this.readSettingsForUpdate(settingsPath)
        if (settings.mcpServers !== undefined && !isRecord(settings.mcpServers)) throw new TypeError('Prime Agent mcpServers setting must contain a JSON object')
        const currentServers = isRecord(settings.mcpServers) ? settings.mcpServers : {}
        if (Object.prototype.hasOwnProperty.call(currentServers, input.name)) {
          response = { ok: false, output: `An MCP server named “${input.name}” already exists in this scope.` }
          return
        }
        const config = input.type === 'http'
          ? { type: 'http', url: input.url, enabled: true }
          : { type: 'stdio', command: input.command, ...(input.args?.length ? { args: input.args } : {}), enabled: true }
        settings.mcpServers = { ...currentServers, [input.name]: config }
        await this.writeSettingsAtomically(settingsPath, settings)
      } finally {
        await release()
      }
    })
    this.settingsMutation = mutation.catch(() => undefined)
    await mutation
    return response
  }

  refresh(): Promise<SkillRecord[]> { return this.list(this.lastProjectPath) }

  private async bundledSkillsDirectory(): Promise<string | null> {
    if (!this.primeAgentPath) return null
    try {
      const executable = await realpath(this.primeAgentPath)
      // Installed CLI is <package>/dist/bundle/cli.js; development launchers may not match.
      const packageRoot = resolve(dirname(executable), '..', '..')
      const candidate = join(packageRoot, 'skills')
      return await pathExists(candidate) ? candidate : null
    } catch { return null }
  }

  private async buildCandidateRecords(candidates: Candidate[], safeProjectPath?: string): Promise<SkillRecord[]> {
    const result: SkillRecord[] = []
    const seenPaths = new Set<string>()
    let cursor = 0
    const worker = async () => {
      while (true) {
        const candidate = candidates[cursor]
        cursor += 1
        if (!candidate) return
        let path: string
        try { path = await realpath(candidate.path) } catch { continue }
        if (candidate.location === 'project' && (!safeProjectPath || !isPathWithin(safeProjectPath, path))) continue
        const extension = extname(path).toLowerCase()
        if (candidate.kind === 'prompt' && extension !== '.md') continue
        if (candidate.kind === 'skill' && extension !== '.md') continue
        if (candidate.kind === 'extension' && !['.ts', '.js', '.mjs', '.cjs'].includes(extension)) continue
        const key = `${candidate.kind}:${path}`
        if (seenPaths.has(key)) continue
        seenPaths.add(key)
        const metadata = candidate.kind === 'extension' ? { description: 'Prime Agent extension' } : await markdownMetadata(path)
        const name = displayName(candidate, metadata)
        result.push({
          id: idFor(candidate.kind, path),
          name,
          description: metadata.description || `${candidate.kind[0].toUpperCase()}${candidate.kind.slice(1)} ${name}`,
          kind: candidate.kind,
          location: candidate.location,
          path,
          enabled: true,
        })
      }
    }
    await Promise.all(Array.from({ length: Math.min(METADATA_CONCURRENCY, candidates.length) }, worker))
    return result
  }

  private addSettingsMetadata(settings: Record<string, unknown>, location: 'user' | 'project', output: SkillRecord[]): void {
    if (Array.isArray(settings.packages)) {
      for (const raw of settings.packages) {
        if (output.length >= MAX_DISCOVERY_RECORDS) break
        const sourceValue = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw.source === 'string' ? raw.source : undefined
        if (!sourceValue) continue
        const source = safeSource(sourceValue)
        output.push({ id: idFor('package', location, sourceValue), name: source.replace(/^(npm:|git:)/, '').slice(0, 120), description: `Prime Agent capability package from ${source}`, kind: 'package', location, enabled: true, source })
      }
    }
    if (isRecord(settings.mcpServers)) {
      for (const [name, raw] of Object.entries(settings.mcpServers)) {
        if (output.length >= MAX_DISCOVERY_RECORDS) break
        if (!isRecord(raw)) continue
        const enabled = raw.enabled !== false
        if (raw.type === 'http' && typeof raw.url === 'string') {
          let origin = 'remote HTTP server'
          try { const url = new URL(raw.url); origin = url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : 'remote server' } catch { /* omit invalid and potentially secret URL */ }
          output.push({ id: idFor('mcp', location, name), name, description: `HTTP MCP server at ${origin}`, kind: 'mcp', location, enabled, source: origin })
        } else if (raw.type === 'stdio' && typeof raw.command === 'string') {
          const command = basename(raw.command).slice(0, 120)
          output.push({ id: idFor('mcp', location, name), name, description: `Local stdio MCP server (${command})`, kind: 'mcp', location, enabled, source: command })
        }
      }
    }
  }

  private validateMcpConnection(value: unknown): McpConnectionInput {
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

  private prepareProjectSettingsPath(projectPath: string): string {
    const projectRoot = realpathSync(projectPath)
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
    }
    const settingsPath = join(directory, 'settings.json')
    if (existsSync(settingsPath)) {
      const stat = lstatSync(settingsPath)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new TypeError('Project MCP settings must be a regular file')
    }
    return settingsPath
  }

  private async readSettingsForUpdate(path: string): Promise<Record<string, unknown>> {
    let content: string
    try {
      const value = await readAtMost(path, MAX_SETTINGS_BYTES)
      if (value.truncated) throw new TypeError('Prime Agent settings exceed the maximum supported size')
      content = value.content
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return {}
      if (error instanceof TypeError && error.message.includes('maximum supported size')) throw error
      throw new TypeError('Prime Agent settings are not valid JSON; fix them before connecting an MCP server')
    }
    let value: unknown
    try { value = JSON.parse(content) } catch { throw new TypeError('Prime Agent settings are not valid JSON; fix them before connecting an MCP server') }
    if (!isRecord(value)) throw new TypeError('Prime Agent settings must contain a JSON object')
    return value
  }

  private async readSettingsLockOwner(lockPath: string): Promise<SettingsLockOwner | null> {
    try {
      const { content, truncated } = await readAtMost(join(lockPath, SETTINGS_LOCK_OWNER), 4 * 1024)
      if (truncated) return null
      return parseSettingsLockOwner(JSON.parse(content) as unknown)
    } catch { return null }
  }

  private isProcessProvablyDead(pid: number): boolean {
    if (pid === process.pid) return false
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      return errorCode(error) === 'ESRCH'
    }
  }

  private async createSettingsLock(lockPath: string): Promise<(() => Promise<void>) | null> {
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
      const current = await this.readSettingsLockOwner(lockPath)
      if (sameSettingsLockOwner(current, owner)) await rm(lockPath, { recursive: true, force: true })
    }
  }

  private async recoverStaleSettingsLock(lockPath: string): Promise<(() => Promise<void>) | null> {
    const observed = await this.readSettingsLockOwner(lockPath)
    if (!observed || !this.isProcessProvablyDead(observed.pid)) return null

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
      const current = await this.readSettingsLockOwner(lockPath)
      if (!sameSettingsLockOwner(current, observed) || !this.isProcessProvablyDead(observed.pid)) return null
      await rm(lockPath, { recursive: true, force: true })
      return await this.createSettingsLock(lockPath)
    } finally {
      await rm(recoveryPath, { recursive: true, force: true })
    }
  }

  private async acquireSettingsLock(settingsPath: string): Promise<() => Promise<void>> {
    await mkdir(dirname(settingsPath), { recursive: true })
    const lockPath = `${settingsPath}.lock`
    for (let attempt = 0; attempt < SETTINGS_LOCK_ATTEMPTS; attempt += 1) {
      const acquired = await this.createSettingsLock(lockPath)
      if (acquired) return acquired
      const recovered = await this.recoverStaleSettingsLock(lockPath)
      if (recovered) return recovered
      await new Promise((resolveWait) => setTimeout(resolveWait, SETTINGS_LOCK_RETRY_MS))
    }
    throw new Error('Prime Agent settings are busy; try again')
  }

  private async writeSettingsAtomically(path: string, settings: Record<string, unknown>): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private validatePackageSource(value: unknown): string {
    const source = requireString(value, 'package source', { min: 1, max: 2_048, trim: true })
    if (source.startsWith('-') || /[\r\n\u2028\u2029]/.test(source)) throw new TypeError('Invalid package source')
    if (source.startsWith('npm:')) {
      if (!/^npm:(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:@[^\s]+)?$/i.test(source)) throw new TypeError('Invalid npm package source')
      return source
    }
    if (source.startsWith('git:')) {
      const spec = source.slice(4)
      const protocolUrl = /^(?:https?|ssh|git):\/\//i.test(spec)
      const sshShorthand = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+(?:@[A-Za-z0-9._/-]+)?$/.test(spec)
      const hostShorthand = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._~/-]+(?:@[A-Za-z0-9._/-]+)?$/.test(spec)
      if (!protocolUrl && !sshShorthand && !hostShorthand) throw new TypeError('Invalid git package source')
      if (protocolUrl) {
        try {
          const url = new URL(spec)
          if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) throw new TypeError('Package URL credentials are not allowed')
        } catch (error) {
          if (error instanceof TypeError && error.message === 'Package URL credentials are not allowed') throw error
          throw new TypeError('Invalid git package URL')
        }
      }
      return source
    }
    if (/^(https?|ssh|git):\/\//i.test(source)) {
      let url: URL
      try { url = new URL(source.replace(/@([^/@]+)$/, '%40$1')) } catch { throw new TypeError('Invalid package URL') }
      if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) throw new TypeError('Package URL credentials are not allowed')
      return source
    }
    if (isAbsolute(source)) {
      if (!existsSync(source)) throw new TypeError('Local package path does not exist')
      return realpathSync(source)
    }
    throw new TypeError('Package source must be npm:, git:, a protocol URL, or an existing absolute path')
  }
}
