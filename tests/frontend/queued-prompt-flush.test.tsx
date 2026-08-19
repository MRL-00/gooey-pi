// @vitest-environment jsdom

import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQueuedPromptFlush } from '../../src/hooks/useQueuedPromptFlush'
import type { PrimeWorkApi, PromptDeliveryIntent, PromptImage, QueuedPrompt } from '../../src/types/api'

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
  it('does not retry a failed head until its marker is cleared', async () => {
    const sendPrompt = vi.fn(async (..._args: [string, PromptImage[], PromptDeliveryIntent, string]) => undefined)
    let controls!: {
      clearFailure(): void
      setBusy(value: boolean): void
      setSubmitting(value: boolean): void
      cloneQueue(): void
    }

    function Probe() {
      const [queue, setQueue] = useState<QueuedPrompt[]>([{
        id: 'queued-1',
        text: 'retry after boundary',
        intent: 'queue',
      }])
      const [busy, setBusy] = useState(false)
      const [submitting, setSubmitting] = useState(false)
      const queuedFlushRef = useRef(false)
      controls = {
        clearFailure: () => setQueue((items) => items.map((item) => ({ ...item, flushAttemptFailed: undefined }))),
        setBusy,
        setSubmitting,
        cloneQueue: () => setQueue((items) => items.map((item) => ({ ...item }))),
      }
      useQueuedPromptFlush({
        bridge: {} as PrimeWorkApi,
        busy,
        externalSessionRunning: false,
        submitting,
        queuedMessages: queue,
        queuedFlushRef,
        sendPrompt: async (...args) => {
          sendPrompt(...args)
          setQueue((items) => items.map((item) => ({ ...item, flushAttemptFailed: true })))
        },
      })
      return null
    }

    await act(async () => { root.render(createElement(Probe)); await Promise.resolve() })
    expect(sendPrompt).toHaveBeenCalledOnce()

    await act(async () => { controls.setBusy(true); await Promise.resolve() })
    await act(async () => { controls.setBusy(false); await Promise.resolve() })
    await act(async () => { controls.setSubmitting(true); await Promise.resolve() })
    await act(async () => { controls.setSubmitting(false); await Promise.resolve() })
    await act(async () => { controls.cloneQueue(); await Promise.resolve() })
    expect(sendPrompt).toHaveBeenCalledOnce()

    await act(async () => {
      controls.clearFailure()
      await Promise.resolve()
    })
    expect(sendPrompt).toHaveBeenCalledTimes(2)
    expect(sendPrompt).toHaveBeenLastCalledWith('retry after boundary', [], 'queue', 'queued-1')
  })
})
