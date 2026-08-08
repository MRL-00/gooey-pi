import { Bot, Keyboard, ShieldCheck } from 'lucide-react'
import { HARNESS_IDS, OMP_APPROVAL_MODES, type HarnessId, type OmpApprovalMode } from '@/types/api'
import { HARNESS_AGENT_NAMES, HARNESS_PRODUCT_NAMES, HARNESS_SHORT_NAMES } from '@/lib/harness'
import type { SettingsMetaSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

const APPROVAL_MODE_LABELS: Record<OmpApprovalMode, string> = {
  'inherit': 'Inherit omp config',
  'always-ask': 'Always ask',
  'write': 'Prompt for exec only (write)',
  'yolo': 'YOLO (never prompt)',
}

export function AgentSettings({ settings, meta, onUpdate }: SettingsMetaSectionProps) {
  const activeHarness = settings.activeHarness
  const agentName = HARNESS_AGENT_NAMES[activeHarness]
  const shortName = HARNESS_SHORT_NAMES[activeHarness]
  return (
    <>
      <header><h1>{agentName}</h1><p>Runtime discovery, model providers, and workspace permissions.</p></header>
      <section className="settings-group">
        <h2>Harness</h2>
        <label className="settings-row">
          <span><strong>Active harness</strong><small>The agent that powers the workspace; mirrors the switcher in the sidebar.</small></span>
          <select value={activeHarness} onChange={(event) => { void onUpdate({ activeHarness: event.target.value as HarnessId }) }}>
            {HARNESS_IDS.map((harness) => <option key={harness} value={harness}>{HARNESS_PRODUCT_NAMES[harness]}</option>)}
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
      </section>
      <section className="settings-group">
        <h2>Transcript</h2>
        <SettingsToggle checked={settings.showReasoningSummaries} onChange={(showReasoningSummaries) => { void onUpdate({ showReasoningSummaries }) }} label="Show reasoning summaries" description={`Display reasoning summaries and traces while ${shortName} works. Completed work stays collapsed.`} />
        <SettingsToggle checked={settings.showToolCalls} onChange={(showToolCalls) => { void onUpdate({ showToolCalls }) }} label="Show tool calls" description="Display compact tool activity, arguments, and expandable results." />
      </section>
      <section className="settings-group">
        <h2>Message shortcuts</h2>
        <div className="settings-row">
          <span><strong>Enter while {shortName} is working</strong><small>Enter queues a message. Ctrl+Enter or ⌘+Enter steers the current turn. Shift+Enter adds a new line.</small></span>
        </div>
        <div className="shortcut-row"><span><Keyboard size={14} />Queue message</span><kbd>Enter</kbd></div>
        <div className="shortcut-row"><span><Keyboard size={14} />Steer current turn</span><kbd>Ctrl Enter</kbd></div>
      </section>
      <section className="settings-group">
        <h2>Permissions</h2>
        <div className="info-row"><ShieldCheck size={15} /><div><strong>Workspace access</strong><small>{shortName} only receives the project folders attached to a session.</small></div></div>
      </section>
    </>
  )
}
