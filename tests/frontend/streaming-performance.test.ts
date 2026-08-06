import { describe, expect, it } from 'vitest'
import type { PendingAgentEvent } from '../../src/app/agent-events'
import { areSidebarPropsEqual, type SidebarProps } from '../../src/components/Sidebar'
import {
  ACTIVITY_BATCH,
  growActivityBatch,
  updateActivityCriteria,
  type ActivityViewState,
} from '../../src/pages/ActivityPage'
import { applyPrimeEvent, createPrimeEventBuffer } from '../../src/lib/events'
import type { TranscriptMessage } from '../../src/types/api'

Object.defineProperty(globalThis, 'self', { value: globalThis })
const { admitAgentEvent, eventsForWorkspace } = await import('../../src/app/agent-events')

const transcript = (): TranscriptMessage[] => [{
  id: 'assistant-1',
  role: 'assistant',
  timestamp: 1,
  streaming: true,
  parts: [{ type: 'text', text: 'loaded:' }],
}]

const delta = (text: string): Record<string, unknown> => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: text },
})

const transcriptText = (messages: TranscriptMessage[]) => {
  const part = messages[0]?.parts[0]
  return part?.type === 'text' ? part.text : undefined
}

function runTranscriptRace(frameBeforeRead: boolean): TranscriptMessage[] {
  const eventBuffer = createPrimeEventBuffer()
  const pendingLoad = { generation: 4, eventBuffer }
  const frameQueue: PendingAgentEvent[] = []
  const events = [delta('one'), delta('-two')]

  expect(events.map((event) => admitAgentEvent(4, event, pendingLoad, frameQueue))).toEqual(['transcript', 'transcript'])

  let messages: TranscriptMessage[] = []
  const flushFrame = () => {
    messages = eventsForWorkspace(frameQueue.splice(0), 4)
      .reduce((current, event) => applyPrimeEvent(current, event), messages)
  }
  const finishRead = () => { messages = eventBuffer.replay(transcript()) }

  if (frameBeforeRead) {
    flushFrame()
    finishRead()
  } else {
    finishRead()
    flushFrame()
  }
  return messages
}

describe('streamed transcript event ownership', () => {
  it('applies buffered deltas exactly once when the transcript read resolves before RAF', () => {
    expect(transcriptText(runTranscriptRace(false))).toBe('loaded:one-two')
  })

  it('applies buffered deltas exactly once and in order when RAF runs before the transcript read', () => {
    expect(transcriptText(runTranscriptRace(true))).toBe('loaded:one-two')
  })

  it('preserves frame order and rejects events from an old workspace generation', () => {
    const queue: PendingAgentEvent[] = [
      { generation: 2, event: delta('old') },
      { generation: 3, event: delta('new-1') },
      { generation: 3, event: delta('-new-2') },
    ]
    const messages = eventsForWorkspace(queue, 3).reduce(
      (current, event) => applyPrimeEvent(current, event),
      transcript(),
    )

    expect(transcriptText(messages)).toBe('loaded:new-1-new-2')
  })
})

const sidebarProps = (onNewSession: () => void): SidebarProps => ({
  projects: [],
  sessions: [],
  activeView: 'projects',
  onSelectProject: () => undefined,
  onSelectSession: () => undefined,
  onNavigate: () => undefined,
  onNewSession,
  onAddProject: () => undefined,
  onClose: () => undefined,
  onOpenPalette: () => undefined,
  onRenameSession: async () => undefined,
  onArchiveSession: async () => undefined,
})

describe('Sidebar memoization', () => {
  it('rejects a streaming parent rerender when navigation data and stable handlers are unchanged', () => {
    const callbacks = sidebarProps(() => undefined)
    const before = { ...callbacks }
    const streamedMessages = applyPrimeEvent(transcript(), delta('next frame'))
    const after = { ...callbacks }

    expect(streamedMessages).not.toBe(transcript())
    expect(areSidebarPropsEqual(before, after)).toBe(true)
  })

  it('admits identical data props with a replacement handler and invokes only the newest handler', () => {
    let oldCalls = 0
    let newCalls = 0
    const previous = sidebarProps(() => { oldCalls += 1 })
    const next = { ...previous, onNewSession: () => { newCalls += 1 } }

    const retained = areSidebarPropsEqual(previous, next) ? previous : next
    retained.onNewSession()

    expect(oldCalls).toBe(0)
    expect(newCalls).toBe(1)
  })
})

describe('Activity batching', () => {
  const initial = (): ActivityViewState => ({ filter: 'all', query: '', visibleLimit: ACTIVITY_BATCH })

  it('grows by one bounded batch', () => {
    expect(growActivityBatch(initial(), 1_000).visibleLimit).toBe(500)
    expect(growActivityBatch({ ...initial(), visibleLimit: 750 }, 800).visibleLimit).toBe(800)
  })

  it('resets the limit atomically with query and filter changes', () => {
    const expanded = { ...initial(), visibleLimit: 750 }
    expect(updateActivityCriteria(expanded, { query: 'running' })).toEqual({
      filter: 'all', query: 'running', visibleLimit: ACTIVITY_BATCH,
    })
    expect(updateActivityCriteria(expanded, { filter: 'archived' })).toEqual({
      filter: 'archived', query: '', visibleLimit: ACTIVITY_BATCH,
    })
  })
})
