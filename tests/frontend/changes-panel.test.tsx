// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
})
