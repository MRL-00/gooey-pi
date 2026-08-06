import { Fragment } from 'react'

export type SyntaxTokenKind = 'key' | 'string' | 'keyword' | 'number' | 'plain'

export interface SyntaxToken {
  kind: SyntaxTokenKind
  text: string
}

// Limit styled fragments so newline- or token-heavy tool output cannot create an
// unbounded number of React elements. The caller separately caps output at 200k.
export const MAX_SYNTAX_HIGHLIGHTS = 10_000

function isWord(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character)
}

/**
 * Tokenize JSON-like tool output with one monotonically advancing cursor.
 * Every source character is consumed once, including whitespace used to decide
 * whether a quoted token is an object key. Repeated token text is therefore
 * classified by its actual position rather than by searching from the start.
 */
export function tokenizeSyntax(text: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = []
  let cursor = 0
  let plainStart = 0
  let highlights = 0

  const push = (kind: SyntaxTokenKind, start: number, end: number) => {
    if (end <= start) return
    const value = text.slice(start, end)
    const previous = tokens[tokens.length - 1]
    if (kind === 'plain' && previous?.kind === 'plain') previous.text += value
    else tokens.push({ kind, text: value })
  }

  const emitHighlight = (kind: Exclude<SyntaxTokenKind, 'plain'>, start: number, end: number) => {
    push('plain', plainStart, start)
    push(kind, start, end)
    highlights += 1
    plainStart = end
  }

  while (cursor < text.length && highlights < MAX_SYNTAX_HIGHLIGHTS) {
    const character = text[cursor]

    if (character === '"') {
      const start = cursor
      cursor += 1
      let closed = false
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor = Math.min(text.length, cursor + 2)
        } else if (text[cursor] === '"') {
          cursor += 1
          closed = true
          break
        } else {
          cursor += 1
        }
      }
      if (!closed) break

      let afterWhitespace = cursor
      while (afterWhitespace < text.length && /\s/.test(text[afterWhitespace])) afterWhitespace += 1
      emitHighlight(text[afterWhitespace] === ':' ? 'key' : 'string', start, cursor)
      push('plain', plainStart, afterWhitespace)
      plainStart = afterWhitespace
      cursor = afterWhitespace
      continue
    }

    const keyword = character === 't' && text.startsWith('true', cursor) ? 'true'
      : character === 'f' && text.startsWith('false', cursor) ? 'false'
        : character === 'n' && text.startsWith('null', cursor) ? 'null'
          : undefined
    if (keyword && !isWord(text[cursor - 1]) && !isWord(text[cursor + keyword.length])) {
      emitHighlight('keyword', cursor, cursor + keyword.length)
      cursor += keyword.length
      continue
    }

    const numberStart = character === '-' && /[0-9]/.test(text[cursor + 1] ?? '') ? cursor + 1 : cursor
    if (/[0-9]/.test(text[numberStart] ?? '') && (numberStart !== cursor || !isWord(text[cursor - 1]))) {
      let end = numberStart + 1
      while (/[0-9]/.test(text[end] ?? '')) end += 1
      if (text[end] === '.' && /[0-9]/.test(text[end + 1] ?? '')) {
        end += 2
        while (/[0-9]/.test(text[end] ?? '')) end += 1
      }
      if (!isWord(text[end])) {
        emitHighlight('number', cursor, end)
        cursor = end
        continue
      }
    }

    cursor += 1
  }

  push('plain', plainStart, text.length)
  return tokens
}

export function SyntaxText({ text }: { text: string }) {
  return <>{tokenizeSyntax(text).map((token, index) => (
    <span className={token.kind === 'plain' ? undefined : `syntax-${token.kind}`} key={`${index}-${token.text.slice(0, 8)}`}>{token.text}</span>
  ))}</>
}

export function InlineText({ text }: { text: string }) {
  const lines = text.split('\n')
  return <>{lines.map((line, lineIndex) => (
    <Fragment key={`${lineIndex}-${line.slice(0, 12)}`}>
      {line.split(/(`[^`]+`)/g).map((fragment, index) => fragment.startsWith('`') && fragment.endsWith('`')
        ? <code key={index}>{fragment.slice(1, -1)}</code>
        : <Fragment key={index}>{fragment}</Fragment>)}
      {lineIndex < lines.length - 1 ? <br /> : null}
    </Fragment>
  ))}</>
}
