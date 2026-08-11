import type { MessageEnterAction, PromptDeliveryIntent } from '@/types/api'

export interface MessageShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

export function messageActionForKey(event: MessageShortcutEvent, enterAction: MessageEnterAction = 'queue'): PromptDeliveryIntent | null {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey) return null
  // Cmd+Enter is the macOS-native alias for Ctrl+Enter. The modifier always
  // selects the opposite action so the two shortcuts remain swappable.
  if (event.ctrlKey || event.metaKey) return enterAction === 'queue' ? 'steer' : 'queue'
  return enterAction
}
