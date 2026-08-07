// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkTimeline } from '../../src/components/transcript/timeline'
import { replayPrimeEvents } from '../../src/lib/events'
import type { TranscriptMessage } from '../../src/types/api'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderTimeline(message: TranscriptMessage): void {
  act(() => {
    root.render(createElement(WorkTimeline, { parts: message.parts, showReasoning: true, showTools: true }))
  })
}

describe('timeline part identity', () => {
  it('keeps an expanded activity panel attached to its content when a tool result is spliced in', () => {
    const streamed = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'Read', args: { path: 'a.ts' } },
      {
        type: 'custom_message', customType: 'agent_message', content: 'fallback',
        details: { message: 'Subagent finished the review.', from: { sessionName: 'reviewer' } },
      },
    ])
    renderTimeline(streamed[0])
    const agentButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Message from agent'))
    expect(agentButton).toBeDefined()
    act(() => { agentButton!.click() })
    expect(container.querySelector('.activity-agent__details')?.textContent).toContain('Subagent finished the review.')

    // The tool result splices in between the tool call and the agent message.
    const finished = replayPrimeEvents(streamed, [
      { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'Read', result: 'done' },
    ])
    expect(finished[0].parts.map((part) => part.type)).toEqual(['toolCall', 'toolResult', 'agentMessage'])
    renderTimeline(finished[0])

    expect(container.querySelector('.activity-agent__details')?.textContent).toContain('Subagent finished the review.')
  })

  it('mints stable ids for reducer-created parts and preserves them across updates', () => {
    const streamed = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } },
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'Read', args: { path: 'a.ts' } },
    ])
    const ids = streamed[0].parts.map((part) => part.partId)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)

    const finished = replayPrimeEvents(streamed, [
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: ' more' } },
      { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'Read', result: 'done' },
    ])
    expect(finished[0].parts[0].partId).toBe(ids[0])
    expect(finished[0].parts[1].partId).toBe(ids[1])
  })
})
