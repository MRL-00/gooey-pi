import { ExternalLink, KeyRound, LogIn, LogOut, RefreshCw, Search } from 'lucide-react'
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

  return (
    <section className="settings-group provider-settings">
      <div className="settings-group__heading"><h2>Providers</h2><button type="button" className="button button--icon" aria-label="Refresh providers" disabled={busyProvider === 'refresh'} onClick={() => void run('refresh', onRefresh)}><RefreshCw size={13} /></button></div>
      <label className="provider-search"><Search size={13} /><input value={query} placeholder="Search providers" aria-label="Search providers" onChange={(event) => setQuery(event.target.value)} /></label>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      <div className="provider-list">
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
      </div>
      {!providers.length ? <p className="settings-empty">No providers match your search.</p> : null}
      {apiKeyProvider ? <Modal title={`Connect ${apiKeyProvider.name}`} onClose={() => { if (!busyProvider) closeApiKey() }} footer={<><button type="button" className="button" disabled={Boolean(busyProvider)} onClick={closeApiKey}>Cancel</button><button type="button" className="button button--primary" disabled={Boolean(busyProvider) || !apiKey.trim()} onClick={() => void saveApiKey()}>Save API key</button></>}><p className="modal-intro">The key is sent directly to Prime Agent’s protected auth store. Prime Work clears it from renderer state when this dialog closes.</p><label className="field"><span>API key</span><input autoFocus type="password" value={apiKey} autoComplete="off" spellCheck={false} onChange={(event) => setApiKey(event.target.value)} /></label></Modal> : null}
    </section>
  )
}
