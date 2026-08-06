// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import type { PrimeModelDescriptor, PrimeProviderDescriptor } from '../../src/types/api'

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

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  let id = 0
  vi.stubGlobal('crypto', { randomUUID: () => `image-${id += 1}` })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderComposer(onSend = vi.fn(), imageInputSupported = true) {
  act(() => root.render(<Composer
    busy={false}
    model="provider/vision"
    effort="medium"
    models={models}
    providers={providers}
    reasoningLevels={['medium']}
    fast={false}
    fastSupported={false}
    fastAvailable
    imageInputSupported={imageInputSupported}
    skills={[]}
    onModelChange={vi.fn()}
    onEffortChange={vi.fn()}
    onFastChange={vi.fn()}
    onSend={onSend}
    onStop={vi.fn()}
  />))
  return onSend
}

function pastedPng(read?: () => Promise<ArrayBuffer>): File {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const file = new File([bytes], 'pasted.png', { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', { value: read ?? (async () => bytes.buffer) })
  return file
}

function dispatchPasteFiles(files: File[], text = ''): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      getData: (type: string) => type === 'text/plain' ? text : '',
    },
  })
  container.querySelector('textarea')?.dispatchEvent(event)
}

async function pasteFiles(files: File[], text = ''): Promise<void> {
  await act(async () => {
    dispatchPasteFiles(files, text)
    await Promise.resolve()
    await Promise.resolve()
  })
}

const paste = (file: File) => pasteFiles([file])

describe('Composer image paste', () => {
  it('previews and sends a pasted image through the prompt callback', async () => {
    const onSend = renderComposer(vi.fn(async () => undefined))
    await paste(pastedPng())

    expect(container.querySelector('.composer-attachment')?.textContent).toContain('pasted.png')
    await act(async () => {
      ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(onSend).toHaveBeenCalledWith('[Attached image]', [{
      type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=',
    }])
    expect(container.querySelector('.composer-attachment')).toBeNull()
  })

  it('shows an actionable rejection for a known text-only model', async () => {
    const onSend = renderComposer(vi.fn(), false)
    await paste(pastedPng())

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not accept images')
    expect(container.querySelector('.composer-attachment')).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('waits for pending image reads and preserves mixed clipboard text', async () => {
    let resolveBuffer!: (value: ArrayBuffer) => void
    const file = pastedPng(() => new Promise<ArrayBuffer>((resolve) => { resolveBuffer = resolve }))
    const onSend = renderComposer(vi.fn(async () => undefined))
    await pasteFiles([file], 'clipboard note')

    await act(async () => { await Promise.resolve() })
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('clipboard note')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true)
    expect(onSend).not.toHaveBeenCalled()

    await act(async () => {
      resolveBuffer(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false)
  })

  it('enforces the attachment count across concurrent paste completions', async () => {
    renderComposer()
    const files = Array.from({ length: 10 }, () => pastedPng())
    await act(async () => {
      dispatchPasteFiles(files.slice(0, 5))
      dispatchPasteFiles(files.slice(5))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(5)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('up to 8 images')
  })


  it('restores the text and image draft when prompt admission fails', async () => {
    const onSend = renderComposer(vi.fn(async () => { throw new Error('rejected') }))
    await pasteFiles([pastedPng()], 'Keep this draft')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(onSend).toHaveBeenCalledOnce()
    expect(textarea.value).toBe('Keep this draft')
    expect(container.querySelector('.composer-attachment')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('restored')
  })

})
