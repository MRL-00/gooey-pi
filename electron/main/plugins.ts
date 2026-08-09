import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PluginCatalog, ProcessOutcome, SkillRecord } from '../../src/types/api'
import { createAdmissionQueue, createSingleFlight } from './lib/async'
import { requireString } from './validation'
import { discoverPlugins } from './plugins/catalog'
import { acquireSettingsLock, prepareProjectSettingsPath, settingsFingerprint, updateMcpSettings, validateMcpConnection } from './plugins/mcp'
import type { ProjectSettingsPath } from './plugins/mcp'
import { executePackageInstall, validatePackageSource } from './plugins/package-execution'

type PluginDiscovery = typeof discoverPlugins

interface PluginServiceOptions {
  agentDir?: string
  discover?: PluginDiscovery
  builtInSkills?: SkillRecord[]
}

const MAX_CONCURRENT_PLUGIN_DISCOVERIES = 2
const MAX_QUEUED_PLUGIN_DISCOVERIES = 32
const MAX_KNOWN_PATH_OWNERS = 64
const MAX_KNOWN_PATHS_PER_OWNER = 4_096

const createDiscoveryQueue = () => createAdmissionQueue({
  maxConcurrent: MAX_CONCURRENT_PLUGIN_DISCOVERIES,
  maxPending: MAX_QUEUED_PLUGIN_DISCOVERIES,
  pendingLimitError: () => new TypeError('Too many plugin discoveries are pending'),
  closedError: () => new TypeError('GUI Pie is shutting down'),
})
let discoveryQueue = createDiscoveryQueue()

export function beginPluginDiscoveryShutdown(): void {
  // Reject queued waiters; running discoveries finish normally. A fresh queue
  // keeps later callers working (only the quit path calls this in the app).
  discoveryQueue.close()
  discoveryQueue = createDiscoveryQueue()
}

export class PluginService {
  private lastProjectPath: string | undefined
  private readonly knownPathsByOwner = new Map<string, Set<string>>()
  private settingsMutation = Promise.resolve()
  private readonly discoveryInFlight = createSingleFlight<string, PluginCatalog>()
  private readonly agentDir: string
  private readonly discoverCatalog: PluginDiscovery
  private readonly builtInSkills: SkillRecord[]

  constructor(
    private readonly primeAgentPath: string | null,
    private readonly authorizeProject: (path: string) => Promise<string>,
    options: PluginServiceOptions = {},
  ) {
    this.agentDir = options.agentDir ?? join(homedir(), '.prime', 'agent')
    this.discoverCatalog = options.discover ?? discoverPlugins
    this.builtInSkills = options.builtInSkills ?? []
  }

  list(projectPath?: unknown): Promise<PluginCatalog> {
    if (!projectPath) return this.listCanonical()
    const requested = requireString(projectPath, 'projectPath', { min: 1, max: 4096 })
    return this.authorizeProject(requested).then((safeProjectPath) => this.listCanonical(safeProjectPath))
  }

  private listCanonical(safeProjectPath?: string): Promise<PluginCatalog> {
    const key = safeProjectPath ? `project:${safeProjectPath}` : 'user'
    return this.discoveryInFlight.run(key, () => discoveryQueue.run(() => this.discover(safeProjectPath, key)))
  }

  private async discover(safeProjectPath: string | undefined, ownerKey: string): Promise<PluginCatalog> {
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    const result = await this.discoverCatalog(this.agentDir, safeProjectPath, this.primeAgentPath)
    const combined = [...this.builtInSkills, ...result.skills.filter((item) => !this.builtInSkills.some((builtIn) => builtIn.id === item.id))]
    const knownPaths = combined.flatMap((item) => item.path ? [item.path] : []).slice(0, MAX_KNOWN_PATHS_PER_OWNER)
    // Delete-then-set keeps insertion order as LRU order for owner eviction.
    this.knownPathsByOwner.delete(ownerKey)
    this.knownPathsByOwner.set(ownerKey, new Set(knownPaths))
    while (this.knownPathsByOwner.size > MAX_KNOWN_PATH_OWNERS) {
      const oldest = this.knownPathsByOwner.keys().next().value
      if (oldest === undefined) break
      this.knownPathsByOwner.delete(oldest)
    }
    return { skills: combined, warnings: result.warnings }
  }

  authorizeReveal(pathValue: unknown): string {
    const requested = requireString(pathValue, 'plugin path', { min: 1, max: 4096 })
    let path: string
    try { path = realpathSync(requested) } catch { throw new TypeError('plugin path does not exist') }
    if (![...this.knownPathsByOwner.values()].some((knownPaths) => knownPaths.has(path))) {
      throw new TypeError('plugin path was not discovered')
    }
    return path
  }

  async install(sourceValue: unknown): Promise<ProcessOutcome> {
    if (!this.primeAgentPath) return { ok: false, reason: 'blocked', output: 'Prime Agent executable was not found' }
    const source = validatePackageSource(sourceValue)
    const settingsPath = join(this.agentDir, 'settings.json')
    const operation = this.settingsMutation.then(async () => {
      // The Prime CLI does not participate in Prime Work's settings lock. Holding
      // it around the subprocess still coordinates package installs launched by
      // this app with MCP updates from every PluginService instance.
      const release = await acquireSettingsLock(settingsPath)
      try {
        return await executePackageInstall(this.primeAgentPath!, source)
      } finally {
        await release()
      }
    })
    this.settingsMutation = operation.then(() => undefined, () => undefined)
    return await operation
  }

  async connectMcp(inputValue: unknown): Promise<ProcessOutcome> {
    const input = validateMcpConnection(inputValue)
    let settingsTarget: string | ProjectSettingsPath
    if (input.scope === 'project') {
      const projectPath = await this.authorizeProject(requireString(input.projectPath, 'projectPath', { min: 1, max: 4096 }))
      this.lastProjectPath = projectPath
      settingsTarget = await prepareProjectSettingsPath(projectPath)
    } else {
      settingsTarget = join(this.agentDir, 'settings.json')
    }

    const mutation = this.settingsMutation.then(() => updateMcpSettings(settingsTarget, input, (path) => this.settingsFingerprint(path)))
    this.settingsMutation = mutation.then(() => undefined, () => undefined)
    return await mutation
  }

  refresh(): Promise<PluginCatalog> {
    const projectPath = this.lastProjectPath
    if (!projectPath) return this.listCanonical()
    // Re-authorize on every refresh: the remembered project may have been
    // removed (or replaced) since the scope was last used.
    return this.authorizeProject(projectPath).then(
      (safeProjectPath) => this.listCanonical(safeProjectPath),
      (error) => {
        // Surface the failure once, then forget the stale scope so later
        // refreshes fall back to the user catalog.
        if (this.lastProjectPath === projectPath) this.lastProjectPath = undefined
        this.knownPathsByOwner.delete(`project:${projectPath}`)
        throw error
      },
    )
  }

  /** Revokes a removed project's revealable paths. */
  evictProjects(roots: readonly string[]): void {
    for (const root of roots) this.knownPathsByOwner.delete(`project:${root}`)
  }

  private settingsFingerprint(path: string): Promise<string> {
    return settingsFingerprint(path)
  }
}
