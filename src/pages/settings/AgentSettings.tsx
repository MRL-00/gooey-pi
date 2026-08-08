import { Bot, Keyboard, ShieldCheck } from 'lucide-react'
import { HARNESS_IDS, type HarnessId } from '@/types/api'
import type { SettingsMetaSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

const HARNESS_NAMES: Record<HarnessId, string> = { prime: 'Prime Agent', omp: 'OMP' }

export function AgentSettings({ settings, meta, onUpdate }: SettingsMetaSectionProps) {
  return (
    <>
      <header><h1>Prime Agent</h1><p>Runtime discovery, model providers, and workspace permissions.</p></header>
      <section className="settings-group">
        <h2>Runtime</h2>
        {HARNESS_IDS.map((harness) => {
          const name = HARNESS_NAMES[harness]
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
        <SettingsToggle checked={settings.showReasoningSummaries} onChange={(showReasoningSummaries) => { void onUpdate({ showReasoningSummaries }) }} label="Show reasoning summaries" description="Display reasoning summaries and traces while Prime works. Completed work stays collapsed." />
        <SettingsToggle checked={settings.showToolCalls} onChange={(showToolCalls) => { void onUpdate({ showToolCalls }) }} label="Show tool calls" description="Display compact tool activity, arguments, and expandable results." />
      </section>
      <section className="settings-group">
        <h2>Message shortcuts</h2>
        <div className="settings-row">
          <span><strong>Enter while Prime is working</strong><small>Enter queues a message. Ctrl+Enter steers the current turn. Shift+Enter adds a new line.</small></span>
        </div>
        <div className="shortcut-row"><span><Keyboard size={14} />Queue message</span><kbd>Enter</kbd></div>
        <div className="shortcut-row"><span><Keyboard size={14} />Steer current turn</span><kbd>Ctrl Enter</kbd></div>
      </section>
      <section className="settings-group">
        <h2>Permissions</h2>
        <div className="info-row"><ShieldCheck size={15} /><div><strong>Workspace access</strong><small>Prime only receives the project folders attached to a session.</small></div></div>
      </section>
    </>
  )
}
