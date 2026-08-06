import type { AppSettings } from '@/types/api'

export interface PanelSettings {
  sidebarOpen: boolean
  inspectorOpen: boolean
  terminalOpen: boolean
}

export function confirmedPanelSettings(settings: AppSettings): PanelSettings {
  return {
    sidebarOpen: settings.sidebarOpen,
    inspectorOpen: settings.inspectorOpen,
    terminalOpen: settings.terminalOpen,
  }
}
