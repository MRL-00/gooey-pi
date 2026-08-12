import { describe, expect, it, vi } from 'vitest'
import { HarnessDiscoveryService, detectedHarnesses } from '../../electron/main/harness-discovery'
import type { HarnessDescriptor } from '../../electron/main/harness'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('HarnessDiscoveryService', () => {
  it('publishes one atomic status snapshot using the current runtime overrides', async () => {
    const runtimePaths = { omp: '/configured/omp', prime: '', pi: '' }
    const findExecutable = vi.fn(async (descriptor: HarnessDescriptor, configured?: string) =>
      descriptor.id === 'omp' ? configured ?? null : descriptor.id === 'pi' ? '/usr/bin/pi' : null)
    const readVersion = vi.fn(async (path: string | null) => path ? `${path}-version` : null)
    const discovery = new HarnessDiscoveryService(() => runtimePaths, { findExecutable, readVersion })

    const statuses = await discovery.refresh()

    expect(statuses).toEqual({
      omp: { path: '/configured/omp', version: '/configured/omp-version' },
      prime: { path: null, version: null },
      pi: { path: '/usr/bin/pi', version: '/usr/bin/pi-version' },
    })
    expect(discovery.executable('omp')).toBe('/configured/omp')
    expect(detectedHarnesses(statuses)).toEqual(['omp', 'pi'])
    expect(findExecutable).toHaveBeenCalledWith(expect.objectContaining({ id: 'omp' }), '/configured/omp')
  })

  it('prevents an older overlapping refresh from replacing newer results', async () => {
    const firstOmp = deferred<string | null>()
    let generation = 0
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '', prime: '', pi: '' }),
      {
        findExecutable: async (descriptor) => {
          if (descriptor.id !== 'omp') return null
          generation += 1
          return generation === 1 ? firstOmp.promise : '/new/omp'
        },
        readVersion: async () => null,
      },
    )

    const stale = discovery.refresh()
    const current = await discovery.refresh()
    firstOmp.resolve('/old/omp')

    expect(current.omp.path).toBe('/new/omp')
    await expect(stale).resolves.toMatchObject({ omp: { path: '/new/omp' } })
    expect(discovery.executable('omp')).toBe('/new/omp')
  })
})
