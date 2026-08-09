import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn(), defaultSession: {} } }))

import { SettingsService } from '../../electron/main/settings-schedules'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
function makeService(validateShell: (shell: unknown) => string = () => '/bin/zsh') {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-settings-'))
  dirs.push(dir)
  return new SettingsService(new JsonStateStore(join(dir, 'state.json')), validateShell)
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('SettingsService.update', () => {
  it('applies every field of a full valid patch', async () => {
    const service = makeService()
    const next = await service.update({
      theme: 'dark',
      sidebarOpen: false,
      inspectorOpen: true,
      showFileChangesPopup: false,
      terminalOpen: true,
      defaultInspectorTab: 'changes',
      browserHome: 'https://example.test/',
      browserAskForDownloads: false,
      terminalShell: '/bin/zsh',
      reduceMotion: true,
      showReasoningSummaries: false,
      showToolCalls: false,
      messageEnterAction: 'steer',
      telemetry: false,
      disabledProviders: ['openai', 'openai', 'google'],
      ompDisabledProviders: ['anthropic', 'anthropic'],
      activeHarness: 'omp',
      ompApprovalMode: 'always-ask',
      petEnabled: true,
      petId: 'codex/rocky',
      voiceTranscriptionProvider: 'groq',
      voiceOpenAiLiveTranscriptionModel: 'gpt-realtime-whisper',
      voiceOpenAiTranscriptionModel: 'gpt-4o-mini-transcribe',
      voiceGroqTranscriptionModel: 'whisper-large-v3',
      voiceDeepgramTranscriptionModel: 'nova-3-general',
      voiceLocalWhisperExecutable: '/opt/whisper-cli',
      voiceLocalWhisperModel: '/opt/ggml-model.bin',
      voiceRealtimeModel: 'gpt-realtime-2.1',
      voiceRealtimeVoice: 'cedar',
    })
    expect(next).toMatchObject({
      theme: 'dark', sidebarOpen: false, inspectorOpen: true, showFileChangesPopup: false, terminalOpen: true,
      defaultInspectorTab: 'changes', browserHome: 'https://example.test/',
      browserAskForDownloads: false, terminalShell: '/bin/zsh', reduceMotion: true,
      showReasoningSummaries: false, showToolCalls: false, messageEnterAction: 'steer',
      telemetry: false, disabledProviders: ['openai', 'google'], ompDisabledProviders: ['anthropic'],
      activeHarness: 'omp', ompApprovalMode: 'always-ask', petEnabled: true, petId: 'codex/rocky',
      voiceTranscriptionProvider: 'groq', voiceRealtimeVoice: 'cedar',
    })
    expect(service.get()).toEqual(next)
  })

  it('leaves unrelated settings untouched on a partial patch', async () => {
    const service = makeService()
    const before = service.get()
    const next = await service.update({ theme: 'light' })
    expect(next.theme).toBe('light')
    expect(next.sidebarOpen).toBe(before.sidebarOpen)
    expect(next.terminalShell).toBe(before.terminalShell)
  })

  it('rejects unknown keys, invalid enums, and malformed values without persisting', async () => {
    const service = makeService()
    const before = service.get()
    await expect(service.update({ nope: true })).rejects.toThrow(/not supported/)
    await expect(service.update('dark')).rejects.toThrow(/must be an object/)
    await expect(service.update({ theme: 'solarized' })).rejects.toThrow(/Invalid theme/)
    await expect(service.update({ defaultInspectorTab: 'tools' })).rejects.toThrow(/Invalid inspector tab/)
    await expect(service.update({ messageEnterAction: 'send' })).rejects.toThrow(/Invalid message Enter action/)
    await expect(service.update({ sidebarOpen: 'yes' })).rejects.toThrow(/must be a boolean/)
    await expect(service.update({ browserHome: 'javascript:alert(1)' })).rejects.toThrow(/scheme/)
    await expect(service.update({ disabledProviders: ['../evil'] })).rejects.toThrow(/provider ID/)
    await expect(service.update({ disabledProviders: Array.from({ length: 129 }, () => 'p') })).rejects.toThrow(/bounded/)
    await expect(service.update({ ompDisabledProviders: ['../evil'] })).rejects.toThrow(/provider ID/)
    await expect(service.update({ ompDisabledProviders: Array.from({ length: 257 }, () => 'p') })).rejects.toThrow(/bounded/)
    await expect(service.update({ activeHarness: 'codex' })).rejects.toThrow(/Invalid harness/)
    await expect(service.update({ ompApprovalMode: 'sudo' })).rejects.toThrow(/Invalid OMP approval mode/)
    await expect(service.update({ petId: '../escape' })).rejects.toThrow(/Invalid pet id/)
    await expect(service.update({ voiceTranscriptionProvider: 'carrier-pigeon' })).rejects.toThrow(/Invalid voice transcription provider/)
    await expect(service.update({ voiceRealtimeModel: '../bad model' })).rejects.toThrow(/not valid/)
    expect(service.get()).toEqual(before)
  })

  it('routes terminalShell through the injected shell validator', async () => {
    const validateShell = vi.fn(() => '/bin/bash')
    const service = makeService(validateShell)
    const next = await service.update({ terminalShell: '/bin/bash' })
    expect(validateShell).toHaveBeenCalledWith('/bin/bash')
    expect(next.terminalShell).toBe('/bin/bash')
    validateShell.mockImplementation(() => { throw new TypeError('shell is not allowed') })
    await expect(service.update({ terminalShell: '/tmp/evil' })).rejects.toThrow(/not allowed/)
  })
})
