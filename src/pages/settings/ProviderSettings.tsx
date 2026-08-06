import { ExternalLink, Gauge, KeyRound, LogIn, LogOut, RefreshCw, Search, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { PrimeModelCatalog, PrimeProviderDescriptor } from '@/types/api'
import { Modal } from '@/components/ui'

interface ProviderSettingsProps {
  catalog: PrimeModelCatalog | null
  onRefresh(): Promise<void>
  onSaveApiKey(providerId: string, apiKey: string): Promise<void>
  onLogout(providerId: string): Promise<void>
  onSetEnabled(providerId: string, enabled: boolean): Promise<void>
  onStartOAuth(providerId: string): Promise<void>
  onOpenDocs(): void
}

function authDescription(provider: PrimeProviderDescriptor): string {
  if (!provider.configured) return provider.authMethod === 'external' ? 'Uses credentials configured outside Prime Work' : 'Not connected'
  const source = provider.authSource === 'environment' ? provider.authLabel ? `Environment · ${provider.authLabel}` : 'Environment'
    : provider.authSource === 'prime_cli' ? 'Prime CLI account'
      : provider.authSource === 'models_json_key' || provider.authSource === 'models_json_command' ? 'models.json'
        : provider.authSource === 'stored' ? provider.authMethod === 'oauth' ? 'Connected account' : 'Stored API key'
          : provider.authSource ?? 'Configured'
  return `${source} · ${provider.availableModelCount.toLocaleString()} available models`
}

export function ProviderSettings({ catalog, onRefresh, onSaveApiKey, onLogout, onSetEnabled, onStartOAuth, onOpenDocs }: ProviderSettingsProps) {
  const [view, setView] = useState<'providers' | 'models'>('providers')
  const [query, setQuery] = useState('')
  const [apiKeyProvider, setApiKeyProvider] = useState<PrimeProviderDescriptor | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [error, setError] = useState('')
  const providers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return catalog?.providers ?? []
    return (catalog?.providers ?? []).filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(normalized))
  }, [catalog, query])
  const providerNames = useMemo(() => new Map((catalog?.providers ?? []).map((provider) => [provider.id, provider.name])), [catalog])
  const models = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return catalog?.models ?? []
    return (catalog?.models ?? []).filter((model) => `${model.name} ${model.id} ${model.provider} ${providerNames.get(model.provider) ?? ''}`.toLowerCase().includes(normalized))
  }, [catalog, providerNames, query])

  const run = async (providerId: string, action: () => Promise<void>) => {
    setBusyProvider(providerId); setError('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setBusyProvider(null) }
  }

  const saveApiKey = async () => {
    const provider = apiKeyProvider
    if (!provider || !apiKey.trim()) return
    await run(provider.id, async () => { await onSaveApiKey(provider.id, apiKey); setApiKey(''); setApiKeyProvider(null) })
  }

  const closeApiKey = () => { setApiKey(''); setApiKeyProvider(null) }
  const enableAll = () => run('enable-all', async () => {
    for (const provider of catalog?.providers ?? []) if (!provider.enabled) await onSetEnabled(provider.id, true)
  })

  const providerCount = catalog?.providers.length ?? 0
  const modelCount = catalog?.models.length ?? 0
  const availableModelCount = catalog?.models.filter((model) => model.available).length ?? 0
  const disabledCount = catalog?.providers.filter((provider) => !provider.enabled).length ?? 0

  return (
    <section className="settings-group provider-settings">
      <div className="settings-group__heading"><h2>Prime Agent catalogue</h2><div className="provider-heading-actions">{disabledCount ? <button type="button" className="button" disabled={Boolean(busyProvider)} onClick={() => void enableAll()}>Enable all</button> : null}<button type="button" className="button button--icon" aria-label="Refresh providers" disabled={Boolean(busyProvider)} onClick={() => void run('refresh', onRefresh)}><RefreshCw size={13} /></button></div></div>
      <div className="provider-catalog-summary"><strong>{catalog ? `${providerCount.toLocaleString()} providers · ${modelCount.toLocaleString()} models` : 'Loading provider catalogue…'}</strong>{catalog ? <small>{availableModelCount.toLocaleString()} models are available with your current Prime Agent credentials</small> : null}</div>
      {catalog?.warning ? <p className="provider-catalog-warning" role="status">{catalog.warning}</p> : null}
      <div className="provider-catalog-tabs" role="tablist" aria-label="Provider catalogue view">
        <button type="button" role="tab" aria-selected={view === 'providers'} className={view === 'providers' ? 'is-active' : ''} onClick={() => { setView('providers'); setQuery('') }}>Providers <span>{providerCount.toLocaleString()}</span></button>
        <button type="button" role="tab" aria-selected={view === 'models'} className={view === 'models' ? 'is-active' : ''} onClick={() => { setView('models'); setQuery('') }}>Models <span>{modelCount.toLocaleString()}</span></button>
      </div>
      <label className="provider-search"><Search size={13} /><input value={query} placeholder={view === 'providers' ? 'Search providers' : 'Search models'} aria-label={view === 'providers' ? 'Search providers' : 'Search models'} onChange={(event) => setQuery(event.target.value)} /></label>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {view === 'providers' ? <div className="provider-list">
        {providers.map((provider) => {
          const busy = busyProvider === provider.id
          return <div className="provider-row" key={provider.id}>
            <label className="provider-row__toggle" title={provider.enabled ? 'Disable provider in Prime Work' : 'Enable provider in Prime Work'}><input type="checkbox" checked={provider.enabled} disabled={busy} onChange={(event) => void run(provider.id, () => onSetEnabled(provider.id, event.target.checked))} /><i aria-hidden="true"><span /></i></label>
            <div className="provider-row__identity"><strong>{provider.name}</strong><small>{authDescription(provider)}</small></div>
            <div className="provider-row__actions">
              {provider.authMethod === 'oauth' ? <button type="button" className="button" disabled={busy} onClick={() => void run(provider.id, () => onStartOAuth(provider.id))}><LogIn size={13} /> {provider.configured ? 'Reconnect' : 'Connect'}</button> : null}
              {provider.authMethod === 'api_key' ? <button type="button" className="button" disabled={busy} onClick={() => { setError(''); setApiKey(''); setApiKeyProvider(provider) }}><KeyRound size={13} /> {provider.configured ? 'Replace key' : 'Add key'}</button> : null}
              {provider.authMethod === 'external' ? <button type="button" className="button" onClick={onOpenDocs}><ExternalLink size={13} /> Setup</button> : null}
              {provider.configured && provider.authSource === 'stored' ? <button type="button" className="button button--icon" aria-label={`Log out of ${provider.name}`} disabled={busy} onClick={() => void run(provider.id, () => onLogout(provider.id))}><LogOut size={13} /></button> : null}
            </div>
          </div>
        })}
      </div> : <div className="provider-list provider-model-list">
        {models.map((model) => <div className="provider-model-row" key={model.key}>
          <div className="provider-row__identity"><strong>{model.name}</strong><small>{providerNames.get(model.provider) ?? model.provider} · {model.id}</small></div>
          <div className="provider-model-row__capabilities">
            {model.reasoning ? <span title={`${model.availableThinkingLevels.length} reasoning levels`}><Gauge size={11} /> Reasoning</span> : null}
            {model.fastModeSupported ? <span><Zap size={11} /> Fast</span> : null}
            <span className={model.available ? 'is-available' : ''}>{model.available ? 'Available' : 'Needs credentials'}</span>
          </div>
        </div>)}
      </div>}
      {catalog && view === 'providers' && !providers.length ? <p className="settings-empty">No providers match your search.</p> : null}
      {catalog && view === 'models' && !models.length ? <p className="settings-empty">No models match your search.</p> : null}
      {apiKeyProvider ? <Modal title={`Connect ${apiKeyProvider.name}`} onClose={() => { if (!busyProvider) closeApiKey() }} footer={<><button type="button" className="button" disabled={Boolean(busyProvider)} onClick={closeApiKey}>Cancel</button><button type="button" className="button button--primary" disabled={Boolean(busyProvider) || !apiKey.trim()} onClick={() => void saveApiKey()}>Save API key</button></>}><p className="modal-intro">The key is sent directly to Prime Agent’s protected auth store. Prime Work clears it from renderer state when this dialog closes.</p><label className="field"><span>API key</span><input autoFocus type="password" value={apiKey} autoComplete="off" spellCheck={false} onChange={(event) => setApiKey(event.target.value)} /></label></Modal> : null}
    </section>
  )
}
