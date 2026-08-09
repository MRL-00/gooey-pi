// @vitest-environment jsdom
import React, { act } from 'react'
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
    const pet = container.querySelector<HTMLElement>('.desktop-pet')!
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
})
