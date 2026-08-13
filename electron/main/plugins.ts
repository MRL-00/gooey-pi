import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessId, PluginCatalog, ProcessOutcome, SkillRecord } from '../../src/types/api'
import { HARNESSES } from './harness'
import { createAdmissionQueue, createSingleFlight } from './lib/async'
import { resolveExecutable, type ExecutableSource } from './process-utils'
import { isRecord, requireString } from './validation'
import { discoverPlugins } from './plugins/catalog'
import { readAtMost } from './plugins/file-io'
import { acquireSettingsLock, prepareProjectSettingsPath, settingsFingerprint, updateMcpSettings, validateMcpConnection } from './plugins/mcp'
import type { ProjectSettingsPath } from './plugins/mcp'
import { executeOmpPluginInstall, executePackageInstall, executePiPluginInstall, validatePackageSource } from './plugins/package-execution'

type PluginDiscovery = typeof discoverPlugins

interface PluginServiceOptions {
  harness?: HarnessId
  agentDir?: string
  discover?: PluginDiscovery
  builtInSkills?: SkillRecord[] | (() => SkillRecord[] | Promise<SkillRecord[]>)
}

const MAX_ADAPTER_SETTINGS_BYTES = 4 * 1024 * 1024

const MAX_CONCURRENT_PLUGIN_DISCOVERIES = 2
const MAX_QUEUED_PLUGIN_DISCOVERIES = 32
const MAX_KNOWN_PATH_OWNERS = 64
const MAX_KNOWN_PATHS_PER_OWNER = 4_096

const createDiscoveryQueue = () => createAdmissionQueue({
  maxConcurrent: MAX_CONCURRENT_PLUGIN_DISCOVERIES,
  maxPending: MAX_QUEUED_PLUGIN_DISCOVERIES,
  pendingLimitError: () => new TypeError('Too many plugin discoveries are pending'),
  closedError: () => new TypeError('GooeyPi is shutting down'),
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
  private readonly builtInSkills: () => SkillRecord[] | Promise<SkillRecord[]>
  private readonly harness: HarnessId

  constructor(
    private readonly agentPath: ExecutableSource,
    private readonly authorizeProject: (path: string) => Promise<string>,
    options: PluginServiceOptions = {},
  ) {
    this.harness = options.harness ?? 'prime'
    this.agentDir = options.agentDir ?? HARNESSES[this.harness].agentDir(homedir())
    this.discoverCatalog = options.discover ?? discoverPlugins
    const builtInSkills = options.builtInSkills
    this.builtInSkills = typeof builtInSkills === 'function'
      ? builtInSkills
      : () => builtInSkills ?? []
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
    const result = await this.discoverCatalog(this.agentDir, safeProjectPath, resolveExecutable(this.agentPath), this.harness)
    const builtInSkills = await this.builtInSkills()
    const combined = [...builtInSkills, ...result.skills.filter((item) => !builtInSkills.some((builtIn) => builtIn.id === item.id))]
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
    const agentPath = resolveExecutable(this.agentPath)
    if (!agentPath) return { ok: false, reason: 'blocked', output: `${HARNESSES[this.harness].agentName} executable was not found` }
    const source = validatePackageSource(sourceValue)
    // Pi and Prime record installed sources in the agent settings.json; OMP
    // tracks installs through its plugin lock file.
    const settingsPath = this.harness === 'omp' ? join(this.agentDir, '..', 'plugins', 'omp-plugins.lock.json') : join(this.agentDir, 'settings.json')
    const operation = this.settingsMutation.then(async () => {
      // The Prime CLI does not participate in Prime Work's settings lock. Holding
      // it around the subprocess still coordinates package installs launched by
      // this app with MCP updates from every PluginService instance.
      const release = await acquireSettingsLock(settingsPath)
      try {
        return this.harness === 'omp'
          ? await executeOmpPluginInstall(agentPath, source)
          : this.harness === 'pi'
            ? await executePiPluginInstall(agentPath, source)
            : await executePackageInstall(agentPath, source)
      } finally {
        await release()
      }
    })
    this.settingsMutation = operation.then(() => undefined, () => undefined)
    return await operation
  }

  async connectMcp(inputValue: unknown): Promise<ProcessOutcome> {
    const input = validateMcpConnection(inputValue, this.harness)
    let settingsTarget: string | ProjectSettingsPath
    if (input.scope === 'project') {
      const projectPath = await this.authorizeProject(requireString(input.projectPath, 'projectPath', { min: 1, max: 4096 }))
      this.lastProjectPath = projectPath
      settingsTarget = await prepareProjectSettingsPath(projectPath, this.harness === 'prime'
        ? undefined
        : { segments: [this.harness === 'omp' ? '.omp' : '.pi'], filename: 'mcp.json' })
    } else {
      settingsTarget = join(this.agentDir, this.harness === 'prime' ? 'settings.json' : 'mcp.json')
    }

    const options = this.harness === 'omp' ? {
      agentName: 'OMP',
      schema: 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json',
    } : this.harness === 'pi' ? {
      agentName: 'Pi',
      successMessage: `Saved MCP server definition “${input.name}”. Start a new Pi session to load it.${await this.piMcpAdapterAdvisory()}`,
    } : undefined
    const mutation = this.settingsMutation.then(() => updateMcpSettings(
      settingsTarget,
      input,
      (path) => this.settingsFingerprint(path),
      options,
    ))
    this.settingsMutation = mutation.then(() => undefined, () => undefined)
    return await mutation
  }

  /**
   * Pi loads mcp.json through the pi-mcp-adapter extension. The installed
   * sources recorded in ~/.pi/agent/settings.json are read (bounded, never
   * written) to warn when the adapter is missing; the write itself proceeds.
   */
  private async piMcpAdapterAdvisory(): Promise<string> {
    const advisory = ' Note: Pi loads MCP servers through the pi-mcp-adapter extension, which is not installed — run: pi install npm:pi-mcp-adapter'
    try {
      const { content, truncated } = await readAtMost(join(this.agentDir, 'settings.json'), MAX_ADAPTER_SETTINGS_BYTES)
      if (truncated) return advisory
      const value = JSON.parse(content) as unknown
      if (!isRecord(value) || !Array.isArray(value.packages)) return advisory
      const installed = value.packages.some((raw) => {
        const source = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw.source === 'string' ? raw.source : ''
        return source.includes('pi-mcp-adapter')
      })
      return installed ? '' : advisory
    } catch {
      return advisory
    }
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
