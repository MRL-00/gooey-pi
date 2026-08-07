// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('app keyboard shortcuts lifecycle', () => {
  it('subscribes the window keydown handler once and keeps it across re-renders', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => { root.render(<App />) })
    const keydownAdds = () => addSpy.mock.calls.filter(([type]) => type === 'keydown').length
    const keydownRemoves = () => removeSpy.mock.calls.filter(([type]) => type === 'keydown').length
    const initialAdds = keydownAdds()
    expect(initialAdds).toBeGreaterThan(0)

    // Force state-driven re-renders through the shortcut itself.
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true })) })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true })) })

    expect(keydownAdds()).toBe(initialAdds)
    expect(keydownRemoves()).toBe(0)
    await act(async () => root.unmount())
    expect(keydownRemoves()).toBeGreaterThan(0)
    container.remove()
  })
})
