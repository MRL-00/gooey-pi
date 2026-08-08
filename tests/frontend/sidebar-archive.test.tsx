// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/components/Sidebar'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const session: SessionRecord = {
  id: 'session', harness: 'prime', filePath: '/sessions/session.jsonl', projectPath: '/project', title: 'Session',
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
async function rightClick(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
}

describe('sidebar project context menu', () => {
  it('offers a confirmed remove action without deleting the project folder', async () => {
    const onRemoveProject = vi.fn()
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
          onRemoveProject={onRemoveProject}
          onClose={noop}
          onOpenPalette={noop}
          onRenameSession={async () => undefined}
          onArchiveSession={async () => undefined}
        />,
      )
    })

    await rightClick(container.querySelector('.project-row')!)
    const menu = container.querySelector('[aria-label="Project options for Project"]')
    expect(menu).not.toBeNull()
    const remove = [...menu!.querySelectorAll('button')].find((button) => button.textContent?.includes('Remove project'))
    expect(remove).toBeDefined()
    await press(remove!)

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('The folder and saved sessions will not be deleted.')
    await press(document.body.querySelector('.modal .button--danger')!)
    expect(onRemoveProject).toHaveBeenCalledOnce()
    expect(onRemoveProject).toHaveBeenCalledWith(project)
  })

  it('uses notebook icons for new sessions and a folder-plus icon for projects', async () => {
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
          onRemoveProject={noop}
          onClose={noop}
          onOpenPalette={noop}
          onRenameSession={async () => undefined}
          onArchiveSession={async () => undefined}
        />,
      )
    })

    expect(container.querySelector('.sidebar__primary .lucide-notebook-pen')).not.toBeNull()
    expect(container.querySelector('.project-row__new-session .lucide-notebook-pen')).not.toBeNull()
    expect(container.querySelector('.sidebar__section-heading .lucide-folder-plus')).not.toBeNull()
    expect(container.querySelector('.sidebar__primary button[title="New session (⌘N)"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="New session in Project"][title="New session in Project"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Add project"][title="Add project"]')).not.toBeNull()
  })
})

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
          onRemoveProject={noop}
          onClose={noop}
          onOpenPalette={noop}
          onRenameSession={async () => undefined}
          onArchiveSession={onArchiveSession}
        />,
      )
    })

    const archive = container.querySelector('[aria-label="Archive Session"]')
    expect(archive).not.toBeNull()
    expect(archive?.getAttribute('title')).toBe('Archive Session')
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
