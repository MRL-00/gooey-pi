import { LockKeyhole } from 'lucide-react'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

export function PrivacySettings({ settings, onUpdate }: SettingsSectionProps) {
  return (
    <>
      <header><h1>Privacy</h1><p>Control optional diagnostics and local data.</p></header>
      <section className="settings-group">
        <h2>Diagnostics</h2>
        <SettingsToggle
          checked={settings.telemetry}
          onChange={(telemetry) => { void onUpdate({ telemetry }) }}
          label="Share optional diagnostics"
          description="Allow future anonymous reliability diagnostics. Prompts, files, and terminal output are never included."
        />
      </section>
      <section className="settings-group">
        <h2>Local-first</h2>
        <div className="info-row"><LockKeyhole size={15} /><div><strong>Your work stays on this Mac</strong><small>Project metadata and interface settings are stored locally. Provider requests follow your Prime Agent configuration.</small></div></div>
      </section>
    </>
  )
}
