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

function agentMessagePart(raw: Record<string, unknown>): Extract<MessagePart, { type: 'agentMessage' }> | undefined {
  if (raw.customType !== 'agent_message') return undefined
  const details = record(raw.details)
  const from = record(details?.from)
  const text = string(details?.message) ?? string(raw.content) ?? ''
  return { type: 'agentMessage', text, agentName: string(from?.sessionName) }
}

function updateLastAssistant(messages: TranscriptMessage[], updater: (message: TranscriptMessage) => TranscriptMessage): TranscriptMessage[] {
  let index = -1
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'assistant' && messages[cursor].streaming) { index = cursor; break }
  }
  if (index < 0) return [...messages, updater({ id: `stream-${Date.now()}`, role: 'assistant', timestamp: Date.now(), startedAt: Date.now(), streaming: true, parts: [] })]
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

export interface PrimeEventReplayStats {
  messageScans: number
  eventScans: number
  partScans: number
  transcriptCopies: number
}

interface PartNode {
  part: MessagePart
  previous?: PartNode
  next?: PartNode
}

interface PartDraft {
  head?: PartNode
  tail?: PartNode
  length: number
  firstToolById: Map<string | undefined, PartNode>
}

/** Applies a frame batch with one transcript scan and one scan of each drafted part list. */
export function replayPrimeEvents(
  messages: TranscriptMessage[],
  events: Record<string, unknown>[],
  stats?: PrimeEventReplayStats,
): TranscriptMessage[] {
  if (!events.length) return messages
  let next = messages
  let copiedMessages = false
  let lastStreamingAssistant = -1
  const streaming = new Set<number>()
  const draftedMessages = new Set<number>()
  const partDrafts = new Map<number, PartDraft>()

  for (let index = 0; index < messages.length; index += 1) {
    if (stats) stats.messageScans += 1
    const message = messages[index]
    if (!message.streaming) continue
    streaming.add(index)
    if (message.role === 'assistant') lastStreamingAssistant = index
  }

  const copyTranscript = () => {
    if (copiedMessages) return
    next = messages.slice()
    copiedMessages = true
    if (stats) stats.transcriptCopies += 1
  }
  const draftMessage = (index: number): TranscriptMessage => {
    copyTranscript()
    if (!draftedMessages.has(index)) {
      next[index] = { ...next[index] }
      draftedMessages.add(index)
    }
    return next[index]
  }
  const appendNode = (draft: PartDraft, part: MessagePart): PartNode => {
    const node: PartNode = { part, previous: draft.tail }
    if (draft.tail) draft.tail.next = node
    else draft.head = node
    draft.tail = node
    draft.length += 1
    if (part.type === 'toolCall' && !draft.firstToolById.has(part.id)) draft.firstToolById.set(part.id, node)
    return node
  }
  const draftParts = (index: number): PartDraft => {
    const existing = partDrafts.get(index)
    if (existing) return existing
    const message = draftMessage(index)
    const draft: PartDraft = { length: 0, firstToolById: new Map() }
    for (const part of message.parts) {
      if (stats) stats.partScans += 1
      appendNode(draft, part)
    }
    partDrafts.set(index, draft)
    return draft
  }
  const insertAfter = (draft: PartDraft, node: PartNode, part: MessagePart): PartNode => {
    const inserted: PartNode = { part, previous: node, next: node.next }
    if (node.next) node.next.previous = inserted
    else draft.tail = inserted
    node.next = inserted
    draft.length += 1
    return inserted
  }
  const appendAssistant = (prefix: 'assistant' | 'stream'): number => {
    copyTranscript()
    const now = Date.now()
    const index = next.length
    next.push({ id: `${prefix}-${now}`, role: 'assistant', timestamp: now, startedAt: now, streaming: true, parts: [] })
    draftedMessages.add(index)
    streaming.add(index)
    lastStreamingAssistant = index
    return index
  }
  const assistantIndex = () => lastStreamingAssistant >= 0 ? lastStreamingAssistant : appendAssistant('stream')
  const upsertToolDraft = (index: number, id: string | undefined, name: string, args: unknown): PartNode => {
    const draft = draftParts(index)
    const existing = id ? draft.firstToolById.get(id) : undefined
    const tool: MessagePart = { type: 'toolCall', id, name, args }
    if (existing) {
      existing.part = tool
      return existing
    }
    return appendNode(draft, tool)
  }
  const setToolResult = (draft: PartDraft, call: PartNode, result: MessagePart) => {
    if (call.next?.part.type === 'toolResult') call.next.part = result
    else insertAfter(draft, call, result)
  }
  const finalizeStreaming = (completedAt: number, addFallback: boolean) => {
    for (const index of streaming) {
      const message = draftMessage(index)
      message.streaming = false
      message.completedAt = completedAt
      const parts = partDrafts.get(index)
      if (addFallback && (parts?.length ?? message.parts.length) === 0) {
        appendNode(draftParts(index), { type: 'text', text: 'Completed without a text response.' })
      }
    }
    streaming.clear()
    lastStreamingAssistant = -1
  }

  for (const raw of events) {
    if (stats) stats.eventScans += 1
    const type = string(raw.type) ?? string(raw.event)
    if (!type) continue
    if (type === 'agent_start' || type === 'turn_start') {
      if (streaming.size === 0) appendAssistant('assistant')
      continue
    }
    if (type === 'message_update') {
      const delta = record(raw.assistantMessageEvent) ?? record(raw.delta)
      const deltaType = string(delta?.type)
      const text = string(delta?.delta) ?? ''
      if ((deltaType === 'text_delta' || deltaType === 'thinking_delta') && text) {
        const draft = draftParts(assistantIndex())
        const partType = deltaType === 'text_delta' ? 'text' : 'thinking'
        if (draft.tail?.part.type === partType) draft.tail.part = { ...draft.tail.part, text: draft.tail.part.text + text }
        else appendNode(draft, { type: partType, text })
      } else if (deltaType === 'toolcall_end') {
        const tool = record(delta?.toolCall)
        upsertToolDraft(assistantIndex(), string(tool?.id), string(tool?.name) ?? 'Tool', tool?.arguments ?? tool?.args)
      }
      continue
    }
    if (type === 'tool_execution_start') {
      upsertToolDraft(assistantIndex(), string(raw.toolCallId), string(raw.toolName) ?? 'Tool', raw.args)
      continue
    }
    if (type === 'tool_execution_update') {
      const index = assistantIndex()
      const id = string(raw.toolCallId)
      const name = string(raw.toolName) ?? 'Tool'
      upsertToolDraft(index, id, name, raw.args)
      const draft = draftParts(index)
      const call = draft.firstToolById.get(id)
      if (call) setToolResult(draft, call, { type: 'toolResult', name, text: resultText(raw.partialResult) })
      continue
    }
    if (type === 'tool_execution_end') {
      const index = assistantIndex()
      const id = string(raw.toolCallId)
      const name = string(raw.toolName) ?? 'Tool'
      const draft = draftParts(index)
      const call = id ? draft.firstToolById.get(id) : undefined
      const resultPart: MessagePart = { type: 'toolResult', name, text: resultText(raw.result), isError: raw.isError === true }
      if (call) setToolResult(draft, call, resultPart)
      else {
        appendNode(draft, { type: 'toolCall', id, name })
        appendNode(draft, resultPart)
      }
      continue
    }
    if (type === 'custom_message') {
      const part = agentMessagePart(raw)
      if (part) appendNode(draftParts(assistantIndex()), part)
      continue
    }
    if (type === 'agent_end') {
      finalizeStreaming(Date.now(), true)
      continue
    }
    if (type === 'extension_error' || type === 'error' || type === 'transport_error') {
      const text = string(raw.error) ?? string(raw.message) ?? 'Prime encountered an error.'
      finalizeStreaming(Date.now(), false)
      copyTranscript()
      next.push({ id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text }] })
      continue
    }
    if (type === 'runtime_exit') {
      finalizeStreaming(Date.now(), false)
      if (raw.expected === true || next.at(-1)?.role === 'system') continue
      const reason = raw.code !== null && raw.code !== undefined ? `exit code ${String(raw.code)}` : string(raw.signal) ?? 'an unknown error'
      copyTranscript()
      next.push({ id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: `Prime Agent stopped unexpectedly (${reason}). Send the message again to restart it.` }] })
    }
  }

  for (const [index, draft] of partDrafts) {
    const parts: MessagePart[] = []
    for (let node = draft.head; node; node = node.next) parts.push(node.part)
    draftMessage(index).parts = parts
  }
  return next
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
    const startedAt = Date.now()
    return [...messages, { id: `assistant-${startedAt}`, role: 'assistant', timestamp: startedAt, startedAt, streaming: true, parts: [] }]
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
  if (type === 'custom_message') {
    const part = agentMessagePart(raw)
    return part ? updateLastAssistant(messages, (message) => ({ ...message, parts: [...message.parts, part] })) : messages
  }
  if (type === 'agent_end') {
    const completedAt = Date.now()
    return messages.map((message) => message.streaming ? { ...message, streaming: false, completedAt, parts: message.parts.length ? message.parts : [{ type: 'text', text: 'Completed without a text response.' }] } : message)
  }
  if (type === 'extension_error' || type === 'error' || type === 'transport_error') {
    const text = string(raw.error) ?? string(raw.message) ?? 'Prime encountered an error.'
    const completedAt = Date.now()
    const finalized = messages.map((message) => message.streaming ? { ...message, streaming: false, completedAt } : message)
    return [...finalized, { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text }] }]
  }
  if (type === 'runtime_exit') {
    const completedAt = Date.now()
    const finalized = messages.map((message) => message.streaming ? { ...message, streaming: false, completedAt } : message)
    if (raw.expected === true || finalized.at(-1)?.role === 'system') return finalized
    const reason = raw.code !== null && raw.code !== undefined ? `exit code ${String(raw.code)}` : string(raw.signal) ?? 'an unknown error'
    return [...finalized, { id: `error-${Date.now()}`, role: 'system', timestamp: Date.now(), parts: [{ type: 'text', text: `Prime Agent stopped unexpectedly (${reason}). Send the message again to restart it.` }] }]
  }
  return messages
}
