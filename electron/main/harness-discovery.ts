import { HARNESS_IDS, type AppSettings, type HarnessId, type HarnessStatus } from '../../src/types/api'
import { HARNESSES, type HarnessDescriptor } from './harness'
import { findHarnessExecutable, runProcess } from './process-utils'
import type { JsonStateStore } from './store'

type RuntimePaths = Record<HarnessId, string>
interface HarnessProbe { runnable: boolean; version: string | null }
type ExecutableFinder = (descriptor: HarnessDescriptor, configuredPath?: string, accept?: (candidate: string) => Promise<boolean>) => Promise<string | null>
type ExecutableProbe = (executable: string) => Promise<HarnessProbe>

export interface HarnessDiscoveryOptions {
  findExecutable?: ExecutableFinder
  probeExecutable?: ExecutableProbe
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

const emptyStatuses = (): Record<HarnessId, HarnessStatus> => ({
  omp: { path: null, version: null },
  prime: { path: null, version: null },
  pi: { path: null, version: null },
})

export async function probeHarnessExecutable(executable: string): Promise<HarnessProbe> {
  try {
    const result = await runProcess(executable, ['--version'], { timeoutMs: 10_000, maxBytes: 16 * 1024 })
    if (result.code !== 0 || result.timedOut || result.outputExceeded) return { runnable: false, version: null }
    const token = result.stdout.trim().split(/\s+/).at(-1) ?? ''
    const version = token && token.length <= 128 && !hasControlCharacter(token) ? token : null
    return { runnable: true, version }
  } catch { return { runnable: false, version: null } }
}

export function detectedHarnesses(statuses: Record<HarnessId, HarnessStatus>): HarnessId[] {
  return HARNESS_IDS.filter((harness) => Boolean(statuses[harness].path))
}

/** Serializes active-harness reconciliation with every other persisted setting mutation. */
export function reconcileActiveHarness(
  store: Pick<JsonStateStore, 'update'>,
  statuses: Record<HarnessId, HarnessStatus>,
): Promise<AppSettings> {
  const detected = detectedHarnesses(statuses)
  return store.update((state) => {
    if (detected.length && !detected.includes(state.settings.activeHarness)) {
      state.settings.activeHarness = detected[0]
    }
    return structuredClone(state.settings)
  })
}

/**
 * Owns the atomically published executable snapshot used by future process
 * launches. Overlapping refreshes may probe concurrently, but only the newest
 * request is allowed to replace the live snapshot.
 */
export class HarnessDiscoveryService {
  private statuses = emptyStatuses()
  private refreshRevision = 0
  private readonly findExecutable: ExecutableFinder
  private readonly probeExecutable: ExecutableProbe

  constructor(
    private readonly runtimePaths: () => RuntimePaths,
    options: HarnessDiscoveryOptions = {},
  ) {
    this.findExecutable = options.findExecutable ?? findHarnessExecutable
    this.probeExecutable = options.probeExecutable ?? probeHarnessExecutable
  }

  executable(harness: HarnessId): string | null {
    return this.statuses[harness].path
  }

  snapshot(): Record<HarnessId, HarnessStatus> {
    return structuredClone(this.statuses)
  }

  async refresh(): Promise<Record<HarnessId, HarnessStatus>> {
    const revision = ++this.refreshRevision
    const runtimePaths = this.runtimePaths()
    const discovered = await Promise.all(HARNESS_IDS.map(async (harness): Promise<HarnessStatus> => {
      const probes = new Map<string, HarnessProbe>()
      const probe = async (candidate: string) => {
        const result = await this.probeExecutable(candidate)
        probes.set(candidate, result)
        return result.runnable
      }
      const path = await this.findExecutable(HARNESSES[harness], runtimePaths[harness], probe)
      if (!path) return { path: null, version: null }
      const result = probes.get(path) ?? await this.probeExecutable(path)
      return result.runnable ? { path, version: result.version } : { path: null, version: null }
    }))
    const next = emptyStatuses()
    for (const [index, harness] of HARNESS_IDS.entries()) {
      next[harness] = discovered[index]
    }
    if (revision === this.refreshRevision) this.statuses = next
    return this.snapshot()
  }
}
