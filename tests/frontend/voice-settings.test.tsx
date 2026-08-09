// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { VoiceSettings } from '../../src/pages/settings/VoiceSettings'
import type { AppSettings, PrimeWorkApi, VoiceCredentialStatus } from '../../src/types/api'

vi.mock('../../src/components/ui', () => ({
  Modal: ({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}))

const emptyStatus: VoiceCredentialStatus = {
  configured: { openai: false, groq: false, deepgram: false },
  source: {},
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(node: ReactNode) {
  await act(async () => { root.render(node); await Promise.resolve() })
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function voiceBridge(overrides: Partial<PrimeWorkApi['voice']> = {}): PrimeWorkApi['voice'] {
  return {
    credentialStatus: vi.fn().mockResolvedValue(emptyStatus),
    saveApiKey: vi.fn().mockResolvedValue(emptyStatus),
    deleteApiKey: vi.fn().mockResolvedValue(emptyStatus),
    createRealtimeCall: vi.fn(),
    transcribe: vi.fn(),
    executeTool: vi.fn(),
    ...overrides,
  }
}

function Harness({ voice }: { voice: PrimeWorkApi['voice'] | null }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  return <VoiceSettings settings={settings} voice={voice} onUpdate={(patch) => { setSettings((current) => ({ ...current, ...patch })) }} />
}

describe('Voice settings setup flow', () => {
  it('shows only the selected provider model picker and switches to curated Groq models', async () => {
    await render(<Harness voice={voiceBridge()} />)

    const service = container.querySelector<HTMLSelectElement>('select[aria-label="Dictation service"]')!
    const model = container.querySelector<HTMLSelectElement>('select[aria-label="Dictation model"]')!
    expect(service.value).toBe('openai-live')
    expect([...model.options].map((option) => option.value)).toEqual(['gpt-live-transcribe', 'gpt-realtime-whisper'])
    expect(container.querySelector('input[aria-label="whisper-cli executable"]')).toBeNull()

    await choose(service, 'groq')
    const groqModel = container.querySelector<HTMLSelectElement>('select[aria-label="Dictation model"]')!
    expect([...groqModel.options].map((option) => option.value)).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3'])
    expect(container.textContent).not.toContain('OpenAI file model')
  })

  it('opens an enabled API-key flow and saves through the voice bridge', async () => {
    const saveApiKey = vi.fn().mockResolvedValue({
      configured: { openai: true, groq: false, deepgram: false },
      source: { openai: 'saved' },
    } satisfies VoiceCredentialStatus)
    await render(<Harness voice={voiceBridge({ saveApiKey })} />)

    const openAiCard = [...container.querySelectorAll<HTMLElement>('.voice-connection-card')].find((card) => card.textContent?.includes('OpenAI'))!
    const addKey = [...openAiCard.querySelectorAll('button')].find((button) => button.textContent?.includes('Add key'))!
    expect(addKey.disabled).toBe(false)
    await click(addKey)
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const input = dialog.querySelector<HTMLInputElement>('input[type="password"]')!
    await enter(input, 'sk-test-key')
    const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Save API key'))!
    await click(save)

    expect(saveApiKey).toHaveBeenCalledWith('openai', 'sk-test-key')
  })

  it('explains how to recover an older desktop process instead of showing disabled key buttons', async () => {
    await render(<Harness voice={null} />)

    expect(container.textContent).toContain('Restart GooeyPi to finish enabling Voice')
    expect(container.textContent).toContain('⌘Q')
    expect([...container.querySelectorAll('button')].some((button) => button.disabled && button.textContent?.includes('Add key'))).toBe(false)
  })

  it('turns a missing Voice IPC handler into a restart state instead of checking forever', async () => {
    const credentialStatus = vi.fn().mockRejectedValue(new Error("No handler registered for 'voice:credential-status'"))
    await render(<Harness voice={voiceBridge({ credentialStatus })} />)

    expect(container.textContent).toContain('Restart GooeyPi to finish enabling Voice')
    expect(container.textContent).toContain('Restart required')
    expect(container.textContent).not.toContain('Checking…')
    expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes('Add key'))).toBe(false)
  })
})
