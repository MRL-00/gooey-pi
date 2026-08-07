import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTranscript } from '../../electron/main/sessions/transcript'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('tool result placement in assembled turns', () => {
  it('splices results after their call by id, appends unmatched results, and pairs duplicate ids with the first call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-transcript-tools-'))
    dirs.push(dir)
    const file = join(dir, 'session.jsonl')
    const records = [
      JSON.stringify({ type: 'session', id: 'session-1', cwd: dir, timestamp: '2026-08-07T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'user-1', parentId: null, message: { role: 'user', content: 'run tools' } }),
      JSON.stringify({ type: 'message', id: 'assistant-1', parentId: 'user-1', message: { role: 'assistant', content: [
        { type: 'text', text: 'working' },
        { type: 'toolCall', id: 'call-1', name: 'Read' },
        { type: 'toolCall', id: 'call-dup', name: 'First' },
        { type: 'toolCall', id: 'call-dup', name: 'Second' },
        { type: 'toolCall', id: 'call-2', name: 'Write' },
      ] } }),
      // Results arrive out of call order; each must land after its own call.
      JSON.stringify({ type: 'message', id: 'result-2', parentId: 'assistant-1', message: { role: 'toolResult', toolCallId: 'call-2', toolName: 'Write', content: 'wrote' } }),
      JSON.stringify({ type: 'message', id: 'result-1', parentId: 'result-2', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'Read', content: 'read' } }),
      JSON.stringify({ type: 'message', id: 'result-dup', parentId: 'result-1', message: { role: 'toolResult', toolCallId: 'call-dup', toolName: 'First', content: 'first wins' } }),
      JSON.stringify({ type: 'message', id: 'result-lost', parentId: 'result-dup', message: { role: 'toolResult', toolCallId: 'call-missing', toolName: 'Ghost', content: 'appended' } }),
      '',
    ].join('\n')
    writeFileSync(file, records)

    const transcript = await readTranscript(file, false)
    const assistant = transcript.at(-1)
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.parts.map((part) => part.type === 'toolCall' ? `call:${part.id}` : part.type === 'toolResult' ? `result:${part.text}` : part.type)).toEqual([
      'text',
      'call:call-1',
      'result:read',
      'call:call-dup',
      'result:first wins',
      'call:call-dup',
      'call:call-2',
      'result:wrote',
      'result:appended',
    ])
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
