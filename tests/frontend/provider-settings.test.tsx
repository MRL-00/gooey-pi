// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderAuthModal } from '../../src/components/ProviderAuthModal'
import { useProviderCatalog } from '../../src/hooks/useProviderCatalog'
import { PrivacySettings } from '../../src/pages/settings/PrivacySettings'
import { ProviderSettings } from '../../src/pages/settings/ProviderSettings'
import type { AppSettings, PrimeModelCatalog, PrimeWorkApi, RuntimeInfo } from '../../src/types/api'

vi.mock('../../src/components/ui', () => ({
  Modal: ({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}))

const model = {
  key: 'openai-codex/gpt-5.6', provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true,
  input: ['text'] as const, contextWindow: 400_000, maxTokens: 128_000,
  availableThinkingLevels: ['low', 'medium', 'high'] as const, fastModeSupported: true, available: true,
}
const catalog: PrimeModelCatalog = {
  primeVersion: '0.7.0',
  refreshedAt: '2026-08-06T00:00:00.000Z',
  models: [
    { ...model, input: [...model.input], availableThinkingLevels: [...model.availableThinkingLevels] },
    { ...model, key: 'openai-codex/gpt-5.5', id: 'gpt-5.5', name: 'GPT-5.5', input: [...model.input], availableThinkingLevels: ['low', 'high'] },
  ],
  providers: [
    { id: 'openai-codex', name: 'ChatGPT Plus/Pro', authMethod: 'oauth', configured: true, authSource: 'stored', modelCount: 8, availableModelCount: 8, enabled: true },
    { id: 'anthropic', name: 'Anthropic', authMethod: 'api_key', configured: false, modelCount: 14, availableModelCount: 0, enabled: false },
  ],
}
const runtime: RuntimeInfo = {
  runtimeId: 'runtime-1', cwd: '/tmp/project', isStreaming: false,
  model: { provider: model.provider, id: model.id, name: model.name },
  thinkingLevel: 'medium', serviceTier: 'default',
}
const noop = async () => undefined
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
  await act(async () => { root.render(node) })
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))
  if (!match) throw new Error(`Button not found: ${label}`)
  return match as HTMLButtonElement
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

