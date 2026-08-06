import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginService } from '../../electron/main/plugins'

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
    await expect(first).resolves.toEqual(expect.any(Array))
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

    const records = await service.list(project)

    expect(records).toContainEqual(expect.objectContaining({ kind: 'prompt', location: 'project', path: realpathSync(inside) }))
    expect(records.some((record) => record.path === outside || record.path === join(notes, 'linked-outside.md'))).toBe(false)
  })
})

describe('PluginService MCP connections', () => {
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
    const record = (await service.list()).find((item) => item.name === 'local-studio')
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
    expect((await service.list(project)).find((item) => item.name === 'project-files')).toMatchObject({ kind: 'mcp', location: 'project' })
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

  it('serializes package installation before an MCP settings merge', async () => {
    const root = temp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const settingsPath = join(agentDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'test/model' }))
    const executable = join(root, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const fs=require('node:fs');setTimeout(()=>{fs.writeFileSync(${JSON.stringify(settingsPath)},JSON.stringify({defaultModel:'test/model',packageInstalled:true}));process.stdout.write('installed\\n')},100)
`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => resolve(path), { agentDir })

    const [installed, connected] = await Promise.all([
      service.install('npm:example-package'),
      service.connectMcp({ name: 'after-package', scope: 'user', type: 'stdio', command: 'safe-command' }),
    ])

    expect(installed.ok).toBe(true)
    expect(connected.ok).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(settings.packageInstalled).toBe(true)
    expect(settings.mcpServers['after-package'].command).toBe('safe-command')
  })

})
