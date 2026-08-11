import { Bot, Keyboard, ShieldCheck } from 'lucide-react'
import { HARNESS_IDS, OMP_APPROVAL_MODES, type HarnessId, type OmpApprovalMode } from '@/types/api'
import { HARNESS_AGENT_NAMES, HARNESS_PRODUCT_NAMES, HARNESS_SHORT_NAMES } from '@/lib/harness'
import type { SettingsMetaSectionProps } from './contracts'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

const APPROVAL_MODE_LABELS: Record<OmpApprovalMode, string> = {
  'inherit': 'Inherit omp config',
  'always-ask': 'Always ask',
  'write': 'Prompt for exec only (write)',
  'yolo': 'YOLO (never prompt)',
}

export function AgentSettings({ settings, meta, onUpdate }: SettingsMetaSectionProps) {
  const activeHarness = settings.activeHarness
  const shortName = HARNESS_SHORT_NAMES[activeHarness]
  const toggleHarness = (harness: HarnessId, enabled: boolean) => {
    const next = enabled
      ? [...new Set([...settings.enabledHarnesses, harness])]
      : settings.enabledHarnesses.filter((candidate) => candidate !== harness)
    if (!next.length) return
    const nextDefault = next.length === 1
      ? next[0]
      : next.includes(settings.activeHarness) ? settings.activeHarness : next[0]
    void onUpdate({ enabledHarnesses: next, activeHarness: nextDefault })
  }
  const runtimePathValidation = (value: string, harness: HarnessId): string => {
    if (!value) return ''
    const absolute = meta?.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') : value.startsWith('/')
    return absolute ? '' : `${HARNESS_AGENT_NAMES[harness]} path must be absolute (or blank for automatic discovery)`
  }
  return (
    <>
      <header><h1>Harness</h1><p>Runtime discovery, model providers, and workspace permissions.</p></header>
      <section className="settings-group">
        <h2>Harness</h2>
        {HARNESS_IDS.map((harness) => <SettingsToggle key={harness} checked={settings.enabledHarnesses.includes(harness)} onChange={(enabled) => toggleHarness(harness, enabled)} label={`Enable ${HARNESS_PRODUCT_NAMES[harness]}`} description="Show this harness in the Harness menu and allow it to be the default." />)}
        <label className="settings-row">
          <span><strong>Active harness / default</strong><small>The harness opened by default; mirrors the current choice in the Harness menu.</small></span>
          <select value={activeHarness} onChange={(event) => { void onUpdate({ activeHarness: event.target.value as HarnessId }) }}>
            {HARNESS_IDS.filter((harness) => settings.enabledHarnesses.includes(harness)).map((harness) => <option key={harness} value={harness}>{HARNESS_PRODUCT_NAMES[harness]}</option>)}
          </select>
        </label>
        {activeHarness === 'omp' ? (
          <label className="settings-row">
            <span><strong>Approval mode</strong><small>How OMP asks before running tools; Inherit leaves your omp configuration in charge.</small></span>
            <select value={settings.ompApprovalMode} onChange={(event) => { void onUpdate({ ompApprovalMode: event.target.value as OmpApprovalMode }) }}>
              {OMP_APPROVAL_MODES.map((mode) => <option key={mode} value={mode}>{APPROVAL_MODE_LABELS[mode]}</option>)}
            </select>
          </label>
        ) : null}
      </section>
      <section className="settings-group">
        <h2>Runtime</h2>
        {HARNESS_IDS.map((harness) => {
          const name = HARNESS_AGENT_NAMES[harness]
          const status = meta?.harnesses[harness]
          return (
            <div className="runtime-card" key={harness}>
              <span className={status?.path ? 'is-online' : ''}><Bot size={17} /></span>
              <div>
                <strong>{status?.path ? `${name} is ready` : `${name} not detected`}</strong>
                <small>{status?.path ?? `Install ${name} and restart the app.`}</small>
              </div>
              {status?.version ? <code>v{status.version}</code> : null}
            </div>
          )
        })}
        <p className="settings-group__description">Discovery checks a saved override first, then the harness environment variable, bundled files, PATH, and standard install directories. Changes apply after restarting GooeyPi.</p>
        {HARNESS_IDS.map((harness) => <DraftSettingField
          key={harness}
          id={`runtime-path-${harness}`}
          label={`${HARNESS_AGENT_NAMES[harness]} executable override`}
          description="Optional absolute path. Leave blank to keep automatic discovery."
          committedValue={settings.runtimePaths[harness]}
          validate={(value) => runtimePathValidation(value.trim(), harness)}
          normalize={(value) => value.trim()}
          onCommit={(value) => onUpdate({ runtimePaths: { ...settings.runtimePaths, [harness]: value } })}
        />)}
      </section>
      <section className="settings-group">
        <h2>Transcript</h2>
        <SettingsToggle checked={settings.showReasoningSummaries} onChange={(showReasoningSummaries) => { void onUpdate({ showReasoningSummaries }) }} label="Show reasoning summaries" description={`Display reasoning summaries and traces while ${shortName} works. Completed work stays collapsed.`} />
        <SettingsToggle checked={settings.showToolCalls} onChange={(showToolCalls) => { void onUpdate({ showToolCalls }) }} label="Show tool calls" description="Display compact tool activity, arguments, and expandable results." />
      </section>
      <section className="settings-group">
        <h2>Message shortcuts</h2>
        <label className="settings-row">
          <span><strong>Primary Enter action while {shortName} is working</strong><small>Ctrl+Enter or ⌘+Enter always uses the opposite action. Shift+Enter adds a new line.</small></span>
          <span className="shortcut-choice" role="radiogroup" aria-label="Primary Enter action">
            {(['queue', 'steer'] as const).map((action) => <button key={action} type="button" className={`button button--compact ${settings.messageEnterAction === action ? 'is-active' : ''}`} role="radio" aria-checked={settings.messageEnterAction === action} onClick={() => { void onUpdate({ messageEnterAction: action }) }}>{action === 'queue' ? 'Queue' : 'Steer'}</button>)}
          </span>
        </label>
        <div className="shortcut-row"><span><Keyboard size={14} />{settings.messageEnterAction === 'queue' ? 'Queue message' : 'Steer current turn'}</span><kbd>Enter</kbd></div>
        <div className="shortcut-row"><span><Keyboard size={14} />{settings.messageEnterAction === 'queue' ? 'Steer current turn' : 'Queue message'}</span><kbd>Ctrl Enter / ⌘ Enter</kbd></div>
      </section>
      <section className="settings-group">
        <h2>Permissions</h2>
        <div className="info-row"><ShieldCheck size={15} /><div><strong>Workspace access</strong><small>{shortName} only receives the project folders attached to a session.</small></div></div>
      </section>
    </>
  )
}