describe('provider settings behavior and accessibility', () => {
  it('gives each enable checkbox a provider-specific accessible name and reports toggle failure', async () => {
    const onSetEnabled = vi.fn().mockRejectedValue(new Error('Provider policy was not saved'))
    await render(<ProviderSettings catalog={catalog} onRefresh={noop} onSaveApiKey={noop} onLogout={noop} onSetEnabled={onSetEnabled} onSetAllEnabled={noop} onSetAllDisabled={noop} onStartOAuth={noop} onOpenDocs={() => undefined} />)

    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="Enable Anthropic provider"]')
    expect(checkbox).not.toBeNull()
    await click(checkbox!)

    expect(onSetEnabled).toHaveBeenCalledWith('anthropic', true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Provider policy was not saved')
  })

  it('uses one bulk mutation and exposes the provider and model catalogue UI', async () => {
    const onSetEnabled = vi.fn().mockResolvedValue(undefined)
    const onSetAllEnabled = vi.fn().mockResolvedValue(undefined)
    const onSetAllDisabled = vi.fn().mockResolvedValue(undefined)
    await render(<ProviderSettings catalog={catalog} onRefresh={noop} onSaveApiKey={noop} onLogout={noop} onSetEnabled={onSetEnabled} onSetAllEnabled={onSetAllEnabled} onSetAllDisabled={onSetAllDisabled} onStartOAuth={noop} onOpenDocs={() => undefined} />)

    expect(container.textContent).toContain('2 providers · 2 models')
    expect(container.textContent).toContain('ChatGPT Plus/Pro')
    expect(container.textContent).toContain('Anthropic')
    expect(button('Reconnect')).toBeTruthy()
    expect(button('Add key')).toBeTruthy()
    await click(button('Enable all'))
    expect(onSetAllEnabled).toHaveBeenCalledTimes(1)
    expect(onSetEnabled).not.toHaveBeenCalled()
    await click(button('Disable all'))
    expect(onSetAllDisabled).toHaveBeenCalledTimes(1)
    expect(onSetEnabled).not.toHaveBeenCalled()

    await click(button('Models'))
    expect(container.textContent).toContain('GPT-5.6')
    expect(container.textContent).toContain('GPT-5.5')
    expect(container.querySelector('input[aria-label="Search models"]')).not.toBeNull()
  })

  it('keeps API-key failures announced inside the active modal', async () => {
    const onSaveApiKey = vi.fn().mockRejectedValue(new Error('Credential rejected'))
    await render(<ProviderSettings catalog={catalog} onRefresh={noop} onSaveApiKey={onSaveApiKey} onLogout={noop} onSetEnabled={noop} onSetAllEnabled={noop} onSetAllDisabled={noop} onStartOAuth={noop} onOpenDocs={() => undefined} />)

    await click(button('Add key'))
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')
    const input = dialog?.querySelector<HTMLInputElement>('input[type="password"]')
    expect(input).not.toBeNull()
    await enter(input!, 'not-a-real-secret')
    await click(button('Save API key'))

    expect(onSaveApiKey).toHaveBeenCalledWith('anthropic', 'not-a-real-secret')
    const alert = dialog?.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Credential rejected')
    expect(container.querySelector('[role="dialog"]')).toBe(dialog)
  })

  it('uses ordinary buttons for OAuth choices and submits the selected id', async () => {
    const onRespond = vi.fn()
    await render(<ProviderAuthModal event={{ type: 'select', flowId: 'flow-1', providerId: 'openai-codex', promptId: 'prompt-1', message: 'Choose an account', options: [{ id: 'personal', label: 'Personal' }, { id: 'work', label: 'Work' }] }} onOpen={() => undefined} onRespond={onRespond} onCancel={() => undefined} />)

    expect(container.querySelector('[role="listbox"]')).toBeNull()
    expect(container.querySelector('[role="option"]')).toBeNull()
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-labelledby')).toBeTruthy()
    await click(button('Work'))
    expect(onRespond).toHaveBeenCalledWith('prompt-1', 'work')
  })

  it('persists the diagnostics toggle through the privacy settings contract', async () => {
    const settings = { telemetry: false } as AppSettings
    const onUpdate = vi.fn()
    await render(<PrivacySettings settings={settings} onUpdate={onUpdate} />)

    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(toggle).not.toBeNull()
    await click(toggle!)
    expect(onUpdate).toHaveBeenCalledWith({ telemetry: true })
  })
})

