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
 * OMP session JSONL v3 layout under `~/.omp/agent/sessions/<bucket>/`:
 * - Line 1 is a fixed-width 256-byte title slot (`{"type":"title",...,"pad":"..."}`)
 *   that OMP REWRITES IN PLACE, keeping the byte length constant.
 * - Line 2 is the `{"type":"session","version":3,...}` header; everything after
 *   it is append-only entries with `id`/`parentId` forming a branch tree.
 * - File names are `<ISO timestamp with dashes>_<uuid>.jsonl`; ordering derives
 *   from the name prefix, not UUIDv7 bits.
 */
export const OMP_TITLE_SLOT_BYTES = 256

const MAX_OMP_BUCKET_DIRECTORIES = 4_096

export function ompSessionRoot(): string {
  return join(homedir(), '.omp', 'agent', 'sessions')
}

const OMP_SESSION_FILE_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[0-9a-f][0-9a-f-]*\.jsonl$/i

/** Creation time encoded in an OMP session file name (`2026-08-08T02-12-49-414Z_<uuid>.jsonl`), bucket prefix allowed. */
export function ompTimestampFromSessionName(name: string): number | undefined {
  const file = name.slice(name.lastIndexOf('/') + 1)
  const match = OMP_SESSION_FILE_NAME.exec(file)
  if (!match) return undefined
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Catalog IO that recurses exactly one bucket-directory level under the OMP
 * session root. Discovered entries carry bucket-relative names so the shared
 * catalog joins, stats, canonicalizes, caches, and bounds them exactly like
 * flat Prime entries.
 */
export function createOmpCatalogIo(): SessionCatalogIo {
  return {
    async readDirectory(root: string): Promise<readonly SessionCatalogEntry[]> {
      const buckets = (await readdir(root, { withFileTypes: true }))
        .filter((bucket) => bucket.isDirectory() && !bucket.name.startsWith('.'))
        .slice(0, MAX_OMP_BUCKET_DIRECTORIES)
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

/** OMP session paths sit exactly one bucket directory below the root and end in `.jsonl`. */
export function isOmpSessionPath(sessionRootRealPath: string, sessionRealPath: string): boolean {
  if (!isPathWithin(sessionRootRealPath, sessionRealPath) || !sessionRealPath.endsWith('.jsonl')) return false
  const segments = relative(sessionRootRealPath, sessionRealPath).split(sep)
  return segments.length === 2 && segments.every((segment) => segment.length > 0)
}

interface OmpMetadataAccumulator {
  id: string
  projectPath: string
  createdAt: string
  updatedAt: string
  sawRecordTimestamp: boolean
  lastUserMessageAt?: string
  model?: string
  provider?: string
  thinkingLevel?: string
  title?: string
  firstUser: string
  preview: string
  lastRole?: string
  stopReason?: string
  records: number
}

function idFromOmpFileName(filePath: string): string {
  const base = basename(filePath, '.jsonl')
  const separator = base.indexOf('_')
  return separator >= 0 ? base.slice(separator + 1) : base
}

function createOmpAccumulator(filePath: string, fileStat: Stats): OmpMetadataAccumulator {
  const nameTimestamp = ompTimestampFromSessionName(basename(filePath))
  return {
    id: idFromOmpFileName(filePath),
    projectPath: '',
    createdAt: nameTimestamp !== undefined ? new Date(nameTimestamp).toISOString() : fileStat.birthtime.toISOString(),
    updatedAt: fileStat.mtime.toISOString(),
    sawRecordTimestamp: false,
    firstUser: '',
    preview: '',
    records: 0,
  }
}

function ingestOmpMetadataLine(state: OmpMetadataAccumulator, line: string): void {
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
  } else if (value.type === 'model_change' && typeof value.model === 'string') {
    // OMP records `model` as a single `provider/id` string; a `role` other
    // than the default selects a task-specific model, not the session model.
    if (value.role === undefined || value.role === 'default') {
      const separator = value.model.indexOf('/')
      state.provider = separator > 0 ? value.model.slice(0, separator) : undefined
      state.model = separator > 0 ? value.model.slice(separator + 1) : value.model
    }
  } else if (value.type === 'thinking_level_change' && typeof value.thinkingLevel === 'string') state.thinkingLevel = value.thinkingLevel
  else if ((value.type === 'title_change' || value.type === 'title') && typeof value.title === 'string') state.title = value.title
  else if (value.type === 'message') ingestMessageActivity(state, value)
}

function ompMetadataFromAccumulator(state: OmpMetadataAccumulator, filePath: string, fallbackUpdated: string): SessionMetadata {
  return {
    id: state.id,
    filePath,
    projectPath: state.projectPath,
    title: compactText(state.title ?? '', 100) || compactText(state.firstUser, 100) || 'Untitled session',
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

const ompMetadataParser: MetadataLineParser<OmpMetadataAccumulator> = {
  createAccumulator: createOmpAccumulator,
  ingestLine: ingestOmpMetadataLine,
  snapshot: ompMetadataFromAccumulator,
}

async function readOmpTitleSlot(io: SessionMetadataReaderIo, filePath: string): Promise<string | undefined> {
  const stream = io.openStream(filePath, 0, OMP_TITLE_SLOT_BYTES - 1)
  const chunks: Buffer[] = []
  try {
    for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk as Buffer)
  } finally {
    stream.destroy()
  }
  const slot = Buffer.concat(chunks)
  const newline = slot.indexOf(0x0a)
  if (newline < 0) return undefined
  let value: unknown
  try { value = JSON.parse(slot.toString('utf8', 0, newline)) } catch { return undefined }
  if (!isRecord(value) || value.type !== 'title' || typeof value.title !== 'string' || !value.title.trim()) return undefined
  return value.title
}

/**
 * OMP metadata reader: the append-only tail (everything after the 256-byte
 * title slot) reuses the shared incremental machinery, while the slot itself
 * is re-read on every snapshot because OMP rewrites it in place without
 * changing the file size of the parsed range.
 */
export function createOmpSessionMetadataReader(io: SessionMetadataReaderIo = nodeMetadataReaderIo): SessionMetadataReader {
  const readTail = createIncrementalMetadataReader(ompMetadataParser, io, OMP_TITLE_SLOT_BYTES)
  return async (filePath, knownStat) => {
    const [metadata, title] = await Promise.all([readTail(filePath, knownStat), readOmpTitleSlot(io, filePath)])
    if (title !== undefined) metadata.title = compactText(title, 100)
    return metadata
  }
}

/**
 * OMP transcript reader over the shared branch machinery: `branch_summary`
 * records are renderable (and can anchor the active leaf) in addition to the
 * shared `message`, `compaction`, and displayed `custom_message` types.
 */
export const readOmpTranscript: TranscriptFileReader = createTranscriptReader({
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
 * Fully wired SessionService options for an OMP session root. Construct the
 * service with a null CLI path: OMP has no `prime-agent list` live overlay.
 */
export function ompSessionServiceOptions(sessionRoot = ompSessionRoot()): SessionServiceOptions {
  return {
    sessionRoot,
    catalogIo: createOmpCatalogIo(),
    catalogNameTimestamp: ompTimestampFromSessionName,
    metadataReader: createOmpSessionMetadataReader(),
    transcriptReader: readOmpTranscript,
    isSessionPathAuthorized: isOmpSessionPath,
  }
}
