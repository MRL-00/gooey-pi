import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTranscript } from '../../electron/main/sessions/transcript'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function sessionFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-transcript-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

function userMessage(id: string, parentId: string | null, text = `text-${id}`): string {
  return JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: text } })
}

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

describe('transcript graph bounds', () => {
  it('keeps the parent chain intact at exactly the record capacity', async () => {
    // 1 root + 9_998 unrelated fillers + 1 leaf = 10_000 records: no eviction.
    const fillers = Array.from({ length: 9_998 }, (_, index) => userMessage(`noise-${index}`, `noise-${index}`))
    const file = sessionFile([userMessage('root', null), ...fillers, userMessage('leaf', 'root')])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['root', 'leaf'])
  })

  it('evicts the least recently written record one past the capacity', async () => {
    // One extra filler pushes the map to 10_001, evicting the oldest entry
    // (the root), which breaks the leaf's parent chain at the eviction point.
    const fillers = Array.from({ length: 9_999 }, (_, index) => userMessage(`noise-${index}`, `noise-${index}`))
    const file = sessionFile([userMessage('root', null), ...fillers, userMessage('leaf', 'root')])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['leaf'])
  })

  it('refreshes recency when a record id is rewritten later in the file', async () => {
    // Re-emitting the root just before the leaf moves it to the tail of the
    // LRU map, so the same overflow now evicts a filler instead of the root.
    const fillers = Array.from({ length: 9_999 }, (_, index) => userMessage(`noise-${index}`, `noise-${index}`))
    const file = sessionFile([userMessage('root', null), ...fillers, userMessage('root', null, 'rewritten root'), userMessage('leaf', 'root')])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['root', 'leaf'])
    expect(transcript[0].parts).toEqual([{ type: 'text', text: 'rewritten root' }])
  })

  it('evicts oldest records when the graph byte budget overflows', async () => {
    // Three ~7 MiB records exceed the 16 MiB graph budget, so the oldest is
    // dropped and the branch walk stops where the chain breaks.
    const big = 'x'.repeat(7 * 1024 * 1024)
    const file = sessionFile([
      userMessage('old', null, big),
      userMessage('mid', 'old', big),
      userMessage('leaf', 'mid', big),
    ])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['mid', 'leaf'])
  }, 20_000)

  it('falls back to the partial branch when the leaf references a missing parent', async () => {
    const file = sessionFile([
      userMessage('a', null),
      userMessage('b', 'a'),
      userMessage('leaf', 'not-persisted'),
    ])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['leaf'])
  })

  it('terminates on a parent cycle instead of looping', async () => {
    const file = sessionFile([userMessage('a', 'b'), userMessage('b', 'a')])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['a', 'b'])
  })

  it('treats a trailing parentId null record as a new single-entry branch', async () => {
    // The branch is walked from the last record; a trailing root orphans the
    // earlier chain entirely.
    const file = sessionFile([
      userMessage('a', null),
      userMessage('b', 'a'),
      userMessage('fresh-root', null),
    ])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['fresh-root'])
  })
})

describe('transcript text budgets', () => {
  const partMax = 256 * 1024 // MAX_PART_TEXT_CHARS

  it('drops the oldest text once newer parts consume the transcript budget exactly', async () => {
    // Four maximum-size parts consume MAX_TRANSCRIPT_TEXT_CHARS (1 MiB) to
    // the character, leaving nothing for the oldest message, which is dropped.
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5']
    const file = sessionFile(ids.map((id, index) => userMessage(id, index === 0 ? null : ids[index - 1], 'x'.repeat(partMax))))
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['m2', 'm3', 'm4', 'm5'])
    for (const message of transcript) expect(message.parts).toEqual([{ type: 'text', text: 'x'.repeat(partMax) }])
  })

  it('keeps a message that fits the remaining budget exactly', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4']
    const file = sessionFile(ids.map((id, index) => userMessage(id, index === 0 ? null : ids[index - 1], 'x'.repeat(partMax))))
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('bounds compaction summaries by the remaining text budget without consuming it', async () => {
    // Pins current behavior: the compaction part is always retained, its
    // summary is truncated to the remaining shared text budget, and it does
    // not decrement that budget for other parts.
    const summary = 's'.repeat(partMax)
    const bigText = 'x'.repeat(partMax)
    const ids = ['m1', 'm2', 'm3', 'm4']
    const compaction = JSON.stringify({ type: 'compaction', id: 'compact-1', parentId: null, summary, firstKeptEntryId: 'm1' })
    const messages = ids.map((id, index) => userMessage(id, index === 0 ? 'compact-1' : ids[index - 1], bigText))
    const file = sessionFile([compaction, ...messages])
    const transcript = await readTranscript(file, false)
    expect(transcript.map((message) => message.id)).toEqual(['compact-1', 'm1', 'm2', 'm3', 'm4'])
    const part = transcript[0]?.parts[0]
    expect(part).toMatchObject({ type: 'compaction', status: 'done' })
    // The four newer text parts consumed the whole budget, so the older
    // summary collapses to an empty string while the part itself survives.
    expect(part && 'summary' in part ? part.summary : undefined).toBe('')
    for (const message of transcript.slice(1)) expect(message.parts).toEqual([{ type: 'text', text: bigText }])
  })
})
