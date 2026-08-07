import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PrimeModelCatalog, PrimeModelDescriptor, PrimeThinkingLevel, PrimeWorkApi, ProviderAuthEvent, RuntimeInfo } from '@/types/api'

type ActiveProviderAuthEvent = Extract<ProviderAuthEvent, { type: 'auth' | 'progress' | 'prompt' | 'select' }>

/** Stable fallback identities so consumers can memoize on prop equality. */
const DEFAULT_REASONING_LEVELS: PrimeThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function groupModelsByProvider(models: readonly PrimeModelDescriptor[] | undefined): Map<string, PrimeModelDescriptor[]> {
  const grouped = new Map<string, PrimeModelDescriptor[]>()
  for (const model of models ?? []) {
    const bucket = grouped.get(model.provider)
    if (bucket) bucket.push(model)
    else grouped.set(model.provider, [model])
  }
  return grouped
}

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
  const modelRef = useRef(model)
  const effortRef = useRef(effort)
  const fastRef = useRef(fast)
  const mutationRevisionRef = useRef(0)
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve())
  const runtimeIdRef = useRef(runtime?.runtimeId)
  useLayoutEffect(() => { runtimeIdRef.current = runtime?.runtimeId })

  const updateModel = useCallback((value: string) => { modelRef.current = value; setModel(value) }, [])
  const updateEffort = useCallback((value: PrimeThinkingLevel) => { effortRef.current = value; setEffort(value) }, [])
  const updateFast = useCallback((value: boolean) => { fastRef.current = value; setFast(value) }, [])

  const queueRuntimeMutation = useCallback((
    runtimeId: string,
    command: () => Promise<void>,
    rollback: () => void,
  ) => {
    const revision = ++mutationRevisionRef.current
    mutationQueueRef.current = mutationQueueRef.current.then(async () => {
      try {
        await command()
      } catch (error) {
        if (mutationRevisionRef.current === revision && runtimeIdRef.current === runtimeId) {
          rollback()
          try { await syncRuntime(runtimeId) } catch (syncError) { reportError(syncError) }
        }
        reportError(error)
        return
      }
      if (mutationRevisionRef.current === revision && runtimeIdRef.current === runtimeId) {
        try { await syncRuntime(runtimeId) } catch (error) { reportError(error) }
      }
    })
  }, [reportError, syncRuntime])

  useEffect(() => () => {
    mutationRevisionRef.current += 1
    runtimeIdRef.current = undefined
  }, [])

  const refresh = useCallback(async (force = false) => {
    if (!bridge) return
    setCatalog(await bridge.providers.catalog(force))
  }, [bridge])

  const selectedModel = useMemo<PrimeModelDescriptor | undefined>(() => {
    if (model !== 'auto') return catalog?.models.find((candidate) => candidate.key === model)
    return catalog?.models.find((candidate) => candidate.provider === runtime?.model?.provider && candidate.id === runtime?.model?.id)
  }, [catalog, model, runtime?.model?.id, runtime?.model?.provider])
  const reasoningLevels = selectedModel?.availableThinkingLevels ?? runtime?.availableThinkingLevels ?? DEFAULT_REASONING_LEVELS
  // Group once per catalog identity so the composer's <option> tree can memoize.
  const modelsByProvider = useMemo(() => groupModelsByProvider(catalog?.models), [catalog?.models])

  useEffect(() => {
    if (reasoningLevels.includes(effort)) return
    updateEffort(reasoningLevels.includes('medium') ? 'medium' : reasoningLevels[0] ?? 'off')
  }, [effort, reasoningLevels, updateEffort])

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
    if (effectiveModel) updateModel(effectiveModel.key)
    if (runtime.thinkingLevel && effectiveModel?.availableThinkingLevels.includes(runtime.thinkingLevel as PrimeThinkingLevel)) updateEffort(runtime.thinkingLevel as PrimeThinkingLevel)
  }, [catalog, runtime?.model?.id, runtime?.model?.provider, runtime?.thinkingLevel, updateEffort, updateModel])

  // Scoped to the runtime's reported tier so a catalog refresh cannot revert
  // an optimistic fast-mode toggle that the runtime has not confirmed yet.
  useEffect(() => {
    if (!runtime) return
    updateFast(runtime.serviceTier === 'priority')
  }, [runtime?.runtimeId, runtime?.serviceTier, updateFast])

  const changeModel = useCallback((nextModelKey: string) => {
    const previous = { model: modelRef.current, effort: effortRef.current, fast: fastRef.current }
    const nextModel = catalog?.models.find((candidate) => candidate.key === nextModelKey)
    const nextEffort = nextModel && !nextModel.availableThinkingLevels.includes(effortRef.current)
      ? nextModel.availableThinkingLevels.includes('medium') ? 'medium' : nextModel.availableThinkingLevels[0] ?? 'off'
      : effortRef.current
    updateModel(nextModelKey)
    updateEffort(nextEffort)
    if (!nextModel?.fastModeSupported) updateFast(false)
    if (!bridge || !runtime || !nextModel) return
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => {
        await bridge.agent.command(runtime.runtimeId, { type: 'set_model', provider: nextModel.provider, modelId: nextModel.id })
        await bridge.agent.command(runtime.runtimeId, { type: 'set_thinking_level', level: nextEffort })
      },
      () => { updateModel(previous.model); updateEffort(previous.effort); updateFast(previous.fast) },
    )
  }, [bridge, catalog?.models, queueRuntimeMutation, runtime, updateEffort, updateFast, updateModel])

  const changeEffort = useCallback((nextEffort: PrimeThinkingLevel) => {
    const previous = effortRef.current
    updateEffort(nextEffort)
    if (!bridge || !runtime) return
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => { await bridge.agent.command(runtime.runtimeId, { type: 'set_thinking_level', level: nextEffort }) },
      () => updateEffort(previous),
    )
  }, [bridge, queueRuntimeMutation, runtime, updateEffort])

  const changeFast = useCallback((enabled: boolean) => {
    const previous = fastRef.current
    updateFast(enabled)
    if (!bridge || !runtime) return
    queueRuntimeMutation(
      runtime.runtimeId,
      async () => { await bridge.agent.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: enabled ? 'priority' : 'default' }) },
      () => updateFast(previous),
    )
  }, [bridge, queueRuntimeMutation, runtime, updateFast])

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
    const selectedProvider = catalog?.models.find((candidate) => candidate.key === modelRef.current)?.provider
    if (selectedProvider && disabledProviders.includes(selectedProvider)) { updateModel('auto'); updateFast(false) }
  }, [bridge, catalog?.models, updateFast, updateModel])

  const setAllEnabled = useCallback(async () => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    await syncDisabledProviders([])
    setCatalog(await bridge.providers.catalog(true))
  }, [bridge, syncDisabledProviders])

  const setAllDisabled = useCallback(async () => {
    if (!bridge) throw new Error('Providers can only be configured in the desktop app.')
    const providerIds = catalog?.providers.map((provider) => provider.id).sort() ?? []
    if (!providerIds.length) throw new Error('Provider catalogue is not loaded.')
    await syncDisabledProviders(providerIds)
    setCatalog(await bridge.providers.catalog(true))
    const selectedProvider = catalog?.models.find((candidate) => candidate.key === modelRef.current)?.provider
    if (selectedProvider && providerIds.includes(selectedProvider)) {
      updateModel('auto')
      updateFast(false)
    }
  }, [bridge, catalog?.models, catalog?.providers, syncDisabledProviders, updateFast, updateModel])

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
    model, effort, fast, catalog, authEvent, selectedModel, reasoningLevels, modelsByProvider,
    refresh, changeModel, changeEffort, changeFast,
    saveApiKey, logout, setEnabled, setAllEnabled, setAllDisabled, startOAuth, respondOAuth, cancelOAuth,
  }
}
