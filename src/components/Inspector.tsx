import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  ExternalLink,
  File,
  FileCode2,
  FileJson2,
  FileText,
  Folder,
  GitBranch,
  Globe2,
  History,
  Home,
  ListChecks,
  LoaderCircle,
  MessageCirclePlus,
  MousePointer2,
  PanelRightClose,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Undo2,
  X,
} from 'lucide-react'
import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { GitStatus, InspectorTab, ProjectRecord, RuntimeInfo, TranscriptMessage } from '@/types/api'
import { basename } from '@/lib/data'
import { EmptyState, IconButton, Modal, Segmented } from './ui'

type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>
  getURL(): string
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  stop(): void
  executeJavaScript(code: string): Promise<unknown>
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

function SummaryPanel({ project, runtime, messages, git }: { project?: ProjectRecord; runtime?: RuntimeInfo | null; messages: TranscriptMessage[]; git: GitStatus }) {
  const toolCount = messages.reduce((sum, message) => sum + message.parts.filter((part) => part.type === 'toolCall').length, 0)
  const lastText = [...messages].reverse().flatMap((message) => [...message.parts].reverse()).find((part) => part.type === 'text')
  return (
    <div className="inspector-scroll scroll-area summary-panel">
      <section className="summary-hero">
        <span className={`run-state ${runtime?.isStreaming ? 'is-running' : ''}`}>{runtime?.isStreaming ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}{runtime?.isStreaming ? 'Prime is working' : 'Ready'}</span>
        <h2>{runtime?.isStreaming ? 'Working through the request' : 'Session overview'}</h2>
        <p>{lastText?.type === 'text' ? lastText.text.slice(0, 220) : 'Start a conversation to see a compact summary of the work here.'}</p>
      </section>
      <section className="summary-section"><h3>Workspace</h3><dl className="detail-list"><div><dt>Project</dt><dd>{project?.name ?? 'No project'}</dd></div><div><dt>Branch</dt><dd><GitBranch size={12} />{git.branch ?? project?.gitBranch ?? '—'}</dd></div><div><dt>Environment</dt><dd>Local</dd></div><div><dt>Working directory</dt><dd title={project?.primaryFolder} className="mono truncate">{project?.primaryFolder ?? '—'}</dd></div></dl></section>
      <section className="summary-section"><h3>Progress</h3><div className="progress-list"><div><Check size={13} /><span>Loaded project context</span></div><div><Check size={13} /><span>{toolCount} tool {toolCount === 1 ? 'call' : 'calls'} recorded</span></div><div className={git.files.length ? 'is-current' : ''}><CircleDot size={13} /><span>{git.files.length ? `${git.files.length} files ready to review` : 'No uncommitted changes'}</span></div></div></section>
      <section className="summary-section"><h3>Context</h3><div className="context-meter"><div><span>Session context</span><span>18%</span></div><progress max="100" value="18" /><small>Plenty of room remains in this session.</small></div></section>
    </div>
  )
}

