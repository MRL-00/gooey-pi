import { AudioLines, Bot, Boxes, ChevronRight, Info, LockKeyhole, Settings2, Sun, Terminal } from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { errorMessage } from '@/lib/errors'
import { BrowserGlobe, Modal } from '@/components/ui'
import { HARNESS_AGENT_NAMES } from '@/lib/harness'
import type { AppMeta, AppSettings, PrimeModelCatalog, PrimeWorkApi } from '@/types/api'
import { AboutSettings } from './settings/AboutSettings'
import { AgentSettings } from './settings/AgentSettings'
import { AppearanceSettings } from './settings/AppearanceSettings'
import { BrowserSettings } from './settings/BrowserSettings'
import type { SettingsSection, SettingsUpdate } from './settings/contracts'
import { GeneralSettings } from './settings/GeneralSettings'
import { PrivacySettings } from './settings/PrivacySettings'
import { ProvidersSettings } from './settings/ProviderSettings'
import { TerminalSettings } from './settings/TerminalSettings'
import { VoiceSettings } from './settings/VoiceSettings'

const sections: Array<{ id: SettingsSection; label: string; icon: ComponentType<{ size?: number }> }> = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'appearance', label: 'Appearance', icon: Sun },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'providers', label: 'Providers', icon: Boxes },
  { id: 'voice', label: 'Voice', icon: AudioLines },
  { id: 'browser', label: 'Browser', icon: BrowserGlobe },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'privacy', label: 'Privacy', icon: LockKeyhole },
  { id: 'about', label: 'About', icon: Info },
]

interface SettingsPageProps {
  settings: AppSettings
  meta?: AppMeta | null
  providerCatalog: PrimeModelCatalog | null
  voice: PrimeWorkApi['voice'] | null
  onUpdate: SettingsUpdate
  onResetBrowser(): Promise<void> | void
  onOpenDocs(): void
  onRefreshProviders(): Promise<void>
  onSaveProviderApiKey(providerId: string, apiKey: string): Promise<void>
  onLogoutProvider(providerId: string): Promise<void>
  onSetProviderEnabled(providerId: string, enabled: boolean): Promise<void>
  onSetAllProvidersEnabled(): Promise<void>
  onSetAllProvidersDisabled(): Promise<void>
  onStartProviderOAuth(providerId: string): Promise<void>
}

export function SettingsPage({ settings, meta, providerCatalog, voice, onUpdate, onResetBrowser, onOpenDocs, onRefreshProviders, onSaveProviderApiKey, onLogoutProvider, onSetProviderEnabled, onSetAllProvidersEnabled, onSetAllProvidersDisabled, onStartProviderOAuth }: SettingsPageProps) {
  const [section, setSection] = useState<SettingsSection>('general')
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState('')

  const resetBrowser = async () => {
    setResetting(true)
    setResetError('')
    try {
      await onResetBrowser()
      setConfirmReset(false)
    } catch (error) {
      setResetError(errorMessage(error))
    } finally {
      setResetting(false)
    }
  }

  const content = (() => {
    switch (section) {
      case 'general': return <GeneralSettings settings={settings} onUpdate={onUpdate} />
      case 'appearance': return <AppearanceSettings settings={settings} onUpdate={onUpdate} />
      case 'agent': return <AgentSettings settings={settings} meta={meta} onUpdate={onUpdate} />
      case 'providers': return <ProvidersSettings harness={settings.activeHarness} catalog={providerCatalog} onRefresh={onRefreshProviders} onSaveApiKey={onSaveProviderApiKey} onLogout={onLogoutProvider} onSetEnabled={onSetProviderEnabled} onSetAllEnabled={onSetAllProvidersEnabled} onSetAllDisabled={onSetAllProvidersDisabled} onStartOAuth={onStartProviderOAuth} onOpenDocs={onOpenDocs} />
      case 'voice': return <VoiceSettings settings={settings} onUpdate={onUpdate} voice={voice} />
      case 'browser': return <BrowserSettings settings={settings} onUpdate={onUpdate} onRequestReset={() => { setResetError(''); setConfirmReset(true) }} />
      case 'terminal': return <TerminalSettings settings={settings} onUpdate={onUpdate} />
      case 'privacy': return <PrivacySettings settings={settings} onUpdate={onUpdate} />
      case 'about': return <AboutSettings meta={meta} onOpenDocs={onOpenDocs} />
    }
  })()

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label="Settings sections">
        {sections.map((item) => {
          const Icon = item.icon
          const label = item.id === 'agent' ? HARNESS_AGENT_NAMES[settings.activeHarness] : item.label
          return (
            <button type="button" key={item.id} className={section === item.id ? 'is-active' : ''} onClick={() => setSection(item.id)}>
              <Icon size={14} /><span>{label}</span><ChevronRight size={12} />
            </button>
          )
        })}
      </nav>
      <div className="settings-content scroll-area"><div className="settings-content__inner">{content}</div></div>
      {confirmReset ? (
        <Modal
          title="Clear browser data?"
          onClose={() => { if (!resetting) setConfirmReset(false) }}
          footer={(
            <>
              <button type="button" className="button" disabled={resetting} onClick={() => setConfirmReset(false)}>Cancel</button>
              <button type="button" className="button button--danger" disabled={resetting} onClick={() => { void resetBrowser() }}>{resetting ? 'Clearing…' : 'Clear browsing data'}</button>
            </>
          )}
        >
          <p>This signs you out of websites opened in Prime Work and removes history, cache, cookies, and saved permissions. This cannot be undone.</p>
          {resetError ? <p className="settings-error" role="alert">{resetError}</p> : null}
        </Modal>
      ) : null}
    </div>
  )
}
