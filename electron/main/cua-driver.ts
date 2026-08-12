import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, posix, win32 } from 'node:path'
import type { AppSettings } from '../../src/types/api'
import { runProcess } from './process-utils'
import { updateManagedMcpServer, type ManagedStdioMcpServer } from './plugins/mcp'

export const CUA_DRIVER_INSTALL_URL = 'https://cua.ai/driver'
export const MIN_CUA_DRIVER_VERSION = '0.19.0'
const MANAGED_SERVER_NAME = 'gooeypi-cua-driver'
const MANAGED_MARKER = { key: 'GOOEYPI_MANAGED_CUA_DRIVER', value: '1' } as const
const OMP_MCP_SCHEMA = 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json'
const VERSION_PATTERN = /\b(?:cua-driver(?:-rs)?\s+)?v?(\d+)\.(\d+)\.(\d+)\b/i

interface DriverProbe {
  runnable: boolean
  version: string | null
  supported: boolean
}

export interface CuaDriverStatus {
  installed: boolean
  supported: boolean
  path: string | null
  version: string | null
  enabled: boolean
  installUrl: string
  detail: string
}

type CandidateAccess = (path: string, mode?: number) => Promise<void>
type DriverProber = (path: string) => Promise<DriverProbe>

export interface CuaDriverServiceOptions {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  home?: string
  access?: CandidateAccess
  probe?: DriverProber
  agentDirs?: { prime: string; omp: string; pi: string }
}

function versionTuple(value: string): [number, number, number] | null {
  const match = VERSION_PATTERN.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function versionAtLeast(value: string, minimum: string): boolean {
  const actual = versionTuple(value)
  const required = versionTuple(minimum)
  if (!actual || !required) return false
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] > required[index]) return true
    if (actual[index] < required[index]) return false
  }
  return true
}

export function cuaDriverExecutableCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix
  const executable = platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'
  const candidates: string[] = []
  const configured = env.CUA_DRIVER_PATH
  if (configured && pathApi.isAbsolute(configured)) candidates.push(configured)

  const pathValues = platform === 'win32' ? [env.Path, env.PATH] : [env.PATH]
  for (const directory of pathValues.flatMap((value) => (value ?? '').split(platform === 'win32' ? ';' : delimiter))) {
    if (directory && pathApi.isAbsolute(directory)) candidates.push(pathApi.join(directory, executable))
  }

  if (platform === 'win32') {
    for (const root of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (!root || !win32.isAbsolute(root)) continue
      candidates.push(win32.join(root, 'CuaDriver', executable), win32.join(root, 'Programs', 'CuaDriver', executable))
    }
    candidates.push(win32.join(home, '.local', 'bin', executable))
  } else {
    candidates.push(posix.join(home, '.local', 'bin', executable), '/usr/local/bin/cua-driver', '/usr/bin/cua-driver')
    if (platform === 'darwin') {
      candidates.push(
        '/opt/homebrew/bin/cua-driver',
        '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
        '/Applications/CuaDriverLocal.app/Contents/MacOS/cua-driver',
        posix.join(home, 'Applications', 'CuaDriver.app', 'Contents', 'MacOS', 'cua-driver'),
      )
    } else {
      candidates.push('/home/linuxbrew/.linuxbrew/bin/cua-driver')
    }
  }

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = platform === 'win32' ? candidate.toLowerCase() : candidate
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function probeCuaDriverExecutable(path: string): Promise<DriverProbe> {
  try {
    const result = await runProcess(path, ['--version'], { timeoutMs: 10_000, maxBytes: 16 * 1024 })
    if (result.code !== 0 || result.timedOut || result.outputExceeded) return { runnable: false, version: null, supported: false }
    const match = VERSION_PATTERN.exec(`${result.stdout}\n${result.stderr}`)
    if (!match) return { runnable: false, version: null, supported: false }
    const version = `${match[1]}.${match[2]}.${match[3]}`
    return { runnable: true, version, supported: versionAtLeast(version, MIN_CUA_DRIVER_VERSION) }
  } catch {
    return { runnable: false, version: null, supported: false }
  }
}

