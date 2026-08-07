import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleExecution, ScheduleTarget } from '../../src/types/api'
import { AutomationService } from '../../electron/main/schedules/service'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
function store(): JsonStateStore {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-automation-'))
  dirs.push(dir)
  return new JsonStateStore(join(dir, 'state.json'))
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const target: ScheduleTarget = { kind: 'project', projectId: 'project-one' }
const execution: ScheduleExecution = { model: 'auto', thinking: 'auto', speed: 'normal' }
const onceAt = (time: string) => ({ kind: 'once' as const, at: time })

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try { assertion(); return } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
  }
  assertion()
}

describe('AutomationService', () => {
  it('creates, updates, pauses, resumes, and deletes versioned tasks', async () => {
    let now = new Date('2030-01-01T00:00:00Z')
    const service = new AutomationService(store(), {
      validateTarget: vi.fn(async () => undefined),
      validateExecution: vi.fn(async () => undefined),
      run: vi.fn(async () => ({})),
      now: () => now,
    })
    const created = await service.create({
      title: 'Triage', prompt: 'Review issues', target,
      timing: onceAt('2030-01-02T09:00:00Z'), execution,
    })
    expect(created).toMatchObject({ revision: 1, status: 'active', createdBy: 'user', nextRunAt: '2030-01-02T09:00:00.000Z' })

    now = new Date('2030-01-01T01:00:00Z')
    const updated = await service.update(created.id, { revision: 1, title: 'Morning triage', timing: onceAt('2030-01-03T09:00:00Z') })
    expect(updated).toMatchObject({ revision: 2, title: 'Morning triage', nextRunAt: '2030-01-03T09:00:00.000Z' })
    await expect(service.update(created.id, { revision: 1, title: 'stale' })).rejects.toThrow(/changed/i)

    const paused = await service.pause(created.id)
    expect(paused).toMatchObject({ revision: 3, status: 'paused', nextRunAt: undefined })
    const resumed = await service.resume(created.id)
    expect(resumed).toMatchObject({ revision: 4, status: 'active', nextRunAt: '2030-01-03T09:00:00.000Z' })
    expect(await service.delete(created.id)).toBe(true)
    expect(service.list()).toEqual([])
  })

  it('runs a manual project task and persists its linked session result', async () => {
    const run = vi.fn(async () => ({ sessionId: 'fresh-session', sessionFile: '/tmp/fresh-session.jsonl' }))
    const service = new AutomationService(store(), {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run,
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    await service.start()
    const task = await service.create({ prompt: 'Do the work', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const queued = await service.runNow(task.id)
    expect(queued.status).toBe('queued')
    await eventually(() => expect(service.get(task.id).runs[0]).toMatchObject({
      id: queued.id, status: 'succeeded', sessionId: 'fresh-session', sessionFile: '/tmp/fresh-session.jsonl',
    }))
    expect(run).toHaveBeenCalledOnce()
    await service.stop()
  })

  it('records missed occurrences as skipped without dispatching them', async () => {
    const stateStore = store()
    let now = new Date('2030-01-01T00:00:00Z')
    const run = vi.fn(async () => ({}))
    const service = new AutomationService(stateStore, {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run,
      now: () => now,
    })
    const task = await service.create({
      prompt: 'Hourly check', target,
      timing: { kind: 'rrule', dtstartLocal: '2030-01-01T01:00:00', timeZone: 'UTC', rrule: 'FREQ=HOURLY' }, execution,
    })
    now = new Date('2030-01-01T04:30:00Z')
    await service.start()
    const recovered = service.get(task.id)
    expect(recovered.runs[0]).toMatchObject({ status: 'skipped', skippedCount: 4 })
    expect(recovered.nextRunAt).toBe('2030-01-01T05:00:00.000Z')
    expect(run).not.toHaveBeenCalled()
    await service.stop()
  })
})
