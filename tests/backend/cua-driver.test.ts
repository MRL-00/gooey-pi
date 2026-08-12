import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CuaDriverService, cuaDriverExecutableCandidates } from '../../electron/main/cua-driver'

const dirs: string[] = []

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gooeypi-cua-driver-'))
  dirs.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('cuaDriverExecutableCandidates', () => {
  it('discovers absolute PATH and standard candidates on macOS, Windows, and Linux', () => {
    expect(cuaDriverExecutableCandidates({ PATH: '/custom/bin:/usr/bin' }, 'darwin', '/Users/test')).toContain('/opt/homebrew/bin/cua-driver')
    expect(cuaDriverExecutableCandidates({ Path: 'C:\\Tools;C:\\Windows', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, 'win32', 'C:\\Users\\test')).toContain('C:\\Tools\\cua-driver.exe')
    expect(cuaDriverExecutableCandidates({ PATH: '/custom/bin' }, 'linux', '/home/test')).toContain('/home/linuxbrew/.linuxbrew/bin/cua-driver')
  })

  it('honors only an absolute CUA_DRIVER_PATH override and deduplicates candidates', () => {
    const candidates = cuaDriverExecutableCandidates({ CUA_DRIVER_PATH: '/opt/cua-driver', PATH: '/opt:/opt' }, 'linux', '/home/test')
    expect(candidates[0]).toBe('/opt/cua-driver')
    expect(candidates.filter((candidate) => candidate === '/opt/cua-driver')).toHaveLength(1)
    expect(cuaDriverExecutableCandidates({ CUA_DRIVER_PATH: 'relative/cua-driver', PATH: '' }, 'linux', '/home/test')).not.toContain('relative/cua-driver')
  })
})

describe('CuaDriverService', () => {
  it('reports an actionable unavailable state when no runnable driver is found', async () => {
    const service = new CuaDriverService(
      () => ({ cuaDriverMcpEnabled: false, computerUseEnabled: false }),
      { platform: 'linux', home: '/home/test', environment: { PATH: '/missing' }, access: vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }) },
    )
    await expect(service.status()).resolves.toMatchObject({ installed: false, supported: false, path: null, installUrl: 'https://cua.ai/driver' })
    await expect(service.requireAvailable()).rejects.toThrow('Install Cua Driver')
  })

  it('writes and removes only the managed Prime MCP entry', async () => {
    const root = makeDirectory()
    const executable = join(root, 'bin', 'cua-driver')
    const agentDirs = { prime: join(root, 'prime'), omp: join(root, 'omp'), pi: join(root, 'pi') }
    const service = new CuaDriverService(
      () => ({ cuaDriverMcpEnabled: true, computerUseEnabled: true }),
      {
        platform: 'linux', home: root, environment: { CUA_DRIVER_PATH: executable }, agentDirs,
        access: vi.fn(async (candidate) => { if (candidate !== executable) throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }),
        probe: vi.fn(async () => ({ runnable: true, version: '0.19.0', supported: true })),
      },
    )

    await expect(service.setEnabled(true)).resolves.toMatchObject({ enabled: true, path: executable })
    for (const [harness, file] of [['prime', 'settings.json']] as const) {
      const settings = JSON.parse(readFileSync(join(agentDirs[harness], file), 'utf8')) as Record<string, unknown>
      expect(settings).toMatchObject({ mcpServers: { 'gooeypi-cua-driver': { type: 'stdio', command: executable, args: ['mcp'], env: { GOOEYPI_MANAGED_CUA_DRIVER: '1' }, enabled: true } } })
    }

    await service.setEnabled(false)
    for (const [harness, file] of [['prime', 'settings.json']] as const) {
      const settings = JSON.parse(readFileSync(join(agentDirs[harness], file), 'utf8')) as Record<string, unknown>
      expect(settings.mcpServers).toBeUndefined()
    }
  })

  it('does not overwrite a user-owned entry that uses the reserved managed name', async () => {
    const root = makeDirectory()
    const executable = join(root, 'cua-driver')
    const agentDirs = { prime: join(root, 'prime'), omp: join(root, 'omp'), pi: join(root, 'pi') }
    mkdirSync(agentDirs.prime, { recursive: true })
    writeFileSync(join(agentDirs.prime, 'settings.json'), JSON.stringify({ mcpServers: { 'gooeypi-cua-driver': { type: 'stdio', command: '/user/command' } } }))
    const service = new CuaDriverService(
      () => ({ cuaDriverMcpEnabled: true, computerUseEnabled: true }),
      {
        platform: 'linux', home: root, environment: { CUA_DRIVER_PATH: executable }, agentDirs,
        access: vi.fn(async (candidate) => { if (candidate !== executable) throw new Error('missing') }),
        probe: vi.fn(async () => ({ runnable: true, version: '0.19.0', supported: true })),
      },
    )

    await expect(service.setEnabled(true)).rejects.toThrow('not managed by GooeyPi')
    expect(JSON.parse(readFileSync(join(agentDirs.prime, 'settings.json'), 'utf8'))).toMatchObject({ mcpServers: { 'gooeypi-cua-driver': { command: '/user/command' } } })
  })
})
