import { Code2, FileJson2, FileText, Folder, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitStatus, ProjectFileEntry, ProjectRecord } from '@/types/api'
import { basename } from '@/lib/data'
import { EmptyState, IconButton } from '../ui'

export function FilesPanel({ project, git, onReveal }: { project?: ProjectRecord; git: GitStatus; onReveal(path: string): void }) {
  type BrowserEntry = ProjectFileEntry & { root: string; displayPath: string; key: string }
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<BrowserEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [skipped, setSkipped] = useState(0)
  const [visibleLimit, setVisibleLimit] = useState(1_000)
  const loadToken = useRef(0)

  const load = async () => {
    const token = ++loadToken.current
    setEntries([]); setError(''); setSkipped(0); setVisibleLimit(1_000)
    if (!project || !window.prime) return
    setLoading(true)
    try {
      const roots = project.folders.length ? project.folders : [project.primaryFolder]
      const groups = await Promise.all(roots.map(async (root) => ({ root, listing: await window.prime.projects.listFiles(root) })))
      if (loadToken.current !== token) return
      const multipleRoots = roots.length > 1
      setSkipped(groups.reduce((sum, group) => sum + group.listing.skipped, 0))
      setEntries(groups.flatMap(({ root, listing }) => listing.entries.map((entry) => ({
        ...entry,
        root,
        displayPath: multipleRoots ? `${basename(root)}/${entry.path}` : entry.path,
        key: `${root}\0${entry.path}`,
      }))))
    } catch (reason) {
      if (loadToken.current === token) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (loadToken.current === token) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    return () => { loadToken.current += 1 }
  }, [project?.id, project?.folders.join('\0')])

  const changed = useMemo(() => new Map(git.files.map((file) => [file.path, file.status])), [git.files])
  const normalizedQuery = query.trim().toLowerCase()
  const files = useMemo(() => entries.filter((entry) => !normalizedQuery || entry.displayPath.toLowerCase().includes(normalizedQuery)), [entries, normalizedQuery])
  const visibleFiles = files.slice(0, visibleLimit)
  if (!project) return <EmptyState icon={<Folder size={24} />} title="No project files">Choose a local project to inspect files.</EmptyState>
  return <div className="files-panel"><div className="files-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter project paths" /><IconButton size="small" label="Refresh project files" onClick={() => void load()}><RefreshCw className={loading ? 'spin' : ''} size={13}/></IconButton></div><div className="file-tree scroll-area"><button type="button" className="tree-root" onClick={() => onReveal(project.primaryFolder)}><Folder size={14} /><strong>{project.folders.length > 1 ? `${project.folders.length} project folders` : basename(project.primaryFolder)}</strong></button>{loading ? <p>Loading project files…</p> : null}{error ? <p>Unable to list project files: {error}</p> : null}{!loading && !error && skipped > 0 ? <p className="file-tree__skipped">{skipped} {skipped === 1 ? 'folder' : 'folders'} could not be read and {skipped === 1 ? 'was' : 'were'} skipped.</p> : null}{!loading && !error ? visibleFiles.map((entry) => {
    const status = entry.root === project.primaryFolder ? changed.get(entry.path) : undefined
    return <button type="button" key={entry.key} title={entry.displayPath} onClick={() => onReveal(`${entry.root}/${entry.path}`)}>{entry.type === 'directory' ? <Folder size={13} /> : entry.path.endsWith('.json') ? <FileJson2 size={13} /> : /\.(tsx?|jsx?)$/.test(entry.path) ? <Code2 size={13} /> : <FileText size={13} />}<span>{entry.displayPath}</span>{status ? <small>{status}</small> : null}</button>
  }) : null}{!loading && !error && files.length > visibleFiles.length ? <button type="button" className="file-tree__show-more" onClick={() => setVisibleLimit((limit) => Math.min(files.length, limit + 1_000))}>Show {Math.min(1_000, files.length - visibleFiles.length)} more paths</button> : null}{!loading && !error && files.length === 0 ? <p>{normalizedQuery ? `No files match “${query}”.` : 'No project files found.'}</p> : null}</div></div>
}
