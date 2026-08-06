import type { AppSettings } from '@/types/api'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

export function GeneralSettings({ settings, onUpdate }: SettingsSectionProps) {
  return (
    <>
      <header><h1>General</h1><p>Choose how Prime Work behaves across projects.</p></header>
      <section className="settings-group">
        <h2>Window</h2>
        <SettingsToggle checked={settings.sidebarOpen} onChange={(sidebarOpen) => { void onUpdate({ sidebarOpen }) }} label="Show project sidebar" description="Keep projects and sessions visible when the app opens." />
        <SettingsToggle checked={settings.inspectorOpen} onChange={(inspectorOpen) => { void onUpdate({ inspectorOpen }) }} label="Open session inspector" description="Show the summary pane for newly opened sessions." />
      </section>
      <section className="settings-group">
        <h2>Session defaults</h2>
        <label className="settings-row">
          <span><strong>Default inspector tab</strong><small>The first detail surface shown in a session.</small></span>
          <select value={settings.defaultInspectorTab} onChange={(event) => { void onUpdate({ defaultInspectorTab: event.target.value as AppSettings['defaultInspectorTab'] }) }}>
            <option value="summary">Summary</option>
            <option value="changes">Changes</option>
            <option value="browser">Browser</option>
            <option value="files">Files</option>
          </select>
        </label>
      </section>
    </>
  )
}
