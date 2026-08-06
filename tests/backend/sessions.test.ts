import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionService, type SessionServiceOptions } from '../../electron/main/sessions'
import { SessionMetadataCatalog, type SessionCatalogIo } from '../../electron/main/sessions/catalog'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup(maxSessionFiles?: number, options?: SessionServiceOptions): { root: string; project: string; service: SessionService } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-sessions-')); dirs.push(dir)
  const root = join(dir, 'sessions'); mkdirSync(root)
  const project = join(dir, 'project'); mkdirSync(project)
  const store = new JsonStateStore(join(dir, 'state.json'))
  const service = new SessionService(store, null, maxSessionFiles, options)
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
    const oldest = join(root, '01800000-0000-7000-8000-000000000000.jsonl')
    const tiedA = join(root, '01900000-0001-7000-8000-000000000000.jsonl')
    const tiedB = join(root, '01900000-0002-7000-8000-000000000000.jsonl')
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

  it('bounds canonicalize and stat work before scanning a huge directory', async () => {
    const root = '/sessions'
    const maxSessionFiles = 3
    const sessionName = (timestamp: number): string => {
      const prefix = timestamp.toString(16).padStart(12, '0')
      return `${prefix.slice(0, 8)}-${prefix.slice(8)}-7000-8000-${timestamp.toString(16).padStart(12, '0')}.jsonl`
    }
    const names = Array.from({ length: 50_000 }, (_, index) => sessionName(index))
    const canonicalize = vi.fn(async (path: string) => path)
    const inspect = vi.fn(async (path: string) => {
      const name = path.slice(path.lastIndexOf('/') + 1)
      const timestamp = Number.parseInt(name.slice(0, 8) + name.slice(9, 13), 16)
      return { isFile: () => true, mtimeMs: timestamp, size: 100 } as Stats
    })
    const io: SessionCatalogIo = {
      readDirectory: vi.fn(async () => names.map((name) => ({ name }))),
      canonicalize,
      inspect,
    }
    const readMetadata = vi.fn(async (filePath: string) => ({
      id: filePath.slice(filePath.lastIndexOf('/') + 1, -'.jsonl'.length),
      filePath,
      projectPath: '/project',
      title: 'Session',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      status: 'idle' as const,
      depth: 0,
      pinned: false,
      unread: false,
      preview: '',
    }))
    const catalog = new SessionMetadataCatalog(() => root, null, maxSessionFiles, readMetadata, io)

    const records = await catalog.all()

    const selectedIds = [49_999, 49_998, 49_997].map((value) => sessionName(value).slice(0, -'.jsonl'.length))
    expect(records.map((record) => record.id).sort()).toEqual(selectedIds.sort())
    expect(canonicalize).toHaveBeenCalledTimes(1 + maxSessionFiles)
    expect(inspect).toHaveBeenCalledTimes(2 * maxSessionFiles)
    expect(readMetadata).toHaveBeenCalledTimes(maxSessionFiles)
    expect(inspect.mock.calls.flat().join(' ')).not.toContain(sessionName(0))
  })
})

describe('SessionService transcript bounds', () => {
  it('authorizes each caller, coalesces in-flight reads per session, and returns deep clones', async () => {
    let releaseRead: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted })
    const transcriptReader = vi.fn(async () => {
      markStarted?.()
      await new Promise<void>((resolveRead) => { releaseRead = resolveRead })
      return [{ id: 'message', role: 'user' as const, parts: [{ type: 'text' as const, text: 'original' }] }]
    })
    const { root, project, service } = setup(undefined, { transcriptReader })
    const file = join(root, 'coalesced.jsonl')
    writeSession(file, project, 'coalesced')
    const authorize = vi.spyOn(service, 'requireSessionPath').mockResolvedValue(file)

    const firstRequest = service.read(file)
    const secondRequest = service.read(file)
    await started
    expect(authorize).toHaveBeenCalledTimes(2)
    releaseRead?.()
    const [first, second] = await Promise.all([firstRequest, secondRequest])

    expect(transcriptReader).toHaveBeenCalledTimes(1)
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    expect(first[0]?.parts).not.toBe(second[0]?.parts)
    const firstPart = first[0]?.parts[0]
    if (firstPart?.type === 'text') firstPart.text = 'mutated'
    expect(second[0]?.parts).toEqual([{ type: 'text', text: 'original' }])
  })

  it('admits only a bounded number of transcript scans across sessions', async () => {
    let active = 0
    let maximumActive = 0
    let startedCount = 0
    let markTwoStarted: (() => void) | undefined
    let markThreeStarted: (() => void) | undefined
    const twoStarted = new Promise<void>((resolveStarted) => { markTwoStarted = resolveStarted })
    const threeStarted = new Promise<void>((resolveStarted) => { markThreeStarted = resolveStarted })
    const releases: Array<() => void> = []
    const transcriptReader = vi.fn(async () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await new Promise<void>((resolveRead) => {
        releases.push(resolveRead)
        startedCount += 1
        if (startedCount === 2) markTwoStarted?.()
        if (startedCount === 3) markThreeStarted?.()
      })
      active -= 1
      return []
    })
    const { root, project, service } = setup(undefined, {
      transcriptReader,
      maxConcurrentTranscriptReads: 2,
    })
    const files = ['one.jsonl', 'two.jsonl', 'three.jsonl'].map((name, index) => {
      const file = join(root, name)
      writeSession(file, project, `session-${index}`)
      return file
    })

    const requests = files.map((file) => service.read(file))
    await twoStarted
    expect(transcriptReader).toHaveBeenCalledTimes(2)
    releases.shift()?.()
    await threeStarted
    expect(maximumActive).toBe(2)
    for (const release of releases.splice(0)) release()
    await expect(Promise.all(requests)).resolves.toEqual([[], [], []])
  })

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

  it('preserves goal summaries as a distinct readable transcript role', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'goal-summary.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'goal-summary', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Start a goal' } }),
      JSON.stringify({
        type: 'custom_message', id: 'goal', parentId: 'root', customType: 'goal_context', display: true,
        content: '<goal_context>Internal control envelope that should stay hidden.</goal_context>',
        details: {
          kind: 'created',
          goalId: 'goal-1',
          objective: 'Ship the transcript activity refinements.',
          status: 'active',
          continuationsUsed: 0,
        },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    expect(transcript.at(-1)).toMatchObject({
      id: 'goal',
      role: 'goal',
      parts: [{ type: 'text', text: 'Ship the transcript activity refinements.' }],
    })
    expect(JSON.stringify(transcript)).not.toContain('<goal_context>')
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
