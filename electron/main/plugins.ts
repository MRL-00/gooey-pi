import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

function readSmall(path: string, max = 128 * 1024): string {
  try {
    const data = readFileSync(path)
    return data.subarray(0, max).toString('utf8')
  } catch { return '' }
}

function scalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  if (!match) return undefined
  const value = match[1].trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')
  if (value === '|' || value === '>') return undefined
  return value.slice(0, 500)
}

function markdownMetadata(path: string): { name?: string; description: string } {
  const content = readSmall(path)
  const frontmatter = content.startsWith('---') ? content.slice(3, content.indexOf('\n---', 3) >= 0 ? content.indexOf('\n---', 3) : 0) : ''
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

function readSettings(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readSmall(path, 4 * 1024 * 1024))
    return isRecord(value) ? value : {}
  } catch { return {} }
}

function resolveConfiguredPath(value: string, base: string): string | null {
  if (!value || /^[!+*-]/.test(value) || value.includes('*') || value.includes('?')) return null
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  return resolve(base, expanded)
}

function collectDirectory(root: string, kind: Candidate['kind'], location: Location, output: Candidate[], options: { skillRoot?: boolean; depth?: number } = {}): void {
  if (!existsSync(root) || output.length >= 2_000) return
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
  const depth = options.depth ?? 0
  for (const entry of entries) {
    if (output.length >= 2_000 || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isFile()) {
      if (kind === 'skill' && (entry.name === 'SKILL.md' || (depth === 0 && options.skillRoot && extname(entry.name) === '.md'))) output.push({ path, kind, location })
      else if (kind === 'prompt' && depth === 0 && extname(entry.name) === '.md') output.push({ path, kind, location })
      else if (kind === 'extension' && (depth === 0 || /^index\.(?:[cm]?[jt]s)$/.test(entry.name)) && ['.ts', '.js', '.mjs', '.cjs'].includes(extname(entry.name))) output.push({ path, kind, location })
    } else if (entry.isDirectory() && depth < 6) {
      collectDirectory(path, kind, location, output, { ...options, depth: depth + 1 })
    }
  }
}

function collectConfigured(value: unknown, base: string, kind: Candidate['kind'], location: Location, output: Candidate[]): void {
  if (!Array.isArray(value)) return
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const path = resolveConfiguredPath(raw, base)
    if (!path || !existsSync(path)) continue
    try {
      const stat = lstatSync(path)
      if (stat.isFile()) output.push({ path: realpathSync(path), kind, location })
      else if (stat.isDirectory()) collectDirectory(path, kind, location, output, { skillRoot: kind === 'skill' })
    } catch { /* stale configured path */ }
  }
}

