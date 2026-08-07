import type { MessageEnterAction, PromptDeliveryIntent } from '@/types/api'

export interface MessageShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing: boolean
}

export function messageActionForKey(event: MessageShortcutEvent, enterAction: MessageEnterAction): PromptDeliveryIntent | null {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.metaKey || event.altKey) return null
  if (!event.ctrlKey) return enterAction
  return enterAction === 'queue' ? 'steer' : 'queue'
}
