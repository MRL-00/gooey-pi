import { Check, KeyRound, Laptop, Mic2, Radio, RefreshCw, ShieldCheck, Trash2, Waves } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui'
import { errorMessage } from '@/lib/errors'
import {
  DEEPGRAM_MODELS,
  GROQ_MODELS,
  OPENAI_FILE_MODELS,
  OPENAI_LIVE_MODELS,
  REALTIME_MODELS,
  REALTIME_VOICES,
  VOICE_PROVIDER_OPTIONS,
  optionsWithCurrent,
  type VoiceOption,
} from '@/lib/voice-options'
import type { AppSettings, PrimeWorkApi, VoiceCredentialProvider, VoiceCredentialStatus, VoiceTranscriptionProvider } from '@/types/api'
import type { SettingsSectionProps } from './contracts'

const CREDENTIALS: Array<{ id: VoiceCredentialProvider; name: string; monogram: string; detail: string }> = [
  { id: 'openai', name: 'OpenAI', monogram: 'OA', detail: 'Required for live dictation and the realtime orb.' },
  { id: 'groq', name: 'Groq', monogram: 'GQ', detail: 'Used only when Groq is your dictation provider.' },
  { id: 'deepgram', name: 'Deepgram', monogram: 'DG', detail: 'Used only when Deepgram is your dictation provider.' },
]

interface VoiceSettingsProps extends SettingsSectionProps {
  voice: PrimeWorkApi['voice'] | null
}

type VoiceServiceState = 'checking' | 'ready' | 'restart-required' | 'error'

function needsDesktopRestart(error: unknown): boolean {
  return /No handler registered for ['"]voice:/i.test(errorMessage(error))
}

function ModelSelect({ label, description, value, options, onChange }: { label: string; description: string; value: string; options: VoiceOption[]; onChange(value: string): void }) {
  const choices = optionsWithCurrent(options, value)
  const selected = choices.find((option) => option.value === value)
  return (
    <label className="voice-choice-row">
      <span><strong>{label}</strong><small>{description}</small></span>
      <span className="voice-choice-control">
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          {choices.map((option) => <option key={option.value} value={option.value}>{option.label}{option.recommended ? ' · Recommended' : ''}</option>)}
        </select>
        {selected ? <small>{selected.detail}</small> : null}
      </span>
    </label>
  )
}

function PathInput({ label, description, placeholder, value, onCommit }: { label: string; description: string; placeholder: string; value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <label className="voice-path-field">
      <span><strong>{label}</strong><small>{description}</small></span>
      <input aria-label={label} value={draft} placeholder={placeholder} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft) }} />
    </label>
  )
}

