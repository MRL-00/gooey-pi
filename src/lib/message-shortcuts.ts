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
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.metaKey || event.altKey) return null
  return event.ctrlKey ? 'steer' : 'queue'
}
