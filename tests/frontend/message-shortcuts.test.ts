import { describe, expect, it } from 'vitest'
import { messageActionForKey, type MessageShortcutEvent } from '../../src/lib/message-shortcuts'

const event = (overrides: Partial<MessageShortcutEvent> = {}): MessageShortcutEvent => ({
  key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...overrides,
})

describe('message shortcuts', () => {
  it('defaults Enter to queue and Ctrl+Enter to steer', () => {
    expect(messageActionForKey(event(), 'queue')).toBe('queue')
    expect(messageActionForKey(event({ ctrlKey: true }), 'queue')).toBe('steer')
  })

  it('swaps the actions as one collision-free setting', () => {
    expect(messageActionForKey(event(), 'steer')).toBe('steer')
    expect(messageActionForKey(event({ ctrlKey: true }), 'steer')).toBe('queue')
  })

  it('leaves newlines, composition, and unsupported modifiers alone', () => {
    expect(messageActionForKey(event({ shiftKey: true }), 'queue')).toBeNull()
    expect(messageActionForKey(event({ isComposing: true }), 'queue')).toBeNull()
    expect(messageActionForKey(event({ metaKey: true }), 'queue')).toBeNull()
    expect(messageActionForKey(event({ altKey: true }), 'queue')).toBeNull()
    expect(messageActionForKey(event({ key: 'a' }), 'queue')).toBeNull()
  })
})
