import { session } from 'electron'
import { BROWSER_PARTITION, type AppSettings } from '../../src/types/api'
import type { JsonStateStore } from './store'
import { isRecord, rejectUnknownKeys, requireBoolean, requireString, requireWebUrl } from './validation'

export class SettingsService {
  constructor(private readonly store: JsonStateStore, private readonly validateShell: (shell: unknown) => string, private readonly cancelBrowserDownloads: () => void = () => undefined) {}

  get(): AppSettings { return this.store.getSettings() }

  async update(raw: unknown): Promise<AppSettings> {
    if (!isRecord(raw)) throw new TypeError('settings patch must be an object')
    // One validator per AppSettings field, compiler-enforced: adding a field
    // without a validator (or vice versa) is a type error, so a patch can
    // never be silently rejected or silently dropped.
    const validators: { [K in keyof AppSettings]: (value: unknown) => AppSettings[K] } = {
      theme: (value) => {
        if (value !== 'system' && value !== 'light' && value !== 'dark') throw new TypeError('Invalid theme')
        return value
      },
      sidebarOpen: (value) => requireBoolean(value, 'sidebarOpen'),
      inspectorOpen: (value) => requireBoolean(value, 'inspectorOpen'),
      terminalOpen: (value) => requireBoolean(value, 'terminalOpen'),
      browserAskForDownloads: (value) => requireBoolean(value, 'browserAskForDownloads'),
      reduceMotion: (value) => requireBoolean(value, 'reduceMotion'),
      showReasoningSummaries: (value) => requireBoolean(value, 'showReasoningSummaries'),
      showToolCalls: (value) => requireBoolean(value, 'showToolCalls'),
      telemetry: (value) => requireBoolean(value, 'telemetry'),
      defaultInspectorTab: (value) => {
        if (value !== 'summary' && value !== 'changes' && value !== 'browser' && value !== 'files') throw new TypeError('Invalid inspector tab')
        return value
      },
      messageEnterAction: (value) => {
        if (value !== 'queue' && value !== 'steer') throw new TypeError('Invalid message Enter action')
        return value
      },
      browserHome: (value) => requireWebUrl(value),
      terminalShell: (value) => this.validateShell(value),
      disabledProviders: (value) => {
        if (!Array.isArray(value) || value.length > 128) throw new TypeError('disabledProviders must be a bounded array')
        return [...new Set(value.map((entry, index) => {
          const id = requireString(entry, `disabledProviders[${index}]`, { min: 1, max: 128, trim: true })
          if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) throw new TypeError(`disabledProviders[${index}] is not a valid provider ID`)
          return id
        }))]
      },
    }
    const keys = Object.keys(validators) as Array<keyof AppSettings>
    rejectUnknownKeys(raw, keys, 'settings patch')
    const patch: Partial<AppSettings> = {}
    const applyField = <K extends keyof AppSettings>(key: K): void => {
      if (raw[key] !== undefined) patch[key] = validators[key](raw[key])
    }
    for (const key of keys) applyField(key)
    return this.store.update((state) => Object.assign(state.settings, patch))
  }

  async resetBrowserData(): Promise<boolean> {
    try {
      this.cancelBrowserDownloads()
      const browserSession = session.fromPartition(BROWSER_PARTITION)
      await Promise.all([
        browserSession.clearStorageData(), browserSession.clearCache(), browserSession.clearAuthCache(),
        session.defaultSession.clearStorageData(), session.defaultSession.clearCache(), session.defaultSession.clearAuthCache(),
      ])
      return true
    } catch { return false }
  }
}
