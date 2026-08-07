import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { AgentBrowserService } from '../../electron/main/browser/agent-service'
import type { AgentBrowserState } from '../../src/types/api'

let nextGuestId = 1000

class FakeGuest extends EventEmitter {
  readonly id = nextGuestId++
  url = 'about:blank'
  title = ''
  destroyed = false
  loading = false
  throttling: boolean | null = null
  readonly loadedUrls: string[] = []
  readonly inputEvents: Array<Record<string, unknown>> = []
  readonly insertedText: string[] = []
  readonly executedScripts: string[] = []
  scriptResult: (code: string) => unknown = (code) => {
    if (code.includes('readyState')) {
      return JSON.stringify({ url: this.url, title: this.title, innerWidth: 640, innerHeight: 480, scrollY: 0, scrollHeight: 900, readyState: 'complete' })
    }
    return JSON.stringify({})
  }

  isDestroyed() { return this.destroyed }
  isLoading() { return this.loading }
  getURL() { return this.url }
  getTitle() { return this.title }
  canGoBack() { return false }
  canGoForward() { return false }
  goBack() {}
  goForward() {}
  reload() {}
  stop() {}
  focus() {}
  setBackgroundThrottling(allowed: boolean) { this.throttling = allowed }
  async loadURL(url: string) {
    this.loadedUrls.push(url)
    this.url = url
    this.emit('did-navigate')
  }
  async insertText(value: string) { this.insertedText.push(value) }
  sendInputEvent(event: Record<string, unknown>) { this.inputEvents.push(event) }
  async executeJavaScript(code: string) {
    this.executedScripts.push(code)
    return this.scriptResult(code)
  }
  async capturePage() {
    const image = {
      getSize: () => ({ width: 1280, height: 960 }),
      resize: ({ width }: { width: number }) => ({
        getSize: () => ({ width, height: Math.round((width / 1280) * 960) }),
        resize: () => image,
        toJPEG: () => Buffer.from('resized-jpeg'),
      }),
      toJPEG: () => Buffer.from('jpeg'),
    }
    return image
  }
  destroy() {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function fixture() {
  const guests = new Map<number, FakeGuest>()
  const service = new AgentBrowserService({
    getGuest: (id) => guests.get(id) as unknown as WebContents,
    attachTimeoutMs: 1_500,
    loadTimeoutMs: 1_500,
  })
  const states: AgentBrowserState[] = []
  service.onDidChange((state) => states.push(state))
  const newGuest = () => {
    const guest = new FakeGuest()
    guests.set(guest.id, guest)
    service.approveGuest(guest as unknown as WebContents)
    return guest
  }
  const openAttached = async (sessionKey: string, url?: string) => {
    const guest = newGuest()
    const opening = service.openTab(sessionKey, url === undefined ? {} : { url })
    // The renderer would mount a webview for the pushed pending tab and report attachment.
    await new Promise((resolveTick) => setTimeout(resolveTick, 10))
    const pending = service.state().tabs.find((tab) => !tab.attached && tab.sessionFile === sessionKey)
    expect(pending).toBeDefined()
    service.attachTab(pending!.tabId, guest.id)
    const result = await opening
    return { guest, tabId: result.tabId as string, result }
  }
  return { service, states, guests, newGuest, openAttached }
}

describe('AgentBrowserService', () => {
  it('opens a tab once the renderer attaches an approved guest and navigates it', async () => {
    const { service, openAttached } = fixture()
    const { guest, tabId, result } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    expect(guest.loadedUrls).toContain('https://example.com/')
    expect(guest.throttling).toBe(false)
    expect(result.url).toBe('https://example.com/')
    const snapshot = service.state()
    expect(snapshot.tabs).toHaveLength(1)
    expect(snapshot.tabs[0]).toMatchObject({ tabId, sessionFile: '/sessions/a.jsonl', attached: true, active: true })
  })

  it('rejects unapproved guests and guests already bound to another tab', async () => {
    const { service, guests, openAttached } = fixture()
    const { guest } = await openAttached('/sessions/a.jsonl')
    const rogue = new FakeGuest()
    guests.set(rogue.id, rogue)
    const opening = service.openTab('/sessions/a.jsonl', {})
    await new Promise((resolveTick) => setTimeout(resolveTick, 10))
    const pending = service.state().tabs.find((tab) => !tab.attached)!
    expect(() => service.attachTab(pending.tabId, rogue.id)).toThrow(/not an approved browser guest/)
    expect(() => service.attachTab(pending.tabId, guest.id)).toThrow(/already bound/)
    service.closeTab(pending.tabId)
    await expect(opening).rejects.toThrow()
  })

  it('scopes agent actions to the owning session', async () => {
    const { service, openAttached } = fixture()
    const { tabId } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    await openAttached('/sessions/b.jsonl', 'https://other.example/')
    await expect(service.closeTabScoped('/sessions/b.jsonl', { tabId })).rejects.toThrow(/does not belong to this thread/)
    await expect(service.readPage('/sessions/b.jsonl', { tabId })).rejects.toThrow(/does not belong to this thread/)
    const mine = await service.listTabs('/sessions/a.jsonl')
    expect(mine.tabs).toHaveLength(1)
  })

  it('enforces the per-session tab cap', async () => {
    const { service, openAttached } = fixture()
    for (let index = 0; index < 6; index += 1) await openAttached('/sessions/a.jsonl')
    await expect(service.openTab('/sessions/a.jsonl', {})).rejects.toThrow(/already has 6 browser tabs/)
  })

  it('refuses non-http(s) navigation targets', async () => {
    const { service, openAttached } = fixture()
    await openAttached('/sessions/a.jsonl')
    await expect(service.navigate('/sessions/a.jsonl', { url: 'file:///etc/passwd' })).rejects.toThrow(/credential-free http/)
    await expect(service.navigate('/sessions/a.jsonl', { url: 'https://user:pw@example.com/' })).rejects.toThrow(/credential-free http/)
    await expect(service.openTab('/sessions/a.jsonl', { url: 'javascript:alert(1)' })).rejects.toThrow(/credential-free http/)
  })

  it('clicks element refs through injected geometry and trusted input events', async () => {
    const { service, openAttached } = fixture()
    const { guest } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    guest.scriptResult = (code) => {
      if (code.includes('__primeWorkAgentRefs')) return JSON.stringify({ x: 12, y: 34 })
      return JSON.stringify({ url: guest.url, title: guest.title, innerWidth: 640, innerHeight: 480, scrollY: 0, scrollHeight: 900, readyState: 'complete' })
    }
    await service.click('/sessions/a.jsonl', { ref: 3 })
    const types = guest.inputEvents.map((event) => event.type)
    expect(types).toEqual(expect.arrayContaining(['mouseMove', 'mouseDown', 'mouseUp']))
    expect(guest.inputEvents.find((event) => event.type === 'mouseDown')).toMatchObject({ x: 12, y: 34, button: 'left' })
  })

  it('types into the page and submits with Enter', async () => {
    const { service, openAttached } = fixture()
    const { guest } = await openAttached('/sessions/a.jsonl', 'https://example.com/')
    await service.type('/sessions/a.jsonl', { text: 'hello world', submit: true })
    expect(guest.insertedText).toEqual(['hello world'])
    expect(guest.inputEvents.filter((event) => event.keyCode === 'Return').map((event) => event.type)).toEqual(['keyDown', 'char', 'keyUp'])
  })

  it('captures screenshots resized to the CSS viewport', async () => {
    const { service, openAttached } = fixture()
    await openAttached('/sessions/a.jsonl', 'https://example.com/')
    const shot = await service.screenshot('/sessions/a.jsonl', {})
    expect(shot.mimeType).toBe('image/jpeg')
    expect(shot.width).toBe(640)
    expect(Buffer.from(shot.data as string, 'base64').toString()).toBe('resized-jpeg')
  })

  it('marks tabs detached when their guest is destroyed and reactivates a sibling on close', async () => {
    const { service, openAttached } = fixture()
    const first = await openAttached('/sessions/a.jsonl')
    const second = await openAttached('/sessions/a.jsonl')
    expect(service.state().tabs.find((tab) => tab.tabId === second.tabId)?.active).toBe(true)
    second.guest.destroy()
    expect(service.state().tabs.find((tab) => tab.tabId === second.tabId)).toMatchObject({ attached: false })
    service.closeTab(second.tabId)
    expect(service.state().tabs.find((tab) => tab.tabId === first.tabId)?.active).toBe(true)
  })

  it('rejects malformed keys, scroll directions, and coordinates', async () => {
    const { service, openAttached } = fixture()
    await openAttached('/sessions/a.jsonl')
    await expect(service.pressKey('/sessions/a.jsonl', { key: 'definitely-not-a-key' })).rejects.toThrow(/key must be/)
    await expect(service.scroll('/sessions/a.jsonl', { direction: 'sideways' })).rejects.toThrow(/direction must be/)
    await expect(service.click('/sessions/a.jsonl', {})).rejects.toThrow(/ref .*or x and y/)
    await expect(service.click('/sessions/a.jsonl', { x: -5, y: 10 })).rejects.toThrow(/within the page viewport/)
  })
})
