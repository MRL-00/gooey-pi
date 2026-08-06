import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { StrictJsonlDecoder } from '../jsonl'
import { errorMessage } from '../validation'

/** Owns JSONL frame decoding and serialized, byte-bounded writes for one RPC child. */
export class FramedRpcTransport {
  private readonly decoder: StrictJsonlDecoder
  private frameFailed = false
  private writeQueue: Promise<void> = Promise.resolve()
  private queuedWriteBytes = 0

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    onLine: (line: string) => void,
    onFatalFrameError: (error: unknown) => void,
    private readonly isAvailable: () => boolean,
  ) {
    this.decoder = new StrictJsonlDecoder(onLine, 16 * 1024 * 1024)
    this.child.stdout.on('data', (chunk: Buffer) => {
      try { this.decoder.push(chunk) } catch (error) {
        this.frameFailed = true
        onFatalFrameError(error)
      }
    })
    this.child.stdout.on('end', () => {
      if (this.frameFailed) return
      try { this.decoder.end() } catch (error) { onFatalFrameError(error) }
    })
    this.child.stderr.on('data', () => { /* stderr can contain secrets; never forward it to the renderer */ })
  }

  writable(): boolean { return this.isAvailable() && this.child.stdin.writable }

  enqueue(line: string): Promise<void> {
    if (!this.writable()) return Promise.reject(new Error('Runtime is not available'))
    const bytes = Buffer.byteLength(line)
    if (bytes > 2 * 1024 * 1024) return Promise.reject(new Error('RPC write exceeded the per-message byte limit'))
    if (this.queuedWriteBytes + bytes > 32 * 1024 * 1024) return Promise.reject(new Error('RPC write queue byte budget exceeded'))
    this.queuedWriteBytes += bytes
    const operation = this.writeQueue.catch(() => undefined).then(() => new Promise<void>((resolveWrite, rejectWrite) => {
      if (!this.writable()) { rejectWrite(new Error('Runtime is not available')); return }
      let settled = false
      const finish = (error?: Error | null) => {
        if (settled) return
        settled = true
        if (error) rejectWrite(error)
        else resolveWrite()
      }
      try { this.child.stdin.write(line, finish) } catch (error) { finish(error instanceof Error ? error : new Error(errorMessage(error))) }
    }))
    const tracked = operation.finally(() => { this.queuedWriteBytes = Math.max(0, this.queuedWriteBytes - bytes) })
    this.writeQueue = tracked.catch(() => undefined)
    return tracked
  }

  endInput(): void { this.child.stdin.end() }
  destroyInput(): void { this.child.stdin.destroy() }
  pauseOutput(): void { this.child.stdout.pause() }
}
