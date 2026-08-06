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


  it('preserves agent messages as a distinct transcript role with only the readable body', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'agent-message.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'agent-message', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Delegate this task' } }),
      JSON.stringify({
        type: 'custom_message', id: 'handoff', parentId: 'root', customType: 'agent_message', display: true,
        content: '[from child:reviewer]\nAgent-to-agent message received.\n\nThe full envelope should not be shown.',
        details: {
          message: 'Review complete. The project authorization gate was the root cause.',
          from: { sessionName: 'project-reviewer', runtimeKind: 'subagent' },
        },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    expect(transcript.at(-1)).toMatchObject({
      id: 'handoff',
      role: 'agent',
      agentName: 'project-reviewer',
      parts: [{ type: 'text', text: 'Review complete. The project authorization gate was the root cause.' }],
    })
  })

  it('reconstructs only the final parent branch and merges assistant tool activity', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'branch.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'branch', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'keep-root' } }),
      JSON.stringify({ type: 'message', id: 'discarded', parentId: 'root', message: { role: 'user', content: 'discard-me' } }),
      JSON.stringify({
        type: 'message', id: 'assistant', parentId: 'root',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'lookup', arguments: { query: 'value' } }] },
      }),
      JSON.stringify({
        type: 'message', id: 'result', parentId: 'assistant',
        message: { role: 'toolResult', toolCallId: 'call', toolName: 'lookup', content: 'tool-output' },
      }),
      JSON.stringify({
        type: 'message', id: 'continuation', parentId: 'result',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final-answer' }] },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    expect(transcript.map((message) => message.id)).toEqual(['root', 'assistant'])
    expect(transcript[1]?.parts.map((part) => part.type)).toEqual(['toolCall', 'toolResult', 'text'])
    expect(transcript[1]?.parts.at(-1)).toEqual({ type: 'text', text: 'final-answer' })
  })
})


describe('SessionService orchestration', () => {
  it('overlays runtime state and preserves archive and rename hook semantics', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'runtime.jsonl')
    writeSession(file, project, 'runtime')
    const safePath = await service.requireSessionPath(file)
    const stop = vi.fn(async () => undefined)
    const rename = vi.fn(async () => true)
    service.bindRuntimeHooks({
      get: (candidate) => candidate === safePath ? { isStreaming: true } : undefined,
      stop,
      rename,
    })

    expect((await service.list())[0]?.status).toBe('running')
    await expect(service.rename(file, '  Renamed session  ')).resolves.toBe(true)
    expect(rename).toHaveBeenCalledWith(safePath, 'Renamed session')
    await expect(service.rename(file, '-invalid')).rejects.toThrow('title contains invalid characters')

    await expect(service.archive(file)).resolves.toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(await service.list()).toEqual([])
    expect((await service.list(undefined, true))[0]?.archived).toBe(true)

    await expect(service.archive(file, false)).resolves.toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect((await service.list())[0]?.archived).toBe(false)
  })
})
