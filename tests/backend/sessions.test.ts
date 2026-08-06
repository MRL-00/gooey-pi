import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService } from '../../electron/main/sessions'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup(maxSessionFiles?: number): { root: string; project: string; service: SessionService } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-sessions-')); dirs.push(dir)
  const root = join(dir, 'sessions'); mkdirSync(root)
  const project = join(dir, 'project'); mkdirSync(project)
  const store = new JsonStateStore(join(dir, 'state.json'))
  const service = new SessionService(store, null, maxSessionFiles)
  Object.defineProperty(service, 'sessionRoot', { value: root })
  return { root, project, service }
}

function writeSession(path: string, project: string, id: string, timestamp = '2025-01-01T00:00:00.000Z'): void {
  writeFileSync(path, [
    JSON.stringify({ type: 'session', id, cwd: project, timestamp }),
    JSON.stringify({ type: 'message', id: `${id}-message`, parentId: null, message: { role: 'user', content: id, timestamp } }),
    '',
  ].join('\n'))
}

describe('SessionService catalog scaling', () => {
  it('coalesces concurrent lists and reuses metadata by canonical path, mtime, and size', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'one.jsonl')
    writeSession(file, project, 'one')
    const readMetadata = vi.spyOn(service as unknown as { readMetadata(...args: unknown[]): Promise<unknown> }, 'readMetadata')

    const [all, archived, filtered] = await Promise.all([
      service.list(),
      service.list(undefined, true),
      service.list(project),
    ])
    expect(all).toHaveLength(1)
    expect(archived).toHaveLength(1)
    expect(filtered).toHaveLength(1)
    expect(readMetadata).toHaveBeenCalledTimes(1)

    await service.list()
    expect(readMetadata).toHaveBeenCalledTimes(1)
    writeSession(file, project, 'one-expanded', '2025-02-01T00:00:00.000Z')
    expect((await service.list())[0]?.id).toBe('one-expanded')
    expect(readMetadata).toHaveBeenCalledTimes(2)
  })

  it('selects the newest files before parsing with a deterministic canonical-path tie break', async () => {
    const { root, project, service } = setup(2)
    const oldest = join(root, 'c-oldest.jsonl')
    const tiedA = join(root, 'a-newest.jsonl')
    const tiedB = join(root, 'b-newest.jsonl')
    writeSession(oldest, project, 'oldest')
    writeSession(tiedA, project, 'newest-a')
    writeSession(tiedB, project, 'newest-b')
    const oldTime = new Date('2024-01-01T00:00:00.000Z')
    const newTime = new Date('2025-01-01T00:00:00.000Z')
    utimesSync(oldest, oldTime, oldTime)
    utimesSync(tiedA, newTime, newTime)
    utimesSync(tiedB, newTime, newTime)

    const records = await service.list()
    expect(records.map((record) => record.id)).toEqual(['newest-a', 'newest-b'])
  })
})

describe('SessionService transcript bounds', () => {
  it('returns a bounded recent suffix of long conversations', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'long.jsonl')
    const lines = [JSON.stringify({ type: 'session', id: 'long', cwd: project })]
    let parentId: string | null = null
    for (let index = 0; index < 450; index += 1) {
      const id = `message-${index}`
      lines.push(JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: `recent-${index}` } }))
      parentId = id
    }
    writeFileSync(file, `${lines.join('\n')}\n`)

    const transcript = await service.read(file)
    expect(transcript).toHaveLength(400)
    expect(transcript[0]?.id).toBe('message-50')
    expect(transcript.at(-1)?.id).toBe('message-449')
    expect(transcript.at(-1)?.parts).toEqual([{ type: 'text', text: 'recent-449' }])
  })

  it('caps tool arguments, tool output, and image data before IPC return', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'large-parts.jsonl')
    const largeArgs = `args-start-${'a'.repeat(300_000)}-args-end`
    const largeImage = `image-start-${'i'.repeat(600_000)}-image-end`
    const largeOutput = `output-start-${'o'.repeat(300_000)}-output-end`
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'large-parts', cwd: project }),
      JSON.stringify({
        type: 'message', id: 'assistant', parentId: null,
        message: { role: 'assistant', content: [
          { type: 'toolCall', id: 'tool', name: 'large-tool', arguments: largeArgs },
          { type: 'image', mimeType: 'image/png', data: largeImage },
        ] },
      }),
      JSON.stringify({
        type: 'message', id: 'tool-result', parentId: 'assistant',
        message: { role: 'toolResult', toolCallId: 'tool', toolName: 'large-tool', content: largeOutput },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    const parts = transcript[0]?.parts ?? []
    const call = parts.find((part) => part.type === 'toolCall')
    const result = parts.find((part) => part.type === 'toolResult')
    const image = parts.find((part) => part.type === 'image')
    expect(typeof call?.args).toBe('string')
    expect((call?.args as string).length).toBeLessThanOrEqual(128 * 1024)
    expect(result?.text.length).toBeLessThanOrEqual(128 * 1024)
    expect(image?.data?.length).toBeLessThanOrEqual(256 * 1024)
    expect(call?.args).toContain('[truncated]')
    expect(result?.text).toContain('[truncated]')
    expect(image?.data).toContain('[truncated]')
  })
})
