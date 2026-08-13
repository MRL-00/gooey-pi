import { Bell, CheckCircle2, CircleAlert, Clock3, LoaderCircle, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ProjectRecord, SessionRecord } from '@/types/api'
import { formatRelative } from '@/lib/data'
import { EmptyState, Segmented } from '@/components/ui'

export type ActivityFilter = 'all' | 'attention' | 'running'
export const ACTIVITY_BATCH = 250

export interface ActivityViewState {
  filter: ActivityFilter
  query: string
  visibleLimit: number
}

export function updateActivityCriteria(state: ActivityViewState, criteria: Partial<Pick<ActivityViewState, 'filter' | 'query'>>): ActivityViewState {
  return { ...state, ...criteria, visibleLimit: ACTIVITY_BATCH }
}

export function growActivityBatch(state: ActivityViewState, total: number): ActivityViewState {
  return { ...state, visibleLimit: Math.min(total, state.visibleLimit + ACTIVITY_BATCH) }
}

export function ActivityPage({ sessions, projects, onOpen }: { sessions: SessionRecord[]; projects: ProjectRecord[]; onOpen(session: SessionRecord): void }) {
  const [viewState, setViewState] = useState<ActivityViewState>({ filter: 'all', query: '', visibleLimit: ACTIVITY_BATCH })
  const { filter, query, visibleLimit } = viewState
  const projectNames = useMemo(() => new Map(projects.flatMap((project) => [...new Set([project.path, ...project.folders])].map((path) => [path, project.name] as const))), [projects])
  const normalized = query.trim().toLowerCase()
  const visible = useMemo(() => sessions.filter((session) => {
    const statusMatches = !session.archived && (
      filter === 'all'
      || filter === 'attention' && (session.unread || session.status === 'waiting' || session.status === 'failed')
      || filter === 'running' && session.status === 'running'
    )
    return statusMatches && (!normalized || `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized))
  }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), [sessions, filter, normalized])
  const displayed = visible.slice(0, visibleLimit)
  const projectName = (path: string) => projectNames.get(path) ?? path.split('/').at(-1)

  return <div className="page scroll-area"><div className="page-container page-container--narrow">
    <header className="page-header"><div><h1>Activity</h1><p>Work in progress and sessions that need your attention.</p></div></header>
    <div className="page-tools page-tools--activity"><Segmented value={filter} label="Activity filter" onChange={(value) => setViewState((current) => updateActivityCriteria(current, { filter: value as ActivityFilter }))} options={[{ value: 'all', label: 'All' }, { value: 'attention', label: 'Needs attention' }, { value: 'running', label: 'Running' }]}/><label className="page-search page-search--small"><Search size={13}/><input value={query} onChange={(event) => setViewState((current) => updateActivityCriteria(current, { query: event.target.value }))} placeholder="Filter activity"/></label></div>
    {displayed.length ? <div className="activity-list">{displayed.map((session) => <div className="activity-row" key={session.id}><button type="button" className="activity-row__main" aria-label={`Open ${session.title}`} onClick={() => onOpen(session)}><span className={`activity-icon activity-icon--${session.status}`}>{session.status === 'running' ? <LoaderCircle className="spin" size={15}/> : session.status === 'failed' || session.status === 'waiting' ? <CircleAlert size={15}/> : <CheckCircle2 size={15}/>}</span><span className="activity-main"><span><strong>{session.title}</strong>{session.unread ? <i>New</i> : null}</span><small>{session.preview ?? 'Open session to view details'}</small><span><span>{projectName(session.projectPath)}</span><span><Clock3 size={11}/>{formatRelative(session.updatedAt)}</span></span></span><span className={`activity-status activity-status--${session.status}`}>{session.status === 'waiting' ? 'Needs attention' : session.status === 'complete' ? 'Finished' : session.status}</span></button></div>)}</div> : <EmptyState icon={<Bell size={24}/>} title="You’re all caught up">Running sessions and new results will appear here.</EmptyState>}
    {visible.length > displayed.length ? <button type="button" className="page-show-more" onClick={() => setViewState((current) => growActivityBatch(current, visible.length))}>Show {Math.min(ACTIVITY_BATCH, visible.length - displayed.length)} more sessions</button> : null}
  </div></div>
}
