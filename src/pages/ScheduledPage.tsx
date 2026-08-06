import { CalendarClock, CheckCircle2, Clock3, Pause, Plus, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import type { ScheduleRecord } from '@/types/api'
import { formatRelative } from '@/lib/data'
import { EmptyState, IconButton, Modal, Segmented } from '@/components/ui'

type ScheduleFilter = 'all' | 'active' | 'paused'

interface ScheduledPageProps {
  schedules: ScheduleRecord[]
  error?: string
  canCreate: boolean
  onAdd(schedule: string, prompt: string): Promise<void>
  onCancel(schedule: ScheduleRecord): Promise<void>
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

export function ScheduledPage({ schedules, error, canCreate, onAdd, onCancel }: ScheduledPageProps) {
  const [filter, setFilter] = useState<ScheduleFilter>('all')
  const [open, setOpen] = useState(false)
  const [schedule, setSchedule] = useState('Every weekday at 9:00 AM')
  const [prompt, setPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const visible = schedules.filter((item) => filter === 'all' || item.status === filter)

  const create = async () => {
    if (!prompt.trim() || !schedule.trim() || saving) return
    setSaving(true); setFormError('')
    try {
      await onAdd(schedule.trim(), prompt.trim())
      setOpen(false); setPrompt('')
    } catch (reason) { setFormError(messageOf(reason)) }
    finally { setSaving(false) }
  }

  const cancel = async (item: ScheduleRecord) => {
    if (cancelling) return
    setCancelling(item.id); setActionError('')
    try { await onCancel(item) }
    catch (reason) { setActionError(messageOf(reason)) }
    finally { setCancelling(null) }
  }

  return (
    <div className="page scroll-area"><div className="page-container page-container--narrow">
      <header className="page-header"><div><h1>Scheduled</h1><p>Recurring work and unattended Prime runs.</p></div><button type="button" className="button button--primary" disabled={!canCreate} title={canCreate ? 'Create a schedule in this session' : 'Open a running session first'} onClick={() => { setFormError(''); setOpen(true) }}><Plus size={14}/> New schedule</button></header>
      <div className="page-tools"><Segmented value={filter} label="Schedule filter" onChange={(value) => setFilter(value as ScheduleFilter)} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }]}/><span>{visible.length} tasks</span></div>
      {error ? <p className="page-inline-error" role="alert">Schedule catalog unavailable: {error}</p> : null}
      {actionError ? <p className="page-inline-error" role="alert">{actionError}</p> : null}
      {visible.length ? <div className="schedule-list">{visible.map((item) => <article key={item.id}>
        <div className={`schedule-icon schedule-icon--${item.status}`}>{item.status === 'active' ? <RotateCcw size={15}/> : <Pause size={15}/>}</div>
        <div className="schedule-main"><div><h2>{item.title}</h2><span className={`schedule-state schedule-state--${item.status}`}>{item.status}</span></div><p>{item.prompt}</p><div><span><CalendarClock size={12}/>{item.schedule}</span>{item.nextRun ? <span><Clock3 size={12}/>Next {formatRelative(item.nextRun)}</span> : null}{item.lastRun ? <span><CheckCircle2 size={12}/>Last {formatRelative(item.lastRun)}</span> : null}</div></div>
        <div className="schedule-actions">{item.status === 'active' ? <IconButton disabled={cancelling === item.id} label={`Cancel ${item.title}`} onClick={() => void cancel(item)}><X size={14}/></IconButton> : null}</div>
      </article>)}</div> : <EmptyState icon={<CalendarClock size={24}/>} title="No scheduled work">Create a recurring task and Prime will bring results back here.</EmptyState>}
      {open ? <Modal title="Schedule Prime work" onClose={() => { if (!saving) setOpen(false) }} footer={<><button type="button" className="button" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button type="button" className="button button--primary" disabled={!prompt.trim() || !schedule.trim() || saving} onClick={() => void create()}>{saving ? 'Scheduling…' : 'Create schedule'}</button></>}>
        <p className="modal-intro">Prime will run this prompt in the current project. Keep the app open when local access is required.</p>
        <label className="field"><span>When</span><select value={schedule} disabled={saving} onChange={(event) => setSchedule(event.target.value)}><option>Every weekday at 9:00 AM</option><option>Every day at 6:00 PM</option><option>Every Monday</option><option>Every hour</option></select></label>
        <label className="field"><span>Prompt</span><textarea autoFocus rows={4} value={prompt} disabled={saving} onChange={(event) => setPrompt(event.target.value)} placeholder="Review open issues and summarize anything blocked…"/></label>
        {formError ? <p className="page-inline-error" role="alert">{formError}</p> : null}
      </Modal> : null}
    </div></div>
  )
}
