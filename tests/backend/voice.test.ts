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
      expect(session.tools.map((tool) => tool.name)).toEqual(['list_projects', 'start_task', 'search_web'])
      return new Response('v=0\r\no=answer')
    })
    const { service } = makeService({ fetch: fetchMock as typeof fetch })
    await service.saveApiKey('openai', 'sk-test')
    await expect(service.createRealtimeCall({ mode: 'conversation', sdp: 'v=0\r\no=offer-value' })).resolves.toContain('o=answer')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('starts an explicitly requested task immediately in an existing granted project', async () => {
    const { service, agent } = makeService()
    const result = await service.executeTool({ name: 'start_task', arguments: { project_id: 'prime-project', prompt: 'Implement the feature', title: 'Voice feature' } })
    expect(agent.start).toHaveBeenCalledWith({ cwd: '/tmp/prime' })
    expect(agent.command).toHaveBeenNthCalledWith(1, 'runtime-1', { type: 'prompt', message: 'Implement the feature' })
    expect(result.task).toMatchObject({ projectId: 'prime-project', runtimeId: 'runtime-1' })
  })

  it('never promotes an inferred project into a voice task grant', async () => {
    const { service, options } = makeService()
    vi.mocked(options.projects.prime.list).mockResolvedValue([project('prime', true)])
    await expect(service.executeTool({ name: 'start_task', arguments: { project_id: 'prime-project', prompt: 'Run it' } })).rejects.toThrow(/explicitly granted/)
  })
})
