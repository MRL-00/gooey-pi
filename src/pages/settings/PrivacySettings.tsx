import { LockKeyhole } from 'lucide-react'
import type { SettingsSectionProps } from './contracts'

export function PrivacySettings({ settings }: SettingsSectionProps) {
  return (
    <>
      <header><h1>Privacy</h1><p>Control optional diagnostics and local data.</p></header>
      <section className="settings-group">
        <h2>Diagnostics</h2>
        <div className="info-row">
          <LockKeyhole size={15} />
          <div>
            <strong>{settings.telemetry ? 'Diagnostics preference is on' : 'Diagnostics are off'}</strong>
            <small>Prime Work does not send prompts, files, terminal output, or usage telemetry.</small>
          </div>
        </div>
      </section>
      <section className="settings-group">
        <h2>Local-first</h2>
        <div className="info-row"><LockKeyhole size={15} /><div><strong>Your work stays on this Mac</strong><small>Project metadata and interface settings are stored locally. Provider requests follow your Prime Agent configuration.</small></div></div>
      </section>
    </>
  )
}
