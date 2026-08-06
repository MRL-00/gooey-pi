import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRpcManager } from '../../electron/main/agent-rpc'

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
  } else if (command.type === 'prompt') {
    send(${promptResponse})
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
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

describe('agent RPC responses', () => {
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
})
