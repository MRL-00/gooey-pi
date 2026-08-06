import { Check, Laptop, Moon, Sun } from 'lucide-react'
import type { ThemeMode } from '@/types/api'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

const themes: Array<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
  { id: 'system', label: 'System', icon: Laptop },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
]

export function AppearanceSettings({ settings, onUpdate }: SettingsSectionProps) {
  return (
    <>
      <header><h1>Appearance</h1><p>Keep the workspace comfortable in any environment.</p></header>
      <section className="settings-group">
        <h2>Theme</h2>
        <div className="theme-options">
          {themes.map((item) => {
            const Icon = item.icon
            return (
              <button type="button" key={item.id} className={settings.theme === item.id ? 'is-active' : ''} onClick={() => { void onUpdate({ theme: item.id }) }}>
                <span><Icon size={17} /></span><strong>{item.label}</strong>{settings.theme === item.id ? <Check size={13} /> : null}
              </button>
            )
          })}
        </div>
      </section>
      <section className="settings-group">
        <h2>Motion</h2>
        <SettingsToggle checked={settings.reduceMotion} onChange={(reduceMotion) => { void onUpdate({ reduceMotion }) }} label="Reduce interface motion" description="Minimize panel transitions and animated status indicators." />
      </section>
    </>
  )
}
