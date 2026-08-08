// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TitleToolbar } from '../../src/components/TitleToolbar'
import { VoiceOrb } from '../../src/components/VoiceOrb'
import type { PrimeWorkApi } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'open'
  send = vi.fn()
  close = vi.fn()
}

class FakePeer extends EventTarget {
  static latest: FakePeer
  channel = new FakeDataChannel()
  close = vi.fn()
  addTrack = vi.fn()
  setLocalDescription = vi.fn(async () => undefined)
  setRemoteDescription = vi.fn(async () => undefined)
  createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'v=0\r\no=test-offer-value' }))
  createDataChannel = vi.fn(() => this.channel as unknown as RTCDataChannel)
  constructor() { super(); FakePeer.latest = this }
}

describe('realtime voice surface', () => {
  let container: HTMLDivElement
  let root: Root
  const track = { enabled: true, stop: vi.fn() }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }

  beforeEach(() => {
    track.enabled = true; track.stop.mockReset()
    vi.stubGlobal('RTCPeerConnection', FakePeer)
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('places the waveform toggle immediately before the terminal button', () => {
    act(() => root.render(<TitleToolbar view="session" sidebarOpen inspectorOpen terminalOpen={false} voiceOpen onToggleSidebar={vi.fn()} onToggleInspector={vi.fn()} onToggleTerminal={vi.fn()} onOpenBrowser={vi.fn()} onToggleVoice={vi.fn()} />))
    const labels = [...container.querySelectorAll<HTMLButtonElement>('.title-toolbar__actions button')].map((button) => button.getAttribute('aria-label'))
    expect(labels.slice(0, 2)).toEqual(['Close realtime voice', 'Toggle terminal (⌘J)'])
  })

  it('shows mute and close controls and disables the microphone track when muted', async () => {
    const voice = {
      createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'),
      executeTool: vi.fn(),
    } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="omp" onClose={vi.fn()} onTaskStarted={vi.fn()} />))
    expect(voice.createRealtimeCall).toHaveBeenCalledWith({ mode: 'conversation', sdp: 'v=0\r\no=test-offer-value', harness: 'omp' })
    const mute = container.querySelector<HTMLButtonElement>('[aria-label="Mute realtime voice"]')!
    expect(container.querySelector('[aria-label="Close realtime voice"]')).not.toBeNull()
    await act(async () => mute.click())
    expect(track.enabled).toBe(false)
    expect(container.querySelector('[aria-label="Unmute realtime voice"]')).not.toBeNull()
  })

  it('executes a start_task call and reports the started task to the workspace', async () => {
    const task = { projectId: 'p1', projectName: 'Prime', harness: 'prime' as const, runtimeId: 'r1', sessionFile: '/tmp/session.jsonl' }
    const executeTool = vi.fn(async () => ({ output: '{"started":true}', task }))
    const onTaskStarted = vi.fn(async () => undefined)
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="prime" onClose={vi.fn()} onTaskStarted={onTaskStarted} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-1', name: 'start_task', arguments: JSON.stringify({ project_id: 'p1', prompt: 'Build it', model: 'openai-codex/gpt-5.6-sol', reasoning: 'high' }) }) }))
      await Promise.resolve()
    })
    expect(executeTool).toHaveBeenCalledWith({ name: 'start_task', arguments: { project_id: 'p1', prompt: 'Build it', model: 'openai-codex/gpt-5.6-sol', reasoning: 'high' } }, 'prime')
    expect(onTaskStarted).toHaveBeenCalledWith(task)
    expect(container.textContent).toContain('Task started')
    expect(container.textContent).toContain('Prime · Prime')
    expect(container.textContent).toContain('Opened in the sidebar')
  })

  it('forwards model discovery calls through the pinned harness', async () => {
    const executeTool = vi.fn(async () => ({ output: '{"models":[]}' }))
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="omp" onClose={vi.fn()} onTaskStarted={vi.fn()} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-models', name: 'list_models', arguments: JSON.stringify({ query: 'sonnet' }) }) }))
      await Promise.resolve()
    })
    expect(executeTool).toHaveBeenCalledWith({ name: 'list_models', arguments: { query: 'sonnet' } }, 'omp')
  })

  it('keeps tool calls bound to the harness selected when the orb opened', async () => {
    const executeTool = vi.fn(async () => ({ output: '{"active_harness":"omp"}' }))
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    const onClose = vi.fn()
    const onTaskStarted = vi.fn(async () => undefined)
    await act(async () => root.render(<VoiceOrb voice={voice} harness="omp" onClose={onClose} onTaskStarted={onTaskStarted} />))
    await act(async () => root.render(<VoiceOrb voice={voice} harness="prime" onClose={onClose} onTaskStarted={onTaskStarted} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-context', name: 'get_local_context', arguments: '{}' }) }))
      await Promise.resolve()
    })
    expect(executeTool).toHaveBeenCalledWith({ name: 'get_local_context', arguments: {} }, 'omp')
  })

  it('shows a durable failure instead of claiming an unconfirmed task started', async () => {
    const executeTool = vi.fn(async () => { throw new Error('OMP did not create a visible session') })
    const voice = { createRealtimeCall: vi.fn(async () => 'v=0\r\no=test-answer-value'), executeTool } as unknown as PrimeWorkApi['voice']
    await act(async () => root.render(<VoiceOrb voice={voice} harness="omp" onClose={vi.fn()} onTaskStarted={vi.fn(async () => undefined)} />))
    await act(async () => {
      FakePeer.latest.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', call_id: 'call-2', name: 'start_task', arguments: JSON.stringify({ project_id: 'p1', prompt: 'Build it' }) }) }))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Task was not started: OMP did not create a visible session')
    expect(container.textContent).not.toContain('Task started')
  })
})
