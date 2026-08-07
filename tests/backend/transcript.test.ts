import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTranscript } from '../../electron/main/sessions/transcript'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function makeSessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-transcript-'))
  dirs.push(dir)
  return join(dir, 'session.jsonl')
}

describe('transcript graph budgets', () => {
  it('does not let non-renderable records evict renderable history or break the walk', async () => {
    const file = makeSessionFile()
    const records = [
      JSON.stringify({ type: 'session', id: 'session-1', cwd: '/tmp' }),
      JSON.stringify({ type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'first question' } }),
      JSON.stringify({ type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: 'first answer' } }),
    ]
    let parent = 'assistant-1'
    for (let index = 0; index < 10_050; index += 1) {
      const id = `event-${index}`
      records.push(JSON.stringify({ type: 'event', id, parentId: parent, name: 'internal' }))
      parent = id
    }
    records.push(JSON.stringify({ type: 'message', id: 'user-2', parentId: parent, message: { role: 'user', content: 'second question' } }))
    writeFileSync(file, `${records.join('\n')}\n`)

    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['user-1', 'assistant-1', 'user-2'])
  })
})

describe('persisted compaction transcript entries', () => {
  it('shares the transcript text budget across repeated compaction summaries', async () => {
    const file = makeSessionFile()
    const summary = 'S'.repeat(256 * 1024)
    const records = [JSON.stringify({ type: 'session', id: 'session-1', cwd: '/tmp' })]
    let parent: string | null = null
    for (let index = 0; index < 5; index += 1) {
      records.push(JSON.stringify({ type: 'compaction', id: `compact-${index}`, parentId: parent, timestamp: '2026-08-07T00:00:00.000Z', summary }))
      parent = `compact-${index}`
    }
    writeFileSync(file, `${records.join('\n')}\n`)

    const transcript = await readTranscript(file, false)
    expect(transcript).toHaveLength(5)
    const summaryLengths = transcript.map((message) => {
      const part = message.parts[0] as { summary?: string }
      return part.summary?.length ?? 0
    })
    expect(summaryLengths.reduce((total, length) => total + length, 0)).toBeLessThanOrEqual(1024 * 1024)
    // The budget is consumed newest-first; the most recent compaction keeps its full summary.
    expect(summaryLengths.at(-1)).toBe(256 * 1024)
    expect(summaryLengths[0]).toBe(0)
  })

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
