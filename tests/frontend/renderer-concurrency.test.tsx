// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppSettings } from '../../src/hooks/useAppSettings'
import { useBootstrap } from '../../src/hooks/useBootstrap'
import { useExtensionUi } from '../../src/hooks/useExtensionUi'
import { usePluginSkills } from '../../src/hooks/usePluginSkills'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { AppSettings, PrimeWorkApi, ProjectRecord, RuntimeInfo, SessionRecord, SkillRecord, TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const project: ProjectRecord = {
  id: 'project', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project', pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const session: SessionRecord = {
  id: 'session', projectPath: '/project', filePath: '/sessions/current.jsonl', title: 'Current',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}
const message = (text: string): TranscriptMessage => ({
  id: text, role: 'assistant', timestamp: 1, streaming: true, parts: [{ type: 'text', text }],
})
const runtime: RuntimeInfo = { runtimeId: 'runtime', cwd: '/project', sessionFile: session.filePath, isStreaming: false }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function Probe({ children }: { children?: ReactNode }) { return <>{children}</> }

describe('settings queue reconciliation', () => {
  it('restores every standalone panel from the latest saved settings after a queued failure', async () => {
    const first = deferred<AppSettings>()
    const second = deferred<AppSettings>()
    const update = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const bridge = {
      settings: { get: async () => DEFAULT_SETTINGS, update },
    } as unknown as PrimeWorkApi
    const errors: unknown[] = []
    const reportError = (error: unknown) => { errors.push(error) }
    let state!: ReturnType<typeof useAppSettings>
    function SettingsProbe() {
      state = useAppSettings({ bridge, reportError })
      return <Probe />
    }
    await act(async () => { root.render(<SettingsProbe />); await Promise.resolve() })

    let firstMutation!: Promise<void>
    let secondMutation!: Promise<void>
    await act(async () => {
      firstMutation = state.updateSettings({ sidebarOpen: false })
      secondMutation = state.updateSettings({ terminalOpen: true })
    })
    expect([state.sidebarOpen, state.inspectorOpen, state.terminalOpen]).toEqual([false, true, true])

    const saved = { ...DEFAULT_SETTINGS, sidebarOpen: false, inspectorOpen: false, terminalOpen: false }
    await act(async () => { first.resolve(saved); await firstMutation })
    await act(async () => { second.reject(new Error('save failed')); await secondMutation })

    expect([state.sidebarOpen, state.inspectorOpen, state.terminalOpen]).toEqual([false, false, false])
    expect(state.settings).toEqual(saved)
    expect(errors).toHaveLength(1)
  })

  it('does not replace unrelated transient panel state during authoritative reconciliation', async () => {
    const save = deferred<AppSettings>()
    const bridge = {
      settings: { get: async () => DEFAULT_SETTINGS, update: () => save.promise },
    } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useAppSettings>
    function SettingsProbe() {
      state = useAppSettings({ bridge, reportError })
      return <Probe />
    }
    await act(async () => { root.render(<SettingsProbe />); await Promise.resolve() })

    let mutation!: Promise<void>
    await act(async () => {
      mutation = state.updateSettings({ sidebarOpen: false })
      state.setInspectorOpen(false)
    })
    const saved = { ...DEFAULT_SETTINGS, sidebarOpen: false, inspectorOpen: true }
    await act(async () => { save.resolve(saved); await mutation })

    expect(state.settings).toEqual(saved)
    expect([state.sidebarOpen, state.inspectorOpen]).toEqual([false, false])
  })
})

describe('transcript read ownership', () => {
  it('performs one initial read and rejects an older same-runtime reconciliation after prompt admission', async () => {
    const staleRead = deferred<TranscriptMessage[]>()
    const read = vi.fn()
      .mockResolvedValueOnce([message('loaded:')])
      .mockImplementationOnce(() => staleRead.promise)
    const bridge = { sessions: { read } } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useWorkspaceRuntime>
    function WorkspaceProbe() {
      state = useWorkspaceRuntime({
        bridge, initialProject: project, initialSession: session, projects: [project], sessions: [session],
        initialMessages: [], reportError,
      })
      return <Probe />
    }
    await act(async () => { root.render(<WorkspaceProbe />); await Promise.resolve(); await Promise.resolve() })
    expect(read).toHaveBeenCalledTimes(1)
    expect(state.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'loaded:' })

    await act(async () => { state.attachRuntime(runtime, 0) })
    await act(async () => {
      state.reconcileTranscriptForEvent(runtime.runtimeId, { type: 'transport_error' })
      state.reconcileTranscriptForEvent(runtime.runtimeId, { type: 'agent_end' })
      await Promise.resolve()
    })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => {
      state.queueAgentEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live' } })
      expect(state.prepareForPrompt(0)).toBe(true)
    })
    await act(async () => { staleRead.resolve([message('stale-authoritative')]); await staleRead.promise; await Promise.resolve() })

    expect(state.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'loaded:live' })
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('bootstrap critical path', () => {
  it('selects projects and sessions before runtime discovery resolves', async () => {
    const runtimes = deferred<RuntimeInfo[]>()
    const bridge = {
      projects: { list: async () => [project] },
      sessions: { list: async () => [session], onChanged: () => () => undefined },
      agent: { list: () => runtimes.promise },
      app: { getMeta: async () => ({ version: '1', platform: 'darwin', arch: 'arm64', primeAvailable: true }) },
      schedules: { list: async () => [] },
    } as unknown as PrimeWorkApi
    const workspaceRef = { current: { generation: 0 } }
    const activated: Array<{ project?: ProjectRecord; session?: SessionRecord }> = []
    const attached: RuntimeInfo[] = []
    const setProjects = vi.fn()
    const setSessions = vi.fn()
    const setSchedules = vi.fn()
    const setScheduleError = vi.fn()
    const runtimeSessionsRef = { current: new Map<string, string>() }
    const reportError = vi.fn()
    const activateWorkspace = (nextProject?: ProjectRecord, nextSession?: SessionRecord) => {
      workspaceRef.current = { generation: 1, project: nextProject, session: nextSession, cwd: '/project', sessionFile: nextSession?.filePath }
      activated.push({ project: nextProject, session: nextSession })
      return 1
    }
    const attachRuntime = (next?: RuntimeInfo) => { if (next) attached.push(next) }
    let initialized = false
    function BootstrapProbe() {
      const result = useBootstrap({
        bridge, setProjects, setSessions, setSchedules, setScheduleError,
        runtimeSessionsRef, workspaceRef,
        activateWorkspace, attachRuntime, reportError,
      })
      initialized = result.initialized
      return <Probe />
    }
    await act(async () => { root.render(<BootstrapProbe />); await Promise.resolve(); await Promise.resolve() })

    expect(initialized).toBe(true)
    expect(activated).toEqual([{ project, session }])
    expect(attached).toEqual([])
    await act(async () => { runtimes.resolve([runtime]); await runtimes.promise; await Promise.resolve() })
    expect(attached).toEqual([runtime])
  })
})


describe('extension UI runtime ownership', () => {
  it('retains a background request and surfaces it when that runtime activates', async () => {
    const bridge = { agent: { command: vi.fn().mockResolvedValue({}) } } as unknown as PrimeWorkApi
    const runtimeIdRef = { current: 'active' as string | null }
    const runtimeSessionsRef = { current: new Map<string, string>() }
    const setSessions = vi.fn()
    const setRuntime = vi.fn()
    const reportError = vi.fn()
    let state!: ReturnType<typeof useExtensionUi>
    function ExtensionProbe({ activeRuntimeId }: { activeRuntimeId: string }) {
      runtimeIdRef.current = activeRuntimeId
      state = useExtensionUi({ bridge, activeRuntimeId, runtimeIdRef, runtimeSessionsRef, setSessions, setRuntime, reportError })
      return <Probe />
    }
    await act(async () => { root.render(<ExtensionProbe activeRuntimeId="active" />) })
    await act(async () => {
      state.showExtensionUi('background', {
        type: 'extension_ui_request', id: 'background-question', method: 'confirm', title: 'Continue?', message: 'Proceed',
      })
    })
    expect(state.extensionUi).toBeNull()

    await act(async () => { root.render(<ExtensionProbe activeRuntimeId="background" />) })
    expect(state.extensionUi?.runtimeId).toBe('background')
    expect(state.extensionUi?.request.id).toBe('background-question')
    expect(bridge.agent.command).not.toHaveBeenCalled()
  })

  it('groups ask_user question requests and responds to every pending question', async () => {
    const command = vi.fn().mockResolvedValue({})
    const bridge = { agent: { command } } as unknown as PrimeWorkApi
    const runtimeIdRef = { current: 'runtime' as string | null }
    const runtimeSessionsRef = { current: new Map<string, string>() }
    const setSessions = vi.fn()
    const setRuntime = vi.fn()
    const reportError = vi.fn()
    let state!: ReturnType<typeof useExtensionUi>
    function ExtensionProbe() {
      state = useExtensionUi({ bridge, activeRuntimeId: 'runtime', runtimeIdRef, runtimeSessionsRef, setSessions, setRuntime, reportError })
      return <Probe />
    }

    await act(async () => { root.render(<ExtensionProbe />) })
    await act(async () => {
      state.showExtensionUi('runtime', {
        type: 'extension_ui_request', id: 'question-1', method: 'select', title: 'First question',
        options: ['__prime_ask_user__group-1:0:2', 'A', 'B'],
      })
      state.showExtensionUi('runtime', {
        type: 'extension_ui_request', id: 'question-2', method: 'select', title: 'Second question',
        options: ['__prime_ask_user__group-1:1:2', 'C', 'D'],
      })
    })

    expect(state.extensionUi?.request.method).toBe('questionnaire')
    expect(state.extensionUi?.request.method === 'questionnaire' ? state.extensionUi.request.questions : []).toHaveLength(2)

    await act(async () => {
      await state.respondToExtensionUi({ values: {
        'question-1': JSON.stringify({ answer: 'B', answerSource: 'option' }),
        'question-2': JSON.stringify({ answer: 'D', answerSource: 'option', context: 'Because it is safer.' }),
      } })
    })

    expect(command).toHaveBeenNthCalledWith(1, 'runtime', { type: 'extension_ui_response', id: 'question-1', value: JSON.stringify({ answer: 'B', answerSource: 'option' }) })
    expect(command).toHaveBeenNthCalledWith(2, 'runtime', { type: 'extension_ui_response', id: 'question-2', value: JSON.stringify({ answer: 'D', answerSource: 'option', context: 'Because it is safer.' }) })
    expect(setRuntime).toHaveBeenCalledTimes(1)
    const resumeRuntime = setRuntime.mock.calls[0][0] as (current: RuntimeInfo | null) => RuntimeInfo | null
    expect(resumeRuntime(runtime)).toMatchObject({ runtimeId: 'runtime', isStreaming: true })
  })
})


describe('plugin request ownership', () => {
  it('rejects stale global, project, refresh, generation, and path completions', async () => {
    const requests = Array.from({ length: 4 }, () => deferred<SkillRecord[]>())
    const list = vi.fn()
    requests.forEach((request) => list.mockImplementationOnce(() => request.promise))
    const bridge = { plugins: { list } } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    const skill = (id: string): SkillRecord => ({ id, name: id, description: id, kind: 'skill', location: 'project', enabled: true })
    let state!: ReturnType<typeof usePluginSkills>
    function PluginProbe({ scope, generation }: { scope?: string; generation: number }) {
      state = usePluginSkills({ bridge, scope, generation, initialSkills: [], reportError })
      return <Probe />
    }
    await act(async () => { root.render(<PluginProbe generation={0} />) })
    expect(list).toHaveBeenNthCalledWith(1, undefined)
    await act(async () => { root.render(<PluginProbe scope="/project" generation={1} />) })
    expect(list).toHaveBeenNthCalledWith(2, '/project')

    await act(async () => { requests[0].resolve([skill('stale-global')]); await requests[0].promise })
    expect(state.skills).toEqual([])
    await act(async () => { requests[1].resolve([skill('project-one')]); await requests[1].promise })
    expect(state.skills.map(({ id }) => id)).toEqual(['project-one'])

    let refresh!: Promise<void>
    await act(async () => { refresh = state.refresh(); await Promise.resolve() })
    await act(async () => { root.render(<PluginProbe scope="/project" generation={2} />) })
    await act(async () => { requests[2].resolve([skill('stale-refresh')]); await refresh })
    expect(state.skills.map(({ id }) => id)).toEqual(['project-one'])
    await act(async () => { requests[3].resolve([skill('project-two')]); await requests[3].promise })
    expect(state.skills.map(({ id }) => id)).toEqual(['project-two'])
    expect(reportError).not.toHaveBeenCalled()
  })
})
