export interface BoundedLines {
  lines: string[]
  truncated: boolean
}

export function newestWindow<T>(items: readonly T[], limit: number): readonly T[] {
  const safeLimit = Math.max(0, Math.floor(limit))
  return items.slice(Math.max(0, items.length - safeLimit))
}

export function boundText(text: string, maxCharacters: number, marker: string): string {
  const limit = Math.max(0, Math.floor(maxCharacters))
  return text.length > limit ? `${text.slice(0, limit)}${marker}` : text
}

/** Split only the admitted prefix so hostile newline-heavy data cannot allocate an unbounded array. */
export function boundLines(text: string, maxCharacters: number, maxLines: number): BoundedLines {
  const characterLimit = Math.max(0, Math.floor(maxCharacters))
  const lineLimit = Math.max(0, Math.floor(maxLines))
  const bounded = text.slice(0, characterLimit)
  const lines: string[] = []
  let cursor = 0
  while (lines.length < lineLimit && cursor <= bounded.length) {
    const newline = bounded.indexOf('\n', cursor)
    if (newline === -1) {
      lines.push(bounded.slice(cursor))
      cursor = bounded.length + 1
      break
    }
    lines.push(bounded.slice(cursor, newline))
    cursor = newline + 1
  }
  return { lines, truncated: text.length > bounded.length || cursor <= bounded.length }
}
