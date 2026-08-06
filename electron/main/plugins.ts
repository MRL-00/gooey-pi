import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { SkillRecord } from '../../src/types/api'
import { runProcess } from './process-utils'
import { isPathWithin, isRecord, requireString, stripAnsi } from './validation'

type Kind = SkillRecord['kind']
type Location = SkillRecord['location']
interface Candidate { path: string; kind: Exclude<Kind, 'package' | 'mcp'>; location: Location }

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

  constructor(private readonly primeAgentPath: string | null, private readonly authorizeProject: (path: string) => Promise<string>) {}

  async list(projectPath?: string): Promise<SkillRecord[]> {
    const safeProjectPath = projectPath ? await this.authorizeProject(requireString(projectPath, 'projectPath', { min: 1, max: 4096 })) : undefined
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    const candidates: Candidate[] = []
    const agentDir = join(homedir(), '.prime', 'agent')
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
