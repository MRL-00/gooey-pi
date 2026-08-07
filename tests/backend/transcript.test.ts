import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionMetadata } from '../../electron/main/sessions/metadata'
import { readTranscript } from '../../electron/main/sessions/transcript'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('session file record tolerance', () => {
  it('opens a record beyond the old 8 MiB transcript cap in both same-file readers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-transcript-'))
    dirs.push(dir)
    const file = join(dir, 'session.jsonl')
    const oversized = 'x'.repeat(9 * 1024 * 1024)
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'big-record', cwd: dir, timestamp: '2026-08-07T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'user-1', parentId: null, timestamp: '2026-08-07T00:01:00.000Z', message: { role: 'user', content: oversized } }),
      '',
    ].join('\n'))

    // The catalog admits this session, so the transcript reader must open it too.
    const metadata = await readSessionMetadata(file)
    expect(metadata.id).toBe('big-record')
    expect(metadata.preview.length).toBeGreaterThan(0)

    const transcript = await readTranscript(file, false)
    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toMatchObject({ id: 'user-1', role: 'user' })
  })
})

describe('persisted compaction transcript entries', () => {
  it('keeps completed compaction summaries visible after a session reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-transcript-'))
    dirs.push(dir)
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'session-1', cwd: dir, timestamp: '2026-08-07T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'user-1', parentId: null, timestamp: '2026-08-07T00:01:00.000Z', message: { role: 'user', content: 'Investigate the failure' } }),
      JSON.stringify({ type: 'compaction', id: 'compact-1', parentId: 'user-1', timestamp: '2026-08-07T00:02:00.000Z', summary: 'The prior investigation was summarized.', firstKeptEntryId: 'kept-1', tokensBefore: 99_175 }),
      '',
    ].join('\n'))

    const transcript = await readTranscript(file, false)
    expect(transcript.at(-1)).toMatchObject({ role: 'system', id: 'compact-1' })
    expect(transcript.at(-1)?.parts[0]).toMatchObject({
      type: 'compaction', status: 'done', tokensBefore: 99_175, firstKeptEntryId: 'kept-1',
      summary: 'The prior investigation was summarized.',
    })
  })
})
