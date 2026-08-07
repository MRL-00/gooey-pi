import { Check, CircleDot, GitBranch, LoaderCircle } from 'lucide-react'
import type { GitStatus, ProjectRecord, RuntimeInfo, TranscriptMessage } from '@/types/api'
import { MarkdownText } from '../MarkdownText'

export function SummaryPanel({ project, runtime, messages, git }: { project?: ProjectRecord; runtime?: RuntimeInfo | null; messages: TranscriptMessage[]; git: GitStatus }) {
  const toolCount = messages.reduce((sum, message) => sum + message.parts.filter((part) => part.type === 'toolCall').length, 0)
  const lastText = [...messages].reverse().flatMap((message) => [...message.parts].reverse()).find((part) => part.type === 'text')
  const active = Boolean(runtime?.isStreaming || runtime?.isCompacting)
  return (
    <div className="inspector-scroll scroll-area summary-panel">
      <section className="summary-hero">
        <span className={`run-state ${active ? 'is-running' : ''}`}>{active ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}{runtime?.isCompacting ? 'Compacting context' : active ? 'Prime is working' : 'Ready'}</span>
        <h2>{runtime?.isCompacting ? 'Compacting the session context' : active ? 'Working through the request' : 'Session overview'}</h2>
        <MarkdownText text={lastText?.type === 'text' ? lastText.text.slice(0, 220) : 'Start a conversation to see a compact summary of the work here.'} />
      </section>
      <section className="summary-section"><h3>Workspace</h3><dl className="detail-list"><div><dt>Project</dt><dd>{project?.name ?? 'No project'}</dd></div><div><dt>Branch</dt><dd><GitBranch size={12} />{git.branch ?? project?.gitBranch ?? '—'}</dd></div><div><dt>Environment</dt><dd>Local</dd></div><div><dt>Working directory</dt><dd title={project?.primaryFolder} className="mono truncate">{project?.primaryFolder ?? '—'}</dd></div></dl></section>
      <section className="summary-section"><h3>Progress</h3><div className="progress-list"><div><Check size={13} /><span>Loaded project context</span></div><div><Check size={13} /><span>{toolCount} tool {toolCount === 1 ? 'call' : 'calls'} recorded</span></div><div className={git.files.length ? 'is-current' : ''}><CircleDot size={13} /><span>{git.files.length ? `${git.files.length} files ready to review` : git.isRepo ? 'No uncommitted changes' : 'Git repository not detected'}</span></div></div></section>
      <section className="summary-section"><h3>Context</h3><div className="context-meter"><div><span>Session context</span><span>Managed</span></div><small>Prime Agent monitors and compacts context when needed.</small></div></section>
    </div>
  )
}
