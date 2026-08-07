import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { SESSION_FILE_RECORD_LIMIT_BYTES } from './jsonl-limits'

const MAX_UNFRAMED_BYTES = SESSION_FILE_RECORD_LIMIT_BYTES

class FragmentedLineBuffer {
  private fragments: string[] = []
  private bytes = 0

  constructor(private readonly maxUnframedBytes: number, private readonly recordName: string) {}

  append(fragment: string): void {
    if (!fragment) return
    const bytes = Buffer.byteLength(fragment, 'utf8')
    if (this.bytes + bytes > this.maxUnframedBytes) this.tooLarge()
    this.fragments.push(fragment)
    this.bytes += bytes
  }

  takeLine(fragment: string): string {
    const fragmentBytes = Buffer.byteLength(fragment, 'utf8')
    const totalBytes = this.bytes + fragmentBytes
    // A CR immediately before LF is framing, so it does not count toward the record limit.
    if (totalBytes > this.maxUnframedBytes + 1) this.tooLarge()
    if (fragment) this.fragments.push(fragment)
    const line = this.fragments.join('')
    this.fragments = []
    this.bytes = 0
    const framed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (totalBytes - Number(line.endsWith('\r')) > this.maxUnframedBytes) this.tooLarge()
    return framed
  }

  finish(): string | undefined {
    if (!this.fragments.length) return undefined
    const line = this.fragments.join('')
    this.fragments = []
    this.bytes = 0
    return line.endsWith('\r') ? line.slice(0, -1) : line
  }

  private tooLarge(): never { throw new Error(`${this.recordName} record exceeded the maximum frame size`) }
}

function* decodedLines(text: string, buffer: FragmentedLineBuffer): Generator<string> {
  let start = 0
  while (true) {
    const index = text.indexOf('\n', start)
    if (index < 0) break
    yield buffer.takeLine(text.slice(start, index))
    start = index + 1
  }
  buffer.append(text.slice(start))
}

/** Strict JSONL parser: only LF is a delimiter; U+2028/U+2029 stay inside JSON strings. */
export async function* strictJsonLines(stream: Readable, maxUnframedBytes = MAX_UNFRAMED_BYTES): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  const buffer = new FragmentedLineBuffer(maxUnframedBytes, 'JSONL')
  for await (const raw of stream) {
    const decoded = typeof raw === 'string' ? raw : decoder.write(raw as Buffer)
    for (const line of decodedLines(decoded, buffer)) yield line
  }
  buffer.append(decoder.end())
  const finalLine = buffer.finish()
  if (finalLine !== undefined) yield finalLine
}

export class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private readonly buffer: FragmentedLineBuffer

  constructor(private readonly onLine: (line: string) => void, maxUnframedBytes = MAX_UNFRAMED_BYTES) {
    this.buffer = new FragmentedLineBuffer(maxUnframedBytes, 'RPC')
  }

  push(chunk: Buffer | string): void {
    const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    for (const line of decodedLines(decoded, this.buffer)) if (line) this.onLine(line)
  }

  end(): void {
    this.buffer.append(this.decoder.end())
    const finalLine = this.buffer.finish()
    if (finalLine !== undefined) this.onLine(finalLine)
  }
}
