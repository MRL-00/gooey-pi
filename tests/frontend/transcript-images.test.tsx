// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptImage } from '../../src/components/transcript/TranscriptImage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const source = 'data:image/png;base64,iVBORw0KGgo='
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  container = document.createElement('div')
  container.className = 'app-shell'
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<TranscriptImage source={source} alt="User attachment" />))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function openLightbox(): HTMLElement {
  const preview = container.querySelector('[aria-label="Expand pasted image"]') as HTMLButtonElement
  preview.focus()
  act(() => preview.click())
  return document.querySelector('[role="dialog"]') as HTMLElement
}

describe('transcript image lightbox', () => {
  it('opens the original image in an accessible modal and keeps clicks on the image open', () => {
    const dialog = openLightbox()
    const expanded = dialog.querySelector('.image-lightbox__image') as HTMLImageElement

    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.textContent).toContain('Expanded pasted image')
    expect(expanded.src).toBe(source)
    expect(container.getAttribute('aria-hidden')).toBe('true')
    expect(container.inert).toBe(true)

    act(() => expanded.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBe(dialog)
  })

  it('closes on Escape or a click outside the image and restores thumbnail focus', () => {
    const preview = container.querySelector('[aria-label="Expand pasted image"]') as HTMLButtonElement
    let dialog = openLightbox()
    const close = dialog.querySelector('[aria-label="Close expanded image"]') as HTMLButtonElement

    act(() => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(preview)
    expect(container.hasAttribute('aria-hidden')).toBe(false)

    dialog = openLightbox()
    const backdrop = dialog.parentElement as HTMLElement
    act(() => backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(preview)
  })
})
