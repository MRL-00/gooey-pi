import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRpcManager } from '../../electron/main/agent-rpc'
import { FramedRpcTransport } from '../../electron/main/agent-rpc/transport'
import { validateRpcCommand } from '../../electron/main/agent-rpc/command-schema'
import { MAX_RPC_WRITE_FRAME_BYTES, rpcRequestFrameBytes } from '../../electron/main/agent-rpc/limits'
import { PrimeProviderService } from '../../electron/main/providers'

const dirs: string[] = []
const managers: AgentRpcManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeAgent(promptResponse: string, stateResponse?: string): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-agent.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send(${stateResponse ?? "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', thinkingLevel: 'medium', isStreaming: false } }"})
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 25000, contextWindow: 100000, percent: 25 } } })
  } else if (command.type === 'prompt') {
    send(${promptResponse})
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  } else if (command.type === 'set_service_tier') {
    send({ id: command.id, type: 'response', command: 'set_service_tier', success: true })
  }
})
`)
  chmodSync(executable, 0o755)
  return { cwd, executable }
}

function managerFor(executable: string): AgentRpcManager {
  const manager = new AgentRpcManager(executable, async (cwd) => cwd, async (path) => path)
  managers.push(manager)
  return manager
}

const waitUntil = async (predicate: () => boolean, timeoutMs = 7_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
}

const processExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('agent RPC command frame bounds', () => {
  it('accepts the largest canonical image that fits transport and rejects the next base64 block', async () => {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const imageData = (bytes: number) => Buffer.concat([signature, Buffer.alloc(Math.max(0, bytes - signature.length))]).toString('base64')
    const command = (bytes: number) => ({
      type: 'prompt',
      message: 'describe this image',
      images: [{ type: 'image', data: imageData(bytes), mimeType: 'image/png' }],
    })
    const sample = command(signature.length)
    const overhead = rpcRequestFrameBytes(sample) - sample.images[0].data.length
    let decodedBytes = Math.floor((MAX_RPC_WRITE_FRAME_BYTES - overhead) / 4) * 3
    while (rpcRequestFrameBytes(command(decodedBytes + 1)) <= MAX_RPC_WRITE_FRAME_BYTES) decodedBytes += 1
    while (rpcRequestFrameBytes(command(decodedBytes)) > MAX_RPC_WRITE_FRAME_BYTES) decodedBytes -= 1

    const accepted = await validateRpcCommand(command(decodedBytes), async (path) => path)
    expect(rpcRequestFrameBytes(accepted)).toBeLessThanOrEqual(MAX_RPC_WRITE_FRAME_BYTES)
    await expect(validateRpcCommand(command(decodedBytes + 1), async (path) => path)).rejects.toThrow('too large for the RPC transport')
  })

  it('rejects malformed base64 and image data that does not match its MIME type', async () => {
    const command = (data: string, mimeType = 'image/png') => ({ type: 'prompt', message: 'inspect', images: [{ type: 'image', data, mimeType }] })
    await expect(validateRpcCommand(command('not base64'), async (path) => path)).rejects.toThrow('canonical base64')
    await expect(validateRpcCommand(command(Buffer.from('GIF89a').toString('base64')), async (path) => path)).rejects.toThrow('does not match')
  })
})

describe('agent RPC responses', () => {
  it('hydrates and refreshes authoritative context-window usage', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-context-'))
    dirs.push(cwd)
    const executable = join(cwd, 'context-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
let stats = 0
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'context', isStreaming: false } })
  else if (command.type === 'get_session_stats') {
    stats += 1
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: stats * 25000, contextWindow: 100000, percent: stats * 25 } } })
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    send({ type: 'agent_end' })
  } else if (command.type === 'abort') send({ id: command.id, type: 'response', command: 'abort', success: true })
})
`)
    chmodSync(executable, 0o755)
    const manager = managerFor(executable)
    const events: Array<{ event: Record<string, unknown> }> = []
    manager.setEventSink((event) => events.push(event))

    const runtime = await manager.start({ cwd })
    expect(runtime.contextUsage).toEqual({ tokens: 25_000, contextWindow: 100_000, percent: 25 })
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'continue' })
    await waitUntil(() => events.some(({ event }) => event.type === 'context_usage'
      && typeof (event.contextUsage as { percent?: unknown } | undefined)?.percent === 'number'
      && Number((event.contextUsage as { percent: number }).percent) >= 50))
    expect(manager.list()[0]?.contextUsage?.percent).toBeGreaterThanOrEqual(50)
  })

  it('stays busy while an overflow compaction is waiting to restart', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-compaction-'))
    dirs.push(cwd)
    const executable = join(cwd, 'compaction-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'compaction', isStreaming: false, isCompacting: false } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 50000, contextWindow: 100000, percent: 50 } } })
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    send({ type: 'agent_end' })
    send({ type: 'compaction_start', reason: 'overflow' })
    send({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true, result: { summary: 'Compacted', tokensBefore: 95000 } })
    setTimeout(() => send({ type: 'agent_start' }), 450)
    setTimeout(() => send({ type: 'agent_end' }), 550)
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  }
})
`)
    chmodSync(executable, 0o755)
    const manager = managerFor(executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd })

    const completion = manager.runPromptToCompletion(runtime.runtimeId, 'continue')
    await waitUntil(() => events.some((event) => event.type === 'compaction_end'))
    expect(manager.list()[0]).toMatchObject({ isStreaming: true, isCompacting: false })
    let settled = false
    void completion.finally(() => { settled = true })
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    expect(settled).toBe(false)
    await completion
    expect(events.some((event) => event.type === 'agent_start')).toBe(true)
    expect(manager.list()[0]).toMatchObject({ isStreaming: false, isCompacting: false })
  })

  it('rejects a negative command response with the agent error', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: false, error: 'No model credentials are configured' }")
    const manager = managerFor(fake.executable)
    const runtime = await manager.start({ cwd: fake.cwd })

    await expect(manager.command(runtime.runtimeId, { type: 'prompt', message: 'hello' })).rejects.toThrow('No model credentials are configured')
  })

  it('rejects a response whose command does not match its request', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'follow_up', success: true }")
    const manager = managerFor(fake.executable)
    const runtime = await manager.start({ cwd: fake.cwd })

    await expect(manager.command(runtime.runtimeId, { type: 'prompt', message: 'hello' })).rejects.toThrow(/mismatched response/)
  })

  it('does not admit a runtime when the handshake fails', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", "{ id: command.id, type: 'response', command: 'get_state', success: false, error: 'Unable to initialize session' }")
    const manager = managerFor(fake.executable)

    await expect(manager.start({ cwd: fake.cwd })).rejects.toThrow('Unable to initialize session')
    expect(manager.list()).toEqual([])
  })

  it('decorates runtime reasoning and fast-mode capabilities from the Prime catalog', async () => {
    const state = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', thinkingLevel: 'high', isStreaming: false, model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' } } }"
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", state)
    const providers = new PrimeProviderService({ authPath: join(fake.cwd, 'auth.json'), modelsPath: join(fake.cwd, 'models.json') })
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, providers)
    managers.push(manager)

    const runtime = await manager.start({ cwd: fake.cwd, fast: true })

    expect(runtime.fastModeSupported).toBe(true)
    expect(runtime.fastModeAvailable).toBe(true)
    expect(runtime.serviceTier).toBe('priority')
    expect(runtime.availableThinkingLevels).toContain('xhigh')
    expect(runtime.availableThinkingLevels).not.toContain('max')
  })
  it('rejects images authoritatively when the active runtime model is text-only', async () => {
    const state = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', isStreaming: false, model: { provider: 'fixture', id: 'text-model', name: 'Text model' } } }"
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", state)
    const providers = {
      capabilities: async () => ({
        key: 'fixture/text-model', provider: 'fixture', id: 'text-model', name: 'Text model', reasoning: false,
        input: ['text'], contextWindow: 1_000, maxTokens: 100, availableThinkingLevels: ['off'], fastModeSupported: false, available: true,
      }),
      requireAvailableModel: async () => { throw new Error('not used') },
    } as unknown as PrimeProviderService
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, providers)
    managers.push(manager)
    const runtime = await manager.start({ cwd: fake.cwd })

    expect(runtime.imageInputSupported).toBe(false)
    await expect(manager.command(runtime.runtimeId, {
      type: 'prompt', message: 'inspect', images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    })).rejects.toThrow('active model does not accept images')
  })

  it('terminates a process group that keeps writing after an oversized frame', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-overflow-'))
    dirs.push(cwd)
    const executable = join(cwd, 'overflow-agent.cjs')
    const pidFile = join(cwd, 'pid')
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.on('SIGTERM', () => {})
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'overflow', isStreaming: false } }) + '\\n')
    setTimeout(() => process.stdout.write('x'.repeat(17 * 1024 * 1024)), 25)
  } else if (command.type === 'get_session_stats') {
    process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } } }) + '\\n')
  }
})
setInterval(() => {}, 1000)
`)
    chmodSync(executable, 0o755)
    const manager = managerFor(executable)
    const events: Array<{ event: { type?: unknown; error?: unknown } }> = []
    manager.setEventSink((event) => events.push(event))
    await manager.start({ cwd })
    const pid = Number(readFileSync(pidFile, 'utf8'))

    await waitUntil(() => manager.list().length === 0)
    expect(events.filter((envelope) => envelope.event.type === 'transport_error')).toHaveLength(1)
    expect(String(events.find((envelope) => envelope.event.type === 'transport_error')?.event.error)).toMatch(/maximum frame size/i)
    expect(processExists(pid)).toBe(false)
  }, 12_000)


  it('stops only runtimes whose cwd is inside a removed project root', async () => {
    const project = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const outside = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(project.executable)
    const projectRuntime = await manager.start({ cwd: project.cwd })
    const outsideRuntime = await manager.start({ cwd: outside.cwd })

    await manager.stopForProjectRoots([project.cwd])

    expect(manager.list().map((runtime) => runtime.runtimeId)).toEqual([outsideRuntime.runtimeId])
    expect(manager.list().some((runtime) => runtime.runtimeId === projectRuntime.runtimeId)).toBe(false)
  })

})

