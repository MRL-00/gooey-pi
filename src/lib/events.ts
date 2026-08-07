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

function compactionReason(value: unknown): Extract<MessagePart, { type: 'compaction' }>['reason'] {
  return value === 'manual' || value === 'threshold' || value === 'overflow' || value === 'requested' ? value : undefined
}

function compactionOutcome(value: unknown): Extract<MessagePart, { type: 'compaction' }>['outcome'] {
  return value === 'failed' || value === 'cancelled' || value === 'skipped' ? value : undefined
}

function compactionResult(value: unknown): Pick<Extract<MessagePart, { type: 'compaction' }>, 'summary' | 'tokensBefore' | 'firstKeptEntryId'> {
  const result = record(value)
  const tokensBefore = typeof result?.tokensBefore === 'number' && Number.isFinite(result.tokensBefore) && result.tokensBefore >= 0
    ? result.tokensBefore
    : undefined
  return {
    summary: string(result?.summary),
    tokensBefore,
    firstKeptEntryId: string(result?.firstKeptEntryId),
  }
}

function compactionPartFromStart(raw: Record<string, unknown>): Extract<MessagePart, { type: 'compaction' }> {
  return {
    type: 'compaction',
    status: 'running',
    reason: compactionReason(raw.reason),
    customInstructions: string(raw.customInstructions),
  }
}

function compactionPartFromEnd(raw: Record<string, unknown>): Extract<MessagePart, { type: 'compaction' }> {
  const result = compactionResult(raw.result)
  const aborted = raw.aborted === true
  const hasResult = Boolean(result.summary || result.tokensBefore !== undefined || result.firstKeptEntryId)
  const status = aborted ? 'cancelled' : hasResult ? 'done' : 'failed'
  const outcome = aborted ? 'cancelled' : raw.errorSeverity === 'warning' ? 'skipped' : status === 'failed' ? 'failed' : undefined
  return {
    type: 'compaction',
    status,
    reason: compactionReason(raw.reason),
    outcome,
    ...result,
    error: string(raw.errorMessage),
    customInstructions: string(raw.customInstructions),
    willRetry: raw.willRetry === true,
  }
}

function compactionOutcomePart(message: Record<string, unknown>): Extract<MessagePart, { type: 'compaction' }> | undefined {
  if (message.customType !== 'compaction_outcome') return undefined
  const details = record(message.details)
  const outcome = compactionOutcome(details?.outcome) ?? 'failed'
  return {
    type: 'compaction',
    status: outcome === 'cancelled' ? 'cancelled' : 'failed',
    reason: compactionReason(details?.reason),
    outcome,
    error: string(message.content) ?? 'Context compaction did not complete.',
  }
}

function compactionOutcomeFromEvent(raw: Record<string, unknown>): Extract<MessagePart, { type: 'compaction' }> | undefined {
  if (raw.type === 'custom_message') return compactionOutcomePart(raw)
  if (raw.type !== 'message_end') return undefined
  const message = record(raw.message)
  return message ? compactionOutcomePart(message) : undefined
}

function isCompactionEvent(raw: Record<string, unknown>): boolean {
  const type = string(raw.type) ?? string(raw.event)
  return type === 'compaction_start' || type === 'compaction_end' || Boolean(compactionOutcomeFromEvent(raw))
}

function sameCompactionResult(left: Extract<MessagePart, { type: 'compaction' }>, right: Extract<MessagePart, { type: 'compaction' }>): boolean {
  if (left.reason && right.reason && left.reason !== right.reason) return false
  if (left.firstKeptEntryId && right.firstKeptEntryId) return left.firstKeptEntryId === right.firstKeptEntryId
  if (left.status !== 'done' && right.status !== 'done') {
    return Boolean(left.reason && right.reason && left.reason === right.reason && (!left.error || !right.error || left.error === right.error))
  }
  return Boolean(left.summary && right.summary && left.summary === right.summary && left.tokensBefore === right.tokensBefore)
}

function compactionIndex(messages: TranscriptMessage[], status?: Extract<MessagePart, { type: 'compaction' }>['status']): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const part = messages[index].parts.find((candidate): candidate is Extract<MessagePart, { type: 'compaction' }> => candidate.type === 'compaction')
    if (part && (status === undefined || part.status === status)) return index
  }
  return -1
}

