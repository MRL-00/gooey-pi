import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRpcManager } from '../../electron/main/agent-rpc'
import { PluginService } from '../../electron/main/plugins'
import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'
import type { SessionRecord } from '../../src/types/api'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir }

describe('security boundaries', () => {
  it('does not expose project-configured files outside the project root', async () => {
    const project = temp('prime-work-plugin-')
    const config = join(project, '.prime', 'agent')
    mkdirSync(config, { recursive: true })
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ prompts: ['/etc/hosts'] }))
    const service = new PluginService(null, async () => resolve(project))
    const records = await service.list(project)
    expect(records.some((record) => record.path === '/private/etc/hosts' || record.path === '/etc/hosts')).toBe(false)
  })

  it('revokes a removed project immediately and ignores a session rooted at filesystem root', async () => {
    const dir = temp('prime-work-project-')
    const folder = join(dir, 'project'); mkdirSync(folder)
    const store = new JsonStateStore(join(dir, 'state.json'))
    await store.update((state) => { state.projects.push({ id: 'project-1', name: 'Project', path: folder, folders: [folder], primaryFolder: folder, pinned: false, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }) })
    const service = new ProjectService(store, () => null)
    service.bindProviders({
      sessions: async () => [{ id: 'unsafe', filePath: join(dir, 'unsafe.jsonl'), projectPath: '/', title: 'unsafe', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', depth: 0, pinned: false, unread: false } satisfies SessionRecord],
      branch: async () => undefined,
    })
    const listed = await service.list()
    expect(listed.some((project) => project.path === '/')).toBe(false)
    expect(await service.authorizeCwd(folder)).toBe(realpathSync(folder))
    expect(await service.remove('project-1')).toBe(true)
    await expect(service.authorizeCwd(folder)).rejects.toThrow(/not inside/)
  })

  it('lists an inferred project without recursively authorizing it for Git execution', async () => {
    const dir = temp('prime-work-inferred-')
    const folder = join(dir, 'project'); mkdirSync(folder)
    const store = new JsonStateStore(join(dir, 'state.json'))
    const service = new ProjectService(store, () => null)
    let branchCalls = 0
    service.bindProviders({
      sessions: async () => [{ id: 'session', filePath: join(dir, 'session.jsonl'), projectPath: folder, title: 'session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', depth: 0, pinned: false, unread: false } satisfies SessionRecord],
      branch: async (cwd) => { branchCalls += 1; await service.authorizeCwd(cwd); return undefined },
    })
    const listed = await service.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].inferred).toBe(true)
    expect(branchCalls).toBe(0)
    await expect(service.authorizeCwd(folder)).rejects.toThrow(/not inside/)
  })

  it('awaits TERM/KILL escalation for an RPC child that refuses graceful shutdown', async () => {
    const dir = temp('prime-work-agent-stop-')
    const executable = join(dir, 'fake-agent.cjs')
    const pidFile = join(dir, 'pid')
    writeFileSync(executable, `#!/usr/bin/env node
const readline=require('node:readline');const fs=require('node:fs');fs.writeFileSync(process.env.PRIME_WORK_TEST_PID_FILE,String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);readline.createInterface({input:process.stdin}).on('line',(line)=>{const v=JSON.parse(line);if(v.type==='get_state')process.stdout.write(JSON.stringify({type:'response',id:v.id,success:true,data:{isStreaming:false}})+'\\n')});process.stdin.resume();`)
    chmodSync(executable, 0o755)
    process.env.PRIME_WORK_TEST_PID_FILE = pidFile
    const manager = new AgentRpcManager(executable, async (cwd) => cwd, async (path) => path)
    const runtime = await manager.start({ cwd: dir })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const started = Date.now()
    expect(await manager.stop(runtime.runtimeId)).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_500)
    expect(() => process.kill(pid, 0)).toThrow()
    delete process.env.PRIME_WORK_TEST_PID_FILE
  }, 10_000)
})
