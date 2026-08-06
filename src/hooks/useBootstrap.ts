import { useEffect, useState } from 'react'
import { selectStartupWorkspace } from '@/lib/workspace'
import type { WorkspaceSnapshot } from '@/app/workspace'
import type {
  AppMeta,
  PrimeWorkApi,
  ProjectRecord,
  RuntimeInfo,
  ScheduleRecord,
  SessionRecord,
} from '@/types/api'

interface UseBootstrapOptions {
  bridge: PrimeWorkApi | null
  setProjects: React.Dispatch<React.SetStateAction<ProjectRecord[]>>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  setSchedules: React.Dispatch<React.SetStateAction<ScheduleRecord[]>>
  setScheduleError(value: string): void
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  workspaceRef: React.RefObject<WorkspaceSnapshot>
  activateWorkspace(project?: ProjectRecord, session?: SessionRecord, runtime?: RuntimeInfo): number
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
    const runtimesRequest = bridge.agent.list()

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

    void projectsRequest.then((value) => {
      if (!cancelled) setProjects(value)
    }).catch((error) => { if (!cancelled) reportError(error) })

    void sessionsRequest.then((value) => {
      if (!cancelled) {
        setSessions(value.map((session) => session.status === 'waiting'
          ? { ...session, unread: true }
          : session))
      }
    }).catch((error) => { if (!cancelled) reportError(error) })

    void runtimesRequest.then((value) => {
      if (!cancelled) {
        runtimeSessionsRef.current = new Map(value.flatMap((runtime) => runtime.sessionFile
          ? [[runtime.runtimeId, runtime.sessionFile] as const]
          : []))
      }
    }).catch((error) => { if (!cancelled) reportError(error) })

    void Promise.allSettled([projectsRequest, sessionsRequest, runtimesRequest]).then((results) => {
      if (cancelled) return
      const [projectResult, sessionResult, runtimeResult] = results
      const nextProjects = projectResult.status === 'fulfilled' ? projectResult.value : []
      const nextSessions = sessionResult.status === 'fulfilled' ? sessionResult.value : []
      const nextRuntimes = runtimeResult.status === 'fulfilled' ? runtimeResult.value : []
      if (projectResult.status === 'fulfilled' && workspaceRef.current.generation === startupGeneration) {
        const selected = selectStartupWorkspace(nextProjects, nextSessions, nextRuntimes)
        activateWorkspace(selected.project, selected.session, selected.runtime)
      }
      setInitialized(true)
    })
    return () => { cancelled = true }
  }, [
    activateWorkspace,
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
