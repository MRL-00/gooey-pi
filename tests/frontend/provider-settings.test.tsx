import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ProviderAuthModal } from '../../src/components/ProviderAuthModal'
import { ProviderSettings } from '../../src/pages/settings/ProviderSettings'
import type { PrimeModelCatalog } from '../../src/types/api'

vi.mock('../../src/components/ui', () => ({
  Modal: ({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}))

const catalog: PrimeModelCatalog = {
  primeVersion: '0.7.0',
  refreshedAt: '2026-08-06T00:00:00.000Z',
  models: [],
  providers: [
    { id: 'openai-codex', name: 'ChatGPT Plus/Pro', authMethod: 'oauth', configured: true, authSource: 'stored', modelCount: 8, availableModelCount: 8, enabled: true },
    { id: 'anthropic', name: 'Anthropic', authMethod: 'api_key', configured: false, modelCount: 14, availableModelCount: 0, enabled: false },
  ],
}

const noop = async () => undefined

describe('provider settings', () => {
  it('renders Prime provider state and the correct authentication actions', () => {
    const html = renderToStaticMarkup(<ProviderSettings catalog={{ ...catalog, models: [{ key: 'openai-codex/gpt-5.6', provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true, input: ['text'], contextWindow: 400_000, maxTokens: 128_000, availableThinkingLevels: ['low', 'medium', 'high'], fastModeSupported: true, available: true }] }} onRefresh={noop} onSaveApiKey={noop} onLogout={noop} onSetEnabled={noop} onSetAllEnabled={noop} onStartOAuth={noop} onOpenDocs={() => undefined} />)

    expect(html).toContain('ChatGPT Plus/Pro')
    expect(html).toContain('Anthropic')
    expect(html).toContain('Reconnect')
    expect(html).toContain('Add key')
    expect(html).toContain('Search providers')
    expect(html).toContain('2 providers · 1 model')
    expect(html).toContain('Models <span>1</span>')
    expect(html).toContain('Enable all')
  })

  it('renders bounded OAuth prompts without exposing provider credentials', () => {
    const html = renderToStaticMarkup(<ProviderAuthModal event={{ type: 'prompt', flowId: 'flow-1', providerId: 'openai-codex', promptId: 'prompt-1', message: 'Paste the authorization code', allowEmpty: false }} onOpen={() => undefined} onRespond={() => undefined} onCancel={() => undefined} />)

    expect(html).toContain('Paste the authorization code')
    expect(html).toContain('Continue')
    expect(html).not.toContain('provider-secret')
  })
})