function appendCompaction(messages: TranscriptMessage[], part: Extract<MessagePart, { type: 'compaction' }>, now: number): TranscriptMessage[] {
  return [...messages, {
    id: `compaction-${now}-${messages.length}`,
    role: 'system',
    timestamp: now,
    startedAt: now,
    completedAt: part.status === 'running' ? undefined : now,
    streaming: part.status === 'running',
    parts: [part],
  }]
}

function applyCompactionEvent(messages: TranscriptMessage[], raw: Record<string, unknown>): TranscriptMessage[] | undefined {
  const type = string(raw.type) ?? string(raw.event)
  if (type === 'compaction_start') {
    const running = compactionIndex(messages, 'running')
    if (running >= 0) return messages
    const completedAt = Date.now()
    const finalized = messages.map((message) => message.role === 'assistant' && message.streaming
      ? { ...message, streaming: false, completedAt }
      : message)
    return appendCompaction(finalized, compactionPartFromStart(raw), completedAt)
  }
  let part: Extract<MessagePart, { type: 'compaction' }> | undefined
  if (type === 'compaction_end') part = compactionPartFromEnd(raw)
  else part = compactionOutcomeFromEvent(raw)
  if (!part) return undefined

  const running = compactionIndex(messages, 'running')
  if (running >= 0) {
    const alreadyPersisted = part.status !== 'running' && messages.some((message, index) => index !== running
      && message.parts.some((candidate) => candidate.type === 'compaction' && candidate.status !== 'running' && sameCompactionResult(candidate, part!)))
    if (alreadyPersisted) return messages.filter((_, index) => index !== running)
    const completedAt = Date.now()
    return messages.map((message, index) => index === running
      ? { ...message, completedAt, streaming: false, parts: message.parts.map((candidate) => candidate.type === 'compaction' ? { ...candidate, ...part } : candidate) }
      : message)
  }
  if (part.status !== 'running') {
    const duplicate = messages.some((message) => message.parts.some((candidate) => candidate.type === 'compaction' && candidate.status !== 'running' && sameCompactionResult(candidate, part!)))
    if (duplicate) return messages
  }
  return appendCompaction(messages, part, Date.now())
}

function updateLastAssistant(messages: TranscriptMessage[], updater: (message: TranscriptMessage) => TranscriptMessage): TranscriptMessage[] {
  let index = -1
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'assistant' && messages[cursor].streaming) { index = cursor; break }
  }
  if (index < 0 && messages.at(-1)?.role === 'assistant') index = messages.length - 1
  if (index < 0) return [...messages, updater({ id: `stream-${Date.now()}`, role: 'assistant', timestamp: Date.now(), startedAt: Date.now(), streaming: true, parts: [] })]
  return messages.map((message, messageIndex) => messageIndex === index
    ? updater(message.streaming ? message : { ...message, streaming: true, completedAt: undefined })
    : message)
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
  // Compaction changes the transcript shape (it closes the current assistant
  // turn and inserts a system activity item). Keep that infrequent path on
  // the same reducer as live events so it cannot drift from sequential replay.
  if (events.some(isCompactionEvent)) return events.reduce((current, event) => applyPrimeEvent(current, event), messages)
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
  const resumeTailAssistant = (): number | undefined => {
    const tailIndex = next.length - 1
    if (tailIndex < 0 || next[tailIndex].role !== 'assistant') return undefined
    const message = draftMessage(tailIndex)
    message.streaming = true
    message.completedAt = undefined
    streaming.add(tailIndex)
    lastStreamingAssistant = tailIndex
    return tailIndex
  }
  const assistantIndex = () => lastStreamingAssistant >= 0
    ? lastStreamingAssistant
    : resumeTailAssistant() ?? appendAssistant('stream')
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
      if (streaming.size === 0 && resumeTailAssistant() === undefined) appendAssistant('assistant')
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
  const compaction = applyCompactionEvent(messages, raw)
  if (compaction) return compaction
  if (type === 'agent_start' || type === 'turn_start') {
    if (messages.some((message) => message.role === 'assistant' && message.streaming)) return messages
    if (messages.at(-1)?.role === 'assistant') {
      return messages.map((message, index) => index === messages.length - 1
        ? { ...message, streaming: true, completedAt: undefined }
        : message)
    }
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
