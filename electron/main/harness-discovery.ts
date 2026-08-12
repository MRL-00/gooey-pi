import { HARNESS_IDS, type HarnessId, type HarnessStatus } from '../../src/types/api'
import { HARNESSES, type HarnessDescriptor } from './harness'
import { findHarnessExecutable, runProcess } from './process-utils'

type RuntimePaths = Record<HarnessId, string>
type ExecutableFinder = (descriptor: HarnessDescriptor, configuredPath?: string) => Promise<string | null>
type VersionReader = (executable: string | null) => Promise<string | null>

export interface HarnessDiscoveryOptions {
  findExecutable?: ExecutableFinder
  readVersion?: VersionReader
}

const emptyStatuses = (): Record<HarnessId, HarnessStatus> => ({
  omp: { path: null, version: null },
  prime: { path: null, version: null },
  pi: { path: null, version: null },
})

export async function readHarnessVersion(executable: string | null): Promise<string | null> {
  if (!executable) return null
  try {
    const result = await runProcess(executable, ['--version'], { timeoutMs: 10_000, maxBytes: 64 * 1024 })
    return result.code === 0 ? result.stdout.trim().split(/\s+/).at(-1) ?? null : null
  } catch { return null }
}

export function detectedHarnesses(statuses: Record<HarnessId, HarnessStatus>): HarnessId[] {
  return HARNESS_IDS.filter((harness) => Boolean(statuses[harness].path))
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
  private readonly readVersion: VersionReader

  constructor(
    private readonly runtimePaths: () => RuntimePaths,
    options: HarnessDiscoveryOptions = {},
  ) {
    this.findExecutable = options.findExecutable ?? findHarnessExecutable
    this.readVersion = options.readVersion ?? readHarnessVersion
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
    const paths = await Promise.all(HARNESS_IDS.map((harness) =>
      this.findExecutable(HARNESSES[harness], runtimePaths[harness])))
    const versions = await Promise.all(paths.map((path) => this.readVersion(path)))
    const next = emptyStatuses()
    for (const [index, harness] of HARNESS_IDS.entries()) {
      next[harness] = { path: paths[index], version: versions[index] }
    }
    if (revision === this.refreshRevision) this.statuses = next
    return this.snapshot()
  }
}
