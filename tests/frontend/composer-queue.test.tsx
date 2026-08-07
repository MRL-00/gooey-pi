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

  it('shows user queues in one tray and supports editing or deleting them', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const queued = { id: 'queue-1', text: 'run tests', intent: 'queue' as const }
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
      queuedMessages={[queued]}
      onDeleteQueuedMessage={onDelete}
      onEditQueuedMessage={onEdit}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onFastChange={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />))

    const tray = container.querySelector('.composer-queue')
    expect(tray?.querySelectorAll('.composer-queue__item')).toHaveLength(1)
    expect(tray?.textContent).toContain('run tests')
    expect(tray?.nextElementSibling?.classList.contains('composer')).toBe(true)

    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Edit queued message"]')?.click())
    expect(onEdit).toHaveBeenCalledWith(queued)
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('run tests')

    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Delete queued message"]')?.click())
    expect(onDelete).toHaveBeenCalledWith(queued)
  })

})
