import type { PromptDeliveryIntent } from '@/types/api'

export interface MessageShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

export function messageActionForKey(event: MessageShortcutEvent): PromptDeliveryIntent | null {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey) return null
  // Cmd+Enter is the macOS-native alias for Ctrl+Enter; both steer.
  return event.ctrlKey || event.metaKey ? 'steer' : 'queue'
}
