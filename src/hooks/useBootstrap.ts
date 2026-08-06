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
  SkillRecord,
} from '@/types/api'

interface UseBootstrapOptions {
  bridge: PrimeWorkApi | null
  setProjects: React.Dispatch<React.SetStateAction<ProjectRecord[]>>
  setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>
  setSkills: React.Dispatch<React.SetStateAction<SkillRecord[]>>
  setSchedules: React.Dispatch<React.SetStateAction<ScheduleRecord[]>>
  setScheduleError(value: string): void
  runtimeSessionsRef: React.RefObject<Map<string, string>>
  workspaceRef: React.RefObject<WorkspaceSnapshot>
  activateWorkspace(project?: ProjectRecord, session?: SessionRecord, runtime?: RuntimeInfo): number
  reportError(error: unknown): void
}

export function useBootstrap({
  bridge,
  setProjects,
  setSessions,
  setSkills,
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

    void bridge.plugins.list().then((value) => {
      if (!cancelled) setSkills(value)
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
    setSkills,
    workspaceRef,
  ])

  return { meta, initialized }
}