export class CuaDriverService {
  private lastStatus: CuaDriverStatus | null = null
  private readonly platform: NodeJS.Platform
  private readonly environment: NodeJS.ProcessEnv
  private readonly home: string
  private readonly checkAccess: CandidateAccess
  private readonly probe: DriverProber
  private readonly agentDirs: { prime: string; omp: string; pi: string }

  constructor(
    private readonly settings: () => Pick<AppSettings, 'cuaDriverMcpEnabled' | 'computerUseEnabled'>,
    options: CuaDriverServiceOptions = {},
  ) {
    this.platform = options.platform ?? process.platform
    this.environment = options.environment ?? process.env
    this.home = options.home ?? homedir()
    this.checkAccess = options.access ?? access
    this.probe = options.probe ?? probeCuaDriverExecutable
    const pathApi = this.platform === 'win32' ? win32 : posix
    this.agentDirs = options.agentDirs ?? {
      prime: pathApi.join(this.home, '.prime', 'agent'),
      omp: pathApi.join(this.home, '.omp', 'agent'),
      pi: pathApi.join(this.home, '.pi', 'agent'),
    }
  }

  async status(): Promise<CuaDriverStatus> {
    for (const candidate of cuaDriverExecutableCandidates(this.environment, this.platform, this.home)) {
      try {
        await this.checkAccess(candidate, this.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
        const probe = await this.probe(candidate)
        if (!probe.runnable) continue
        const detail = probe.supported
          ? `Cua Driver ${probe.version ?? ''} is ready at ${candidate}.`
          : `Cua Driver ${probe.version ?? 'unknown'} was found, but GooeyPi requires ${MIN_CUA_DRIVER_VERSION} or newer.`
        const status: CuaDriverStatus = {
          installed: true,
          supported: probe.supported,
          path: candidate,
          version: probe.version,
          enabled: this.settings().cuaDriverMcpEnabled && this.settings().computerUseEnabled,
          installUrl: CUA_DRIVER_INSTALL_URL,
          detail,
        }
        this.lastStatus = status
        return status
      } catch { /* keep probing bounded candidates */ }
    }
    const status: CuaDriverStatus = {
      installed: false,
      supported: false,
      path: null,
      version: null,
      enabled: this.settings().cuaDriverMcpEnabled && this.settings().computerUseEnabled,
      installUrl: CUA_DRIVER_INSTALL_URL,
      detail: 'Cua Driver was not detected. Install it, then refresh this page.',
    }
    this.lastStatus = status
    return status
  }

  executable(): string | null {
    return this.lastStatus?.installed && this.lastStatus.supported ? this.lastStatus.path : null
  }

  async requireAvailable(): Promise<CuaDriverStatus> {
    const status = await this.status()
    if (!status.installed || !status.supported || !status.path) {
      throw new Error(`${status.detail} Install Cua Driver from ${CUA_DRIVER_INSTALL_URL}`)
    }
    return status
  }

  async setEnabled(enabled: boolean): Promise<CuaDriverStatus> {
    const status = enabled ? await this.requireAvailable() : await this.status()
    const config: ManagedStdioMcpServer | null = enabled && status.path ? {
      type: 'stdio',
      command: status.path,
      args: ['mcp'],
      env: { [MANAGED_MARKER.key]: MANAGED_MARKER.value },
      enabled: true,
    } : null
    const targets = [
      { path: (this.platform === 'win32' ? win32 : posix).join(this.agentDirs.prime, 'settings.json'), agentName: 'Prime Agent' },
      { path: (this.platform === 'win32' ? win32 : posix).join(this.agentDirs.omp, 'mcp.json'), agentName: 'OMP', schema: OMP_MCP_SCHEMA },
      { path: (this.platform === 'win32' ? win32 : posix).join(this.agentDirs.pi, 'mcp.json'), agentName: 'Pi' },
    ]
    const changed: typeof targets = []
    try {
      for (const target of targets) {
        const result = await updateManagedMcpServer(target.path, MANAGED_SERVER_NAME, config, MANAGED_MARKER, target)
        if (!result.ok) throw new Error(result.output)
        changed.push(target)
      }
    } catch (error) {
      if (enabled) {
        await Promise.allSettled(changed.map((target) => updateManagedMcpServer(target.path, MANAGED_SERVER_NAME, null, MANAGED_MARKER, target)))
      }
      throw error
    }
    const next = { ...status, enabled }
    this.lastStatus = next
    return next
  }
}
