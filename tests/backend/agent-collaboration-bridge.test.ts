import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCollaborationBridge } from '../../electron/main/collaboration/agent-bridge'
import { configureGooeyPiAgentMessageSigning, parseGooeyPiAgentMessage } from '../../electron/main/collaboration/message-envelope'
import type { AgentRpcManager } from '../../electron/main/agent-rpc'
import type { HarnessId, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'

const bridges: AgentCollaborationBridge[] = []
configureGooeyPiAgentMessageSigning(Buffer.alloc(32, 7))

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
})

const source: SessionRecord = {
  id: '019f0000-0000-7000-8000-000000000001', harness: 'prime', filePath: '/sessions/source.jsonl', projectPath: '/project', title: 'Planner',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'running', depth: 0,
}
const target: SessionRecord = {
  id: '019f0000-0000-7000-8000-000000000002', harness: 'prime', filePath: '/sessions/target.jsonl', projectPath: '/project', title: 'API owner',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', status: 'idle', depth: 0,
}
const foreign: SessionRecord = {
  ...target, id: '019f0000-0000-7000-8000-000000000003', filePath: '/sessions/foreign.jsonl', projectPath: '/other', title: 'Other project',
}
const child: SessionRecord = {
  ...target, id: '019f0000-0000-7000-8000-000000000004', filePath: '/sessions/child.jsonl', title: 'Child agent', depth: 1,
}
const archived: SessionRecord = {
  ...target, id: '019f0000-0000-7000-8000-000000000005', filePath: '/sessions/archived.jsonl', title: 'Archived peer', archived: true,
}

function service(records: SessionRecord[], transcripts: Record<string, TranscriptMessage[]> = {}) {
  return {
    list: vi.fn(async (_projectPath?: unknown, includeArchived?: unknown) => includeArchived ? records : records.filter((record) => !record.archived)),
    read: vi.fn(async (filePath: unknown) => transcripts[String(filePath)] ?? []),
  }
}

function manager(runtime?: RuntimeInfo) {
  let current = runtime
  return {
    getForSession: vi.fn((filePath: string) => current?.sessionFile === filePath ? current : undefined),
    start: vi.fn(async ({ cwd, sessionPath }: { cwd: string; sessionPath?: string }) => {
      current = { runtimeId: 'runtime-awakened', harness: target.harness, sessionId: target.id, sessionFile: sessionPath, cwd, isStreaming: false }
      return current
    }),
    command: vi.fn(async () => ({ ok: true })),
  }
}

async function fixture(live = true) {
  const primeSessions = service([source, target, foreign, child, archived], {
    [target.filePath]: [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Implement the API.' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'The endpoint is ready.' }] },
    ],
  })
  const targetRuntime: RuntimeInfo | undefined = live ? {
    runtimeId: 'runtime-target', harness: 'prime', sessionId: target.id, sessionFile: target.filePath, cwd: '/project', isStreaming: false,
  } : undefined
  const primeManager = manager(targetRuntime)
  const emptySessions = service([])
  const emptyManager = manager()
  const bridge = new AgentCollaborationBridge({
    extensionPath: '/app/extensions/omp-work-collaboration.ts',
    sessions: { prime: primeSessions, omp: emptySessions, pi: emptySessions },
    agents: { prime: primeManager as unknown as AgentRpcManager, omp: emptyManager as unknown as AgentRpcManager, pi: emptyManager as unknown as AgentRpcManager },
  })
  await bridge.start()
  bridges.push(bridge)
  const environment = bridge.environmentFor({ cwd: '/project', sessionPath: source.filePath, harness: 'prime' })
  const call = async (method: string, params: Record<string, unknown> = {}, token = environment.GOOEYPI_COLLABORATION_TOKEN) => {
    const response = await fetch(environment.GOOEYPI_COLLABORATION_URL!, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() as { ok: boolean; result?: Record<string, unknown> | Array<Record<string, unknown>>; error?: string } }
  }
  return { bridge, call, environment, primeManager, primeSessions }
}

