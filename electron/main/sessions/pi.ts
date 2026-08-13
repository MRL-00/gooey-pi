import type { Stats } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { mapLimit } from '../lib/async'
import { isPathWithin, isRecord } from '../validation'
import type { SessionServiceOptions } from '../sessions'
import type { SessionCatalogEntry, SessionCatalogIo } from './catalog'
import {
  createIncrementalMetadataReader,
  ingestMessageActivity,
  MAX_METADATA_RECORDS,
  nodeMetadataReaderIo,
  statusFrom,
  type MetadataLineParser,
  type SessionMetadata,
  type SessionMetadataReader,
  type SessionMetadataReaderIo,
} from './metadata'
import {
  boundedString,
  compactText,
  createTranscriptReader,
  MAX_PART_TEXT_CHARS,
  textFromContent,
  validTimestamp,
  type TranscriptFileReader,
} from './transcript'

/**
 * Pi session JSONL v3 layout under `~/.pi/agent/sessions/<bucket>/`:
 * - Line 1 is the `{"type":"session","version":3,...}` header (no OMP-style
 *   title slot); everything after it is append-only entries with `id`/`parentId`
 *   forming a branch tree. The project path comes from the header `cwd` —
 *   decoding the bucket directory name is lossy for paths containing dashes.
 * - The display name rides `session_info` entries (`name`); the latest one in
 *   file order wins. There is no `title_change` entry and no in-place rewrite.
 * - File names are `<ISO timestamp with dashes>_<uuid>.jsonl`; ordering derives
 *   from the name prefix, not UUIDv7 bits.
 */
const MAX_PI_BUCKET_DIRECTORIES = 4_096

export function piSessionRoot(): string {
  return join(homedir(), '.pi', 'agent', 'sessions')
}

const PI_SESSION_FILE_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[0-9a-f][0-9a-f-]*\.jsonl$/i