function DiffView({ text }: { text: string }) {
  if (!text) return <div className="diff-placeholder"><FileCode2 size={22} /><span>Select a changed file to inspect its diff.</span></div>
  return <pre className="diff-view">{text.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-line diff-line--add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-line diff-line--remove' : line.startsWith('@@') ? 'diff-line diff-line--hunk' : 'diff-line'}><i>{index + 1}</i><button type="button" aria-label={`Comment on line ${index + 1}`}><Plus size={10} /></button><code>{line || ' '}</code></span>)}</pre>
}

function ChangesPanel({ project, git, onRefreshGit, onGitChange }: { project?: ProjectRecord; git: GitStatus; onRefreshGit(): Promise<void> | void; onGitChange?(git: GitStatus): void }) {
  const [scope, setScope] = useState<'unstaged' | 'staged'>('unstaged')
  const [selectedPath, setSelectedPath] = useState<string | undefined>(git.files[0]?.path)
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null)
  const cwd = project?.primaryFolder
  const visibleFiles = git.files.filter((file) => scope === 'staged' ? file.staged : !file.staged)

  useEffect(() => {
    if (selectedPath && !git.files.some((file) => file.path === selectedPath)) setSelectedPath(git.files[0]?.path)
  }, [git.files, selectedPath])

  useEffect(() => {
    if (!cwd || !selectedPath || !window.prime) { setDiff(selectedPath ? `diff --git a/${selectedPath} b/${selectedPath}
--- a/${selectedPath}
+++ b/${selectedPath}
@@ -18,3 +18,6 @@
 const workspace = createWorkspace()
+workspace.open()
+workspace.focus()
 return workspace` : ''); return }
    let cancelled = false
    setLoading(true)
    window.prime.git.diff(cwd, selectedPath, scope === 'staged').then((value) => { if (!cancelled) setDiff(value.text) }).catch(() => { if (!cancelled) setDiff('Unable to load this diff.') }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [cwd, selectedPath, scope])

  const mutate = async (kind: 'stage' | 'unstage' | 'restore', paths: string[]) => {
    if (!cwd || !window.prime) return
    if (kind === 'stage') await window.prime.git.stage(cwd, paths)
    if (kind === 'unstage') await window.prime.git.unstage(cwd, paths)
    if (kind === 'restore') await window.prime.git.restore(cwd, paths)
    await onRefreshGit()
  }

  const commit = async () => {
    if (!cwd || !commitMessage.trim() || !window.prime) return
    await window.prime.git.commit(cwd, commitMessage.trim())
    setCommitOpen(false); setCommitMessage(''); await onRefreshGit()
  }

  if (!git.isRepo) return <EmptyState icon={<GitBranch size={24} />} title="No Git repository">Open a project backed by Git to review, stage, and commit changes.</EmptyState>
  return (
    <div className="changes-panel">
      <div className="changes-toolbar">
        <div><strong><GitBranch size={13} /> {git.branch ?? 'Repository'}</strong>{git.ahead ? <small>{git.ahead} ahead</small> : null}</div>
        <IconButton label="Refresh changes" onClick={() => void onRefreshGit()}><RefreshCw size={14} /></IconButton>
      </div>
      <div className="changes-scopes"><Segmented value={scope} label="Diff scope" options={[{ value: 'unstaged', label: 'Unstaged' }, { value: 'staged', label: 'Staged' }]} onChange={(value) => setScope(value as 'unstaged' | 'staged') } /><button type="button" className="button button--compact" disabled={!git.files.some((file) => file.staged)} onClick={() => setCommitOpen(true)}>Commit</button></div>
      <div className="changes-body">
        <div className="file-changes scroll-area">
          <div className="file-changes__header"><span>{visibleFiles.length} changed {visibleFiles.length === 1 ? 'file' : 'files'}</span>{visibleFiles.length ? <button type="button" onClick={() => void mutate(scope === 'staged' ? 'unstage' : 'stage', visibleFiles.map((file) => file.path))}>{scope === 'staged' ? 'Unstage all' : 'Stage all'}</button> : null}</div>
          {visibleFiles.map((file) => <button type="button" key={file.path} className={selectedPath === file.path ? 'is-selected' : ''} onClick={() => setSelectedPath(file.path)}><File size={13} /><span title={file.path}>{file.path}</span><small className="additions">+{file.additions}</small><small className="deletions">−{file.deletions}</small><span className="file-status">{file.status}</span></button>)}
          {visibleFiles.length === 0 ? <p className="file-changes__empty">No {scope} changes.</p> : null}
        </div>
        <div className="diff-pane scroll-area">
          {selectedPath ? <div className="diff-header"><div><FileCode2 size={13} /><span>{selectedPath}</span></div><div>{scope === 'unstaged' ? <button type="button" onClick={() => void mutate('stage', [selectedPath])}><ArrowDownToLine size={12} /> Stage</button> : <button type="button" onClick={() => void mutate('unstage', [selectedPath])}><Undo2 size={12} /> Unstage</button>}<button type="button" className="danger-action" onClick={() => setConfirmRestore(selectedPath)}><RotateCcw size={12} /> Revert</button></div></div> : null}
          {loading ? <div className="diff-loading"><LoaderCircle className="spin" size={15} /> Loading diff…</div> : <DiffView text={diff} />}
        </div>
      </div>
      {commitOpen ? <Modal title="Commit staged changes" onClose={() => setCommitOpen(false)} footer={<><button className="button" type="button" onClick={() => setCommitOpen(false)}>Cancel</button><button className="button button--primary" type="button" disabled={!commitMessage.trim()} onClick={() => void commit()}>Commit changes</button></>}><label className="field"><span>Commit message</span><input autoFocus value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe this change" /></label><p className="muted-copy">This will commit all staged files on <code>{git.branch}</code>.</p></Modal> : null}
      {confirmRestore ? <Modal title="Revert file changes?" onClose={() => setConfirmRestore(null)} footer={<><button className="button" type="button" onClick={() => setConfirmRestore(null)}>Cancel</button><button className="button button--danger" type="button" onClick={() => { void mutate('restore', [confirmRestore]); setConfirmRestore(null) }}>Revert file</button></>}><p>Uncommitted changes to <code>{confirmRestore}</code> will be permanently discarded.</p></Modal> : null}
    </div>
  )
}

function normalizeUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return 'about:blank'
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('about:')) return trimmed
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(trimmed)) return `http://${trimmed}`
  if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

function BrowserPanel({ home, onOpenExternal }: { home: string; onOpenExternal(url: string): void }) {
  const webviewRef = useRef<WebviewElement | null>(null)
  const [address, setAddress] = useState(home)
  const [currentUrl, setCurrentUrl] = useState(home)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [annotation, setAnnotation] = useState(false)
  const [annotationText, setAnnotationText] = useState('')
  const [annotations, setAnnotations] = useState<Array<{ id: number; text: string }>>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<string[]>(() => [home])

  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    const sync = () => {
      try { const url = view.getURL() || home; setCurrentUrl(url); setAddress(url); setCanBack(view.canGoBack()); setCanForward(view.canGoForward()); setHistory((items) => items.at(-1) === url ? items : [...items.slice(-19), url]) } catch { /* webview not ready */ }
    }
    const didStart = () => setLoading(true)
    const didStop = () => { setLoading(false); sync() }
    view.addEventListener('did-start-loading', didStart)
    view.addEventListener('did-stop-loading', didStop)
    view.addEventListener('did-navigate', sync)
    view.addEventListener('did-navigate-in-page', sync)
    return () => { view.removeEventListener('did-start-loading', didStart); view.removeEventListener('did-stop-loading', didStop); view.removeEventListener('did-navigate', sync); view.removeEventListener('did-navigate-in-page', sync) }
  }, [home])

  const navigate = (value: string) => {
    const url = normalizeUrl(value)
    setAddress(url); setCurrentUrl(url)
    void webviewRef.current?.loadURL(url).catch((error: unknown) => {
      if (!String(error).includes('ERR_ABORTED')) console.error('Browser navigation failed', error)
    })
  }

  const saveAnnotation = () => {
    if (!annotationText.trim()) return
    setAnnotations((items) => [...items, { id: items.length + 1, text: annotationText.trim() }]); setAnnotationText(''); setAnnotation(false)
  }

  const webview = createElement('webview' as never, {
    ref: (node: WebviewElement | null) => { webviewRef.current = node },
    src: home,
    className: 'browser-webview',
    partition: 'persist:prime-work-browser',
    webpreferences: 'contextIsolation=yes,sandbox=yes,nodeIntegration=no',
  })

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <IconButton label="Back" disabled={!canBack} onClick={() => webviewRef.current?.goBack()}><ArrowLeft size={14} /></IconButton><IconButton label="Forward" disabled={!canForward} onClick={() => webviewRef.current?.goForward()}><ArrowRight size={14} /></IconButton><IconButton label={loading ? 'Stop loading' : 'Reload'} onClick={() => loading ? webviewRef.current?.stop() : webviewRef.current?.reload()}>{loading ? <X size={14} /> : <RefreshCw size={14} />}</IconButton>
        <form className="address-field" onSubmit={(event) => { event.preventDefault(); navigate(address) }}><ShieldCheck size={12} /><input value={address} onChange={(event) => setAddress(event.target.value)} aria-label="Browser address" spellCheck={false} /><button type="button" aria-label="Browser history" onClick={() => setHistoryOpen((value) => !value)}><History size={13} /></button></form>
        <IconButton className={annotation ? 'is-active annotation-active' : ''} label="Annotate page" onClick={() => setAnnotation((value) => !value)}><MessageCirclePlus size={15} /></IconButton><IconButton label="Open in default browser" onClick={() => onOpenExternal(currentUrl)}><ExternalLink size={14} /></IconButton>
      </div>
      {historyOpen ? <div className="browser-history"><div><strong>Recent pages</strong><button type="button" onClick={() => setHistory([])}>Clear</button></div>{history.slice().reverse().map((url, index) => <button type="button" key={`${url}-${index}`} onClick={() => { navigate(url); setHistoryOpen(false) }}><History size={12} /><span>{url}</span></button>)}</div> : null}
      <div className={`browser-viewport ${annotation ? 'is-annotating' : ''}`}>
        {webview}
        {annotation ? <div className="annotation-layer"><div className="annotation-target"><span>{annotations.length + 1}</span></div><div className="annotation-popover"><div><MessageCirclePlus size={14} /><strong>Page comment</strong><button type="button" onClick={() => setAnnotation(false)}><X size={13} /></button></div><textarea autoFocus value={annotationText} onChange={(event) => setAnnotationText(event.target.value)} placeholder="Describe what should change…"/><div><button type="button" className="button" onClick={() => setAnnotation(false)}>Cancel</button><button type="button" className="button button--primary" disabled={!annotationText.trim()} onClick={saveAnnotation}>Add comment</button></div></div></div> : null}
        {annotations.length ? <div className="annotation-count"><MessageCirclePlus size={12} /> {annotations.length} comment{annotations.length === 1 ? '' : 's'}</div> : null}
      </div>
    </div>
  )
}

