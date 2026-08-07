import type { MessagePart } from '@/types/api'

/** Record and field coercion for raw Prime events. */

export type UnknownRecord = Record<string, unknown>

export function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' ? value as UnknownRecord : undefined
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function resultText(value: unknown): string {
  if (typeof value === 'string') return value
  const result = record(value)
  if (!result) return ''
  if (typeof result.output === 'string') return result.output
  if (typeof result.text === 'string') return result.text
  if (Array.isArray(result.content)) return result.content.map((item) => { const block = record(item); return block?.type === 'text' && typeof block.text === 'string' ? block.text : '' }).filter(Boolean).join('\n')
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

export function agentMessagePart(raw: Record<string, unknown>): Extract<MessagePart, { type: 'agentMessage' }> | undefined {
  if (raw.customType !== 'agent_message') return undefined
  const details = record(raw.details)
  const from = record(details?.from)
  const text = string(details?.message) ?? string(raw.content) ?? ''
  return { type: 'agentMessage', text, agentName: string(from?.sessionName) }
}
