import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { isAbsolute } from 'node:path'
import { DAEMON_FRAME_LIMIT_BYTES } from './jsonl-limits'
import { StrictJsonlDecoder } from './jsonl'
import { isRecord } from './validation'

const DAEMON_PROTOCOL_NAME = 'prime-agent.daemon'
const DAEMON_PROTOCOL_VERSION = 7

export async function queueDaemonFollowUp(socketPath: string, activeSessionId: string, message: string, commandType: 'follow_up' | 'steer' = 'follow_up'): Promise<void> {
  if (!isAbsolute(socketPath) || socketPath.includes('\0') || socketPath.length > 4_096) {
    throw new Error('Prime Agent returned an invalid daemon socket path')
  }
  let socketInfo: Stats
  try { socketInfo = await lstat(socketPath) } catch { throw new Error('Prime Agent daemon socket is unavailable') }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!socketInfo.isSocket() || (currentUid !== undefined && socketInfo.uid !== currentUid)) {
    throw new Error('Prime Agent returned an untrusted daemon socket')
  }

  await new Promise<void>((resolveQueue, rejectQueue) => {
    const socket = createConnection(socketPath)
    const commandId = `prime_work_${randomUUID()}`
    const clientId = `prime-work-${randomUUID()}`
    let commandSent = false
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) rejectQueue(error)
      else resolveQueue()
    }
    const timer = setTimeout(() => finish(new Error('Prime Agent daemon follow-up timed out')), 10_000)
    timer.unref()
    const write = (value: Record<string, unknown>): void => {
      try { socket.write(`${JSON.stringify(value)}\n`) }
      catch { finish(new Error('Prime Work could not write to the Prime Agent daemon')) }
    }
    const decoder = new StrictJsonlDecoder((line) => {
      let value: unknown
      try { value = JSON.parse(line) } catch { finish(new Error('Prime Agent daemon returned malformed JSON')); return }
      if (!isRecord(value)) return
      if (value.type === 'daemon_hello' && !commandSent) {
        const protocol = isRecord(value.protocol) ? value.protocol : undefined
        if (protocol?.name !== DAEMON_PROTOCOL_NAME || typeof protocol.version !== 'number'
          || protocol.version < DAEMON_PROTOCOL_VERSION
          || !Array.isArray(value.serverCapabilities)
          || !value.serverCapabilities.includes('session_input_admission')) {
          finish(new Error('Prime Agent daemon does not support active-session follow-ups'))
          return
        }
        commandSent = true
        // The hello guard above rejects protocol.version < DAEMON_PROTOCOL_VERSION,
        // so the negotiated version is always exactly ours.
        const command = { id: commandId, type: commandType, activeSessionId, message }
        write({
          type: 'command',
          id: commandId,
          protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION },
          clientId,
          command,
        })
        return
      }
      if (value.type !== 'response' || value.id !== commandId) return
      if (value.command !== commandType || value.success !== true) {
        finish(new Error('Prime Agent rejected the active-session message'))
        return
      }
      const ackId = `prime_work_ack_${randomUUID()}`
      const ack = {
        type: 'command',
        id: ackId,
        protocol: { name: DAEMON_PROTOCOL_NAME, version: DAEMON_PROTOCOL_VERSION },
        clientId,
        command: { id: ackId, type: 'ack_result', commandId },
      }
      try { socket.end(`${JSON.stringify(ack)}\n`, () => finish()) }
      catch { finish(new Error('Prime Work could not acknowledge the queued reply')) }
    }, DAEMON_FRAME_LIMIT_BYTES)

    socket.on('data', (chunk: Buffer) => {
      try { decoder.push(chunk) } catch { finish(new Error('Prime Agent daemon response exceeded its limit')) }
    })
    socket.once('error', () => finish(new Error('Prime Work could not connect to the Prime Agent daemon')))
    socket.once('close', () => { if (!settled) finish(new Error('Prime Agent daemon closed before queuing the reply')) })
  })
}
