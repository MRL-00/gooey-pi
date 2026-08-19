// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('queued prompt flush admission', () => {
  it('keeps a failed head marked until a boundary clears it', () => {
    let latest!: ReturnType<typeof useWorkspaceRuntime>

    function Probe() {
      latest = useWorkspaceRuntime({
        bridge: null,
        initialProject: undefined,
        initialSession: undefined,
        sessions: [],
        initialMessages: [],
        reportError: () => undefined,
      })
      return null
    }

    act(() => { root.render(createElement(Probe)) })
    act(() => { latest.queuePrompt('retry after boundary', 'queue') })
    const queuedId = latest.pendingQueuedPrompts[0].id
    act(() => { latest.markQueuedPromptFlushFailed(queuedId) })
    expect(latest.pendingQueuedPrompts[0].flushAttemptFailed).toBe(true)
    act(() => { latest.markQueuedPromptFlushFailed(queuedId) })
    expect(latest.pendingQueuedPrompts[0].flushAttemptFailed).toBe(true)
    act(() => { latest.clearQueuedPromptFlushFailures() })
    expect(latest.pendingQueuedPrompts[0].flushAttemptFailed).toBeUndefined()
  })
})
