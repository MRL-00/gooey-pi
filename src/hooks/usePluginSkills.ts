import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createScopedRequestGuard } from '@/app/scoped-request'
import type { PluginWarning, PrimeWorkApi, SkillRecord } from '@/types/api'

interface UsePluginSkillsOptions {
  bridge: PrimeWorkApi | null
  scope?: string
  generation: number
  initialSkills: SkillRecord[]
  reportError(error: unknown): void
}

export function usePluginSkills({ bridge, scope, generation, initialSkills, reportError }: UsePluginSkillsOptions) {
  const [skills, setSkills] = useState(initialSkills)
  const [warnings, setWarnings] = useState<PluginWarning[]>([])
  const [loading, setLoading] = useState(false)
  const requestGuardRef = useRef(createScopedRequestGuard())
  const scopeRef = useRef(scope)
  const generationRef = useRef(generation)
  useLayoutEffect(() => {
    scopeRef.current = scope
    generationRef.current = generation
  })

  const load = useCallback(async (requestedScope: string | undefined, showLoading = false) => {
    if (!bridge) return
    const request = requestGuardRef.current.begin(generationRef.current, requestedScope)
    if (showLoading) setLoading(true)
    try {
      const catalog = await bridge.plugins.list(requestedScope)
      if (requestGuardRef.current.isCurrent(request, generationRef.current, scopeRef.current)) {
        setSkills(catalog.skills)
        setWarnings(catalog.warnings)
      }
    } catch (error) {
      if (requestGuardRef.current.isCurrent(request, generationRef.current, scopeRef.current)) reportError(error)
    } finally {
      if (showLoading && requestGuardRef.current.isCurrent(request, generationRef.current, scopeRef.current)) setLoading(false)
    }
  }, [bridge, reportError])

  useEffect(() => {
    setLoading(false)
    void load(scope)
    return () => { requestGuardRef.current.invalidate() }
  }, [generation, load, scope])

  const refresh = useCallback(async () => { await load(scopeRef.current, true) }, [load])
  return { skills, warnings, loading, refresh }
}
