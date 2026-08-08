import { KeyRound, Radio, ShieldCheck, Trash2, Volume2, Waves } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import type { AppSettings, PrimeWorkApi, VoiceCredentialProvider, VoiceCredentialStatus, VoiceTranscriptionProvider } from '@/types/api'
import { Modal } from '@/components/ui'
import type { SettingsSectionProps } from './contracts'

const TRANSCRIPTION_OPTIONS: Array<{ value: VoiceTranscriptionProvider; label: string }> = [
  { value: 'openai-live', label: 'OpenAI native streaming' },
  { value: 'openai', label: 'OpenAI file transcription' },
  { value: 'groq', label: 'Groq Whisper' },
  { value: 'deepgram', label: 'Deepgram' },
  { value: 'local-whisper', label: 'Local whisper.cpp' },
]

const CREDENTIALS: Array<{ id: VoiceCredentialProvider; name: string; detail: string }> = [
  { id: 'openai', name: 'OpenAI', detail: 'Realtime orb, native streaming, file transcription, and web search' },
  { id: 'groq', name: 'Groq', detail: 'Fast hosted Whisper transcription' },
  { id: 'deepgram', name: 'Deepgram', detail: 'Hosted streaming-quality speech recognition' },
]

interface VoiceSettingsProps extends SettingsSectionProps {
  voice: PrimeWorkApi['voice'] | null
}

function SettingInput({ label, description, value, onCommit }: { label: string; description: string; value: string; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <label className="settings-row settings-row--stack voice-setting-field">
      <span><strong>{label}</strong><small>{description}</small></span>
      <input value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onCommit(draft) }} />
    </label>
  )
}

export function VoiceSettings({ settings, onUpdate, voice }: VoiceSettingsProps) {
  const [status, setStatus] = useState<VoiceCredentialStatus | null>(null)
  const [credential, setCredential] = useState<VoiceCredentialProvider | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  useEffect(() => {
    let active = true
    if (!voice) return
    void voice.credentialStatus().then((next) => { if (active) setStatus(next) }).catch((error) => { if (active) setFailure(errorMessage(error)) })
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
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => { void onUpdate({ [key]: value } as Pick<AppSettings, K>) }

  return (
    <>
      <header><h1>Voice</h1><p>Choose transcription services, keep API keys in protected desktop storage, and configure the realtime voice orchestrator.</p></header>
      <section className="settings-group">
        <h2><Waves size={14} /> Dictation</h2>
        <label className="settings-row">
          <span><strong>Transcription service</strong><small>Native streaming appears alongside file and local models.</small></span>
          <select value={settings.voiceTranscriptionProvider} onChange={(event) => update('voiceTranscriptionProvider', event.target.value as VoiceTranscriptionProvider)}>
            {TRANSCRIPTION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <SettingInput label="OpenAI file model" description="Used by OpenAI file transcription." value={settings.voiceOpenAiTranscriptionModel} onCommit={(value) => update('voiceOpenAiTranscriptionModel', value)} />
        <SettingInput label="Groq model" description="An available Groq audio transcription model." value={settings.voiceGroqTranscriptionModel} onCommit={(value) => update('voiceGroqTranscriptionModel', value)} />
        <SettingInput label="Deepgram model" description="An available Deepgram speech model." value={settings.voiceDeepgramTranscriptionModel} onCommit={(value) => update('voiceDeepgramTranscriptionModel', value)} />
        <SettingInput label="whisper.cpp executable" description="Absolute path to the local whisper-cli executable." value={settings.voiceLocalWhisperExecutable} onCommit={(value) => update('voiceLocalWhisperExecutable', value)} />
        <SettingInput label="Local Whisper model" description="Absolute path to a local GGML model file." value={settings.voiceLocalWhisperModel} onCommit={(value) => update('voiceLocalWhisperModel', value)} />
      </section>

      <section className="settings-group">
        <h2><Radio size={14} /> Realtime orb</h2>
        <SettingInput label="Realtime model" description="A Realtime API model with audio and function calling." value={settings.voiceRealtimeModel} onCommit={(value) => update('voiceRealtimeModel', value)} />
        <SettingInput label="Voice" description="The synthesized voice used by the orb." value={settings.voiceRealtimeVoice} onCommit={(value) => update('voiceRealtimeVoice', value)} />
      </section>

      <section className="settings-group">
        <h2><ShieldCheck size={14} /> Service credentials</h2>
        <p className="settings-group__description">Keys are encrypted by macOS and never returned to the renderer. Environment variables are also recognized.</p>
        <div className="voice-credential-list">
          {CREDENTIALS.map((provider) => {
            const configured = status?.configured[provider.id] ?? false
            const source = status?.source[provider.id]
            return <div className="voice-credential-row" key={provider.id}>
              <span><strong>{provider.name}</strong><small>{provider.detail}</small></span>
              <span className="voice-credential-actions">
                <i className={configured ? 'is-configured' : ''}>{configured ? source === 'environment' ? 'Environment' : 'Saved' : 'Not configured'}</i>
                <button type="button" className="button" disabled={!voice || busy} onClick={() => { setFailure(''); setCredential(provider.id) }}><KeyRound size={13} /> {configured ? 'Replace' : 'Add key'}</button>
                {source === 'saved' ? <button type="button" className="button button--icon" aria-label={`Remove ${provider.name} API key`} disabled={busy} onClick={() => void removeCredential(provider.id)}><Trash2 size={13} /></button> : null}
              </span>
            </div>
          })}
        </div>
        {failure && !credential ? <p className="settings-error" role="alert">{failure}</p> : null}
      </section>

      {credential ? <Modal title={`Connect ${CREDENTIALS.find((item) => item.id === credential)?.name ?? credential}`} onClose={closeCredential} footer={<><button type="button" className="button" disabled={busy} onClick={closeCredential}>Cancel</button><button type="button" className="button button--primary" disabled={busy || !apiKey.trim()} onClick={() => void saveCredential()}>Save API key</button></>}>
        <p className="modal-intro">The key is encrypted by the desktop main process and cleared from this form when it closes.</p>
        {failure ? <p className="settings-error" role="alert">{failure}</p> : null}
        <label className="field"><span>API key</span><input autoFocus type="password" value={apiKey} autoComplete="off" spellCheck={false} onChange={(event) => setApiKey(event.target.value)} /></label>
      </Modal> : null}
    </>
  )
}
