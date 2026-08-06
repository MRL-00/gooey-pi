import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS } from '@/lib/data'
import { confirmedPanelSettings } from '@/lib/settings-state'
import type { AppSettings, InspectorTab, PrimeWorkApi } from '@/types/api'

interface UseAppSettingsOptions {
  bridge: PrimeWorkApi | null
  reportError(error: unknown): void
}

export function useAppSettings({ bridge, reportError }: UseAppSettingsOptions) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('summary')
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const confirmedSettingsRef = useRef(settings)
  const settingsMutationRef = useRef(0)
  const settingsQueueRef = useRef<Promise<void>>(Promise.resolve())
  const inspectorTabTouchedRef = useRef(false)

  const applySettings = useCallback((next: AppSettings, panelPatch: Partial<AppSettings>, reconcilePanels = false) => {
    settingsRef.current = next
    setSettings(next)
    const panels = reconcilePanels ? confirmedPanelSettings(next) : next
    if (reconcilePanels || 'sidebarOpen' in panelPatch) setSidebarOpen(panels.sidebarOpen)
    if (reconcilePanels || 'inspectorOpen' in panelPatch) setInspectorOpen(panels.inspectorOpen)
    if (reconcilePanels || 'terminalOpen' in panelPatch) setTerminalOpen(panels.terminalOpen)
  }, [])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const mutation = ++settingsMutationRef.current
    const previous = settingsRef.current
    applySettings({ ...previous, ...patch }, patch)
    if (!bridge) {
      confirmedSettingsRef.current = settingsRef.current
      return
    }
    const operation = settingsQueueRef.current.catch(() => undefined).then(async () => {
      const saved = await bridge.settings.update(patch)
      confirmedSettingsRef.current = saved
      if (settingsMutationRef.current === mutation) applySettings(saved, patch, true)
    })
    settingsQueueRef.current = operation.catch(() => undefined)
    try {
      await operation
    } catch (error) {
      if (settingsMutationRef.current === mutation) applySettings(confirmedSettingsRef.current, patch, true)
      reportError(error)
    }
  }, [applySettings, bridge, reportError])

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    const startupRevision = settingsMutationRef.current
    void bridge.settings.get().then((value) => {
      if (cancelled || settingsMutationRef.current !== startupRevision) return
      confirmedSettingsRef.current = value
      applySettings(value, value)
      if (!inspectorTabTouchedRef.current) setInspectorTab(value.defaultInspectorTab)
    }).catch((error) => { if (!cancelled) reportError(error) })
    return () => { cancelled = true }
  }, [applySettings, bridge, reportError])

  useEffect(() => {
    const theme = settings.theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : settings.theme
    document.documentElement.dataset.theme = theme
    document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion)
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = () => {
      if (settings.theme === 'system') document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'
    }
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [settings.reduceMotion, settings.theme])

  const selectInspectorTab = useCallback((tab: InspectorTab) => {
    inspectorTabTouchedRef.current = true
    setInspectorTab(tab)
  }, [])

  return {
    settings,
    sidebarOpen,
    setSidebarOpen,
    inspectorOpen,
    setInspectorOpen,
    terminalOpen,
    setTerminalOpen,
    inspectorTab,
    selectInspectorTab,
    updateSettings,
  }
}
