// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionShowsCompanionNotification } from '../../src/app/session-attention'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import { ActivityPage } from '../../src/pages/ActivityPage'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 2,
}
const activeSession: SessionRecord = {
  id: 'active', harness: 'prime', filePath: '/sessions/active.jsonl', projectPath: '/project', title: 'Active chat',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', status: 'complete', depth: 0, unread: true,
}
const archivedSession: SessionRecord = {
  ...activeSession,
  id: 'archived',
  filePath: '/sessions/archived.jsonl',
  title: 'Archived chat',
  archived: true,
  status: 'failed',
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('archived activity cleanup', () => {
  it('never renders archived chats in Activity', async () => {
    const onOpen = vi.fn()
    await act(async () => {
      root.render(<ActivityPage sessions={[activeSession, archivedSession]} projects={[project]} onOpen={onOpen} />)
    })

    expect(container.textContent).toContain('Active chat')
    expect(container.textContent).not.toContain('Archived chat')
    expect(container.querySelector('[aria-label="Activity filter"]')?.textContent).not.toContain('Archived')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Open Active chat"]')!.click()
    })
    expect(onOpen).toHaveBeenCalledWith(activeSession)
  })

  it('suppresses notifications from sessions that are already archived', () => {
    expect(sessionShowsCompanionNotification(archivedSession)).toBe(false)
  })

  it('acknowledges and clears unread state when archiving succeeds', async () => {
    const archive = vi.fn(async () => true)
    const clearSessionAttention = vi.fn()
    const setToast = vi.fn()
    let sessions = [activeSession]
    const setSessions = vi.fn((update: (items: SessionRecord[]) => SessionRecord[]) => { sessions = update(sessions) })
    const actions = createWorkspaceActions(() => ({
      bridge: { sessions: { archive } },
      workspace: { workspaceRef: { current: { session: undefined } } },
      setSessions,
      setToast,
      clearSessionAttention,
      reportError: vi.fn(),
    } as unknown as WorkspaceActionsDeps))

    await actions.setSessionArchived(activeSession, true)

    expect(archive).toHaveBeenCalledWith(activeSession.filePath, true)
    expect(clearSessionAttention).toHaveBeenCalledWith(activeSession)
    expect(sessions[0]).toMatchObject({ id: activeSession.id, archived: true, unread: false })
    expect(setToast).toHaveBeenCalledWith('Session archived.')
  })
})
