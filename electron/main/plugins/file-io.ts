import { open } from 'node:fs/promises'
import { isRecord } from '../validation'

export function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : ''
}

export async function readAtMost(path: string, max: number): Promise<{ content: string; truncated: boolean }> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(max + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return { content: buffer.subarray(0, Math.min(offset, max)).toString('utf8'), truncated: offset > max }
  } finally {
    await file.close()
  }
}
