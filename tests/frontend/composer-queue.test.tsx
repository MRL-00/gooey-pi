// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('composer queue tray', () => {
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

  it('keeps accepted queue and steering messages above the input', () => {
    act(() => root.render(<Composer
      busy
      submitting={false}
      loading={false}
      disabled={false}
      model="auto"
      effort="medium"
      modelsByProvider={new Map()}
      providers={[]}
      reasoningLevels={['medium']}
      fast={false}
      fastSupported={false}
      fastAvailable={false}
      imageInputSupported={true}
      messageEnterAction="queue"
      skills={[]}
      queuedMessages={[{ id: 'queue-1', text: 'run tests', intent: 'queue' }, { id: 'steer-1', text: 'focus on auth', intent: 'steer' }]}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onFastChange={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />))
    const tray = container.querySelector('.composer-queue')
    expect(tray).not.toBeNull()
    expect(tray?.textContent).toContain('run tests')
    expect(tray?.textContent).toContain('focus on auth')
    expect(tray?.nextElementSibling?.classList.contains('composer')).toBe(true)
  })
})
