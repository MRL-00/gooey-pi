import type { Stats } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '../process-utils'
import { isPathWithin, isRecord } from '../validation'
import { applyLiveMetadata, type JsonRecord, type SessionMetadata } from './metadata'

interface SessionFileCandidate { filePath: string; fileStat: Stats; fingerprint: string }

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

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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

async function mapLimit<T, U>(values: readonly T[], limit: number, mapper: (value: T) => Promise<U | null>): Promise<U[]> {
  const result: U[] = []
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index++]
      const mapped = await mapper(current)
      if (mapped !== null) result.push(mapped)
    }
  }))
  return result
}

export class SessionMetadataCatalog {
  private catalogCache: { expiresAt: number; revision: number; sessions: Map<string, JsonRecord> } | null = null
  private catalogRequest: { revision: number; promise: Promise<Map<string, JsonRecord>> } | null = null
  private catalogRevision = 0
  private sessionScanRequest: { revision: number; promise: Promise<SessionMetadata[]> } | null = null
  private readonly metadataCache = new Map<string, SessionMetadata>()
  private readonly metadataRequests = new Map<string, Promise<SessionMetadata>>()

  constructor(
    private readonly sessionRoot: () => string,
    private readonly primeAgentPath: string | null,
    private readonly maxSessionFiles: number,
    private readonly readMetadata: (filePath: string, knownStat?: Stats) => Promise<SessionMetadata>,
    private readonly io: SessionCatalogIo = nodeSessionCatalogIo,
  ) {}

  invalidateLiveCatalog(): void {
    this.catalogRevision += 1
    this.catalogCache = null
  }

  /** Live Prime Agent session records keyed by canonical session file path. */
  liveSessions(): Promise<ReadonlyMap<string, JsonRecord>> {
    return this.liveCatalog()
  }

  async all(): Promise<SessionMetadata[]> {
    const revision = this.catalogRevision
    if (this.sessionScanRequest?.revision === revision) return this.sessionScanRequest.promise
    const request = { revision, promise: this.scan(revision) }
    this.sessionScanRequest = request
    try { return await request.promise } finally {
      if (this.sessionScanRequest === request) this.sessionScanRequest = null
    }
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
        const filePath = await this.io.canonicalize(join(root, name))
        if (!isPathWithin(root, filePath)) return null
        const fileStat = await this.io.inspect(filePath)
        if (!fileStat.isFile()) return null
        return { filePath, fileStat, fingerprint: `${filePath}\0${fileStat.mtimeMs}\0${fileStat.size}` }
      } catch { return null }
    })
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
    const inFlight = this.metadataRequests.get(candidate.fingerprint)
    if (inFlight) return { ...await inFlight }
    const request = this.readMetadata(candidate.filePath, candidate.fileStat)
    this.metadataRequests.set(candidate.fingerprint, request)
    try {
      const metadata = await request
      const current = await this.io.inspect(candidate.filePath)
      if (this.catalogRevision === revision
        && current.mtimeMs === candidate.fileStat.mtimeMs && current.size === candidate.fileStat.size) {
        this.metadataCache.set(candidate.fingerprint, metadata)
      }
      return { ...metadata }
    } finally {
      if (this.metadataRequests.get(candidate.fingerprint) === request) this.metadataRequests.delete(candidate.fingerprint)
    }
  }

  private async liveCatalog(): Promise<Map<string, JsonRecord>> {
    if (!this.primeAgentPath) return new Map()
    const revision = this.catalogRevision
    if (this.catalogCache && this.catalogCache.revision === revision && this.catalogCache.expiresAt > Date.now()) {
      return this.catalogCache.sessions
    }
    if (this.catalogRequest?.revision === revision) return this.catalogRequest.promise
    const request = {
      revision,
      promise: (async () => {
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
        if (this.catalogRevision === revision) {
          this.catalogCache = { expiresAt: Date.now() + 2_000, revision, sessions }
        }
        return sessions
      })(),
    }
    this.catalogRequest = request
    try { return await request.promise } finally {
      if (this.catalogRequest === request) this.catalogRequest = null
    }
  }
}
