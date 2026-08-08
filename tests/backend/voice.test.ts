import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../electron/main/store'
import { VoiceService, type VoiceServiceOptions } from '../../electron/main/voice'

const directories: string[] = []

function project(harness: 'prime' | 'omp' = 'prime', inferred = false) {
  return {
    id: `${harness}-project`, harness, name: `${harness} project`, path: `/tmp/${harness}`,
    folders: [`/tmp/${harness}`], primaryFolder: `/tmp/${harness}`, pinned: false,
    createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 0, inferred,
  }
}

function makeService(overrides: Partial<VoiceServiceOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'prime-work-voice-test-'))
  directories.push(directory)
  const command = vi.fn(async () => ({}))
  const stop = vi.fn(async () => true)
  const start = vi.fn(async () => ({ runtimeId: 'runtime-1', harness: 'prime', cwd: '/tmp/prime', isStreaming: false }))
  const list = vi.fn(() => [{ runtimeId: 'runtime-1', harness: 'prime', cwd: '/tmp/prime', isStreaming: true, sessionFile: '/tmp/session.jsonl' }])
  const agent = { start, command, stop, list }
  const options: VoiceServiceOptions = {
    secretPath: join(directory, 'voice-secrets.json'),
    secretCodec: {
      available: () => true,
      encrypt: (value) => Buffer.from(`encrypted:${value}`),
      decrypt: (value) => value.toString().replace(/^encrypted:/, ''),
    },
    settings: defaultSettings,
    projects: {
      prime: { list: vi.fn(async () => [project('prime')]) },
      omp: { list: vi.fn(async () => [project('omp')]) },
    } as unknown as VoiceServiceOptions['projects'],
    agents: { prime: agent, omp: agent } as unknown as VoiceServiceOptions['agents'],
    runProcess: vi.fn(),
    environment: {},
    ...overrides,
  }
  return { service: new VoiceService(options), agent, options }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('VoiceService', () => {
  it('stores encrypted API keys and only returns credential status', async () => {
    const { service } = makeService()
    expect(await service.credentialStatus()).toEqual({ configured: { openai: false, groq: false, deepgram: false }, source: {} })
    expect(await service.saveApiKey('openai', 'sk-secret-value')).toEqual({
      configured: { openai: true, groq: false, deepgram: false },
      source: { openai: 'saved' },
    })
    expect(JSON.stringify(await service.credentialStatus())).not.toContain('sk-secret-value')
  })

  it('creates a realtime session with orchestration tools and no confirmation gate', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData
      const session = JSON.parse(String(form.get('session'))) as { instructions: string; tools: Array<{ name: string }> }
      expect(session.instructions).toContain('Do not ask for a second confirmation')
      expect(session.instructions).toContain('locked to the currently selected OMP harness')
      expect(session.instructions).toContain('Do not include phrases such as start a session')
      expect(session.instructions).toContain('"Determine the next logical feature to add to this project and explain why."')
      expect(session.tools.map((tool) => tool.name)).toEqual(['list_projects', 'start_task', 'get_local_context', 'search_web'])
      return new Response('v=0\r\no=answer')
    })
    const { service } = makeService({ fetch: fetchMock as typeof fetch })
    await service.saveApiKey('openai', 'sk-test')
    await expect(service.createRealtimeCall({ mode: 'conversation', sdp: 'v=0\r\no=offer-value', harness: 'omp' })).resolves.toContain('o=answer')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('uses the selected native streaming transcription model', async () => {
    const settings = { ...defaultSettings(), voiceOpenAiLiveTranscriptionModel: 'gpt-realtime-whisper' }
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData
      const session = JSON.parse(String(form.get('session'))) as { audio: { input: { transcription: { model: string } } } }
      expect(session.audio.input.transcription.model).toBe('gpt-realtime-whisper')
      return new Response('v=0\r\no=answer')
    })
    const { service } = makeService({ settings: () => settings, fetch: fetchMock as typeof fetch })
    await service.saveApiKey('openai', 'sk-test')
    await service.createRealtimeCall({ mode: 'transcription', sdp: 'v=0\r\no=offer-value' })
  })

  it('starts an explicitly requested task immediately in an existing granted project', async () => {
    const { service, agent } = makeService()
    const result = await service.executeTool({ name: 'start_task', arguments: { project_id: 'prime-project', prompt: 'Implement the feature', title: 'Voice feature' } }, 'prime')
    expect(agent.start).toHaveBeenCalledWith({ cwd: '/tmp/prime' })
    expect(agent.command).toHaveBeenNthCalledWith(1, 'runtime-1', { type: 'prompt', message: 'Implement the feature' })
    expect(agent.command).toHaveBeenCalledWith('runtime-1', { type: 'get_state' })
    expect(result.task).toEqual({
      projectId: 'prime-project', projectName: 'prime project', harness: 'prime',
      runtimeId: 'runtime-1', sessionFile: '/tmp/session.jsonl',
    })
  })

  it('does not report success when the harness fails to expose a saved session', async () => {
    const { service, agent } = makeService()
    agent.list.mockReturnValue([])
    await expect(service.executeTool({ name: 'start_task', arguments: { project_id: 'prime-project', prompt: 'Implement it' } }, 'prime')).rejects.toThrow(/did not create a visible session/)
    expect(agent.stop).toHaveBeenCalledWith('runtime-1')
  })

  it('never promotes an inferred project into a voice task grant', async () => {
    const { service, options } = makeService()
    vi.mocked(options.projects.prime.list).mockResolvedValue([project('prime', true)])
    await expect(service.executeTool({ name: 'start_task', arguments: { project_id: 'prime-project', prompt: 'Run it' } }, 'prime')).rejects.toThrow(/explicitly granted/)
  })

  it('scopes project lookup and task starts to the selected harness', async () => {
    const { service, options } = makeService()
    const listed = await service.executeTool({ name: 'list_projects', arguments: {} }, 'omp')
    expect(JSON.parse(listed.output)).toEqual({ projects: [{ id: 'omp-project', name: 'omp project', harness: 'omp', lastOpenedAt: '2026-01-01T00:00:00.000Z' }] })
    expect(options.projects.omp.list).toHaveBeenCalled()
    expect(options.projects.prime.list).not.toHaveBeenCalled()
    await expect(service.executeTool({ name: 'start_task', arguments: { project_id: 'prime-project', prompt: 'Run it' } }, 'omp')).rejects.toThrow(/selected OMP harness/)
  })

  it('dispatches an OMP-scoped voice task only through the OMP manager', async () => {
    const manager = (harness: 'prime' | 'omp') => ({
      start: vi.fn(async () => ({ runtimeId: `${harness}-runtime`, harness, cwd: `/tmp/${harness}`, isStreaming: false })),
      command: vi.fn(async () => ({})),
      stop: vi.fn(async () => true),
      list: vi.fn(() => [{ runtimeId: `${harness}-runtime`, harness, cwd: `/tmp/${harness}`, isStreaming: true, sessionFile: `/tmp/${harness}-session.jsonl` }]),
    })
    const primeAgent = manager('prime')
    const ompAgent = manager('omp')
    const { service } = makeService({ agents: { prime: primeAgent, omp: ompAgent } as unknown as VoiceServiceOptions['agents'] })
    const result = await service.executeTool({ name: 'start_task', arguments: { project_id: 'omp-project', prompt: 'Determine the next logical feature.' } }, 'omp')
    expect(primeAgent.start).not.toHaveBeenCalled()
    expect(ompAgent.start).toHaveBeenCalledWith({ cwd: '/tmp/omp' })
    expect(ompAgent.command).toHaveBeenNthCalledWith(1, 'omp-runtime', { type: 'prompt', message: 'Determine the next logical feature.' })
    expect(result.task?.harness).toBe('omp')
  })

  it('returns bounded local context without a calculation tool', async () => {
    const { service } = makeService()
    const result = await service.executeTool({ name: 'get_local_context', arguments: {} }, 'omp')
    const context = JSON.parse(result.output) as Record<string, string>
    expect(context.active_harness).toBe('omp')
    expect(context.time_zone).toBeTruthy()
    expect(context.utc_offset).toMatch(/^[+-]\d{2}:\d{2}$/)
    expect(context.location_precision).toBe('time-zone only')
  })

  it('uses low-context Responses web search for quick voice lookups', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-5.6-luna',
        tools: [{ type: 'web_search', search_context_size: 'low' }],
        input: 'What happened today?',
      })
      return Response.json({ output_text: 'A quick cited answer.' })
    })
    const { service } = makeService({ fetch: fetchMock as typeof fetch })
    await service.saveApiKey('openai', 'sk-test')
    await expect(service.executeTool({ name: 'search_web', arguments: { query: 'What happened today?' } }, 'prime')).resolves.toEqual({
      output: JSON.stringify({ answer: 'A quick cited answer.' }),
    })
  })
})
