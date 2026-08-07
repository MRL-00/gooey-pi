import type { TranscriptMessage } from '@/types/api'

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => structurallyEqual(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined)
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => structurallyEqual(leftRecord[key], rightRecord[key]))
}

/**
 * Merges an authoritative transcript read into current renderer state by
 * message id: messages whose content is unchanged keep their current object
 * identity so memoized rows skip re-rendering, and a fully unchanged
 * transcript keeps the current array identity.
 */
export function reconcileTranscripts(current: TranscriptMessage[], next: TranscriptMessage[]): TranscriptMessage[] {
  if (current === next || current.length === 0) return next
  const currentById = new Map<string, TranscriptMessage>()
  for (const message of current) if (!currentById.has(message.id)) currentById.set(message.id, message)
  let changed = next.length !== current.length
  const merged = next.map((message, index) => {
    const previous = currentById.get(message.id)
    if (previous && structurallyEqual(previous, message)) {
      if (current[index] !== previous) changed = true
      return previous
    }
    changed = true
    return message
  })
  return changed ? merged : current
}