describe('provider runtime mutations', () => {
  function mountCatalogHook(options: {
    command: PrimeWorkApi['agent']['command']
    syncRuntime?: (runtimeId: string) => Promise<void>
    syncDisabledProviders?: (providerIds: string[]) => Promise<void>
    setEnabled?: PrimeWorkApi['providers']['setEnabled']
    reportError?: (error: unknown) => void
  }) {
    let value: ReturnType<typeof useProviderCatalog> | undefined
    const catalogMock = vi.fn().mockResolvedValue(catalog)
    const bridge = {
      agent: { command: options.command },
      providers: {
        catalog: catalogMock,
        onAuthEvent: vi.fn().mockReturnValue(() => undefined),
        setEnabled: options.setEnabled ?? vi.fn().mockResolvedValue(catalog),
      },
    } as unknown as PrimeWorkApi
    const syncRuntime = options.syncRuntime ?? vi.fn().mockResolvedValue(undefined)
    const syncDisabledProviders = options.syncDisabledProviders ?? vi.fn().mockResolvedValue(undefined)
    const reportError = options.reportError ?? vi.fn()
    function Harness() {
      value = useProviderCatalog({ bridge, runtime, syncRuntime, syncDisabledProviders, reportError })
      return null
    }
    return render(<Harness />).then(() => ({ get value() { return value! }, catalogMock, syncRuntime, syncDisabledProviders, reportError }))
  }

  it('serializes rapid reasoning changes and rolls back/synchronizes the latest rejection', async () => {
    const first = deferred<Record<string, unknown>>()
    const second = deferred<Record<string, unknown>>()
    const command = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const hook = await mountCatalogHook({ command })

    act(() => { hook.value.changeEffort('low'); hook.value.changeEffort('high') })
    await act(async () => { await Promise.resolve() })
    expect(command).toHaveBeenCalledTimes(1)
    expect(hook.value.effort).toBe('high')

    await act(async () => { first.resolve({}); await first.promise; await Promise.resolve() })
    expect(command).toHaveBeenCalledTimes(2)
    expect(hook.syncRuntime).not.toHaveBeenCalled()

    await act(async () => { second.reject(new Error('thinking rejected')); try { await second.promise } catch { /* expected */ }; await Promise.resolve() })
    expect(hook.value.effort).toBe('low')
    expect(hook.syncRuntime).toHaveBeenCalledWith('runtime-1')
    expect(hook.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'thinking rejected' }))
  })

  it('rolls model state back and synchronizes after a rejected model command', async () => {
    const rejected = deferred<Record<string, unknown>>()
    const command = vi.fn().mockReturnValueOnce(rejected.promise)
    const hook = await mountCatalogHook({ command })

    act(() => hook.value.changeModel('openai-codex/gpt-5.5'))
    expect(hook.value.model).toBe('openai-codex/gpt-5.5')
    await act(async () => { rejected.reject(new Error('model rejected')); try { await rejected.promise } catch { /* expected */ }; await Promise.resolve() })

    expect(hook.value.model).toBe('openai-codex/gpt-5.6')
    expect(hook.value.effort).toBe('medium')
    expect(hook.syncRuntime).toHaveBeenCalledWith('runtime-1')
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('accepts main-owned provider enable persistence without writing settings again', async () => {
    const next = { ...catalog, providers: catalog.providers.map((provider) => provider.id === 'anthropic' ? { ...provider, enabled: true } : provider) }
    const setEnabled = vi.fn().mockResolvedValue(next)
    const hook = await mountCatalogHook({ command: vi.fn(), setEnabled })

    await act(async () => { await hook.value.setEnabled('anthropic', true) })
    expect(setEnabled).toHaveBeenCalledWith('anthropic', true)
    expect(hook.syncDisabledProviders).not.toHaveBeenCalled()
    expect(hook.value.catalog?.providers.find((provider) => provider.id === 'anthropic')?.enabled).toBe(true)
  })

  it('enables every provider with one atomic settings mutation and refreshes the catalogue', async () => {
    const hook = await mountCatalogHook({ command: vi.fn() })

    await act(async () => { await hook.value.setAllEnabled() })
    expect(hook.syncDisabledProviders).toHaveBeenCalledTimes(1)
    expect(hook.syncDisabledProviders).toHaveBeenCalledWith([])
    expect(hook.catalogMock).toHaveBeenLastCalledWith(true)
  })

  it('disables every provider and clears an explicitly selected model in one atomic mutation', async () => {
    const hook = await mountCatalogHook({ command: vi.fn() })
    await act(async () => { await Promise.resolve() })

    await act(async () => { await hook.value.setAllDisabled() })
    expect(hook.syncDisabledProviders).toHaveBeenCalledTimes(1)
    expect(hook.syncDisabledProviders).toHaveBeenCalledWith(['anthropic', 'openai-codex'])
    expect(hook.catalogMock).toHaveBeenLastCalledWith(true)
    expect(hook.value.model).toBe('auto')
    expect(hook.value.fast).toBe(false)
  })
})
