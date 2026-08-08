import type { SessionRecord } from '@/types/api'

const VOICE_SESSION_RETRY_DELAYS_MS = [0, 100, 200, 400, 800, 1_200, 2_000, 3_000] as const

interface VoiceSessionResolution {
  session: SessionRecord
  sessions: SessionRecord[]
}

export async function waitForVoiceSession(
  sessionFile: string,
  sessionId: string | undefined,
  load: (force: boolean) => Promise<SessionRecord[]>,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
): Promise<VoiceSessionResolution | null> {
  for (const delayMs of VOICE_SESSION_RETRY_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs)
    const sessions = await load(delayMs > 0)
    const session = sessions.find((candidate) => candidate.filePath === sessionFile || (sessionId !== undefined && candidate.id === sessionId))
    if (session) return { session, sessions }
  }
  return null
}
