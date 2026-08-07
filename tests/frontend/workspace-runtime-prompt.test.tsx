// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import type { PrimeWorkApi, ProjectRecord, SessionRecord, TranscriptMessage } from '../../src/types/api'

const project: ProjectRecord = {
  id: 'project', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const session: SessionRecord = {
  id: 'session', filePath: '/sessions/session.jsonl', projectPath: '/project', title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}

type Workspace = ReturnType<typeof useWorkspaceRuntime>
let latest: Workspace

function Probe({ bridge }: { bridge: PrimeWorkApi }) {
  latest = useWorkspaceRuntime({
    bridge,
    initialProject: project,
    initialSession: session,
    sessions: [session],
    initialMessages: [],
    reportError: () => undefined,
  })
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const flush = async () => { await act(async () => { await Promise.resolve() }) }

describe('prompt admission versus background transcript reads', () => {
  it('keeps the optimistic user message when a pending background read resolves after the prompt', async () => {
    let resolveRead!: (value: TranscriptMessage[]) => void
    const read = vi.fn(() => new Promise<TranscriptMessage[]>((resolve) => { resolveRead = resolve }))
    const bridge = {
      sessions: { read },
      agent: { list: vi.fn(async () => []) },
    } as unknown as PrimeWorkApi

    await act(async () => { root.render(createElement(Probe, { bridge })) })
    await flush()
    expect(read).toHaveBeenCalledTimes(1)

    const generation = latest.workspaceRef.current.generation
    const userMessage: TranscriptMessage = {
      id: 'user-1754500000000', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'run the tests' }],
    }
    await act(async () => {
      expect(latest.prepareForPrompt(generation)).toBe(true)
      latest.setMessages((items) => [...items, userMessage])
    })

    await act(async () => {
      resolveRead([{ id: 'record-1', role: 'assistant', timestamp: 0, parts: [{ type: 'text', text: 'old answer' }] }])
    })
    await flush()

    expect(latest.messages.some((message) => message.id === 'user-1754500000000')).toBe(true)
  })

  it('applies a background read normally when no prompt raced it', async () => {
    let resolveRead!: (value: TranscriptMessage[]) => void
    const read = vi.fn(() => new Promise<TranscriptMessage[]>((resolve) => { resolveRead = resolve }))
    const bridge = {
      sessions: { read },
      agent: { list: vi.fn(async () => []) },
    } as unknown as PrimeWorkApi

    await act(async () => { root.render(createElement(Probe, { bridge })) })
    await flush()

    await act(async () => {
      resolveRead([{ id: 'record-1', role: 'assistant', timestamp: 0, parts: [{ type: 'text', text: 'persisted answer' }] }])
    })
    await flush()

    expect(latest.messages.map((message) => message.id)).toEqual(['record-1'])
    expect(latest.loadingSession).toBe(false)
  })
})
