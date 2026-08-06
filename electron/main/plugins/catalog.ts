import { createHash } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { SkillRecord } from '../../../src/types/api'
import { isPathWithin, isRecord } from '../validation'
import { readAtMost } from './file-io'

type Kind = SkillRecord['kind']
type Location = SkillRecord['location']
interface Candidate { path: string; kind: Exclude<Kind, 'package' | 'mcp'>; location: Location }

const MAX_DISCOVERY_CANDIDATES = 2_000
const MAX_DISCOVERY_DIRECTORIES = 1_000
const MAX_DISCOVERY_ENTRIES = 20_000
const MAX_DISCOVERY_RECORDS = 2_500
const MAX_METADATA_BYTES = 128 * 1024
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
const METADATA_CONCURRENCY = 16

interface DiscoveryBudget {
  candidates: number
  directories: number
  entries: number
  seenCandidates: Set<string>
}

function idFor(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
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


function displayName(candidate: Candidate, metadata: { name?: string }): string {
  if (metadata.name) return metadata.name
  const file = basename(candidate.path)
  if (file === 'SKILL.md' || /^index\.(?:[cm]?[jt]s)$/.test(file)) return basename(dirname(candidate.path))
  return basename(file, extname(file))
}

async function buildCandidateRecords(candidates: Candidate[], safeProjectPath?: string): Promise<SkillRecord[]> {
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

function addSettingsMetadata(settings: Record<string, unknown>, location: 'user' | 'project', output: SkillRecord[]): void {
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

export async function bundledSkillsDirectory(primeAgentPath: string | null): Promise<string | null> {
  if (!primeAgentPath) return null
  try {
    const executable = await realpath(primeAgentPath)
    const packageRoot = resolve(dirname(executable), '..', '..')
    const candidate = join(packageRoot, 'skills')
    return await pathExists(candidate) ? candidate : null
  } catch { return null }
}

export async function discoverPlugins(agentDir: string, safeProjectPath: string | undefined, primeAgentPath: string | null): Promise<SkillRecord[]> {
  const candidates: Candidate[] = []
  const budget: DiscoveryBudget = { candidates: 0, directories: 0, entries: 0, seenCandidates: new Set() }
  const globalSettings = await readSettings(join(agentDir, 'settings.json'))

  await collectDirectory(join(agentDir, 'skills'), 'skill', 'user', candidates, budget, { skillRoot: true })
  await collectDirectory(join(homedir(), '.agents', 'skills'), 'skill', 'user', candidates, budget)
  await collectDirectory(join(agentDir, 'extensions'), 'extension', 'user', candidates, budget)
  await collectDirectory(join(agentDir, 'prompts'), 'prompt', 'user', candidates, budget)
  await collectConfigured(globalSettings.skills, agentDir, 'skill', 'user', candidates, budget)
  await collectConfigured(globalSettings.extensions, agentDir, 'extension', 'user', candidates, budget)
  await collectConfigured(globalSettings.prompts, agentDir, 'prompt', 'user', candidates, budget)

  const bundled = await bundledSkillsDirectory(primeAgentPath)
  if (bundled) await collectDirectory(bundled, 'skill', 'bundled', candidates, budget)

  let projectSettings: Record<string, unknown> = {}
  if (safeProjectPath && isAbsolute(safeProjectPath) && await pathExists(safeProjectPath)) {
    const projectAgentDir = join(safeProjectPath, '.prime', 'agent')
    projectSettings = await readSettings(join(projectAgentDir, 'settings.json'))
    await collectDirectory(join(projectAgentDir, 'skills'), 'skill', 'project', candidates, budget, { skillRoot: true, containmentRoot: safeProjectPath })
    await collectDirectory(join(safeProjectPath, '.agents', 'skills'), 'skill', 'project', candidates, budget, { containmentRoot: safeProjectPath })
    await collectDirectory(join(projectAgentDir, 'extensions'), 'extension', 'project', candidates, budget, { containmentRoot: safeProjectPath })
    await collectDirectory(join(projectAgentDir, 'prompts'), 'prompt', 'project', candidates, budget, { containmentRoot: safeProjectPath })
    await collectConfigured(projectSettings.skills, projectAgentDir, 'skill', 'project', candidates, budget, safeProjectPath)
    await collectConfigured(projectSettings.extensions, projectAgentDir, 'extension', 'project', candidates, budget, safeProjectPath)
    await collectConfigured(projectSettings.prompts, projectAgentDir, 'prompt', 'project', candidates, budget, safeProjectPath)
  }

  const result = await buildCandidateRecords(candidates, safeProjectPath)
  addSettingsMetadata(globalSettings, 'user', result)
  addSettingsMetadata(projectSettings, 'project', result)
  return result.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}
