import { RotateCcw } from 'lucide-react'
import type { SettingsSectionProps } from './contracts'
import { browserHomeValidation, normalizeBrowserHome } from './draft-state'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

interface BrowserSettingsProps extends SettingsSectionProps {
  onRequestReset(): void
}

export function BrowserSettings({ settings, onUpdate, onRequestReset }: BrowserSettingsProps) {
  return (
    <>
      <header><h1>Browser</h1><p>Manage the isolated profile used inside GUI Pie.</p></header>
      <section className="settings-group">
        <h2>Startup</h2>
        <DraftSettingField
          id="browser-home"
          label="Home page"
          description="Opened when you create a browser tab."
          committedValue={settings.browserHome}
          validate={browserHomeValidation}
          normalize={normalizeBrowserHome}
          onCommit={(browserHome) => onUpdate({ browserHome })}
        />
        <SettingsToggle checked={settings.browserAskForDownloads} onChange={(browserAskForDownloads) => { void onUpdate({ browserAskForDownloads }) }} label="Ask where to save downloads" description="Choose a location before every browser download." />
      </section>
      <section className="settings-group">
        <h2>Browser data</h2>
        <div className="danger-row">
          <span><strong>Clear browsing data</strong><small>Remove cookies, cache, permissions, and browsing history.</small></span>
          <button type="button" className="button" onClick={onRequestReset}><RotateCcw size={13} /> Clear data</button>
        </div>
      </section>
    </>
  )
}