function FilesPanel({ project, git, onReveal }: { project?: ProjectRecord; git: GitStatus; onReveal(path: string): void }) {
  const [query, setQuery] = useState('')
  const files = useMemo(() => git.files.filter((file) => file.path.toLowerCase().includes(query.toLowerCase())), [git.files, query])
  if (!project) return <EmptyState icon={<Folder size={24} />} title="No project files">Choose a local project to inspect files.</EmptyState>
  return <div className="files-panel"><div className="files-search"><Search size={13} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter files" /></div><div className="file-tree scroll-area"><div className="tree-root"><ChevronDown size={13} /><Folder size={14} /><strong>{basename(project.primaryFolder)}</strong></div>{project.folders.slice(1).map((folder) => <button type="button" key={folder} onClick={() => onReveal(folder)}><ChevronRight size={12} /><Folder size={13} /><span>{basename(folder)}</span></button>)}<div className="tree-section">Changed files</div>{files.map((file) => <button type="button" key={file.path} onClick={() => onReveal(`${project.primaryFolder}/${file.path}`)}>{file.path.endsWith('.json') ? <FileJson2 size={13} /> : /\.(tsx?|jsx?)$/.test(file.path) ? <Code2 size={13} /> : <FileText size={13} />}<span>{file.path}</span><small>{file.status}</small></button>)}{files.length === 0 ? <p>No files match “{query}”.</p> : null}</div></div>
}

