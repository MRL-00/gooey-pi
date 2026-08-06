import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderAuthModal } from '../../src/components/ProviderAuthModal'
import { ProviderSettings } from '../../src/pages/settings/ProviderSettings'
import type { PrimeModelCatalog } from '../../src/types/api'

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
    const html = renderToStaticMarkup(<ProviderSettings catalog={catalog} onRefresh={noop} onSaveApiKey={noop} onLogout={noop} onSetEnabled={noop} onStartOAuth={noop} onOpenDocs={() => undefined} />)

    expect(html).toContain('ChatGPT Plus/Pro')
    expect(html).toContain('Anthropic')
    expect(html).toContain('Reconnect')
    expect(html).toContain('Add key')
    expect(html).toContain('Search providers')
  })

  it('renders bounded OAuth prompts without exposing provider credentials', () => {
    const html = renderToStaticMarkup(<ProviderAuthModal event={{ type: 'prompt', flowId: 'flow-1', providerId: 'openai-codex', promptId: 'prompt-1', message: 'Paste the authorization code', allowEmpty: false }} onOpen={() => undefined} onRespond={() => undefined} onCancel={() => undefined} />)

    expect(html).toContain('Paste the authorization code')
    expect(html).toContain('Continue')
    expect(html).not.toContain('provider-secret')
  })
})
