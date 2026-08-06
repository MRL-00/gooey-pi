import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRpcManager } from '../../electron/main/agent-rpc'
import { ScheduleService } from '../../electron/main/settings-schedules'
import type { RuntimeInfo } from '../../src/types/api'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const runtime = (runtimeId: string): RuntimeInfo => ({ runtimeId, cwd: '/tmp', isStreaming: false })
const job = (id: string) => ({ id, prompt: `Prompt ${id}`, label: `Job ${id}`, status: 'active', schedule: { type: 'cron', expression: '0 9 * * *' } })

function agents(ids: string[], command: (runtimeId: string) => Promise<Record<string, unknown>>): AgentRpcManager {
  return { list: () => ids.map(runtime), command } as unknown as AgentRpcManager
}

describe('ScheduleService catalog completeness', () => {
  it('merges complete runtime catalogs and records their owner', async () => {
    const service = new ScheduleService(agents(['one', 'two'], async (id) => ({ data: { jobs: [job(id)] } })), null)
    expect((await service.list()).map((item) => [item.id, item.runtimeId])).toEqual([['one', 'one'], ['two', 'two']])
  })

  it('rejects rather than returning an unexplained partial runtime catalog', async () => {
    const service = new ScheduleService(agents(['one', 'two'], async (id) => {
      if (id === 'two') throw new Error('runtime unavailable')
      return { data: { jobs: [job(id)] } }
    }), null)
    await expect(service.list()).rejects.toThrow(/catalog would be incomplete/i)
  })

  it('uses a successful CLI catalog to recover from a runtime failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-schedules-')); dirs.push(dir)
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ jobs: [${JSON.stringify(job('fallback'))}] }) + '\\n')
`)
    chmodSync(executable, 0o755)
    const service = new ScheduleService(agents(['broken'], async () => { throw new Error('runtime unavailable') }), executable)
    expect((await service.list()).map((item) => item.id)).toEqual(['fallback'])
  })
})
