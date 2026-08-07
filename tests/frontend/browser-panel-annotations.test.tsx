// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../src/components/inspector/BrowserPanel'
import { useBrowserAnnotations } from '../../src/hooks/useBrowserAnnotations'
import type { BrowserAnnotationsApi } from '../../src/hooks/useBrowserAnnotations'
import type { BrowserAnnotation } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const capturedPayload = JSON.stringify([{
  selector: '#cta',
  tagName: 'BUTTON',
  id: 'cta',
  classes: ['btn'],
  text: 'Join now',
  href: 'https://example.com/signup',
  rect: { x: 5, y: 6, width: 100, height: 30 },
}])

let container: HTMLDivElement
let root: Root
let executed: string[]
let takeResult: string | null
let webviewUrl: string

// jsdom renders <webview> as HTMLUnknownElement; give the prototype the small
// Electron surface BrowserPanel relies on.
const webviewProto = window.HTMLUnknownElement.prototype as unknown as Record<string, unknown>
const webviewMethods = {
  loadURL: async () => undefined,
  getURL: () => webviewUrl,
  getTitle: () => 'Example Page',
  goBack: () => undefined,
  goForward: () => undefined,
  canGoBack: () => false,
  canGoForward: () => false,
  reload: () => undefined,
  stop: () => undefined,
  executeJavaScript: async (code: string) => {
    executed.push(code)
    return code.includes('.take()') ? takeResult : undefined
  },
}

let latestApi: BrowserAnnotationsApi
function Harness({ pollIntervalMs = 50 }: { pollIntervalMs?: number }) {
  latestApi = useBrowserAnnotations()
  return <BrowserPanel home="https://example.com/" onOpenExternal={() => undefined} annotations={latestApi} pollIntervalMs={pollIntervalMs} />
}

beforeEach(() => {
  vi.useFakeTimers()
  executed = []
  takeResult = null
  webviewUrl = 'https://example.com/'
  Object.assign(webviewProto, webviewMethods)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  for (const key of Object.keys(webviewMethods)) delete webviewProto[key]
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const webviewElement = () => container.querySelector('webview') as HTMLElement

const toggleAnnotate = async () => {
  await act(async () => {
    ;(container.querySelector('button[aria-label="Annotate page"], button[aria-label="Stop annotating"]') as HTMLButtonElement).click()
  })
}

const setComment = async (value: string) => {
  const textarea = container.querySelector('.annotation-popover textarea') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('BrowserPanel annotation mode', () => {
  it('injects the picker, captures a clicked element, and stores the comment', async () => {
    await act(async () => root.render(<Harness />))
    await toggleAnnotate()

    expect(executed.some((code) => code.includes('__primeAnnotator.start()'))).toBe(true)
    expect(container.querySelector('.annotation-hint')).not.toBeNull()

    takeResult = capturedPayload
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    takeResult = null

    // Selection stops picking (page listeners cleaned up) and opens the comment popover.
    expect(executed.some((code) => code.includes('__primeAnnotator.stop()'))).toBe(true)
    const popover = container.querySelector('.annotation-popover')
    expect(popover?.textContent).toContain('Comment on element 1')
    expect(popover?.textContent).toContain('button#cta.btn')
    expect(popover?.textContent).toContain('Join now')

    await setComment('Make this button blue')
    await act(async () => { (container.querySelector('.button--primary') as HTMLButtonElement).click() })

    expect(latestApi.annotations).toHaveLength(1)
    expect(latestApi.annotations[0].comment).toBe('Make this button blue')
    expect(latestApi.annotations[0].pageUrl).toBe('https://example.com/')
    expect(latestApi.annotations[0].pageTitle).toBe('Example Page')
    expect(container.querySelector('.annotation-popover')).toBeNull()
    expect(container.querySelector('.annotation-count')?.textContent).toContain('1 of 20')

    // The stored annotation now renders as a persistent numbered marker in the page.
    const markerCall = [...executed].reverse().find((code) => code.includes('setMarkers'))
    expect(markerCall).toContain('"selector":"#cta"')
    expect(markerCall).toContain('"index":1')
  })

  it('blocks entering annotation mode at the 20-annotation cap with clear feedback', async () => {
    const annotations: BrowserAnnotation[] = Array.from({ length: 20 }, (_, index) => ({
      id: `a-${index}`, comment: `c-${index}`,
      element: { selector: `#e-${index}`, tagName: 'div', id: '', classes: [], text: '', rect: { x: 0, y: 0, width: 0, height: 0 } },
      pageUrl: 'https://example.com/', pageTitle: 'Example', stale: false, createdAt: index,
    }))
    const api: BrowserAnnotationsApi = { annotations, atCapacity: true, add: vi.fn(() => false), remove: vi.fn(), clear: vi.fn(), handleNavigation: vi.fn() }
    await act(async () => root.render(<BrowserPanel home="https://example.com/" onOpenExternal={() => undefined} annotations={api} pollIntervalMs={50} />))
    const injectedBefore = executed.filter((code) => code.includes('__primeAnnotator.start()')).length

    await toggleAnnotate()

    expect(container.querySelector('.annotation-notice')?.textContent).toContain('at most 20 annotations')
    expect(container.querySelector('.annotation-hint')).toBeNull()
    expect(executed.filter((code) => code.includes('__primeAnnotator.start()')).length).toBe(injectedBefore)
  })

  it('marks annotations stale on navigation and exits annotation mode', async () => {
    await act(async () => root.render(<Harness />))
    act(() => {
      latestApi.add({
        comment: 'Original page note',
        element: { selector: '#hero', tagName: 'div', id: 'hero', classes: [], text: '', rect: { x: 0, y: 0, width: 10, height: 10 } },
        pageUrl: 'https://example.com/',
        pageTitle: 'Example',
      })
    })
    await toggleAnnotate()
    expect(container.querySelector('.annotation-hint')).not.toBeNull()

    webviewUrl = 'https://example.com/other'
    await act(async () => { webviewElement().dispatchEvent(new Event('did-navigate')) })

    expect(latestApi.annotations[0].stale).toBe(true)
    expect(container.querySelector('.annotation-hint')).toBeNull()
    expect(container.querySelector('.annotation-count')?.textContent).toContain('1 from earlier pages')

    // Navigating back to the captured page revives the marker.
    webviewUrl = 'https://example.com/'
    await act(async () => { webviewElement().dispatchEvent(new Event('did-navigate')) })
    expect(latestApi.annotations[0].stale).toBe(false)
    const markerCall = [...executed].reverse().find((code) => code.includes('setMarkers'))
    expect(markerCall).toContain('"selector":"#hero"')
  })

  it('rejects malformed picker payloads without leaving annotation mode', async () => {
    await act(async () => root.render(<Harness />))
    await toggleAnnotate()

    takeResult = JSON.stringify([{ tagName: 'div' }])
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })
    takeResult = 'not json at all'
    await act(async () => { await vi.advanceTimersByTimeAsync(120) })

    expect(container.querySelector('.annotation-popover')).toBeNull()
    expect(container.querySelector('.annotation-hint')).not.toBeNull()
    expect(latestApi.annotations).toHaveLength(0)
  })
})
