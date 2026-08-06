import type { ProjectRecord, SessionRecord } from '@/types/api'

export interface WorkspaceSnapshot {
  generation: number
  project?: ProjectRecord
  session?: SessionRecord
  cwd?: string
  sessionFile?: string
}

export const requestFailureMessage = (error: unknown) => {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim()
  return detail ? `Request failed: ${detail.slice(0, 1_000)}` : 'Prime could not process the request.'
}
