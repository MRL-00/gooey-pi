import { useEffect } from 'react'
import type { PrimeWorkApi, PromptDeliveryIntent, PromptImage, QueuedPrompt } from '@/types/api'

interface UseQueuedPromptFlushOptions {
  bridge: PrimeWorkApi | null
  busy: boolean
  externalSessionRunning: boolean
  submitting: boolean
  queuedMessages: QueuedPrompt[]
  queuedFlushRef: React.MutableRefObject<boolean>
  sendPrompt(
    prompt: string,
    images: PromptImage[],
    intent: PromptDeliveryIntent,
    queuedFlushPromptId: string,
  ): Promise<void>
}

export function useQueuedPromptFlush({
  bridge,
  busy,
  externalSessionRunning,
  submitting,
  queuedMessages,
  queuedFlushRef,
  sendPrompt,
}: UseQueuedPromptFlushOptions): void {
  useEffect(() => {
    if (!bridge || busy || externalSessionRunning || submitting || queuedFlushRef.current || queuedMessages.length === 0) return
    const next = queuedMessages[0]
    if (next.flushAttemptFailed) return
    queuedFlushRef.current = true
    void sendPrompt(next.text, [], 'queue', next.id)
      .finally(() => { queuedFlushRef.current = false })
  }, [bridge, busy, externalSessionRunning, queuedMessages, queuedFlushRef, sendPrompt, submitting])
}
