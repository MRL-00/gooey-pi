import type { PrimeContextUsage } from '../../../src/types/api'
import { isRecord } from '../validation'
import type { RpcObject } from './types'

const CHARS_PER_TOKEN_ESTIMATE = 4

export interface LiveContextUsageUpdate {
  changed: boolean
  reset: boolean
}

function boundedTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function assistantMessage(event: RpcObject): RpcObject | null {
  if (!isRecord(event.message)) return null
  return event.message.role === 'assistant' ? event.message : null
}

/**
 * Tracks output generated since the latest user message. Providers usually
 * include an output-token count on partial assistant messages; character
 * deltas keep the estimate moving for providers that report usage only when
 * the message finishes.
 */
export class LiveContextUsageTracker {
  private completedTokens = 0
  private streamingUsageTokens = 0
  private streamingChars = 0
  private reportedTokens = 0

  get tokens(): number { return this.reportedTokens }

  handleEvent(event: RpcObject): LiveContextUsageUpdate {
    const previous = this.reportedTokens
    if (event.type === 'message_start' && isRecord(event.message) && event.message.role === 'user') {
      this.reset()
      return { changed: previous !== 0, reset: true }
    }

    if (event.type === 'message_update') {
      // message_update is assistant-only in the RPC protocol. When a harness
      // supplies the message, still reject a contradictory role.
      if (isRecord(event.message) && event.message.role !== 'assistant') return { changed: false, reset: false }
      const delta = isRecord(event.assistantMessageEvent) && typeof event.assistantMessageEvent.delta === 'string'
        ? event.assistantMessageEvent.delta
        : ''
      this.streamingChars = saturatingAdd(this.streamingChars, delta.length)
      const message = assistantMessage(event)
      const usage = message && isRecord(message.usage) ? boundedTokenCount(message.usage.output) : undefined
      if (usage !== undefined) this.streamingUsageTokens = usage
      this.captureCurrentTokens()
    } else if (event.type === 'message_end') {
      const message = assistantMessage(event)
      if (!message) return { changed: false, reset: false }
      const usage = isRecord(message.usage) ? boundedTokenCount(message.usage.output) : undefined
      const completed = usage !== undefined && usage > 0 ? usage : this.estimatedStreamingTokens()
      this.completedTokens = saturatingAdd(this.completedTokens, completed)
      this.streamingUsageTokens = 0
      this.streamingChars = 0
      this.captureCurrentTokens()
    }

    return { changed: this.reportedTokens !== previous, reset: false }
  }

  reset(): void {
    this.completedTokens = 0
    this.streamingUsageTokens = 0
    this.streamingChars = 0
    this.reportedTokens = 0
  }

  private captureCurrentTokens(): void {
    const streaming = Math.max(this.streamingUsageTokens, this.estimatedStreamingTokens())
    this.reportedTokens = Math.max(this.reportedTokens, saturatingAdd(this.completedTokens, streaming))
  }

  private estimatedStreamingTokens(): number {
    return Math.round(this.streamingChars / CHARS_PER_TOKEN_ESTIMATE)
  }
}

/** Adds only output produced after the authoritative snapshot was captured. */
export function withLiveContextUsage(
  snapshot: PrimeContextUsage,
  activityTokens: number,
  snapshotActivityTokens: number,
): PrimeContextUsage {
  if (snapshot.tokens === null || snapshot.percent === null) return snapshot
  const inFlight = Math.max(0, activityTokens - snapshotActivityTokens)
  if (inFlight === 0) return snapshot
  const tokens = saturatingAdd(snapshot.tokens, inFlight)
  return {
    tokens,
    contextWindow: snapshot.contextWindow,
    percent: (tokens / snapshot.contextWindow) * 100,
  }
}
