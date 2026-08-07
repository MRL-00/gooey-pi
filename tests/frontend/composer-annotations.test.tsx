// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Composer } from '../../src/components/Composer'
import { groupModelsByProvider } from '../../src/hooks/useProviderCatalog'
import type { BrowserAnnotation, PrimeModelDescriptor, PrimeProviderDescriptor, PromptDeliveryIntent, PromptImage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const models: PrimeModelDescriptor[] = [{
  key: 'provider/vision', provider: 'provider', id: 'vision', name: 'Vision', reasoning: true,
  input: ['text', 'image'], contextWindow: 100_000, maxTokens: 8_000,
  availableThinkingLevels: ['medium'], fastModeSupported: false, available: true,
}]
const providers: PrimeProviderDescriptor[] = [{
  id: 'provider', name: 'Provider', authMethod: 'api_key', configured: true,
  modelCount: 1, availableModelCount: 1, enabled: true,
}]
const modelsByProvider = groupModelsByProvider(models)

const annotation = (id: string, overrides: Partial<BrowserAnnotation> = {}): BrowserAnnotation => ({
  id,
  comment: `Comment ${id}`,
  element: { selector: `#${id}`, tagName: 'button', id, classes: ['btn'], text: 'Sign up', rect: { x: 1, y: 2, width: 30, height: 20 } },
  pageUrl: 'https://example.com/',
  pageTitle: 'Example Page',
  stale: false,
  createdAt: 1,
  ...overrides,
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

interface RenderOptions {
  annotations?: BrowserAnnotation[]
  onSend?: Mock<(prompt: string, images: PromptImage[], intent: PromptDeliveryIntent) => Promise<void>>
  onRemoveAnnotation?: Mock<(id: string) => void>
  onClearAnnotations?: Mock<() => void>
}

function renderComposer({ annotations = [], onSend = vi.fn(async () => undefined), onRemoveAnnotation = vi.fn(), onClearAnnotations = vi.fn() }: RenderOptions = {}) {
  act(() => root.render(<Composer
    busy={false}
    model="provider/vision"
    effort="medium"
    modelsByProvider={modelsByProvider}
    providers={providers}
    reasoningLevels={['medium']}
    fast={false}
    fastSupported={false}
    fastAvailable
    imageInputSupported
    messageEnterAction="queue"
    skills={[]}
    annotations={annotations}
    onModelChange={vi.fn()}
    onEffortChange={vi.fn()}
    onFastChange={vi.fn()}
    onSend={onSend}
    onStop={vi.fn()}
    onRemoveAnnotation={onRemoveAnnotation}
    onClearAnnotations={onClearAnnotations}
  />))
  return { onSend, onRemoveAnnotation, onClearAnnotations }
}

const setDraft = async (value: string) => {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const clickSend = async () => {
  await act(async () => {
    ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
    await Promise.resolve()
  })
}

describe('Composer annotation attachment', () => {
  it('auto-attaches a chip showing the annotation count while any exist', () => {
    renderComposer({ annotations: [annotation('a'), annotation('b')] })
    const chip = container.querySelector('.composer-attachment--annotations')
    expect(chip?.textContent).toContain('2')
    expect(chip?.getAttribute('title')).toBe('2 page annotations')
    expect(chip?.querySelector('.composer-attachment__expand')?.getAttribute('aria-label')).toContain('2 page annotations')
    expect(container.querySelector('.composer-annotations')).toBeNull()
  })

  it('expands to inspect each annotation as plain text and deletes individually', async () => {
    const hostile = annotation('a', { comment: '<img src=x onerror=alert(1)> fix this' })
    const { onRemoveAnnotation } = renderComposer({ annotations: [hostile, annotation('b', { stale: true })] })

    await act(async () => { (container.querySelector('.composer-attachment__expand') as HTMLButtonElement).click() })
    const panel = container.querySelector('.composer-annotations')
    expect(panel).not.toBeNull()
    // Untrusted text renders as text, never as markup.
    expect(panel?.querySelector('img')).toBeNull()
    expect(panel?.textContent).toContain('<img src=x onerror=alert(1)> fix this')
    // Rows show only the comment (plus staleness); DOM labels are intentionally omitted.
    expect(panel?.textContent).not.toContain('button#a.btn')
    expect(panel?.textContent).toContain('page changed')

    await act(async () => { (container.querySelector('button[aria-label="Remove annotation 2"]') as HTMLButtonElement).click() })
    expect(onRemoveAnnotation).toHaveBeenCalledWith('b')
  })

  it('removes the whole attachment through the chip control', async () => {
    const { onClearAnnotations } = renderComposer({ annotations: [annotation('a')] })
    await act(async () => { (container.querySelector('button[aria-label="Remove page annotations"]') as HTMLButtonElement).click() })
    expect(onClearAnnotations).toHaveBeenCalledTimes(1)
  })

  it('appends the serialized annotation block to the sent prompt and clears afterwards', async () => {
    const { onSend, onClearAnnotations } = renderComposer({ annotations: [annotation('a')] })
    await setDraft('Please fix the signup flow')
    await clickSend()

    expect(onSend).toHaveBeenCalledTimes(1)
    const [prompt, images, intent] = onSend.mock.calls[0]
    expect(intent).toBe('queue')
    expect(images).toEqual([])
    expect(prompt.startsWith('Please fix the signup flow\n\n===== BEGIN BROWSER ANNOTATIONS =====')).toBe(true)
    expect(prompt).toContain('Comment: Comment a')
    expect(prompt).toContain('Selector: #a')
    expect(prompt).toContain('Page URL: https://example.com/')
    expect(prompt.endsWith('===== END BROWSER ANNOTATIONS =====')).toBe(true)
    expect(onClearAnnotations).toHaveBeenCalledTimes(1)
  })

  it('allows sending with annotations alone using a placeholder prompt', async () => {
    const { onSend } = renderComposer({ annotations: [annotation('a')] })
    const send = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    await clickSend()
    const [prompt] = onSend.mock.calls[0]
    expect(prompt.startsWith('[Page annotations]\n\n===== BEGIN BROWSER ANNOTATIONS =====')).toBe(true)
  })

  it('keeps the annotations attached when the send fails', async () => {
    const onSend = vi.fn(async () => { throw new Error('rejected') })
    const { onClearAnnotations } = renderComposer({ annotations: [annotation('a')], onSend })
    await setDraft('Keep these')
    await clickSend()

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onClearAnnotations).not.toHaveBeenCalled()
    expect(container.querySelector('.composer-attachment--annotations')).not.toBeNull()
  })

  it('disables send and hides the chip without annotations', () => {
    renderComposer()
    expect(container.querySelector('.composer-attachment--annotations')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true)
  })
})
