// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopPet } from '../../src/components/DesktopPet'
import type { PetDefinition, PrimeWorkApi } from '../../src/types/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const definitions: PetDefinition[] = [
  { id: 'orb', petId: 'orb', displayName: 'Orb', description: 'Orb.', source: 'built-in', kind: 'orb' },
  { id: 'gooey-pi', petId: 'gooey-pi', displayName: 'GooeyPi', description: 'Gooey.', source: 'built-in', kind: 'spritesheet' },
]

describe('DesktopPet', () => {
  let container: HTMLDivElement
  let root: Root
  const pets = { list: vi.fn(async () => definitions), sprite: vi.fn(async () => 'data:image/webp;base64,UklGRgQAAABXRUJQ') } satisfies PrimeWorkApi['pets']
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.localStorage.clear()
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  })
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.clearAllMocks() })

  it('maps agent and voice activity to distinct companion animations', async () => {
    await act(async () => { root.render(<DesktopPet pets={pets} petId="gooey-pi" agentBusy reduceMotion={false} voiceActive={false} />); await Promise.resolve() })
    expect(container.querySelector('.desktop-pet--working')).not.toBeNull()
    await act(async () => { root.render(<DesktopPet pets={pets} petId="gooey-pi" agentBusy reduceMotion={false} voiceActive />); await Promise.resolve() })
    expect(container.querySelector('.desktop-pet--speaking')).not.toBeNull()
  })

  it('runs in the pointer direction while being dragged', async () => {
    await act(async () => { root.render(<DesktopPet pets={pets} petId="orb" agentBusy={false} reduceMotion={false} voiceActive={false} />); await Promise.resolve() })
    const pet = container.querySelector<HTMLElement>('.desktop-pet__drag-target')!
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 100, button: 0 })
      Object.defineProperty(event, 'pointerId', { value: 7 })
      return event
    }
    act(() => {
      pet.dispatchEvent(pointer('pointerdown', 100))
      pet.dispatchEvent(pointer('pointermove', 130))
    })
    expect(container.querySelector('.desktop-pet--running-right')).not.toBeNull()
    act(() => pet.dispatchEvent(pointer('pointerup', 130)))
    expect(container.querySelector('.desktop-pet--idle')).not.toBeNull()
  })

  it('keeps realtime voice controls attached to the pet', async () => {
    const onOpenVoice = vi.fn()
    const onToggleVoiceMute = vi.fn()
    const onCloseVoice = vi.fn()
    await act(async () => { root.render(<DesktopPet pets={pets} petId="gooey-pi" agentBusy={false} reduceMotion={false} voiceActive={false} onOpenVoice={onOpenVoice} />); await Promise.resolve() })
    const open = container.querySelector<HTMLButtonElement>('[aria-label="Open realtime voice"]')!
    act(() => open.click())
    expect(onOpenVoice).toHaveBeenCalledTimes(1)

    await act(async () => { root.render(<DesktopPet pets={pets} petId="gooey-pi" agentBusy={false} reduceMotion={false} voiceActive voiceMuted voiceStatus="Muted" onToggleVoiceMute={onToggleVoiceMute} onCloseVoice={onCloseVoice} />); await Promise.resolve() })
    expect(container.textContent).toContain('Muted')
    const unmute = container.querySelector<HTMLButtonElement>('[aria-label="Unmute realtime voice"]')!
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close realtime voice"]')!
    act(() => { unmute.click(); close.click() })
    expect(onToggleVoiceMute).toHaveBeenCalledTimes(1)
    expect(onCloseVoice).toHaveBeenCalledTimes(1)
  })

  it('keeps an expanded voice pet inside a small viewport and exposes the voice landmark', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
    localStorage.setItem('gooeypi:pet-position', JSON.stringify({ x: 999, y: 999 }))
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('desktop-pet') ? 340 : 0
      return { x: 0, y: 0, top: 0, right: 120, bottom: height, left: 0, width: 120, height, toJSON: () => ({}) }
    })
    await act(async () => {
      root.render(<DesktopPet pets={pets} petId="gooey-pi" agentBusy={false} reduceMotion={false} voiceActive voiceStatus="Voice unavailable" voiceError="Realtime failed" onToggleVoiceMute={vi.fn()} onCloseVoice={vi.fn()}><div className="voice-orb__receipt">Receipt</div></DesktopPet>)
      await Promise.resolve()
    })
    const surface = container.querySelector<HTMLElement>('.desktop-pet')!
    expect(surface.getAttribute('role')).toBe('complementary')
    expect(surface.getAttribute('aria-label')).toBe('Realtime voice session')
    expect(Number.parseFloat(surface.style.left)).toBeLessThanOrEqual(196)
    expect(Number.parseFloat(surface.style.top) + 340).toBeLessThanOrEqual(492)
    expect(surface.dataset.horizontalEdge).toBe('right')
    bounds.mockRestore()
  })

  it('moves a bottom-positioned pet only as far as its measured voice controls require', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 })
    localStorage.setItem('gooeypi:pet-position', JSON.stringify({ x: 450, y: 338 }))
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains('desktop-pet') ? 190 : 0
      return { x: 0, y: 0, top: 0, right: 120, bottom: height, left: 0, width: 120, height, toJSON: () => ({}) }
    })
    await act(async () => {
      root.render(<DesktopPet pets={pets} petId="gooey-pi" agentBusy={false} reduceMotion={false} voiceActive voiceStatus="Listening" onToggleVoiceMute={vi.fn()} onCloseVoice={vi.fn()} />)
      await Promise.resolve()
    })
    const surface = container.querySelector<HTMLElement>('.desktop-pet')!
    expect(Number.parseFloat(surface.style.top)).toBe(302)
    bounds.mockRestore()
  })
})
