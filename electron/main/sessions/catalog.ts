import type { Stats } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { comparePaths, createSingleFlight, mapLimit } from '../lib/async'
import { runProcess } from '../process-utils'
import { isPathWithin, isRecord } from '../validation'
import { applyLiveMetadata, type JsonRecord, type SessionMetadata } from './metadata'

interface SessionFileCandidate { filePath: string; fileStat: Stats; fingerprint: string }

const LIVE_CATALOG_TTL_MS = 2_000
const LIVE_CATALOG_MIN_SPAWN_INTERVAL_MS = 2_000

export interface SessionCatalogEntry {
  name: string
  isFile?(): boolean
  isSymbolicLink?(): boolean
}

export interface SessionCatalogIo {
  readDirectory(path: string): Promise<readonly SessionCatalogEntry[]>
  canonicalize(path: string): Promise<string>
  inspect(path: string): Promise<Stats>
}

const nodeSessionCatalogIo: SessionCatalogIo = {
  readDirectory: (path) => readdir(path, { withFileTypes: true }),
  canonicalize: realpath,
  inspect: stat,
}

function timestampFromSessionName(name: string): number | undefined {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i.exec(name)
  if (!match) return undefined
  return Number.parseInt(`${match[1]}${match[2]}`, 16)
}

function compareCandidateNames(left: string, right: string): number {
  const leftTimestamp = timestampFromSessionName(left)
  const rightTimestamp = timestampFromSessionName(right)
  if (leftTimestamp !== undefined && rightTimestamp !== undefined && leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp
  }
  if (leftTimestamp !== undefined && rightTimestamp === undefined) return -1
  if (leftTimestamp === undefined && rightTimestamp !== undefined) return 1
  return comparePaths(right, left)
}

export function boundedSessionDiscoveryNames(names: readonly string[], maxSessionFiles: number): string[] {
  const budget = Math.max(0, Math.ceil(maxSessionFiles))
  return [...names].sort(compareCandidateNames).slice(0, budget)
}

export class SessionMetadataCatalog {
  private catalogCache: { fetchedAt: number; revision: number; sessions: Map<string, JsonRecord> } | null = null
  // The CLI spawn is deduplicated across revisions (one flight at a time), so
  // the single-flight key is constant; the revision is captured per request.
  private readonly catalogRequests = createSingleFlight<0, Map<string, JsonRecord>>()
  private catalogRevision = 0
  private lastCatalogSpawnAt = 0
  private readonly sessionScanRequests = createSingleFlight<number, SessionMetadata[]>()
  private readonly metadataCache = new Map<string, SessionMetadata>()
  private readonly metadataRequests = createSingleFlight<string, SessionMetadata>()
  private readonly canonicalByName = new Map<string, { canonical: string; dev: number; ino: number }>()

  constructor(
    private readonly sessionRoot: () => string,
    private readonly primeAgentPath: string | null,
    private readonly maxSessionFiles: number,
    private readonly readMetadata: (filePath: string, knownStat?: Stats) => Promise<SessionMetadata>,
    private readonly io: SessionCatalogIo = nodeSessionCatalogIo,
  ) {}

  /**
   * Marks the catalog content stale without discarding the last snapshot: the
   * `prime-agent list` spawn stays rate limited independently of change events,
   * so append bursts keep serving the previous snapshot instead of respawning.
   */
  invalidateLiveCatalog(): void {
    this.catalogRevision += 1
  }

  /** Live Prime Agent session records keyed by canonical session file path. */
  liveSessions(): Promise<ReadonlyMap<string, JsonRecord>> {
    return this.liveCatalog()
  }

  async all(): Promise<SessionMetadata[]> {
    const revision = this.catalogRevision
    return this.sessionScanRequests.run(revision, () => this.scan(revision))
  }

