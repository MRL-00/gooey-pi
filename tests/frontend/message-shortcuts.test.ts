import { describe, expect, it } from 'vitest'
import { messageActionForKey, type MessageShortcutEvent } from '../../src/lib/message-shortcuts'

const event = (overrides: Partial<MessageShortcutEvent> = {}): MessageShortcutEvent => ({
  key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...overrides,
})

describe('message shortcuts', () => {
  it('defaults Enter to queue and Ctrl+Enter to steer', () => {
    expect(messageActionForKey(event())).toBe('queue')
    expect(messageActionForKey(event({ ctrlKey: true }))).toBe('steer')
  })

  it('leaves newlines, composition, and unsupported modifiers alone', () => {
    expect(messageActionForKey(event({ shiftKey: true }))).toBeNull()
    expect(messageActionForKey(event({ isComposing: true }))).toBeNull()
    expect(messageActionForKey(event({ metaKey: true }))).toBeNull()
    expect(messageActionForKey(event({ altKey: true }))).toBeNull()
    expect(messageActionForKey(event({ key: 'a' }))).toBeNull()
  })
})
