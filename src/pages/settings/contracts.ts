import type { AppMeta, AppSettings } from '@/types/api'

export type SettingsSection = 'general' | 'appearance' | 'agent' | 'browser' | 'terminal' | 'privacy' | 'about'

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
  telemetry: 'privacy',
} as const satisfies Record<keyof AppSettings, SettingsSection>
