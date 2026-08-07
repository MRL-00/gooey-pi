import type { SessionRecord, SessionStatus } from '@/types/api'

interface SessionLifecycleChange {
  status: SessionStatus
  markUnread?: boolean
}

export function sessionLifecycleChange(event: Record<string, unknown>): SessionLifecycleChange | undefined {
  const type = typeof event.type === 'string' ? event.type : ''
  if (type === 'extension_ui_request') return { status: 'waiting', markUnread: true }
  if (type === 'agent_start' || type === 'turn_start') return { status: 'running', markUnread: false }
  if (type === 'compaction_start') return { status: 'running', markUnread: false }
  if (type === 'compaction_end' && event.willRetry !== true && (event.reason === 'manual' || event.reason === 'requested')) return { status: 'complete', markUnread: false }
  if (type === 'agent_end') return { status: 'complete', markUnread: true }
  if (type === 'extension_error' || type === 'error' || type === 'transport_error') return { status: 'failed' }
  if (type === 'runtime_exit') return { status: event.expected === true ? 'complete' : 'failed', markUnread: event.expected === true }
  return undefined
}

function nextUpdatedAt(previous: string, now: number): string {
  const previousTime = Date.parse(previous)
  return new Date(Math.max(now, Number.isFinite(previousTime) ? previousTime + 1 : now)).toISOString()
}

export function applySessionLifecycleEvent(
  session: SessionRecord,
  event: Record<string, unknown>,
  visible: boolean,
  now = Date.now(),
): SessionRecord {
  const change = sessionLifecycleChange(event)
  if (!change) return session
  return {
    ...session,
    status: change.status,
    updatedAt: nextUpdatedAt(session.updatedAt, now),
    eventRevision: (session.eventRevision ?? 0) + 1,
    unread: change.markUnread === undefined ? session.unread : change.markUnread && !visible,
  }
}

export function sessionAttentionSignature(session: SessionRecord): string | undefined {
  const revision = session.eventRevision ?? session.updatedAt
  if (session.status === 'waiting') return `waiting:${revision}`
  if (session.status === 'complete' && session.unread) return `complete:${revision}`
  return session.unread ? `unread:${revision}` : undefined
}