export function VoiceSettings({ settings, onUpdate, voice }: VoiceSettingsProps) {
  const [status, setStatus] = useState<VoiceCredentialStatus | null>(null)
  const [serviceState, setServiceState] = useState<VoiceServiceState>(voice ? 'checking' : 'restart-required')
  const [credential, setCredential] = useState<VoiceCredentialProvider | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  useEffect(() => {
    let active = true
    if (!voice) { setServiceState('restart-required'); return }
    setServiceState('checking')
    void voice.credentialStatus().then((next) => {
      if (active) { setStatus(next); setServiceState('ready') }
    }).catch((error) => {
      if (!active) return
      setStatus(null)
      if (needsDesktopRestart(error)) { setCredential(null); setFailure(''); setServiceState('restart-required') }
      else { setFailure(errorMessage(error)); setServiceState('error') }
    })
    return () => { active = false }
  }, [voice])

  const saveCredential = async () => {
    if (!voice || !credential || !apiKey.trim()) return
    setBusy(true); setFailure('')
    try {
      setStatus(await voice.saveApiKey(credential, apiKey))
      setApiKey(''); setCredential(null)
    } catch (error) { setFailure(errorMessage(error)) } finally { setBusy(false) }
  }

  const removeCredential = async (provider: VoiceCredentialProvider) => {
    if (!voice) return
    setBusy(true); setFailure('')
    try { setStatus(await voice.deleteApiKey(provider)) } catch (error) { setFailure(errorMessage(error)) } finally { setBusy(false) }
  }

  const closeCredential = () => { if (!busy) { setCredential(null); setApiKey(''); setFailure('') } }
  const openCredential = (provider: VoiceCredentialProvider) => { setFailure(''); setCredential(provider) }
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => { void onUpdate({ [key]: value } as Pick<AppSettings, K>) }
  const provider = VOICE_PROVIDER_OPTIONS.find((option) => option.value === settings.voiceTranscriptionProvider) ?? VOICE_PROVIDER_OPTIONS[0]
  const selectedCredential = provider.credential
  const selectedConfigured = selectedCredential ? status?.configured[selectedCredential] ?? false : true

  return (
    <>
      <header className="voice-settings-header">
        <span className="voice-settings-header__icon"><Mic2 size={19} /></span>
        <div><h1>Voice</h1><p>Connect a speech service, choose a model, then use the microphone or realtime orb.</p></div>
      </header>

      {serviceState === 'restart-required' ? (
        <div className="voice-bridge-notice" role="status">
          <RefreshCw size={17} />
          <span><strong>Restart GooeyPi to finish enabling Voice</strong><small>This app window is connected to an older desktop process without the Voice handlers. Quit GooeyPi completely with ⌘Q, then reopen it.</small></span>
        </div>
      ) : null}

      <section className="voice-section" aria-labelledby="voice-connections-title">
        <div className="voice-section__heading">
          <span><ShieldCheck size={15} /></span>
          <div><h2 id="voice-connections-title">Connections</h2><p>Add a key for any hosted service you want to use. Keys stay encrypted on this Mac.</p></div>
        </div>
        {voice ? <div className="voice-connection-grid">
          {CREDENTIALS.map((item) => {
            const configured = status?.configured[item.id] ?? false
            const source = status?.source[item.id]
            return (
              <article className={`voice-connection-card${configured ? ' is-connected' : ''}`} key={item.id}>
                <span className="voice-provider-mark" aria-hidden="true">{item.monogram}</span>
                <div className="voice-connection-card__body">
                  <span className="voice-connection-card__title"><strong>{item.name}</strong><i>{serviceState === 'checking' ? 'Checking…' : serviceState === 'restart-required' ? 'Restart required' : serviceState === 'error' ? 'Unavailable' : configured ? source === 'environment' ? 'Environment key' : 'Connected' : 'Not connected'}</i></span>
                  <small>{item.detail}</small>
                </div>
                {serviceState === 'ready' ? <button type="button" className="button" disabled={busy} onClick={() => openCredential(item.id)}><KeyRound size={13} /> {configured ? 'Replace key' : 'Add key'}</button> : null}
                {serviceState === 'ready' && source === 'saved' ? <button type="button" className="button button--icon" aria-label={`Remove ${item.name} API key`} disabled={busy} onClick={() => void removeCredential(item.id)}><Trash2 size={13} /></button> : null}
              </article>
            )
          })}
        </div> : null}
        {failure && !credential ? <p className="settings-error" role="alert">{failure}</p> : null}
      </section>

      <section className="voice-section" aria-labelledby="voice-dictation-title">
        <div className="voice-section__heading">
          <span><Waves size={15} /></span>
          <div><h2 id="voice-dictation-title">Dictation</h2><p>This controls the microphone beside Send.</p></div>
        </div>
        <div className="voice-setup-card">
          <label className="voice-choice-row">
            <span><strong>Service</strong><small>Choose where your microphone audio is transcribed.</small></span>
            <span className="voice-choice-control">
              <select aria-label="Dictation service" value={settings.voiceTranscriptionProvider} onChange={(event) => update('voiceTranscriptionProvider', event.target.value as VoiceTranscriptionProvider)}>
                {VOICE_PROVIDER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}{option.recommended ? ' · Recommended' : ''}</option>)}
              </select>
              <small>{provider.detail}</small>
            </span>
          </label>

          {settings.voiceTranscriptionProvider === 'openai-live' ? <ModelSelect label="Dictation model" description="Streams text while you are speaking." value={settings.voiceOpenAiLiveTranscriptionModel} options={OPENAI_LIVE_MODELS} onChange={(value) => update('voiceOpenAiLiveTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'openai' ? <ModelSelect label="Dictation model" description="Transcribes after you stop recording." value={settings.voiceOpenAiTranscriptionModel} options={OPENAI_FILE_MODELS} onChange={(value) => update('voiceOpenAiTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'groq' ? <ModelSelect label="Dictation model" description="Choose speed or maximum Whisper accuracy." value={settings.voiceGroqTranscriptionModel} options={GROQ_MODELS} onChange={(value) => update('voiceGroqTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'deepgram' ? <ModelSelect label="Dictation model" description="Choose a general or audio-specific Nova model." value={settings.voiceDeepgramTranscriptionModel} options={DEEPGRAM_MODELS} onChange={(value) => update('voiceDeepgramTranscriptionModel', value)} /> : null}
          {settings.voiceTranscriptionProvider === 'local-whisper' ? (
            <div className="voice-local-setup">
              <span className="voice-local-setup__intro"><Laptop size={15} /><span><strong>Local whisper.cpp setup</strong><small>These are file paths because GooeyPi runs your installed whisper.cpp directly. Hosted services do not need them.</small></span></span>
              <PathInput label="whisper-cli executable" description="Path to the whisper.cpp command-line program." placeholder="/opt/homebrew/bin/whisper-cli" value={settings.voiceLocalWhisperExecutable} onCommit={(value) => update('voiceLocalWhisperExecutable', value)} />
              <PathInput label="GGML model file" description="Path to the downloaded whisper.cpp model." placeholder="/path/to/ggml-large-v3-turbo.bin" value={settings.voiceLocalWhisperModel} onCommit={(value) => update('voiceLocalWhisperModel', value)} />
            </div>
          ) : null}

          {selectedCredential ? (
            <div className={`voice-requirement${selectedConfigured ? ' is-ready' : ''}`}>
              <span>{selectedConfigured ? <Check size={13} /> : <KeyRound size={13} />}{selectedConfigured ? `${CREDENTIALS.find((item) => item.id === selectedCredential)?.name} is connected` : `${CREDENTIALS.find((item) => item.id === selectedCredential)?.name} key required`}</span>
              {!selectedConfigured && voice && serviceState === 'ready' ? <button type="button" onClick={() => openCredential(selectedCredential)}>Add key</button> : null}
            </div>
          ) : <div className="voice-requirement is-ready"><span><Check size={13} />Runs locally with no API key</span></div>}
        </div>
      </section>

      <section className="voice-section" aria-labelledby="voice-realtime-title">
        <div className="voice-section__heading">
          <span><Radio size={15} /></span>
          <div><h2 id="voice-realtime-title">Realtime orb</h2><p>The draggable voice agent. It uses your OpenAI connection.</p></div>
        </div>
        <div className="voice-setup-card">
          <ModelSelect label="Realtime model" description="Handles conversation, web search, and task delegation." value={settings.voiceRealtimeModel} options={REALTIME_MODELS} onChange={(value) => update('voiceRealtimeModel', value)} />
          <ModelSelect label="Speaking voice" description="The voice you hear when the orb responds." value={settings.voiceRealtimeVoice} options={REALTIME_VOICES} onChange={(value) => update('voiceRealtimeVoice', value)} />
          <div className={`voice-requirement${status?.configured.openai ? ' is-ready' : ''}`}>
            <span>{status?.configured.openai ? <Check size={13} /> : <KeyRound size={13} />}{status?.configured.openai ? 'OpenAI is connected' : 'OpenAI key required'}</span>
            {!status?.configured.openai && voice && serviceState === 'ready' ? <button type="button" onClick={() => openCredential('openai')}>Add key</button> : null}
          </div>
        </div>
      </section>

      {credential ? <Modal title={`Connect ${CREDENTIALS.find((item) => item.id === credential)?.name ?? credential}`} onClose={closeCredential} footer={<><button type="button" className="button" disabled={busy} onClick={closeCredential}>Cancel</button><button type="button" className="button button--primary" disabled={busy || !apiKey.trim()} onClick={() => void saveCredential()}>{busy ? 'Saving…' : 'Save API key'}</button></>}>
        <p className="modal-intro">Paste the provider API key. GooeyPi encrypts it in the desktop process and never reads it back into this screen.</p>
        {failure ? <p className="settings-error" role="alert">{failure}</p> : null}
        <label className="field"><span>API key</span><input autoFocus type="password" value={apiKey} autoComplete="off" spellCheck={false} placeholder="Paste API key" onChange={(event) => setApiKey(event.target.value)} /></label>
      </Modal> : null}
    </>
  )
}
