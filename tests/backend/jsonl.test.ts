import { describe, expect, it } from 'vitest'
import { StrictJsonlDecoder } from '../../electron/main/jsonl'

describe('StrictJsonlDecoder', () => {
  it('frames only on LF across UTF-8 chunks', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((line) => lines.push(line))
    const input = Buffer.from('{"text":"a\u2028b"}\n{"ok":true}\r\n')
    decoder.push(input.subarray(0, 8))
    decoder.push(input.subarray(8, 17))
    decoder.push(input.subarray(17))
    decoder.end()
    expect(lines).toEqual(['{"text":"a\u2028b"}', '{"ok":true}'])
  })

  it('rejects oversized records', () => {
    const decoder = new StrictJsonlDecoder(() => undefined, 8)
    expect(() => decoder.push('123456789')).toThrow(/maximum frame size/)
  })
})
