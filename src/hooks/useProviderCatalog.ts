import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PrimeModelCatalog, PrimeModelDescriptor, PrimeThinkingLevel, PrimeWorkApi, ProviderAuthEvent, RuntimeInfo } from '@/types/api'

type ActiveProviderAuthEvent = Extract<ProviderAuthEvent, { type: 'auth' | 'progress' | 'prompt' | 'select' }>

interface UseProviderCatalogOptions {
  bridge: PrimeWorkApi | null
  runtime: RuntimeInfo | null
  syncRuntime(runtimeId: string): Promise<void>
  syncDisabledProviders(providerIds: string[]): Promise<void> | void
  reportError(error: unknown): void
}

export function useProviderCatalog({ bridge, runtime, syncRuntime, syncDisabledProviders, reportError }: UseProviderCatalogOptions) {
  const [model, setModel] = useState('auto')
  const [effort, setEffort] = useState<PrimeThinkingLevel>('medium')
  const [fast, setFast] = useState(false)
  const [catalog, setCatalog] = useState<PrimeModelCatalog | null>(null)
  const [authEvent, setAuthEvent] = useState<ActiveProviderAuthEvent | null>(null)

  const refresh = useCallback(async (force = false) => {
    if (!bridge) return
    setCatalog(await bridge.providers.catalog(force))
  }, [bridge])

  const selectedModel = useMemo<PrimeModelDescriptor | undefined>(() => {
    if (model !== 'auto') return catalog?.models.find((candidate) => candidate.key === model)
    return catalog?.models.find((candidate) => candidate.provider === runtime?.model?.provider && candidate.id === runtime?.model?.id)
  }, [catalog, model, runtime?.model?.id, runtime?.model?.provider])
  const reasoningLevels = selectedModel?.availableThinkingLevels ?? runtime?.availableThinkingLevels ?? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

  useEffect(() => {
    if (reasoningLevels.includes(effort)) return
    setEffort(reasoningLevels.includes('medium') ? 'medium' : reasoningLevels[0] ?? 'off')
  }, [effort, reasoningLevels])

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    void bridge.providers.catalog().then((next) => { if (!cancelled) setCatalog(next) }).catch(reportError)
    return () => { cancelled = true }
  }, [bridge, reportError])

  useEffect(() => {
    if (!bridge) return
    return bridge.providers.onAuthEvent((event) => {
      if (event.type === 'complete') {
        setAuthEvent(null)
        void refresh(true).catch(reportError)
      } else if (event.type === 'cancelled') {
        setAuthEvent(null)
      } else if (event.type === 'error') {
        setAuthEvent(null)
        reportError(event.error)
      } else if (event.type === 'auth' || event.type === 'progress' || event.type === 'prompt' || event.type === 'select') {
        setAuthEvent(event)
      }
    })
  }, [bridge, refresh, reportError])

  useEffect(() => {
    if (!runtime?.model?.provider || !runtime.model.id || !catalog) return
    const effectiveModel = catalog.models.find((candidate) => candidate.provider === runtime.model?.provider && candidate.id === runtime.model?.id)
    if (effectiveModel) setModel(effectiveModel.key)
    if (runtime.thinkingLevel && effectiveModel?.availableThinkingLevels.includes(runtime.thinkingLevel as PrimeThinkingLevel)) setEffort(runtime.thinkingLevel as PrimeThinkingLevel)
    setFast(runtime.serviceTier === 'priority')
  }, [catalog, runtime?.model?.id, runtime?.model?.provider, runtime?.serviceTier, runtime?.thinkingLevel])

  const changeModel = useCallback((nextModelKey: string) => {
    setModel(nextModelKey)
    const nextModel = catalog?.models.find((candidate) => candidate.key === nextModelKey)
    const nextEffort = nextModel && !nextModel.availableThinkingLevels.includes(effort)
      ? nextModel.availableThinkingLevels.includes('medium') ? 'medium' : nextModel.availableThinkingLevels[0] ?? 'off'
      : effort
    setEffort(nextEffort)
    if (!nextModel?.fastModeSupported) setFast(false)
    if (!bridge || !runtime || !nextModel) return
    void (async () => {
      try {
        await bridge.agent.command(runtime.runtimeId, { type: 'set_model', provider: nextModel.provider, modelId: nextModel.id })
        await bridge.agent.command(runtime.runtimeId, { type: 'set_thinking_level', level: nextEffort })
        await syncRuntime(runtime.runtimeId)
      } catch (error) { reportError(error) }
    })()
  }, [bridge, catalog?.models, effort, reportError, runtime, syncRuntime])

  const changeEffort = useCallback((nextEffort: PrimeThinkingLevel) => {
    setEffort(nextEffort)
    if (!bridge || !runtime) return
    void bridge.agent.command(runtime.runtimeId, { type: 'set_thinking_level', level: nextEffort })
      .then(() => syncRuntime(runtime.runtimeId))
      .catch(reportError)
  }, [bridge, reportError, runtime, syncRuntime])

  const changeFast = useCallback((enabled: boolean) => {
    setFast(enabled)
    if (!bridge || !runtime) return
    void bridge.agent.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: enabled ? 'priority' : 'default' })
      .then(() => syncRuntime(runtime.runtimeId))
      .catch((error) => { setFast(false); void syncRuntime(runtime.runtimeId); reportError(error) })
  }, [bridge, reportError, runtime, syncRuntime])

  const saveApiKey = useCallback(async (providerId: string, apiKey: string) => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    setCatalog(await bridge.providers.saveApiKey(providerId, apiKey))
  }, [bridge])

  const logout = useCallback(async (providerId: string) => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    setCatalog(await bridge.providers.logout(providerId))
  }, [bridge])

  const setEnabled = useCallback(async (providerId: string, enabled: boolean) => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    const next = await bridge.providers.setEnabled(providerId, enabled)
    setCatalog(next)
    const disabledProviders = next.providers.filter((provider) => !provider.enabled).map((provider) => provider.id)
    await syncDisabledProviders(disabledProviders)
    const selectedProvider = catalog?.models.find((candidate) => candidate.key === model)?.provider
    if (selectedProvider && disabledProviders.includes(selectedProvider)) { setModel('auto'); setFast(false) }
  }, [bridge, catalog?.models, model, syncDisabledProviders])

  const startOAuth = useCallback(async (providerId: string) => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    await bridge.providers.startOAuth(providerId)
  }, [bridge])

  const respondOAuth = useCallback((promptId: string, value?: string) => {
    if (!bridge || !authEvent) return
    void bridge.providers.respondOAuth(authEvent.flowId, promptId, value).catch(reportError)
  }, [authEvent, bridge, reportError])

  const cancelOAuth = useCallback(() => {
    if (bridge && authEvent) void bridge.providers.cancelOAuth(authEvent.flowId).catch(reportError)
    setAuthEvent(null)
  }, [authEvent, bridge, reportError])

  return {
    model, effort, fast, catalog, authEvent, selectedModel, reasoningLevels,
    refresh, changeModel, changeEffort, changeFast,
    saveApiKey, logout, setEnabled, startOAuth, respondOAuth, cancelOAuth,
  }
}
