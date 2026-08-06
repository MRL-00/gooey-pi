import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

const MAX_UNFRAMED_BYTES = 64 * 1024 * 1024

/** Strict JSONL parser: only LF is a delimiter; U+2028/U+2029 stay inside JSON strings. */
export async function* strictJsonLines(stream: Readable, maxUnframedBytes = MAX_UNFRAMED_BYTES): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  for await (const raw of stream) {
    buffer += typeof raw === 'string' ? raw : decoder.write(raw as Buffer)
    if (Buffer.byteLength(buffer, 'utf8') > maxUnframedBytes && !buffer.includes('\n')) {
      throw new Error('JSONL record exceeded the maximum frame size')
    }
    while (true) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      let line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (Buffer.byteLength(line, 'utf8') > maxUnframedBytes) throw new Error('JSONL record exceeded the maximum frame size')
      yield line
    }
  }
  buffer += decoder.end()
  if (buffer) yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
}

export class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  constructor(private readonly onLine: (line: string) => void, private readonly maxUnframedBytes = MAX_UNFRAMED_BYTES) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxUnframedBytes && !this.buffer.includes('\n')) {
      throw new Error('RPC record exceeded the maximum frame size')
    }
    while (true) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) break
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (Buffer.byteLength(line, 'utf8') > this.maxUnframedBytes) throw new Error('RPC record exceeded the maximum frame size')
      if (line) this.onLine(line)
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxUnframedBytes) throw new Error('RPC record exceeded the maximum frame size')
  }

  end(): void {
    this.buffer += this.decoder.end()
    if (this.buffer) this.onLine(this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer)
    this.buffer = ''
  }
}
