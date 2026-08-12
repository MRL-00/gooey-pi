import { describe, expect, it, vi } from 'vitest'
import { HarnessDiscoveryService, detectedHarnesses, reconcileActiveHarness } from '../../electron/main/harness-discovery'
import { defaultSettings, type DesktopState } from '../../electron/main/store'
import type { HarnessDescriptor } from '../../electron/main/harness'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('HarnessDiscoveryService', () => {
  it('reconciles against the settings state inside the serialized transaction', async () => {
    const state = { settings: defaultSettings() } as DesktopState
    state.settings.activeHarness = 'prime'
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let queue = Promise.resolve()
    const store = {
      update<T>(mutator: (draft: DesktopState) => T): Promise<T> {
        const operation = queue.then(async () => {
          if (state.settings.activeHarness === 'prime') await firstGate
          return mutator(state)
        })
        queue = operation.then(() => undefined, () => undefined)
        return operation
      },
    }
    const userSelection = store.update((draft) => { draft.settings.activeHarness = 'omp' })
    const reconciliation = reconcileActiveHarness(store, {
      omp: { path: '/bin/omp', version: '1' },
      prime: { path: '/bin/prime-agent', version: '1' },
      pi: { path: null, version: null },
    })
    releaseFirst()

    await userSelection
    await expect(reconciliation).resolves.toMatchObject({ activeHarness: 'omp' })
    expect(state.settings.activeHarness).toBe('omp')
  })

  it('publishes one atomic status snapshot using the current runtime overrides', async () => {
    const runtimePaths = { omp: '/configured/omp', prime: '', pi: '' }
    const findExecutable = vi.fn(async (descriptor: HarnessDescriptor, configured?: string, accept?: (candidate: string) => Promise<boolean>) => {
      const candidate = descriptor.id === 'omp' ? configured ?? null : descriptor.id === 'pi' ? '/usr/bin/pi' : null
      return candidate && await accept?.(candidate) ? candidate : null
    })
    const probeExecutable = vi.fn(async (path: string) => ({ runnable: true, version: `${path}-version` }))
    const discovery = new HarnessDiscoveryService(() => runtimePaths, { findExecutable, probeExecutable })

    const statuses = await discovery.refresh()

    expect(statuses).toEqual({
      omp: { path: '/configured/omp', version: '/configured/omp-version' },
      prime: { path: null, version: null },
      pi: { path: '/usr/bin/pi', version: '/usr/bin/pi-version' },
    })
    expect(discovery.executable('omp')).toBe('/configured/omp')
    expect(detectedHarnesses(statuses)).toEqual(['omp', 'pi'])
    expect(findExecutable).toHaveBeenCalledWith(expect.objectContaining({ id: 'omp' }), '/configured/omp', expect.any(Function))
  })

  it('excludes existing but non-runnable candidates and continues discovery', async () => {
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '/broken/omp', prime: '', pi: '' }),
      {
        findExecutable: async (descriptor, _configured, accept) => {
          if (descriptor.id !== 'omp' || !accept) return null
          for (const candidate of ['/broken/omp', '/working/omp']) if (await accept(candidate)) return candidate
          return null
        },
        probeExecutable: async (path) => path.includes('working')
          ? { runnable: true, version: '2.0.0' }
          : { runnable: false, version: null },
      },
    )

    await expect(discovery.refresh()).resolves.toMatchObject({
      omp: { path: '/working/omp', version: '2.0.0' },
    })
  })

  it('prevents an older overlapping refresh from replacing newer results', async () => {
    const firstOmp = deferred<string | null>()
    let generation = 0
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '', prime: '', pi: '' }),
      {
        findExecutable: async (descriptor, _configured, accept) => {
          if (descriptor.id !== 'omp') return null
          generation += 1
          const candidate = generation === 1 ? await firstOmp.promise : '/new/omp'
          return candidate && await accept?.(candidate) ? candidate : null
        },
        probeExecutable: async () => ({ runnable: true, version: null }),
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