describe('framed RPC transport stdio failure', () => {
  interface FakeRpcChild extends EventEmitter {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
  }

  function fakeChild(): FakeRpcChild {
    const child = new EventEmitter() as FakeRpcChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    return child
  }

  const asChild = (child: FakeRpcChild): ChildProcessWithoutNullStreams => child as unknown as ChildProcessWithoutNullStreams

  it('routes stdout and stderr pipe errors into the fatal frame path instead of crashing', () => {
    const uncaught: unknown[] = []
    const spy: NodeJS.UncaughtExceptionListener = (error) => { uncaught.push(error) }
    process.on('uncaughtException', spy)
    try {
      const failures: unknown[] = []
      const child = fakeChild()
      new FramedRpcTransport(asChild(child), () => {}, (error) => failures.push(error), () => true)
      const pipeError = new Error('read EPIPE')
      child.stdout.emit('error', pipeError)
      expect(failures).toEqual([pipeError])
      // A second pipe failure and the trailing stdout end must not re-fire the fatal path.
      child.stderr.emit('error', new Error('read ECONNRESET'))
      child.stdout.emit('end')
      expect(failures).toEqual([pipeError])
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', spy)
    }
  })

  it('fails the transport when only stderr errors', () => {
    const failures: unknown[] = []
    const child = fakeChild()
    new FramedRpcTransport(asChild(child), () => {}, (error) => failures.push(error), () => true)
    const pipeError = new Error('read ECONNRESET')
    child.stderr.emit('error', pipeError)
    expect(failures).toEqual([pipeError])
  })
})
