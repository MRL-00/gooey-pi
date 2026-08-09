import { ExternalLink, Gauge, KeyRound, LogIn, LogOut, RefreshCw, Search, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import type { HarnessId, PrimeModelCatalog, PrimeProviderDescriptor } from '@/types/api'
import { HARNESS_AGENT_NAMES } from '@/lib/harness'
import { Modal } from '@/components/ui'

interface ProviderSettingsProps {
  /** Active harness. OMP credentials stay CLI-owned; visibility toggles only affect GooeyPi. */
  harness?: HarnessId
  catalog: PrimeModelCatalog | null
  onRefresh(): Promise<void>
  onSaveApiKey(providerId: string, apiKey: string): Promise<void>
  onLogout(providerId: string): Promise<void>
  onSetEnabled(providerId: string, enabled: boolean): Promise<void>
  onSetAllEnabled(): Promise<void>
  onSetAllDisabled(): Promise<void>
  onStartOAuth(providerId: string): Promise<void>
  onOpenDocs(): void
}

function authDescription(provider: PrimeProviderDescriptor): string {
  if (!provider.configured) return provider.authMethod === 'external' ? 'Uses credentials configured outside GooeyPi' : 'Not connected'
  const source = provider.authSource === 'environment' ? provider.authLabel ? `Environment · ${provider.authLabel}` : 'Environment'
    : provider.authSource === 'prime_cli' ? 'Prime CLI account'
      : provider.authSource === 'models_json_key' || provider.authSource === 'models_json_command' ? 'models.json'
        : provider.authSource === 'stored' ? provider.authMethod === 'oauth' ? 'Connected account' : 'Stored API key'
          : provider.authSource ?? 'Configured'
  return `${source} · ${provider.availableModelCount.toLocaleString()} available models`
}

export function ProviderSettings({ harness = 'prime', catalog, onRefresh, onSaveApiKey, onLogout, onSetEnabled, onSetAllEnabled, onSetAllDisabled, onStartOAuth, onOpenDocs }: ProviderSettingsProps) {
  const externalAuth = harness === 'omp'
  const agentName = HARNESS_AGENT_NAMES[harness]
  const [view, setView] = useState<'providers' | 'models'>('providers')
  const [query, setQuery] = useState('')
  const [apiKeyProvider, setApiKeyProvider] = useState<PrimeProviderDescriptor | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [apiKeyError, setApiKeyError] = useState('')
  const providers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return catalog?.providers ?? []
    return (catalog?.providers ?? []).filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(normalized))
  }, [catalog, query])
  const providerNames = useMemo(() => new Map((catalog?.providers ?? []).map((provider) => [provider.id, provider.name])), [catalog])
  const providerEnabled = useMemo(() => new Map((catalog?.providers ?? []).map((provider) => [provider.id, provider.enabled])), [catalog])
  const models = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return catalog?.models ?? []
    return (catalog?.models ?? []).filter((model) => `${model.name} ${model.id} ${model.provider} ${providerNames.get(model.provider) ?? ''}`.toLowerCase().includes(normalized))
  }, [catalog, providerNames, query])

  const run = async (providerId: string, action: () => Promise<void>) => {
    setBusyProvider(providerId); setError('')
    try { await action() } catch (failure) { setError(errorMessage(failure)) } finally { setBusyProvider(null) }
  }

  const saveApiKey = async () => {
    const provider = apiKeyProvider
    if (!provider || !apiKey.trim()) return
    setBusyProvider(provider.id)
    setApiKeyError('')
    try {
      await onSaveApiKey(provider.id, apiKey)
      setApiKey('')
      setApiKeyProvider(null)
    } catch (failure) {
      setApiKeyError(errorMessage(failure))
    } finally {
      setBusyProvider(null)
    }
  }

  const closeApiKey = () => { setApiKey(''); setApiKeyError(''); setApiKeyProvider(null) }
  const enableAll = () => run('enable-all', onSetAllEnabled)
  const disableAll = () => run('disable-all', onSetAllDisabled)

  const providerCount = catalog?.providers.length ?? 0
  const modelCount = catalog?.models.length ?? 0
  const availableModelCount = catalog?.models.filter((model) => model.available && providerEnabled.get(model.provider) !== false).length ?? 0
  const disabledCount = catalog?.providers.filter((provider) => !provider.enabled).length ?? 0

  return (
    <section className="settings-group provider-settings">
      <div className="settings-group__heading"><h2>{agentName} catalogue</h2><div className="provider-heading-actions">{catalog && disabledCount < providerCount ? <button type="button" className="button button--danger" disabled={Boolean(busyProvider)} onClick={() => void disableAll()}>{externalAuth ? 'Hide all' : 'Disable all'}</button> : null}{disabledCount ? <button type="button" className="button" disabled={Boolean(busyProvider)} onClick={() => void enableAll()}>{externalAuth ? 'Show all' : 'Enable all'}</button> : null}<button type="button" className="button button--icon" aria-label="Refresh providers" disabled={Boolean(busyProvider)} onClick={() => void run('refresh', onRefresh)}><RefreshCw size={13} /></button></div></div>
      <div className="provider-catalog-summary"><strong>{catalog ? `${providerCount.toLocaleString()} providers · ${modelCount.toLocaleString()} models` : 'Loading provider catalogue…'}</strong>{catalog ? <small>{externalAuth ? `${availableModelCount.toLocaleString()} models are shown in GooeyPi; OMP checks credentials when you launch one` : `${availableModelCount.toLocaleString()} models are available with your current ${agentName} credentials`}</small> : null}</div>
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
            <label className="provider-row__toggle" title={provider.enabled ? `Hide provider in ${agentName}` : `Show provider in ${agentName}`}><input type="checkbox" aria-label={`Show ${provider.name} provider`} checked={provider.enabled} disabled={busy} onChange={(event) => void run(provider.id, () => onSetEnabled(provider.id, event.target.checked))} /><i aria-hidden="true"><span /></i></label>
            <div className="provider-row__identity"><strong>{provider.name}</strong><small>{externalAuth ? `${provider.authLabel ?? 'Credentials managed by the omp CLI'} · ${provider.availableModelCount.toLocaleString()} models` : authDescription(provider)}</small></div>
            {externalAuth ? <div className="provider-row__actions"><button type="button" className="button" onClick={onOpenDocs}><ExternalLink size={13} /> Credential setup</button></div> : <div className="provider-row__actions">
              {provider.authMethod === 'oauth' ? <button type="button" className="button" disabled={busy} onClick={() => void run(provider.id, () => onStartOAuth(provider.id))}><LogIn size={13} /> {provider.configured ? 'Reconnect' : 'Connect'}</button> : null}
              {provider.authMethod === 'api_key' ? <button type="button" className="button" disabled={busy} onClick={() => { setError(''); setApiKeyError(''); setApiKey(''); setApiKeyProvider(provider) }}><KeyRound size={13} /> {provider.configured ? 'Replace key' : 'Add key'}</button> : null}
              {provider.authMethod === 'external' ? <button type="button" className="button" onClick={onOpenDocs}><ExternalLink size={13} /> Setup</button> : null}
              {provider.configured && provider.authSource === 'stored' ? <button type="button" className="button button--icon" aria-label={`Log out of ${provider.name}`} disabled={busy} onClick={() => void run(provider.id, () => onLogout(provider.id))}><LogOut size={13} /></button> : null}
            </div>}
          </div>
        })}
      </div> : <div className="provider-list provider-model-list">
        {models.map((model) => <div className="provider-model-row" key={model.key}>
          <div className="provider-row__identity"><strong>{model.name}</strong><small>{providerNames.get(model.provider) ?? model.provider} · {model.id}</small></div>
          <div className="provider-model-row__capabilities">
            {model.reasoning ? <span title={`${model.availableThinkingLevels.length} reasoning levels`}><Gauge size={11} /> Reasoning</span> : null}
            {model.fastModeSupported ? <span><Zap size={11} /> Fast</span> : null}
            <span className={model.available && providerEnabled.get(model.provider) !== false ? 'is-available' : ''}>{providerEnabled.get(model.provider) === false ? (externalAuth ? 'Hidden' : 'Disabled') : externalAuth ? 'Shown' : model.available ? 'Available' : 'Needs credentials'}</span>
          </div>
        </div>)}
      </div>}
      {catalog && view === 'providers' && !providers.length ? <p className="settings-empty">No providers match your search.</p> : null}
      {catalog && view === 'models' && !models.length ? <p className="settings-empty">No models match your search.</p> : null}
      {apiKeyProvider ? <Modal title={`Connect ${apiKeyProvider.name}`} onClose={() => { if (!busyProvider) closeApiKey() }} footer={<><button type="button" className="button" disabled={Boolean(busyProvider)} onClick={closeApiKey}>Cancel</button><button type="button" className="button button--primary" disabled={Boolean(busyProvider) || !apiKey.trim()} onClick={() => void saveApiKey()}>Save API key</button></>}><p className="modal-intro">The key is sent directly to Prime Agent’s protected auth store. GooeyPi clears it from renderer state when this dialog closes.</p>{apiKeyError ? <p className="settings-error" role="alert">{apiKeyError}</p> : null}<label className="field"><span>API key</span><input autoFocus type="password" value={apiKey} autoComplete="off" spellCheck={false} onChange={(event) => setApiKey(event.target.value)} /></label></Modal> : null}
    </section>
  )
}

/** The Providers settings page: heading plus the provider/model catalog section. */
export function ProvidersSettings(props: ProviderSettingsProps) {
  return (
    <>
      <header><h1>Providers</h1><p>{props.harness === 'omp'
        ? 'Choose which OMP providers and models appear in GooeyPi. These visibility settings do not change OMP itself; credentials remain managed by OMP.'
        : 'Connect accounts, choose which providers and their models appear in GooeyPi, and browse every model Prime Agent supports.'}</p></header>
      <ProviderSettings {...props} />
    </>
  )
}
