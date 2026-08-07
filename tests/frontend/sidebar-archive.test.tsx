// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/components/Sidebar'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const session: SessionRecord = {
  id: 'session', filePath: '/sessions/session.jsonl', projectPath: '/project', title: 'Session',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
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
  window.localStorage.clear()
  vi.restoreAllMocks()
})

const noop = () => undefined

async function press(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('sidebar archive confirmation', () => {
  it('requires a second click and cancels when clicking elsewhere', async () => {
    const onArchiveSession = vi.fn(async () => undefined)
    await act(async () => {
      root.render(
        <Sidebar
          projects={[project]}
          sessions={[session]}
          activeView="session"
          onSelectProject={noop}
          onSelectSession={noop}
          onNavigate={noop}
          onNewSession={noop}
          onAddProject={noop}
          onClose={noop}
          onOpenPalette={noop}
          onRenameSession={async () => undefined}
          onArchiveSession={onArchiveSession}
        />,
      )
    })

    const archive = container.querySelector('[aria-label="Archive Session"]')
    expect(archive).not.toBeNull()
    await press(archive!)
    expect(onArchiveSession).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="Confirm archive Session"]')).not.toBeNull()

    await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(container.querySelector('[aria-label="Confirm archive Session"]')).toBeNull()
    expect(container.querySelector('[aria-label="Archive Session"]')).not.toBeNull()

    const restarted = container.querySelector('[aria-label="Archive Session"]')
    await press(restarted!)
    const confirm = container.querySelector('[aria-label="Confirm archive Session"]')
    await press(confirm!)
    expect(onArchiveSession).toHaveBeenCalledOnce()
    expect(onArchiveSession).toHaveBeenCalledWith(session)
  })
})