interface InspectorProps {
  activeTab: InspectorTab
  onTabChange(tab: InspectorTab): void
  onClose(): void
  project?: ProjectRecord
  runtime?: RuntimeInfo | null
  messages: TranscriptMessage[]
  git: GitStatus
  browserHome: string
  onRefreshGit(): Promise<void> | void
  onOpenExternal(url: string): void
  onRevealPath(path: string): void
}

const tabs: Array<{ id: InspectorTab; label: string }> = [{ id: 'summary', label: 'Summary' }, { id: 'changes', label: 'Changes' }, { id: 'browser', label: 'Browser' }, { id: 'files', label: 'Files' }]

export function Inspector({ activeTab, onTabChange, onClose, project, runtime, messages, git, browserHome, onRefreshGit, onOpenExternal, onRevealPath }: InspectorProps) {
  return <aside className="inspector" aria-label="Session inspector"><div className="inspector__tabs" role="tablist">{tabs.map((tab) => <button type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? 'is-active' : ''} key={tab.id} onClick={() => onTabChange(tab.id)}>{tab.label}{tab.id === 'changes' && git.files.length ? <span>{git.files.length}</span> : null}</button>)}<span className="inspector__tab-spacer"/><IconButton label="New browser tab" onClick={() => onTabChange('browser')}><Plus size={14}/></IconButton><IconButton label="Close inspector" onClick={onClose}><PanelRightClose size={15}/></IconButton></div><div className="inspector__body" role="tabpanel">{activeTab === 'summary' ? <SummaryPanel project={project} runtime={runtime} messages={messages} git={git}/> : null}{activeTab === 'changes' ? <ChangesPanel project={project} git={git} onRefreshGit={onRefreshGit}/> : null}{activeTab === 'browser' ? <BrowserPanel home={browserHome} onOpenExternal={onOpenExternal}/> : null}{activeTab === 'files' ? <FilesPanel project={project} git={git} onReveal={onRevealPath}/> : null}</div></aside>
}
