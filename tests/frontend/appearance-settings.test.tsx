// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { AppearanceSettings } from '../../src/pages/settings/AppearanceSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AppearanceSettings', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('offers only the bounded interface text sizes and persists the selected choice', () => {
    const update = vi.fn()
    act(() => root.render(<AppearanceSettings settings={DEFAULT_SETTINGS} onUpdate={update} />))

    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(options.map((option) => option.textContent)).toEqual(['Smaller', 'Default', 'Larger'])
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])

    act(() => options[2].click())
    expect(update).toHaveBeenCalledWith({ interfaceFontScale: 115 })
  })
})
