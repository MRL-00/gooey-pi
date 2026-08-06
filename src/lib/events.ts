import type { MessagePart, TranscriptMessage } from '@/types/api'

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined { return value && typeof value === 'object' ? value as UnknownRecord : undefined }
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }

function resultText(value: unknown): string {
  if (typeof value === 'string') return value
  const result = record(value)
  if (!result) return ''
  if (typeof result.output === 'string') return result.output
  if (typeof result.text === 'string') return result.text
  if (Array.isArray(result.content)) return result.content.map((item) => { const block = record(item); return block?.type === 'text' && typeof block.text === 'string' ? block.text : '' }).filter(Boolean).join('\n')
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function updateLastAssistant(messages: TranscriptMessage[], updater: (message: TranscriptMessage) => TranscriptMessage): TranscriptMessage[] {
  let index = -1
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'assistant' && messages[cursor].streaming) { index = cursor; break }
  }
  if (index < 0) return [...messages, updater({ id: `stream-${Date.now()}`, role: 'assistant', timestamp: Date.now(), streaming: true, parts: [] })]
  return messages.map((message, messageIndex) => messageIndex === index ? updater(message) : message)
}

function appendDelta(parts: MessagePart[], type: 'text' | 'thinking', delta: string): MessagePart[] {
  const last = parts.at(-1)
  if (last?.type === type) return [...parts.slice(0, -1), { ...last, text: last.text + delta }]
  return [...parts, { type, text: delta }]
}

function upsertTool(parts: MessagePart[], id: string | undefined, name: string, args: unknown): MessagePart[] {
  const index = id ? parts.findIndex((part) => part.type === 'toolCall' && part.id === id) : -1
  const next: MessagePart = { type: 'toolCall', id, name, args }
  if (index < 0) return [...parts, next]
  return parts.map((part, partIndex) => partIndex === index ? next : part)
}

function finishTool(parts: MessagePart[], id: string | undefined, name: string, result: unknown, isError: boolean): MessagePart[] {
  const callIndex = id ? parts.findIndex((part) => part.type === 'toolCall' && part.id === id) : -1
  const resultPart: MessagePart = { type: 'toolResult', name, text: resultText(result), isError }
  if (callIndex < 0) return [...parts, { type: 'toolCall', id, name }, resultPart]
  const after = parts[callIndex + 1]
  if (after?.type === 'toolResult') return parts.map((part, index) => index === callIndex + 1 ? resultPart : part)
  return [...parts.slice(0, callIndex + 1), resultPart, ...parts.slice(callIndex + 1)]
}

export function replayPrimeEvents(messages: TranscriptMessage[], events: Record<string, unknown>[]): TranscriptMessage[] {
  return events.reduce((current, event) => applyPrimeEvent(current, event), messages)
}

export interface PrimeEventBuffer {
  readonly size: number
  push(event: Record<string, unknown>): void
  replay(messages: TranscriptMessage[]): TranscriptMessage[]
}

export function createPrimeEventBuffer(): PrimeEventBuffer {
  const events: Record<string, unknown>[] = []
  return {
    get size() { return events.length },
    push(event) { events.push(event) },
    replay(messages) { return replayPrimeEvents(messages, events) },
  }
}

export function applyPrimeEvent(messages: TranscriptMessage[], raw: Record<string, unknown>): TranscriptMessage[] {
  const type = string(raw.type) ?? string(raw.event)
  if (!type) return messages
  if (type === 'agent_start' || type === 'turn_start') {
    if (messages.some((message) => message.role === 'assistant' && message.streaming)) return messages
    return [...messages, { id: `assistant-${Date.now()}`, role: 'assistant', timestamp: Date.now(), streaming: true, parts: [] }]
  }
  if (type === 'message_update') {
    const delta = record(raw.assistantMessageEvent) ?? record(raw.delta)
    const deltaType = string(delta?.type)
    const text = string(delta?.delta) ?? ''
    if ((deltaType === 'text_delta' || deltaType === 'thinking_delta') && text) return updateLastAssistant(messages, (message) => ({ ...message, parts: appendDelta(message.parts, deltaType === 'text_delta' ? 'text' : 'thinking', text) }))
    if (deltaType === 'toolcall_end') {
      const tool = record(delta?.toolCall)
      return updateLastAssistant(messages, (message) => ({ ...message, parts: upsertTool(message.parts, string(tool?.id), string(tool?.name) ?? 'Tool', tool?.arguments ?? tool?.args) }))
    }
    return messages
  }
  if (type === 'tool_execution_start') {
    const id = string(raw.toolCallId)
    const name = string(raw.toolName) ?? 'Tool'
    return updateLastAssistant(messages, (message) => ({ ...message, parts: upsertTool(message.parts, id, name, raw.args) }))
  }
  if (type === 'tool_execution_update') {
    const id = string(raw.toolCallId)
    const name = string(raw.toolName) ?? 'Tool'
    return updateLastAssistant(messages, (message) => {
      const parts = upsertTool(message.parts, id, name, raw.args)
      const callIndex = parts.findIndex((part) => part.type === 'toolCall' && part.id === id)
      const partial: MessagePart = { type: 'toolResult', name, text: resultText(raw.partialResult) }
      if (callIndex >= 0 && parts[callIndex + 1]?.type === 'toolResult') return { ...message, parts: parts.map((part, index) => index === callIndex + 1 ? partial : part) }
      return { ...message, parts: [...parts.slice(0, callIndex + 1), partial, ...parts.slice(callIndex + 1)] }
    })
  }
  if (type === 'tool_execution_end') {
    const id = string(raw.toolCallId)
    const name = string(raw.toolName) ?? 'Tool'
    return updateLastAssistant(messages, (message) => ({ ...message, parts: finishTool(message.parts, id, name, raw.result, raw.isError === true) }))
  }
  if (type === 'agent_end') return messages.map((message) => message.streaming ? { ...message, streaming: false, parts: message.parts.length ? message.parts : [{ type: 'text', text: 'Completed without a text response.' }] } : message)
  if (type === 'extension_error' || type === 'error' || type === 'transport_error') {
    const text = string(raw.error) ?? string(raw.message) ?? 'Prime encountered an error.'
    const finalized = messages.map((message) => message.streaming ? { ...message, streaming: false } : message)
    return [...finalized, { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text }] }]
  }
  if (type === 'runtime_exit') {
    const finalized = messages.map((message) => message.streaming ? { ...message, streaming: false } : message)
    if (raw.expected === true || finalized.at(-1)?.role === 'system') return finalized
    const reason = raw.code !== null && raw.code !== undefined ? `exit code ${String(raw.code)}` : string(raw.signal) ?? 'an unknown error'
    return [...finalized, { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: `Prime Agent stopped unexpectedly (${reason}). Send the message again to restart it.` }] }]
  }
  return messages
}
