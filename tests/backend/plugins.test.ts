import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginService, beginPluginDiscoveryShutdown } from '../../electron/main/plugins'
import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'prime-work-mcp-')); dirs.push(dir); return dir }

describe('PluginService discovery', () => {
  it('coalesces duplicate refreshes while discovery is in flight', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const first = service.list()
    const duplicate = service.refresh()

    expect(duplicate).toBe(first)
    await expect(first).resolves.toEqual({ skills: expect.any(Array), warnings: [] })
  })

  it('does not report a shared user settings tree as both user and project', async () => {
    const root = temp()
    const agentDir = join(root, '.prime', 'agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
      packages: ['local-package'],
      mcpServers: { 'local-server': { type: 'stdio', command: 'local-command' } },
    }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const catalog = await service.list(root)
    const packageRecords = catalog.skills.filter((item) => item.kind === 'package' && item.source === 'local-package')
    const mcpRecords = catalog.skills.filter((item) => item.kind === 'mcp' && item.name === 'local-server')

    expect(packageRecords).toHaveLength(1)
    expect(packageRecords[0]).toMatchObject({ location: 'user' })
    expect(mcpRecords).toHaveLength(1)
    expect(mcpRecords[0]).toMatchObject({ location: 'user' })
  })

  it('coalesces lexical aliases after project authorization canonicalizes them', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const alias = join(root, 'project-alias')
    mkdirSync(agentDir); mkdirSync(project); symlinkSync(project, alias)
    let discoveries = 0
    const service = new PluginService(null, async (path) => realpathSync(path), {
      agentDir,
      discover: async () => { discoveries += 1; await new Promise((resolveWait) => setTimeout(resolveWait, 20)); return { skills: [], warnings: [] } },
    })

    await Promise.all([service.list(project), service.list(alias)])

    expect(discoveries).toBe(1)
  })

  it('coalesces hostile concurrent nested paths to their authorized project root', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const pluginPrompt = join(project, 'project-prompt.md')
    mkdirSync(agentDir); mkdirSync(project); writeFileSync(pluginPrompt, '# Project prompt')
    const nestedPaths = Array.from({ length: 96 }, (_, index) => join(project, 'workspaces', String(index), 'deep'))
    for (const path of nestedPaths) mkdirSync(path, { recursive: true })

    const store = new JsonStateStore(join(root, 'state.json'))
    const info = lstatSync(project, { bigint: true })
    await store.update((state) => { state.projects.push({
      id: 'project', name: 'Project', path: project, folders: [project], primaryFolder: project, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
      folderIdentities: { [realpathSync(project)]: { dev: info.dev.toString(), ino: info.ino.toString() } },
    }) })
    const projects = new ProjectService(store, () => null)
    await projects.list()

    let authorized = 0
    let signalAuthorized: () => void = () => undefined
    const allAuthorized = new Promise<void>((resolveWait) => { signalAuthorized = resolveWait })
    let releaseDiscovery: () => void = () => undefined
    const discoveryGate = new Promise<void>((resolveWait) => { releaseDiscovery = resolveWait })
    let discoveries = 0
    const discoveredRoots = new Set<string | undefined>()
    const service = new PluginService(null, async (path) => {
      const authorizedRoot = await projects.authorizeProjectRoot(path)
      authorized += 1
      if (authorized === nestedPaths.length) signalAuthorized()
      return authorizedRoot
    }, {
      agentDir,
      discover: async (_agentDir, projectPath) => {
        discoveries += 1
        discoveredRoots.add(projectPath)
        await discoveryGate
        return { skills: [{
          id: 'project-prompt', name: 'Project prompt', description: '', kind: 'prompt',
          location: 'project', path: realpathSync(pluginPrompt), enabled: true,
        }], warnings: [] }
      },
    })

    const requests = nestedPaths.map((path) => service.list(path))
    await allAuthorized
    expect(discoveries).toBe(1)
    expect(discoveredRoots).toEqual(new Set([realpathSync(project)]))
    releaseDiscovery()
    const results = await Promise.all(requests)

    expect(new Set(results).size).toBe(1)
    expect(service.authorizeReveal(pluginPrompt)).toBe(realpathSync(pluginPrompt))
  })

  it('rejects excess distinct discovery work instead of growing the global queue', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let releaseDiscovery: () => void = () => undefined
    const discoveryGate = new Promise<void>((resolveWait) => { releaseDiscovery = resolveWait })
    let active = 0
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      discover: async () => {
        active += 1
        await discoveryGate
        active -= 1
        return { skills: [], warnings: [] }
      },
    })

    const outcomes = Array.from({ length: 40 }, (_, index) => service.list(join(root, `hostile-${index}`)))
      .map((request) => request.then(() => 'fulfilled', (error: unknown) => error))
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    const internal = service as unknown as { discoveryInFlight: Map<string, Promise<unknown>> }

    expect(active).toBe(2)
    expect(internal.discoveryInFlight.size).toBeLessThanOrEqual(34)
    releaseDiscovery()
    const settled = await Promise.all(outcomes)
    const rejected = settled.filter((outcome) => outcome !== 'fulfilled')
    expect(rejected).toHaveLength(6)
    expect(rejected.every((error) => error instanceof TypeError && error.message.includes('Too many plugin discoveries'))).toBe(true)
  })

  it('rejects queued discovery waiters on shutdown so pending lists settle', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let releaseDiscovery: () => void = () => undefined
    const discoveryGate = new Promise<void>((resolveWait) => { releaseDiscovery = resolveWait })
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      discover: async () => { await discoveryGate; return { skills: [], warnings: [] } },
    })

    const outcomes = Array.from({ length: 4 }, (_, index) => service.list(join(root, `pending-${index}`)))
      .map((request) => request.then(() => 'fulfilled', (error: unknown) => error))
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))

    beginPluginDiscoveryShutdown()
    releaseDiscovery()
    const settled = await Promise.all(outcomes)

    expect(settled.filter((outcome) => outcome === 'fulfilled')).toHaveLength(2)
    const rejected = settled.filter((outcome) => outcome !== 'fulfilled')
    expect(rejected).toHaveLength(2)
    expect(rejected.every((error) => error instanceof TypeError && error.message.includes('shutting down'))).toBe(true)
  })

  it('bounds catalog work globally across distinct discovery keys', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    let active = 0
    let peak = 0
    const service = new PluginService(null, async (path) => resolve(path), {
      agentDir,
      discover: async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
        active -= 1
        return { skills: [], warnings: [] }
      },
    })

    await Promise.all(Array.from({ length: 8 }, (_, index) => service.list(join(root, `project-${index}`))))

    expect(peak).toBe(2)
  })

  it('surfaces a structured warning for invalid settings.json instead of silently hiding plugins', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    const skillDir = join(agentDir, 'skills', 'local')
    mkdirSync(skillDir, { recursive: true }); mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: local\n---\nLocal skill')
    writeFileSync(join(agentDir, 'settings.json'), '{ this is not json')
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify(['not', 'an', 'object']))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const catalog = await service.list(project)

    expect(catalog.warnings).toEqual([
      { scope: 'user', path: join(agentDir, 'settings.json'), message: 'settings.json invalid — plugins hidden' },
      { scope: 'project', path: join(realpathSync(project), '.prime', 'agent', 'settings.json'), message: 'settings.json invalid — plugins hidden' },
    ])
    expect(catalog.skills).toContainEqual(expect.objectContaining({ name: 'local', kind: 'skill' }))
  })

  it('retains reveal authorization independently for user and project catalogs', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    const userPrompt = join(root, 'agent', 'user-prompt.md')
    const projectPrompt = join(project, 'project-prompt.md')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(userPrompt, '# User prompt')
    writeFileSync(projectPrompt, '# Project prompt')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ prompts: [userPrompt] }))
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({ prompts: [projectPrompt] }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    await service.list()
    await service.list(project)

    expect(service.authorizeReveal(userPrompt)).toBe(realpathSync(userPrompt))
    expect(service.authorizeReveal(projectPrompt)).toBe(realpathSync(projectPrompt))
  })

  it('re-authorizes refresh scope and revokes reveal paths after project removal', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    const projectPrompt = join(project, 'project-prompt.md')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true })
    writeFileSync(projectPrompt, '# Project prompt')
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({ prompts: [projectPrompt] }))
    const store = new JsonStateStore(join(root, 'state.json'))
    const info = lstatSync(project, { bigint: true })
    await store.update((state) => { state.projects.push({
      id: 'project', name: 'Project', path: project, folders: [project], primaryFolder: project, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
      folderIdentities: { [realpathSync(project)]: { dev: info.dev.toString(), ino: info.ino.toString() } },
    }) })
    const projectsService = new ProjectService(store, () => null)
    projectsService.bindProviders({
      sessions: async () => [],
      branch: async () => undefined,
      stopProjectProcesses: async (roots) => service.evictProjects(roots),
    })
    const service = new PluginService(null, (path) => projectsService.authorizeProjectRoot(path), { agentDir })

    await service.list(project)
    expect(service.authorizeReveal(projectPrompt)).toBe(realpathSync(projectPrompt))

    expect(await projectsService.remove('project')).toBe(true)
    await expect(service.refresh()).rejects.toThrow(/not inside an added Prime Work project/)
    expect(() => service.authorizeReveal(projectPrompt)).toThrow('plugin path was not discovered')
  })

  it('bounds the reveal path owners to a fixed LRU window', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const projectFor = (index: number) => {
      const project = join(root, `project-${index}`)
      mkdirSync(project)
      writeFileSync(join(project, 'prompt.md'), `# ${index}`)
      return project
    }
    const projects = Array.from({ length: 66 }, (_, index) => projectFor(index))
    const service = new PluginService(null, async (path) => realpathSync(path), {
      agentDir,
      discover: async (_agentDirectory, safeProjectPath) => safeProjectPath
        ? { skills: [{ id: `skill-${safeProjectPath}`, name: 'Prompt', description: '', kind: 'prompt', location: 'project', path: join(safeProjectPath, 'prompt.md'), enabled: true }], warnings: [] }
        : { skills: [], warnings: [] },
    })

    for (const project of projects) await service.list(project)

    expect(() => service.authorizeReveal(join(projects[0], 'prompt.md'))).toThrow('plugin path was not discovered')
    expect(service.authorizeReveal(join(projects.at(-1)!, 'prompt.md'))).toBe(realpathSync(join(projects.at(-1)!, 'prompt.md')))
  })

  it('discovers only the authorized project .agents root without walking ancestors', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'workspace', 'project')
    const localSkill = join(project, '.agents', 'skills', 'local', 'SKILL.md')
    const ancestorSkill = join(root, 'workspace', '.agents', 'skills', 'ancestor', 'SKILL.md')
    mkdirSync(agentDir)
    mkdirSync(resolve(localSkill, '..'), { recursive: true })
    mkdirSync(resolve(ancestorSkill, '..'), { recursive: true })
    writeFileSync(localSkill, '---\nname: local\n---\nLocal skill')
    writeFileSync(ancestorSkill, '---\nname: ancestor\n---\nAncestor skill')
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const { skills: records } = await service.list(project)

    expect(records).toContainEqual(expect.objectContaining({ name: 'local', path: realpathSync(localSkill) }))
    expect(records.some((record) => record.path === realpathSync(ancestorSkill))).toBe(false)
    expect(readFileSync('electron/main/plugins/catalog.ts', 'utf8')).not.toContain('collectAncestorSkills')
  })

  it('keeps user-configured discovery contained to the agent directory and home', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const inside = join(agentDir, 'inside-prompt.md')
    const outside = join(root, 'outside-prompt.md')
    mkdirSync(agentDir)
    writeFileSync(inside, '# Inside\ncontained user discovery')
    writeFileSync(outside, '# Outside\nshould not be disclosed')
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ prompts: [inside, outside] }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const { skills: records } = await service.list()

    expect(records).toContainEqual(expect.objectContaining({ kind: 'prompt', location: 'user', path: realpathSync(inside) }))
    expect(records.some((record) => record.path === outside || record.path === realpathSync(outside))).toBe(false)
  })

  it('keeps project-configured discovery contained while accepting in-project files', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    const notes = join(project, 'notes')
    const outside = join(root, 'outside.md')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true }); mkdirSync(notes)
    const inside = join(notes, 'inside.md')
    writeFileSync(inside, '# Inside\ncontained discovery')
    writeFileSync(outside, '# Outside\nshould not be disclosed')
    symlinkSync(outside, join(notes, 'linked-outside.md'))
    writeFileSync(join(projectAgentDir, 'settings.json'), JSON.stringify({
      prompts: [inside, outside, join(notes, 'linked-outside.md')],
    }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })

    const { skills: records } = await service.list(project)

    expect(records).toContainEqual(expect.objectContaining({ kind: 'prompt', location: 'project', path: realpathSync(inside) }))
    expect(records.some((record) => record.path === outside || record.path === join(notes, 'linked-outside.md'))).toBe(false)
  })
})

