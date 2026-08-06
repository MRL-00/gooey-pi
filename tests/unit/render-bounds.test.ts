import { describe, expect, it } from 'vitest'
import { boundLines, boundText, newestWindow } from '../../src/lib/render-bounds'

describe('renderer content bounds', () => {
  it('starts with the newest bounded message window', () => {
    expect(newestWindow([1, 2, 3, 4], 2)).toEqual([3, 4])
    expect(newestWindow([1, 2], 0)).toEqual([])
  })

  it('caps expanded tool text and marks truncation', () => {
    expect(boundText('abcdef', 3, '[cut]')).toBe('abc[cut]')
    expect(boundText('abc', 3, '[cut]')).toBe('abc')
  })

  it('does not materialize every line from newline-heavy diff input', () => {
    const result = boundLines('\n'.repeat(1_000_000), 2 * 1024 * 1024, 4_000)
    expect(result.lines).toHaveLength(4_000)
    expect(result.truncated).toBe(true)
  })

  it('reports both character and line truncation', () => {
    expect(boundLines('abcdef', 3, 10)).toEqual({ lines: ['abc'], truncated: true })
    expect(boundLines('a\nb\nc', 100, 2)).toEqual({ lines: ['a', 'b'], truncated: true })
    expect(boundLines('a\nb', 100, 3)).toEqual({ lines: ['a', 'b'], truncated: false })
  })
})
