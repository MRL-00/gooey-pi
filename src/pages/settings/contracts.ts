import type { AppMeta, AppSettings } from '@/types/api'

export type SettingsSection = 'general' | 'appearance' | 'agent' | 'providers' | 'voice' | 'browser' | 'terminal' | 'privacy' | 'about'

export type SettingsUpdate = (patch: Partial<AppSettings>) => Promise<void> | void

export interface SettingsSectionProps {
  settings: AppSettings
  onUpdate: SettingsUpdate
}

export interface SettingsMetaSectionProps extends SettingsSectionProps {
  meta?: AppMeta | null
}

export const SETTINGS_FIELD_SECTIONS = {
  theme: 'appearance',
  sidebarOpen: 'general',
  inspectorOpen: 'general',
  terminalOpen: 'terminal',
  defaultInspectorTab: 'general',
  browserHome: 'browser',
  browserAskForDownloads: 'browser',
  terminalShell: 'terminal',
  reduceMotion: 'appearance',
  showReasoningSummaries: 'agent',
  showToolCalls: 'agent',
  messageEnterAction: 'agent',
  telemetry: 'privacy',
  disabledProviders: 'providers',
  activeHarness: 'agent',
  ompApprovalMode: 'agent',
  voiceTranscriptionProvider: 'voice',
  voiceOpenAiTranscriptionModel: 'voice',
  voiceGroqTranscriptionModel: 'voice',
  voiceDeepgramTranscriptionModel: 'voice',
  voiceLocalWhisperExecutable: 'voice',
  voiceLocalWhisperModel: 'voice',
  voiceRealtimeModel: 'voice',
  voiceRealtimeVoice: 'voice',
} as const satisfies Record<keyof AppSettings, SettingsSection>
