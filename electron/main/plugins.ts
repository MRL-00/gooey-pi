import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProcessOutcome, SkillRecord } from '../../src/types/api'
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
let activePluginDiscoveries = 0
const discoveryWaiters: Array<() => void> = []

async function acquirePluginDiscoverySlot(): Promise<void> {
  if (activePluginDiscoveries < MAX_CONCURRENT_PLUGIN_DISCOVERIES) {
    activePluginDiscoveries += 1
    return
  }
  if (discoveryWaiters.length >= MAX_QUEUED_PLUGIN_DISCOVERIES) {
    throw new TypeError('Too many plugin discoveries are pending')
  }
  await new Promise<void>((resolve) => discoveryWaiters.push(resolve))
}

function releasePluginDiscoverySlot(): void {
  const next = discoveryWaiters.shift()
  if (next) next()
  else activePluginDiscoveries -= 1
}

async function schedulePluginDiscovery<Value>(operation: () => Promise<Value>): Promise<Value> {
  await acquirePluginDiscoverySlot()
  try {
    return await operation()
  } finally {
    releasePluginDiscoverySlot()
  }
}

export class PluginService {
  private lastProjectPath: string | undefined
  private readonly knownPathsByOwner = new Map<string, Set<string>>()
  private settingsMutation = Promise.resolve()
  private readonly discoveryInFlight = new Map<string, Promise<SkillRecord[]>>()
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

  list(projectPath?: string): Promise<SkillRecord[]> {
    if (!projectPath) return this.listCanonical()
    const requested = requireString(projectPath, 'projectPath', { min: 1, max: 4096 })
    return this.authorizeProject(requested).then((safeProjectPath) => this.listCanonical(safeProjectPath))
  }

  private listCanonical(safeProjectPath?: string): Promise<SkillRecord[]> {
    const key = safeProjectPath ? `project:${safeProjectPath}` : 'user'
    const active = this.discoveryInFlight.get(key)
    if (active) return active

    const discovery = schedulePluginDiscovery(() => this.discover(safeProjectPath, key))
    this.discoveryInFlight.set(key, discovery)
    const clear = () => {
      if (this.discoveryInFlight.get(key) === discovery) this.discoveryInFlight.delete(key)
    }
    void discovery.then(clear, clear)
    return discovery
  }

  private async discover(safeProjectPath: string | undefined, ownerKey: string): Promise<SkillRecord[]> {
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    const result = await this.discoverCatalog(this.agentDir, safeProjectPath, this.primeAgentPath)
    const combined = [...this.builtInSkills, ...result.filter((item) => !this.builtInSkills.some((builtIn) => builtIn.id === item.id))]
    this.knownPathsByOwner.set(ownerKey, new Set(combined.flatMap((item) => item.path ? [item.path] : [])))
    return combined
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
      settingsTarget = prepareProjectSettingsPath(projectPath)
    } else {
      settingsTarget = join(this.agentDir, 'settings.json')
    }

    const mutation = this.settingsMutation.then(() => updateMcpSettings(settingsTarget, input, (path) => this.settingsFingerprint(path)))
    this.settingsMutation = mutation.then(() => undefined, () => undefined)
    return await mutation
  }

  refresh(): Promise<SkillRecord[]> { return this.listCanonical(this.lastProjectPath) }

  private settingsFingerprint(path: string): Promise<string> {
    return settingsFingerprint(path)
  }
}
