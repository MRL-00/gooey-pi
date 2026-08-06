import { Bell, CheckCircle2, CircleAlert, Clock3, LoaderCircle, MessageSquare, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ProjectRecord, SessionRecord } from '@/types/api'
import { formatRelative } from '@/lib/data'
import { EmptyState, Segmented } from '@/components/ui'

type ActivityFilter = 'all' | 'attention' | 'running'

export function ActivityPage({ sessions, projects, onOpen }: { sessions: SessionRecord[]; projects: ProjectRecord[]; onOpen(session: SessionRecord): void }) {
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [query, setQuery] = useState('')
  const visible = useMemo(() => sessions.filter((session) => (filter === 'all' || filter === 'attention' && (session.unread || session.status === 'waiting' || session.status === 'failed') || filter === 'running' && session.status === 'running') && `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)), [sessions, filter, query])
  const projectName = (path: string) => projects.find((project) => project.path === path)?.name ?? path.split('/').at(-1)
  return <div className="page scroll-area"><div className="page-container page-container--narrow"><header className="page-header"><div><h1>Activity</h1><p>Work in progress and sessions that need your attention.</p></div></header><div className="page-tools page-tools--activity"><Segmented value={filter} label="Activity filter" onChange={(value)=>setFilter(value as ActivityFilter)} options={[{value:'all',label:'All'},{value:'attention',label:'Needs attention'},{value:'running',label:'Running'}]}/><label className="page-search page-search--small"><Search size={13}/><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Filter activity"/></label></div>{visible.length ? <div className="activity-list">{visible.map((session) => <button type="button" key={session.id} onClick={() => onOpen(session)}><span className={`activity-icon activity-icon--${session.status}`}>{session.status === 'running' ? <LoaderCircle className="spin" size={15}/> : session.status === 'failed' || session.status === 'waiting' ? <CircleAlert size={15}/> : <CheckCircle2 size={15}/>}</span><span className="activity-main"><span><strong>{session.title}</strong>{session.unread ? <i>New</i> : null}</span><small>{session.preview ?? 'Open session to view details'}</small><span><span>{projectName(session.projectPath)}</span><span><Clock3 size={11}/>{formatRelative(session.updatedAt)}</span></span></span><span className={`activity-status activity-status--${session.status}`}>{session.status === 'waiting' ? 'Needs approval' : session.status}</span></button>)}</div> : <EmptyState icon={<Bell size={24}/>} title="You’re all caught up">Running sessions and new results will appear here.</EmptyState>}</div></div>
}