function collectAncestorSkills(start: string, output: Candidate[]): void {
  let current = resolve(start)
  while (true) {
    collectDirectory(join(current, '.agents', 'skills'), 'skill', 'project', output)
    if (existsSync(join(current, '.git'))) break
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
  private readonly agentDir: string

  constructor(
    private readonly primeAgentPath: string | null,
    private readonly authorizeProject: (path: string) => Promise<string>,
    options: PluginServiceOptions = {},
  ) {
    this.agentDir = options.agentDir ?? join(homedir(), '.prime', 'agent')
  }

  async list(projectPath?: string): Promise<SkillRecord[]> {
    const safeProjectPath = projectPath ? await this.authorizeProject(requireString(projectPath, 'projectPath', { min: 1, max: 4096 })) : undefined
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    const candidates: Candidate[] = []
    const agentDir = this.agentDir
    const globalSettings = readSettings(join(agentDir, 'settings.json'))

    collectDirectory(join(agentDir, 'skills'), 'skill', 'user', candidates, { skillRoot: true })
    collectDirectory(join(homedir(), '.agents', 'skills'), 'skill', 'user', candidates)
    collectDirectory(join(agentDir, 'extensions'), 'extension', 'user', candidates)
    collectDirectory(join(agentDir, 'prompts'), 'prompt', 'user', candidates)
    collectConfigured(globalSettings.skills, agentDir, 'skill', 'user', candidates)
    collectConfigured(globalSettings.extensions, agentDir, 'extension', 'user', candidates)
    collectConfigured(globalSettings.prompts, agentDir, 'prompt', 'user', candidates)

    const bundled = this.bundledSkillsDirectory()
    if (bundled) collectDirectory(bundled, 'skill', 'bundled', candidates)

    let projectSettings: Record<string, unknown> = {}
    if (safeProjectPath && isAbsolute(safeProjectPath) && existsSync(safeProjectPath)) {
      const projectAgentDir = join(safeProjectPath, '.prime', 'agent')
      projectSettings = readSettings(join(projectAgentDir, 'settings.json'))
      collectDirectory(join(projectAgentDir, 'skills'), 'skill', 'project', candidates, { skillRoot: true })
      collectAncestorSkills(safeProjectPath, candidates)
      collectDirectory(join(projectAgentDir, 'extensions'), 'extension', 'project', candidates)
      collectDirectory(join(projectAgentDir, 'prompts'), 'prompt', 'project', candidates)
      collectConfigured(projectSettings.skills, projectAgentDir, 'skill', 'project', candidates)
      collectConfigured(projectSettings.extensions, projectAgentDir, 'extension', 'project', candidates)
      collectConfigured(projectSettings.prompts, projectAgentDir, 'prompt', 'project', candidates)
    }

    const result: SkillRecord[] = []
    const seenPaths = new Set<string>()
    for (const candidate of candidates) {
      let path: string
      try { path = realpathSync(candidate.path) } catch { continue }
      if (candidate.location === 'project' && (!safeProjectPath || !isPathWithin(safeProjectPath, path))) continue
      const extension = extname(path).toLowerCase()
      if (candidate.kind === 'prompt' && extension !== '.md') continue
      if (candidate.kind === 'skill' && extension !== '.md') continue
      if (candidate.kind === 'extension' && !['.ts', '.js', '.mjs', '.cjs'].includes(extension)) continue
      const key = `${candidate.kind}:${path}`
      if (seenPaths.has(key)) continue
      seenPaths.add(key)
      const metadata = candidate.kind === 'extension' ? { description: 'Prime Agent extension' } : markdownMetadata(path)
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
        const settings = this.readSettingsForUpdate(settingsPath)
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
        this.writeSettingsAtomically(settingsPath, settings)
      } finally {
        release()
      }
    })
    this.settingsMutation = mutation.catch(() => undefined)
    await mutation
    return response
  }

  refresh(): Promise<SkillRecord[]> { return this.list(this.lastProjectPath) }

  private bundledSkillsDirectory(): string | null {
    if (!this.primeAgentPath) return null
    try {
      const executable = realpathSync(this.primeAgentPath)
      // Installed CLI is <package>/dist/bundle/cli.js; development launchers may not match.
      const packageRoot = resolve(dirname(executable), '..', '..')
      const candidate = join(packageRoot, 'skills')
      return existsSync(candidate) ? candidate : null
    } catch { return null }
  }

  private addSettingsMetadata(settings: Record<string, unknown>, location: 'user' | 'project', output: SkillRecord[]): void {
    if (Array.isArray(settings.packages)) {
      for (const raw of settings.packages) {
        const sourceValue = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw.source === 'string' ? raw.source : undefined
        if (!sourceValue) continue
        const source = safeSource(sourceValue)
        output.push({ id: idFor('package', location, sourceValue), name: source.replace(/^(npm:|git:)/, '').slice(0, 120), description: `Prime Agent capability package from ${source}`, kind: 'package', location, enabled: true, source })
      }
    }
    if (isRecord(settings.mcpServers)) {
      for (const [name, raw] of Object.entries(settings.mcpServers)) {
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

  private readSettingsForUpdate(path: string): Record<string, unknown> {
    if (!existsSync(path)) return {}
    let value: unknown
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new TypeError('Prime Agent settings are not valid JSON; fix them before connecting an MCP server') }
    if (!isRecord(value)) throw new TypeError('Prime Agent settings must contain a JSON object')
    return value
  }

  private async acquireSettingsLock(settingsPath: string): Promise<() => void> {
    const directory = dirname(settingsPath)
    mkdirSync(directory, { recursive: true })
    const lockPath = `${settingsPath}.lock`
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        mkdirSync(lockPath)
        return () => { rmSync(lockPath, { recursive: true, force: true }) }
      } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
        if (code !== 'EEXIST') throw error
        await new Promise((resolveWait) => setTimeout(resolveWait, 50))
      }
    }
    throw new Error('Prime Agent settings are busy; try again')
  }

  private writeSettingsAtomically(path: string, settings: Record<string, unknown>): void {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
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
