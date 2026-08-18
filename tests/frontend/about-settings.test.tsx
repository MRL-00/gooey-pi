// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutSettings, updateStatusCopy } from '../../src/pages/settings/AboutSettings'
import type { AppMeta } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const meta: AppMeta = {
  version: '1.1.11',
  platform: 'darwin',
  homeDir: '/Users/you',
  harnesses: {
    prime: { path: null, version: null },
    omp: { path: null, version: null },
    pi: { path: null, version: null },
  },
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
})

describe('About settings updates', () => {
  it('checks for updates from the About page', async () => {
    const onCheckForUpdates = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<AboutSettings meta={meta} updateState={{ phase: 'idle' }} onCheckForUpdates={onCheckForUpdates} onOpenDocs={vi.fn()} />)
    })

    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Check for updates'))
    expect(button).toBeDefined()
    await act(async () => { button?.click(); await Promise.resolve() })
    expect(onCheckForUpdates).toHaveBeenCalledOnce()
  })

  it('shows update progress and disables duplicate checks while checking', async () => {
    await act(async () => {
      root.render(<AboutSettings meta={meta} updateState={{ phase: 'checking' }} onCheckForUpdates={vi.fn()} onOpenDocs={vi.fn()} />)
    })

    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Checking')) as HTMLButtonElement | undefined
    expect(button?.disabled).toBe(true)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Checking GitHub Releases…')
  })

  it('describes available and current versions', () => {
    expect(updateStatusCopy({ phase: 'available', version: '1.2.0' }, '1.1.11')).toBe('GooeyPi 1.2.0 is available.')
    expect(updateStatusCopy({ phase: 'not-available' }, '1.1.11')).toBe('GooeyPi 1.1.11 is up to date.')
  })
})