describe('PluginService MCP connections', () => {
  it('keeps project settings preparation free of synchronous fs syscalls', () => {
    // renameSync is the one deliberate exception (kept adjacent to its identity
    // checks); everything else in the settings path must be fs/promises.
    const source = readFileSync('electron/main/plugins/mcp.ts', 'utf8')
    expect(source).not.toMatch(/\b(?:existsSync|lstatSync|mkdirSync|realpathSync|readFileSync|writeFileSync|rmSync)\b/)
  })

  it('connects an HTTP MCP server without treating its URL as a package repository', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: 'test/model' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const response = await service.connectMcp({
      name: 'local-studio',
      scope: 'user',
      type: 'http',
      url: 'http://127.0.0.1:3333/mcp',
    })

    expect(response.ok).toBe(true)
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(settings.defaultModel).toBe('test/model')
    expect(settings.mcpServers['local-studio']).toEqual({ type: 'http', url: 'http://127.0.0.1:3333/mcp', enabled: true })
    const record = (await service.list()).skills.find((item) => item.name === 'local-studio')
    expect(record).toMatchObject({ kind: 'mcp', location: 'user', enabled: true, source: 'http://127.0.0.1:3333' })
    expect(record?.description).not.toContain('/mcp')
  })

  it('connects a stdio MCP server at project scope with argv kept separate', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    mkdirSync(project)
    const service = new PluginService(null, async (path) => {
      expect(path).toBe(project)
      return resolve(path)
    }, { agentDir })

    const response = await service.connectMcp({
      name: 'project-files',
      scope: 'project',
      projectPath: project,
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', project],
    })

    expect(response.ok).toBe(true)
    const settings = JSON.parse(readFileSync(join(project, '.prime', 'agent', 'settings.json'), 'utf8'))
    expect(settings.mcpServers['project-files']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', project],
      enabled: true,
    })
    expect((await service.list(project)).skills.find((item) => item.name === 'project-files')).toMatchObject({ kind: 'mcp', location: 'project' })
  })

  it('rejects project MCP settings paths that traverse repository symlinks', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const outside = join(root, 'outside')
    mkdirSync(project); mkdirSync(outside)
    symlinkSync(outside, join(project, '.prime'))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    await expect(service.connectMcp({
      name: 'escaped', scope: 'project', projectPath: project, type: 'http', url: 'http://127.0.0.1:3333/mcp',
    })).rejects.toThrow(/real directory/)
    expect(() => readFileSync(join(outside, 'agent', 'settings.json'))).toThrow()
  })

  it('fails closed when the project MCP directory is substituted at the final rename boundary', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    const project = join(root, 'project')
    const projectAgentDir = join(project, '.prime', 'agent')
    const displacedAgentDir = join(project, '.prime', 'agent-original')
    const outside = join(root, 'outside')
    mkdirSync(agentDir); mkdirSync(projectAgentDir, { recursive: true }); mkdirSync(outside)
    const settingsPath = join(projectAgentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    writeFileSync(join(outside, 'settings.json'), JSON.stringify({ outside: 'unchanged' }))
    const service = new PluginService(null, async (path) => realpathSync(path), { agentDir })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let substituted = false
    internal.settingsFingerprint = async (path) => {
      const fingerprint = await original(path)
      if (!substituted) {
        substituted = true
        const temporaryName = readdirSync(projectAgentDir).find((name) => name.startsWith('settings.json.') && name.endsWith('.tmp'))
        expect(temporaryName).toBeTypeOf('string')
        const stagedSettings = readFileSync(join(projectAgentDir, temporaryName!), 'utf8')
        renameSync(projectAgentDir, displacedAgentDir)
        symlinkSync(outside, projectAgentDir, 'dir')
        // Recreate the observed random staging name so the vulnerable lexical
        // rename would overwrite settings in the substituted directory.
        writeFileSync(join(outside, temporaryName!), stagedSettings)
      }
      return fingerprint
    }

    await expect(service.connectMcp({
      name: 'escaped', scope: 'project', projectPath: project, type: 'stdio', command: 'safe-command',
    })).rejects.toThrow(/configuration directory changed/)

    expect(substituted).toBe(true)
    expect(JSON.parse(readFileSync(join(outside, 'settings.json'), 'utf8')).outside).toBe('unchanged')
    expect(JSON.parse(readFileSync(join(displacedAgentDir, 'settings.json'), 'utf8')).mcpServers).toBeUndefined()
  })

  it('rejects credentialed URLs and refuses to overwrite an existing server', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ mcpServers: { existing: { type: 'stdio', command: 'safe' } } }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    await expect(service.connectMcp({ name: 'secret', scope: 'user', type: 'http', url: 'https://token@example.test/mcp' })).rejects.toThrow(/credentials/)
    const duplicate = await service.connectMcp({ name: 'existing', scope: 'user', type: 'stdio', command: 'other' })
    expect(duplicate.ok).toBe(false)
    expect(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')).mcpServers.existing.command).toBe('safe')
  })

  it('serializes updates across service instances and rereads settings after locking', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: 'test/model' }))
    const first = new PluginService(null, async (path) => resolve(path), { agentDir })
    const second = new PluginService(null, async (path) => resolve(path), { agentDir })

    const responses = await Promise.all([
      first.connectMcp({ name: 'first', scope: 'user', type: 'stdio', command: 'first-command' }),
      second.connectMcp({ name: 'second', scope: 'user', type: 'stdio', command: 'second-command' }),
    ])

    expect(responses.every((response) => response.ok)).toBe(true)
    const settings = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    expect(settings.defaultModel).toBe('test/model')
    expect(settings.mcpServers.first.command).toBe('first-command')
    expect(settings.mcpServers.second.command).toBe('second-command')
  })

  it('recovers a lock only after its recorded owner has exited', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const exitedPid = exited.pid
    expect(exitedPid).toBeTypeOf('number')
    await new Promise<void>((resolveExit, rejectExit) => {
      exited.once('error', rejectExit)
      exited.once('exit', () => resolveExit())
    })
    const lockPath = `${settingsPath}.lock`
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({
      version: 1,
      pid: exitedPid,
      token: 'exited-test-owner',
      createdAt: Date.now() - 1_000,
    }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })

    const response = await service.connectMcp({ name: 'after-crash', scope: 'user', type: 'stdio', command: 'safe-command' })

    expect(response.ok).toBe(true)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers['after-crash'].command).toBe('safe-command')
    expect(() => readFileSync(join(lockPath, 'owner.json'))).toThrow()
  })

  it('detects and merges a non-cooperating writer update before rename', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let injected = false
    internal.settingsFingerprint = async (path) => {
      if (!injected) {
        injected = true
        writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model', changedByCli: true }))
      }
      return original(path)
    }

    expect((await service.connectMcp({ name: 'merged', scope: 'user', type: 'stdio', command: 'safe-command' })).ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.changedByCli).toBe(true)
    expect(settings.mcpServers.merged.command).toBe('safe-command')
  })

  it('retries multiple non-cooperating writer conflicts and merges the latest snapshot', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let conflicts = 0
    internal.settingsFingerprint = async (path) => {
      if (conflicts < 2) {
        conflicts += 1
        writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model', externalRevision: conflicts }))
      }
      return original(path)
    }

    expect((await service.connectMcp({ name: 'after-retries', scope: 'user', type: 'stdio', command: 'safe-command' })).ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(conflicts).toBe(2)
    expect(settings.externalRevision).toBe(2)
    expect(settings.mcpServers['after-retries'].command).toBe('safe-command')
  })

  it('fails after bounded conflicts without replacing the external writer snapshot', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    const service = new PluginService(null, async (path) => resolve(path), { agentDir })
    const internal = service as unknown as { settingsFingerprint(path: string): Promise<string> }
    const original = internal.settingsFingerprint.bind(service)
    let externalRevision = 0
    internal.settingsFingerprint = async (path) => {
      externalRevision += 1
      writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model', externalRevision }))
      return original(path)
    }

    await expect(service.connectMcp({ name: 'never-written', scope: 'user', type: 'stdio', command: 'safe-command' }))
      .rejects.toThrow(/changed repeatedly/)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(externalRevision).toBe(4)
    expect(settings.externalRevision).toBe(4)
    expect(settings.mcpServers).toBeUndefined()
  })

  it('serializes package installation before an MCP settings merge', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    const executable = join(root, 'prime-agent.cjs')
    const installStarted = join(root, 'install-started')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(installStarted)},'');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(settingsPath)},JSON.stringify({defaultModel:'test/model',packageInstalled:true}));process.stdout.write('installed\\n')},100)
`)
    chmodSync(executable, 0o755)
    const installer = new PluginService(executable, async (path) => resolve(path), { agentDir })
    const connector = new PluginService(null, async (path) => resolve(path), { agentDir })

    const installPromise = installer.install('npm:example-package')
    for (let attempt = 0; attempt < 200 && !existsSync(installStarted); attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    expect(existsSync(installStarted)).toBe(true)
    const [installed, connected] = await Promise.all([
      installPromise,
      connector.connectMcp({ name: 'after-package', scope: 'user', type: 'stdio', command: 'safe-command' }),
    ])

    expect(installed.ok).toBe(true)
    expect(connected.ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.packageInstalled).toBe(true)
    expect(settings.mcpServers['after-package'].command).toBe('safe-command')
  })

})
