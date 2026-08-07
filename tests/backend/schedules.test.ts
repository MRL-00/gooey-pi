import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRpcManager } from '../../electron/main/agent-rpc'
import { ScheduleService } from '../../electron/main/settings-schedules'
import type { RuntimeInfo } from '../../src/types/api'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const runtime = (runtimeId: string): RuntimeInfo => ({ runtimeId, cwd: '/tmp', isStreaming: false })
const job = (id: string, label = `Job ${id}`) => ({ id, prompt: `Prompt ${id}`, label, status: 'active', schedule: { type: 'cron', expression: '0 9 * * *' } })

function agents(ids: string[], command: (runtimeId: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>): AgentRpcManager {
  return { list: () => ids.map(runtime), command } as unknown as AgentRpcManager
}

function catalogExecutable(jobs: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-schedules-')); dirs.push(dir)
  const executable = join(dir, 'prime-agent.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify({ jobs }))} + '\\n')
`)
  chmodSync(executable, 0o755)
  return executable
}

function failingExecutable(stderr: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-schedules-')); dirs.push(dir)
  const executable = join(dir, 'prime-agent.cjs')
  const invocations = join(dir, 'invocations')
  writeFileSync(invocations, '')
  writeFileSync(executable, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(invocations)}, 'run\\n')
process.stderr.write(${JSON.stringify(stderr)} + '\\n')
process.exit(1)
`)
  chmodSync(executable, 0o755)
  return executable
}

function invocationCount(executable: string): number {
  return readFileSync(join(dirname(executable), 'invocations'), 'utf8').split('\n').filter(Boolean).length
}

describe('ScheduleService status normalization', () => {
  it('surfaces raw failed statuses as failed even without lastError', async () => {
    const service = new ScheduleService(agents(['one'], async () => ({ data: { jobs: [{ ...job('failed-job'), status: 'failed' }] } })), null)
    expect((await service.list()).map((item) => item.status)).toEqual(['failed'])
  })

  it('maps unrecognized statuses to unknown instead of completed', async () => {
    const service = new ScheduleService(agents(['one'], async () => ({
      data: { jobs: [
        { ...job('novel'), status: 'archived' },
        { ...job('novel-with-error'), status: 'archived', lastError: 'boom' },
        { ...job('recognized'), status: 'paused' },
      ] },
    })), null)
    expect((await service.list()).map((item) => [item.id, item.status])).toEqual([
      ['novel', 'unknown'],
      ['novel-with-error', 'unknown'],
      ['recognized', 'paused'],
    ])
  })
})

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
    const executable = catalogExecutable([job('fallback')])
    const service = new ScheduleService(agents(['broken'], async () => { throw new Error('runtime unavailable') }), executable)
    expect((await service.list()).map((item) => item.id)).toEqual(['fallback'])
  })

  it('treats a missing CLI executable as an empty catalog with one warning', async () => {
    const warnings: string[] = []
    const service = new ScheduleService(agents([], async () => ({})), join(tmpdir(), 'prime-work-does-not-exist', 'prime-agent'), (message) => warnings.push(message))

    expect(await service.list()).toEqual([])
    expect(await service.list()).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/unavailable/i)
  })

  it('treats an unknown-command CLI exit as an empty catalog and caches the negative result', async () => {
    const executable = failingExecutable('Unknown command: schedule')
    const warnings: string[] = []
    const service = new ScheduleService(agents([], async () => ({})), executable, (message) => warnings.push(message))

    expect(await service.list()).toEqual([])
    expect(await service.list()).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(invocationCount(executable)).toBe(1)
  })

  it('still throws on genuine CLI failures', async () => {
    const executable = failingExecutable('schedule storage is corrupted')
    const warnings: string[] = []
    const service = new ScheduleService(agents([], async () => ({})), executable, (message) => warnings.push(message))

    await expect(service.list()).rejects.toThrow(/complete schedule catalog/i)
    await expect(service.list()).rejects.toThrow(/complete schedule catalog/i)
    expect(warnings).toHaveLength(0)
    expect(invocationCount(executable)).toBe(2)
  })

  it('keeps deterministic runtime ownership when fallback IDs and names overlap', async () => {
    const executable = catalogExecutable([
      job('shared', 'Fallback duplicate'),
      job('fallback-named', 'Same name'),
    ])
    const calls: Array<{ runtimeId: string, request: Record<string, unknown> }> = []
    const service = new ScheduleService(agents(['owner', 'duplicate', 'broken'], async (runtimeId, request) => {
      calls.push({ runtimeId, request })
      if (request.type === 'cancel_schedule') return {}
      if (runtimeId === 'broken') throw new Error('runtime unavailable')
      if (runtimeId === 'duplicate') {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { data: { jobs: [job('shared', 'Later runtime duplicate')] } }
      }
      return { data: { jobs: [job('shared', 'Owned job'), job('runtime-named', 'Same name')] } }
    }), executable)

    const catalog = await service.list()
    expect(catalog.map((item) => [item.id, item.title, item.runtimeId])).toEqual([
      ['shared', 'Owned job', 'owner'],
      ['runtime-named', 'Same name', 'owner'],
      ['fallback-named', 'Same name', undefined],
    ])

    const shared = catalog.find((item) => item.id === 'shared')
    expect(shared).toBeDefined()
    await service.cancel(shared?.runtimeId, shared?.id)
    expect(calls.at(-1)).toEqual({
      runtimeId: 'owner',
      request: { type: 'cancel_schedule', jobId: 'shared' },
    })
  })
})
