import { PanelRightClose } from 'lucide-react'
import type { GitStatus, InspectorTab, ProjectRecord, RuntimeInfo, TranscriptMessage } from '@/types/api'
import { BrowserPanel } from './inspector/BrowserPanel'
import { ChangesPanel } from './inspector/ChangesPanel'
import { FilesPanel } from './inspector/FilesPanel'
import { SummaryPanel } from './inspector/SummaryPanel'
import { IconButton, useFocusTrap } from './ui'

interface InspectorProps {
  activeTab: InspectorTab
  onTabChange(tab: InspectorTab): void
  onClose(): void
  project?: ProjectRecord
  cwd?: string
  runtime?: RuntimeInfo | null
  messages: TranscriptMessage[]
  git: GitStatus
  browserHome: string
  onRefreshGit(): Promise<void> | void
  onOpenExternal(url: string): void
  onRevealPath(path: string): void
  overlay?: boolean
}

const tabs: Array<{ id: InspectorTab; label: string }> = [{ id: 'summary', label: 'Summary' }, { id: 'changes', label: 'Changes' }, { id: 'browser', label: 'Browser' }, { id: 'files', label: 'Files' }]

export function Inspector({ activeTab, onTabChange, onClose, project, cwd, runtime, messages, git, browserHome, onRefreshGit, onOpenExternal, onRevealPath, overlay = false }: InspectorProps) {
  const inspectorRef = useFocusTrap<HTMLElement>(overlay, onClose)
  const moveTab = (current: number, key: string) => {
    let next = current
    if (key === 'ArrowRight') next = (current + 1) % tabs.length
    else if (key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length
    else if (key === 'Home') next = 0
    else if (key === 'End') next = tabs.length - 1
    else return
    const tab = tabs[next]
    onTabChange(tab.id)
    requestAnimationFrame(() => document.getElementById(`inspector-tab-${tab.id}`)?.focus())
  }
  return <aside ref={inspectorRef} className="inspector" aria-label="Session inspector" tabIndex={overlay ? -1 : undefined}>
    <div className="inspector__tabs" role="tablist" aria-label="Inspector views">
      {tabs.map((tab, index) => <button id={`inspector-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls={`inspector-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} className={activeTab === tab.id ? 'is-active' : ''} key={tab.id} onKeyDown={(event) => { if (['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) { event.preventDefault(); moveTab(index, event.key) } }} onClick={() => onTabChange(tab.id)}>{tab.label}{tab.id === 'changes' && git.files.length ? <span>{git.files.length}</span> : null}</button>)}
      <span className="inspector__tab-spacer"/>
      <IconButton label="Close inspector" onClick={onClose}><PanelRightClose size={15}/></IconButton>
    </div>
    <div id={`inspector-panel-${activeTab}`} className="inspector__body" role="tabpanel" aria-labelledby={`inspector-tab-${activeTab}`} tabIndex={0}>
      {activeTab === 'summary' ? <SummaryPanel project={project} runtime={runtime} messages={messages} git={git}/> : null}
      {activeTab === 'changes' ? <ChangesPanel key={cwd ?? 'no-workspace'} cwd={cwd} git={git} onRefreshGit={onRefreshGit}/> : null}
      {activeTab === 'browser' ? <BrowserPanel home={browserHome} onOpenExternal={onOpenExternal}/> : null}
      {activeTab === 'files' ? <FilesPanel project={project} git={git} onReveal={onRevealPath}/> : null}
    </div>
  </aside>
}