/** Creation time encoded in a pi session file name (`2026-08-10T22-41-20-246Z_<uuid>.jsonl`), bucket prefix allowed. */
export function piTimestampFromSessionName(name: string): number | undefined {
  const file = name.slice(name.lastIndexOf('/') + 1)
  const match = PI_SESSION_FILE_NAME.exec(file)
  if (!match) return undefined
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Catalog IO that recurses exactly one bucket-directory level under the pi
 * session root. Discovered entries carry bucket-relative names so the shared
 * catalog joins, stats, canonicalizes, caches, and bounds them exactly like
 * flat Prime entries.
 */
export function createPiCatalogIo(): SessionCatalogIo {
  return {
    async readDirectory(root: string): Promise<readonly SessionCatalogEntry[]> {
      const buckets = (await readdir(root, { withFileTypes: true }))
        .filter((bucket) => bucket.isDirectory() && !bucket.name.startsWith('.'))
        .slice(0, MAX_PI_BUCKET_DIRECTORIES)
      const perBucket = await mapLimit(buckets, 8, async (bucket): Promise<SessionCatalogEntry[] | null> => {
        try {
          return (await readdir(join(root, bucket.name), { withFileTypes: true }))
            .filter((file) => file.name.endsWith('.jsonl') && !file.name.startsWith('.'))
            .map((file) => ({
              name: `${bucket.name}/${file.name}`,
              isFile: () => file.isFile(),
              isSymbolicLink: () => file.isSymbolicLink(),
            }))
        } catch { return null }
      })
      return perBucket.flat()
    },
    canonicalize: realpath,
    inspect: stat,
  }
}

/** Pi session paths sit exactly one bucket directory below the root and end in `.jsonl`. */
export function isPiSessionPath(sessionRootRealPath: string, sessionRealPath: string): boolean {
  if (!isPathWithin(sessionRootRealPath, sessionRealPath) || !sessionRealPath.endsWith('.jsonl')) return false
  const segments = relative(sessionRootRealPath, sessionRealPath).split(sep)
  return segments.length === 2 && segments.every((segment) => segment.length > 0)
}

interface PiMetadataAccumulator {
  id: string
  projectPath: string
  createdAt: string
  updatedAt: string
  sawRecordTimestamp: boolean
  lastUserMessageAt?: string
  model?: string
  provider?: string
  thinkingLevel?: string
  sessionName?: string
  firstUser: string
  preview: string
  lastRole?: string
  stopReason?: string
  records: number
}

function idFromPiFileName(filePath: string): string {
  const base = basename(filePath, '.jsonl')
  const separator = base.indexOf('_')
  return separator >= 0 ? base.slice(separator + 1) : base
}

function createPiAccumulator(filePath: string, fileStat: Stats): PiMetadataAccumulator {
  const nameTimestamp = piTimestampFromSessionName(basename(filePath))
  return {
    id: idFromPiFileName(filePath),
    projectPath: '',
    createdAt: nameTimestamp !== undefined ? new Date(nameTimestamp).toISOString() : fileStat.birthtime.toISOString(),
    updatedAt: fileStat.mtime.toISOString(),
    sawRecordTimestamp: false,
    firstUser: '',
    preview: '',
    records: 0,
  }
}

function ingestPiMetadataLine(state: PiMetadataAccumulator, line: string): void {
  if (!line) return
  if (++state.records > MAX_METADATA_RECORDS) throw new Error('Session file has too many records')
  let value: unknown
  try { value = JSON.parse(line) } catch { return }
  if (!isRecord(value)) return
  const recordTimestamp = validTimestamp(value.timestamp, '')
  if (recordTimestamp) {
    state.updatedAt = recordTimestamp
    state.sawRecordTimestamp = true
  }
  if (value.type === 'session') {
    if (typeof value.id === 'string') state.id = value.id
    if (typeof value.cwd === 'string') state.projectPath = value.cwd
    state.createdAt = validTimestamp(value.timestamp, state.createdAt)
  } else if (value.type === 'model_change') {
    // Pi records split `provider` + `modelId` fields (Prime's shape), unlike
    // OMP's single `provider/id` string.
    if (typeof value.modelId === 'string') state.model = value.modelId
    if (typeof value.provider === 'string') state.provider = value.provider
  } else if (value.type === 'thinking_level_change' && typeof value.thinkingLevel === 'string') state.thinkingLevel = value.thinkingLevel
  else if (value.type === 'session_info' && typeof value.name === 'string') state.sessionName = value.name
  else if (value.type === 'message') ingestMessageActivity(state, value)
}

function piMetadataFromAccumulator(state: PiMetadataAccumulator, filePath: string, fallbackUpdated: string): SessionMetadata {
  return {
    id: state.id,
    filePath,
    projectPath: state.projectPath,
    // The latest session_info name wins; an empty name falls back to the prompt.
    title: compactText(state.sessionName ?? '', 100) || compactText(state.firstUser, 100) || 'Untitled session',
    createdAt: state.createdAt,
    updatedAt: state.sawRecordTimestamp ? state.updatedAt : fallbackUpdated,
    lastUserMessageAt: state.lastUserMessageAt ?? state.createdAt,
    status: statusFrom(undefined, undefined, state.lastRole, state.stopReason),
    model: state.model,
    provider: state.provider,
    thinkingLevel: state.thinkingLevel,
    depth: 0,
    pinned: false,
    unread: false,
    preview: compactText(state.preview || state.firstUser),
  }
}

const piMetadataParser: MetadataLineParser<PiMetadataAccumulator> = {
  createAccumulator: createPiAccumulator,
  ingestLine: ingestPiMetadataLine,
  snapshot: piMetadataFromAccumulator,
}

/**
 * Pi metadata reader: the file is append-only from byte zero (no mutable title
 * slot), so the shared incremental machinery covers the whole file.
 */
export function createPiSessionMetadataReader(io: SessionMetadataReaderIo = nodeMetadataReaderIo): SessionMetadataReader {
  return createIncrementalMetadataReader(piMetadataParser, io)
}

/**
 * Pi transcript reader over the shared branch machinery: `branch_summary`
 * records are renderable (and can anchor the active leaf) in addition to the
 * shared `message`, `compaction`, and displayed `custom_message` types.
 */
export const readPiTranscript: TranscriptFileReader = createTranscriptReader({
  isRenderable: (entry) => entry.type === 'message' || entry.type === 'compaction' || entry.type === 'branch_summary'
    || (entry.type === 'custom_message' && entry.display === true),
  renderEntry: (entry, safeId) => {
    if (entry.type !== 'branch_summary') return undefined
    const timestamp = typeof entry.timestamp === 'string' ? boundedString(entry.timestamp, 128) : undefined
    const text = typeof entry.summary === 'string' ? entry.summary : textFromContent(entry.content, MAX_PART_TEXT_CHARS)
    return {
      id: safeId,
      role: 'system',
      timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
      parts: [{ type: 'text', text: boundedString(text, MAX_PART_TEXT_CHARS) }],
    }
  },
})

/**
 * Fully wired SessionService options for a pi session root. Construct the
 * service with a null CLI path: pi has no `prime-agent list` live overlay.
 */
export function piSessionServiceOptions(sessionRoot = piSessionRoot()): SessionServiceOptions {
  return {
    harness: 'pi',
    sessionRoot,
    catalogIo: createPiCatalogIo(),
    catalogNameTimestamp: piTimestampFromSessionName,
    metadataReader: createPiSessionMetadataReader(),
    transcriptReader: readPiTranscript,
    isSessionPathAuthorized: isPiSessionPath,
    // Session files sit one bucket directory below the root; bounded one-level
    // watchers keep catalog refresh behavior identical across platforms.
    recursiveWatch: true,
  }
}