describe('AgentCollaborationBridge', () => {
  it('lists and reads only same-project peers through bounded snapshots', async () => {
    const { call, environment } = await fixture()
    expect(environment.GOOEYPI_COLLABORATION_EXTENSION_PATH).toBe('/app/extensions/omp-work-collaboration.ts')
    const listed = await call('list')
    expect(listed.status).toBe(200)
    expect(listed.body.result).toEqual([expect.objectContaining({ id: target.id, title: 'API owner', live: true })])

    const read = await call('read', { target_session_id: target.id })
    expect(read.status).toBe(200)
    expect(read.body.result).toMatchObject({ session: { id: target.id, harness: 'prime' }, live: true })
    expect(JSON.stringify(read.body.result)).toContain('The endpoint is ready.')

    const denied = await call('read', { target_session_id: foreign.id })
    expect(denied.status).toBe(409)
    expect(denied.body.error).toContain('not found in this working directory')
    const childDenied = await call('read', { target_session_id: child.id })
    expect(childDenied.status).toBe(409)
    expect(childDenied.body.error).toContain('not found in this working directory')
    const archivedDenied = await call('read', { target_session_id: archived.id })
    expect(archivedDenied.status).toBe(409)
    expect(archivedDenied.body.error).toContain('not found in this working directory')
  })

  it('delivers attributed messages to a live target and returns a wait cursor', async () => {
    const { call, primeManager } = await fixture()
    const sent = await call('send', { target_session_id: target.id, message: 'Please claim src/api.ts.' })
    expect(sent.status).toBe(200)
    expect(sent.body.result).toMatchObject({ delivered: true, target_session_id: target.id, queued: false })
    expect(sent.body.result).toHaveProperty('cursor_before')
    expect(primeManager.command).toHaveBeenCalledWith('runtime-target', expect.objectContaining({ type: 'prompt' }))
    const delivered = (primeManager.command.mock.calls[0] as unknown as [string, { message: string }])[1]
    expect(parseGooeyPiAgentMessage(delivered.message)).toEqual({
      fromSessionId: source.id,
      fromTitle: source.title,
      fromHarness: source.harness,
      text: 'Please claim src/api.ts.',
    })

    const waited = await call('wait', { target_session_id: target.id, timeout_ms: 100 })
    expect(waited.status).toBe(200)
    expect(waited.body.result).toMatchObject({ timed_out: false, live: true })
  })

  it('serializes concurrent deliveries to the same target', async () => {
    const { call, primeManager } = await fixture()
    let releaseFirst!: () => void
    primeManager.command
      .mockImplementationOnce(() => new Promise((resolveCommand) => { releaseFirst = () => resolveCommand({ ok: true }) }))
      .mockResolvedValue({ ok: true })
    const first = call('send', { target_session_id: target.id, message: 'First' })
    await vi.waitFor(() => expect(primeManager.command).toHaveBeenCalledTimes(1))
    const second = call('send', { target_session_id: target.id, message: 'Second' })
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    expect(primeManager.command).toHaveBeenCalledTimes(1)
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 200 }), expect.objectContaining({ status: 200 }),
    ])
    expect(primeManager.command).toHaveBeenCalledTimes(2)
  })

  it('allows only one active wait per target and bounds idle transcript polling', async () => {
    const { call, primeSessions } = await fixture()
    const read = await call('read', { target_session_id: target.id })
    const cursor = (read.body.result as Record<string, unknown>).cursor
    const readsBefore = primeSessions.read.mock.calls.length
    const first = call('wait', { target_session_id: target.id, after_cursor: cursor, timeout_ms: 150 })
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    const duplicate = await call('wait', { target_session_id: target.id, after_cursor: cursor, timeout_ms: 150 })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.error).toContain('already active')
    const completed = await first
    expect(completed.body.result).toMatchObject({ timed_out: true })
    expect(primeSessions.read.mock.calls.length - readsBefore).toBeLessThanOrEqual(2)
  })

  it('wakes an offline target while rejecting missing source scope and invalid tokens', async () => {
    const { bridge, call, environment } = await fixture(false)
    const offline = await call('send', { target_session_id: target.id, message: 'Hello' })
    expect(offline.status).toBe(200)
    expect(offline.body.result).toMatchObject({ delivered: true, awakened: true })
    expect((await call('list', {}, 'wrong')).status).toBe(401)

    const unbound = bridge.environmentFor({ cwd: '/project', harness: 'prime' as HarnessId })
    const response = await fetch(unbound.GOOEYPI_COLLABORATION_URL!, {
      method: 'POST', headers: { authorization: `Bearer ${unbound.GOOEYPI_COLLABORATION_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(response.status).toBe(409)
    expect((await response.json() as { error: string }).error).toContain('not available yet')
    expect(environment.GOOEYPI_COLLABORATION_TOKEN).not.toBe(unbound.GOOEYPI_COLLABORATION_TOKEN)
  })

  it('rejects a subagent source even when its runtime token is otherwise valid', async () => {
    const { bridge, environment } = await fixture()
    const childEnvironment = bridge.environmentFor({ cwd: '/project', sessionPath: child.filePath, harness: 'prime' })
    const response = await fetch(environment.GOOEYPI_COLLABORATION_URL!, {
      method: 'POST', headers: { authorization: `Bearer ${childEnvironment.GOOEYPI_COLLABORATION_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(response.status).toBe(409)
    expect((await response.json() as { error: string }).error).toContain('top-level sessions')
  })
})
