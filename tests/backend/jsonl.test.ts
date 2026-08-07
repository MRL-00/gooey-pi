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

  it('accounts each encoded input byte exactly once across chunk boundaries', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((line) => lines.push(line), 5)
    const record = Buffer.from('€xy') // 5 encoded bytes, 3 characters
    decoder.push(record.subarray(0, 1))
    decoder.push(record.subarray(1, 2))
    decoder.push(record.subarray(2))
    decoder.push('\n')
    decoder.end()
    expect(lines).toEqual(['€xy'])
  })

  it('rejects a record whose encoded bytes exceed the limit even when decoded characters are few', () => {
    const decoder = new StrictJsonlDecoder(() => undefined, 5)
    expect(() => decoder.push(Buffer.from('€€'))).toThrow(/maximum frame size/)
  })

  it('assembles highly fragmented records without repeatedly copying the buffered prefix', () => {
    const lines: string[] = []
    const decoder = new StrictJsonlDecoder((line) => lines.push(line), 100_000)
    for (let index = 0; index < 50_000; index += 1) decoder.push('x')
    decoder.push('\n')
    decoder.end()
    expect(lines).toEqual(['x'.repeat(50_000)])
  })
})
