import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runTranscriptRead } from '../../src/app/transcript-load'

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

describe('shared transcript read lifecycle', () => {
  it.each(['initial', 'reconciliation'])('runs success and finally through the shared path for %s loads', async () => {
    const read = deferred<string[]>()
    const values: string[][] = []
    const errors: unknown[] = []
    const finalized = vi.fn()
    const lifecycle = runTranscriptRead({
      read: () => read.promise,
      isCurrent: () => true,
      onValue: (value) => values.push(value),
      onError: (error) => errors.push(error),
      onFinally: finalized,
    })

    read.resolve(['authoritative'])
    await lifecycle
    expect(values).toEqual([['authoritative']])
    expect(errors).toEqual([])
    expect(finalized).toHaveBeenCalledOnce()
  })

  it('replays the error path only while current and always runs finalization', async () => {
    const error = new Error('read failed')
    const onError = vi.fn()
    const onFinally = vi.fn()
    await runTranscriptRead({
      read: () => Promise.reject(error),
      isCurrent: () => true,
      onValue: vi.fn(),
      onError,
      onFinally,
    })
    expect(onError).toHaveBeenCalledWith(error)
    expect(onFinally).toHaveBeenCalledOnce()
  })

  it('ignores a stale completion but still permits deferred-load finalization', async () => {
    const onValue = vi.fn()
    const onError = vi.fn()
    const onFinally = vi.fn()
    await runTranscriptRead({
      read: () => Promise.resolve(['stale']),
      isCurrent: () => false,
      onValue,
      onError,
      onFinally,
    })
    expect(onValue).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(onFinally).toHaveBeenCalledOnce()
  })

  it('keeps the hook on one sessions.read lifecycle implementation', () => {
    const source = readFileSync('src/hooks/useWorkspaceRuntime.ts', 'utf8')
    expect(source.match(/sessions\.read\(/g)).toHaveLength(1)
    expect(source).toContain('runTranscriptRead({')
  })
})