  private async scan(revision: number): Promise<SessionMetadata[]> {
    let entries: readonly SessionCatalogEntry[]
    let root: string
    try {
      [entries, root] = await Promise.all([
        this.io.readDirectory(this.sessionRoot()),
        this.io.canonicalize(this.sessionRoot()),
      ])
    } catch { return [] }

    // UUIDv7 names expose creation order without per-entry I/O. Admit a bounded
    // deterministic set before canonicalization and stat; legacy names fall back
    // to reverse lexical order.
    const names = boundedSessionDiscoveryNames(
      entries
        .filter((entry) => (entry.isFile?.() ?? true) || (entry.isSymbolicLink?.() ?? false))
        .map((entry) => entry.name)
        .filter((name) => name.endsWith('.jsonl') && !name.startsWith('.')),
      this.maxSessionFiles,
    )
    const discovered = await mapLimit(names, 32, async (name): Promise<SessionFileCandidate | null> => {
      try {
        // stat() follows symlinks, so an unchanged dev/ino identity lets the
        // cached canonical path stand in for a realpath call per entry.
        const fileStat = await this.io.inspect(join(root, name))
        if (!fileStat.isFile()) {
          this.canonicalByName.delete(name)
          return null
        }
        const known = this.canonicalByName.get(name)
        const filePath = known && known.dev === fileStat.dev && known.ino === fileStat.ino
          ? known.canonical
          : await this.io.canonicalize(join(root, name))
        this.canonicalByName.set(name, { canonical: filePath, dev: fileStat.dev, ino: fileStat.ino })
        if (!isPathWithin(root, filePath)) return null
        return { filePath, fileStat, fingerprint: `${filePath}\0${fileStat.mtimeMs}\0${fileStat.size}` }
      } catch {
        this.canonicalByName.delete(name)
        return null
      }
    })
    if (this.canonicalByName.size > names.length) {
      const listed = new Set(names)
      for (const name of this.canonicalByName.keys()) {
        if (!listed.has(name)) this.canonicalByName.delete(name)
      }
    }
    const byCanonicalPath = new Map<string, SessionFileCandidate>()
    for (const candidate of discovered) byCanonicalPath.set(candidate.filePath, candidate)
    const selected = [...byCanonicalPath.values()]
      .sort((a, b) => b.fileStat.mtimeMs - a.fileStat.mtimeMs || comparePaths(a.filePath, b.filePath))
      .slice(0, this.maxSessionFiles)
    if (this.catalogRevision === revision) {
      const activeFingerprints = new Set(selected.map((candidate) => candidate.fingerprint))
      for (const fingerprint of this.metadataCache.keys()) {
        if (!activeFingerprints.has(fingerprint)) this.metadataCache.delete(fingerprint)
      }
    }

    const catalogPromise = this.liveCatalog()
    const metadata = await mapLimit(selected, 6, async (candidate) => {
      try { return await this.cachedMetadata(candidate, revision) } catch { return null }
    })
    const catalog = await catalogPromise
    return metadata.map((original) => {
      const item = { ...original }
      const live = catalog.get(item.filePath)
      if (live) applyLiveMetadata(item, live)
      return item
    })
  }

  private async cachedMetadata(candidate: SessionFileCandidate, revision: number): Promise<SessionMetadata> {
    const cached = this.metadataCache.get(candidate.fingerprint)
    if (cached) return { ...cached }
    const metadata = await this.metadataRequests.run(candidate.fingerprint, async () => {
      const read = await this.readMetadata(candidate.filePath, candidate.fileStat)
      const current = await this.io.inspect(candidate.filePath)
      if (this.catalogRevision === revision
        && current.mtimeMs === candidate.fileStat.mtimeMs && current.size === candidate.fileStat.size) {
        this.metadataCache.set(candidate.fingerprint, read)
      }
      return read
    })
    return { ...metadata }
  }

  private async liveCatalog(): Promise<Map<string, JsonRecord>> {
    if (!this.primeAgentPath) return new Map()
    const revision = this.catalogRevision
    const cache = this.catalogCache
    const now = Date.now()
    if (cache && cache.revision === revision && now - cache.fetchedAt < LIVE_CATALOG_TTL_MS) return cache.sessions
    const inFlight = this.catalogRequests.get(0)
    if (inFlight) return inFlight
    // Invalidation marks content stale; the CLI spawn is throttled on its own
    // clock so change-event bursts reuse the last snapshot.
    if (cache && now - this.lastCatalogSpawnAt < LIVE_CATALOG_MIN_SPAWN_INTERVAL_MS) return cache.sessions
    this.lastCatalogSpawnAt = now
    return this.catalogRequests.run(0, async () => {
      const sessions = new Map<string, JsonRecord>()
      try {
        const result = await runProcess(this.primeAgentPath!, ['list', '--all', '--json'], { timeoutMs: 15_000, maxBytes: 16 * 1024 * 1024 })
        if (result.code === 0) {
          const parsed: unknown = JSON.parse(result.stdout)
          if (isRecord(parsed) && Array.isArray(parsed.sessions)
            && parsed.sessions.length <= this.maxSessionFiles * 4) {
            await mapLimit(parsed.sessions, 32, async (raw) => {
              if (!isRecord(raw) || typeof raw.sessionFile !== 'string'
                || raw.sessionFile.length > 4_096 || !isAbsolute(raw.sessionFile)) return null
              try {
                sessions.set(await realpath(raw.sessionFile), raw)
                return true
              } catch { return null }
            })
          }
        }
      } catch { /* JSONL remains authoritative when the live catalog is unavailable. */ }
      this.catalogCache = { fetchedAt: Date.now(), revision, sessions }
      return sessions
    })
  }
}
