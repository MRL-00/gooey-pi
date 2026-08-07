import { useEffect, useState } from 'react'
import { findRuntimeForWorkspace, selectStartupWorkspace } from '@/lib/workspace'
import type { WorkspaceSnapshot } from '@/app/workspace'
import type {
  AppMeta,
  PrimeWorkApi,
  ProjectRecord,
  RuntimeInfo,
  AutomationScheduleRecord,
  SessionRecord,
} from '@/types/api'

interface UseBootstrapOptions {
  bridge: PrimeWorkApi | null
  setProjects: React.Dispatch<React.SetStateAction<ProjectRecord[]>>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  setSchedules: React.Dispatch<React.SetStateAction<AutomationScheduleRecord[]>>
  setScheduleError(value: string): void
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  workspaceRef: React.RefObject<WorkspaceSnapshot>
  activateWorkspace(project?: ProjectRecord, session?: SessionRecord, runtime?: RuntimeInfo): number
  attachRuntime(runtime: RuntimeInfo | undefined, generation: number): void
  reportError(error: unknown): void
}

function mergeSessionCatalog(
  current: SessionRecord[],
  records: SessionRecord[],
  activeFile: string | undefined,
  changedFiles: ReadonlyMap<string, number>,
  catalogRevision: number,
): SessionRecord[] {
  const previousByPath = new Map(current.map((session) => [session.filePath, session]))
  return records.map((record) => {
    const previous = previousByPath.get(record.filePath)
    const needsAttention = (record.status === 'waiting' || record.status === 'complete')
      && previous?.status !== record.status
    const syncRevision = changedFiles.get(record.filePath) ?? (catalogRevision || (previous?.syncRevision ?? record.syncRevision))
    return {
      ...record,
      unread: record.filePath === activeFile ? false : needsAttention ? true : previous?.unread ?? record.unread,
      syncRevision,
    }
  })
}

export function useBootstrap({
  bridge,
  setProjects,
  setSessions,
  setSchedules,
  setScheduleError,
  runtimeSessionsRef,
  workspaceRef,
  activateWorkspace,
  attachRuntime,
  reportError,
}: UseBootstrapOptions) {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [initialized, setInitialized] = useState(!bridge)

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    const startupGeneration = workspaceRef.current.generation
    const projectsRequest = bridge.projects.list()
    const sessionsRequest = bridge.sessions.list(undefined, true)
    const runtimesRequest = bridge.agent.list().then((value) => {
      if (!cancelled) {
        // Merge instead of replacing: entries learned from live events while the
        // bootstrap list was in flight must survive the snapshot.
        for (const runtime of value) {
          if (runtime.sessionFile) runtimeSessionsRef.current.set(runtime.runtimeId, runtime.sessionFile)
        }
      }
      return value
    }).catch((error) => {
      if (!cancelled) reportError(error)
      return [] as RuntimeInfo[]
    })

    void bridge.app.getMeta().then((value) => {
      if (!cancelled) setMeta(value)
    }).catch((error) => { if (!cancelled) reportError(error) })

    void bridge.schedules.list().then((value) => {
      if (!cancelled) {
        setSchedules(value)
        setScheduleError('')
      }
    }).catch((error) => {
      if (!cancelled) {
        setScheduleError(error instanceof Error ? error.message : String(error))
        reportError(error)
      }
    })

    void Promise.allSettled([projectsRequest, sessionsRequest]).then((results) => {
      if (cancelled) return
      const [projectResult, sessionResult] = results
      if (projectResult.status === 'rejected') reportError(projectResult.reason)
      if (sessionResult.status === 'rejected') reportError(sessionResult.reason)
      const nextProjects = projectResult.status === 'fulfilled' ? projectResult.value : []
      const nextSessions = (sessionResult.status === 'fulfilled' ? sessionResult.value : []).map((session) => session.status === 'waiting'
        ? { ...session, unread: true }
        : session)
      setProjects(nextProjects)
      setSessions(nextSessions)

      let selectedGeneration: number | undefined
      if (projectResult.status === 'fulfilled' && workspaceRef.current.generation === startupGeneration) {
        const selected = selectStartupWorkspace(nextProjects, nextSessions, [])
        selectedGeneration = activateWorkspace(selected.project, selected.session)
      }
      setInitialized(true)

      // Runtime discovery is intentionally not on the critical path. It may
      // only attach to the exact startup generation/session it was selected for.
      void runtimesRequest.then((runtimes) => {
        if (cancelled || selectedGeneration === undefined) return
        const current = workspaceRef.current
        if (current.generation !== selectedGeneration) return
        const matching = findRuntimeForWorkspace(runtimes, current.cwd, current.sessionFile)
        if (matching) attachRuntime(matching, selectedGeneration)
      })
    })
    return () => { cancelled = true }
  }, [
    activateWorkspace,
    attachRuntime,
    bridge,
    reportError,
    runtimeSessionsRef,
    setProjects,
    setScheduleError,
    setSchedules,
    setSessions,
    workspaceRef,
  ])

  useEffect(() => {
    if (!bridge || !initialized) return
    let disposed = false
    let refreshTimer: number | null = null
    let requestId = 0
    const pendingChangedFiles = new Map<string, number>()
    let pendingCatalogRevision = 0
    let nextRevision = 0
    const unsubscribe = bridge.sessions.onChanged((change) => {
      const revision = ++nextRevision
      if (change.filePath) pendingChangedFiles.set(change.filePath, revision)
      else pendingCatalogRevision = revision
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        const currentRequest = ++requestId
        const changedFiles = new Map(pendingChangedFiles)
        const catalogRevision = pendingCatalogRevision
        void bridge.sessions.list(undefined, true).then((nextSessions) => {
          if (disposed || currentRequest !== requestId) return
          setSessions((current) => mergeSessionCatalog(
            current,
            nextSessions,
            workspaceRef.current.sessionFile,
            changedFiles,
            catalogRevision,
          ))
          for (const [filePath, changedRevision] of changedFiles) {
            if (pendingChangedFiles.get(filePath) === changedRevision) pendingChangedFiles.delete(filePath)
          }
          if (pendingCatalogRevision === catalogRevision) pendingCatalogRevision = 0
        }).catch((error) => {
          if (!disposed && currentRequest === requestId) reportError(error)
        })
      }, 80)
    })
    return () => {
      disposed = true
      requestId += 1
      unsubscribe()
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    }
  }, [bridge, initialized, reportError, setSessions, workspaceRef])

  return { meta, initialized }
}
