import type { PrimeModelCatalog } from '@/types/api'
import { ProviderSettings } from './ProviderSettings'

interface ProvidersSettingsProps {
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

export function ProvidersSettings(props: ProvidersSettingsProps) {
  return (
    <>
      <header><h1>Providers</h1><p>Connect accounts, choose which providers and their models appear in Prime Work, and browse every model Prime Agent supports.</p></header>
      <ProviderSettings {...props} />
    </>
  )
}
