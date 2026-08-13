import { Keyboard } from 'lucide-react'
import type { SettingsSectionProps } from './contracts'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import { terminalShellValidation } from './draft-state'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

export function TerminalSettings({ settings, onUpdate, platform = 'darwin' }: SettingsSectionProps & { platform?: NodeJS.Platform }) {
  return (
    <>
      <header><h1>Terminal</h1><p>Configure the interactive shell used for local projects.</p></header>
      <section className="settings-group">
        <h2>Shell</h2>
        <DraftSettingField
          id="terminal-shell"
          label="Shell executable"
          description="Restart open terminals after changing this value."
          committedValue={settings.terminalShell}
          validate={terminalShellValidation}
          onCommit={(terminalShell) => onUpdate({ terminalShell })}
          className="mono"
        />
        <SettingsToggle checked={settings.terminalOpen} onChange={(terminalOpen) => { void onUpdate({ terminalOpen }) }} label="Open terminal with new sessions" description="Show the terminal drawer when a new project session starts." />
      </section>
      <section className="settings-group">
        <h2>Keyboard shortcut</h2>
        <div className="shortcut-row"><span><Keyboard size={14} />Toggle terminal</span><kbd>{shortcutLabel(platform, ['Primary', 'J'])}</kbd></div>
      </section>
    </>
  )
}
