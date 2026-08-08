// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangesCard } from '../../src/components/ChangesCard'
import { ChangesPanel } from '../../src/components/inspector/ChangesPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
  Reflect.deleteProperty(window, 'prime')
  vi.restoreAllMocks()
})

describe('ChangesPanel status states', () => {
  it('renders the no-repository state without an error banner', async () => {
    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: false, files: [], error: 'Not a Git repository' }} onRefreshGit={vi.fn()} />)
    })
    expect(container.textContent).toContain('No Git repository')
    expect(container.textContent).not.toContain('Git status unavailable')
  })

  it('renders a distinct failure state with retry when the repo exists but status failed', async () => {
    const onRefreshGit = vi.fn()
    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: true, files: [], error: 'Git status timed out; the result is unknown' }} onRefreshGit={onRefreshGit} />)
    })
    expect(container.textContent).toContain('Git status unavailable')
    expect(container.textContent).toContain('Git status timed out')
    expect(container.textContent).not.toContain('No Git repository')
    act(() => { container.querySelector('button')!.click() })
    expect(onRefreshGit).toHaveBeenCalledTimes(1)
  })
  it('dismisses the file changes card without opening the inspector', async () => {
    const onOpenChanges = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(<ChangesCard git={{ isRepo: true, files: [{ path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 }] }} onOpenChanges={onOpenChanges} onClose={onClose} />)
    })

    act(() => { container.querySelector<HTMLButtonElement>('.changes-card__close')!.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOpenChanges).not.toHaveBeenCalled()
  })

  it('confirms undoing the selected file before restoring it', async () => {
    const restore = vi.fn(async () => true)
    const diff = vi.fn(async () => ({ path: 'file.txt', staged: false, text: '', truncated: false }))
    Object.defineProperty(window, 'prime', { configurable: true, value: { git: { diff, restore } } })
    const onRefreshGit = vi.fn(async () => undefined)

    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: true, files: [{ path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 }] }} onRefreshGit={onRefreshGit} />)
      await Promise.resolve()
    })
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('.diff-header button')].find((button) => button.textContent?.includes('Undo changes'))!.click()
    })
    expect(document.body.textContent).toContain('This discards the staged and unstaged changes')

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('.modal__footer button')].find((button) => button.textContent === 'Undo changes')!.click()
      await Promise.resolve()
    })
    expect(restore).toHaveBeenCalledWith('/project', ['file.txt'])
    expect(onRefreshGit).toHaveBeenCalledTimes(1)
  })
})
