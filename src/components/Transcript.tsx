import { useMemo } from 'react'
import { ChevronRight, FileCode2, LoaderCircle } from 'lucide-react'
import type { GitStatus, TranscriptMessage } from '@/types/api'
import { MarkdownText } from './MarkdownText'
import { PrimeMark } from './ui'
import { ActivityMessage, AgentMessage, AssistantMessage, GoalMessage, UserMessage } from './transcript/messages'
import { useTranscriptScroll } from './transcript/scroll'
import { ThinkingDots, WorkDisclosure } from './transcript/timeline'

export { classifyTool, formatWorkedDuration } from './transcript/timeline'
export { tokenizeSyntax } from './transcript/syntax'

interface TranscriptProps {
  messages: TranscriptMessage[]
  git: GitStatus
  loading?: boolean
  active?: boolean
  showReasoning?: boolean
  showTools?: boolean
  onOpenChanges(): void
  onSuggestion(prompt: string): void
  suggestionsDisabled?: boolean
}

const EMPTY_GIT: GitStatus = { isRepo: false, files: [] }

function ActiveAssistantMessage({ message, showReasoning, showTools }: { message: TranscriptMessage; showReasoning: boolean; showTools: boolean }) {
  const visibleActivity = message.parts.some((part) => part.type === 'thinking' && showReasoning || (part.type === 'toolCall' || part.type === 'toolResult') && showTools || part.type === 'agentMessage')
  return (
    <article className="message message--assistant">
      <div className="assistant-mark"><PrimeMark size={24} /></div>
      <div className="message__content">
        {visibleActivity
          ? <WorkDisclosure message={message} parts={message.parts} showReasoning={showReasoning} showTools={showTools} running />
          : <>
            {message.parts.map((part, index) => part.type === 'text' ? <MarkdownText key={index} text={part.text} /> : null)}
            <div className="streaming-state" aria-live="polite"><ThinkingDots /> Prime is working</div>
          </>}
      </div>
    </article>
  )
}

function ChangesCard({ git, onOpenChanges }: { git: GitStatus; onOpenChanges(): void }) {
  const additions = git.files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = git.files.reduce((sum, file) => sum + file.deletions, 0)
  return <button type="button" className="changes-card" onClick={onOpenChanges}>
    <span className="changes-card__icon"><FileCode2 size={16} /></span>
    <span className="changes-card__text"><strong>{git.files.length} {git.files.length === 1 ? 'file' : 'files'} changed</strong><small>Review changes in the inspector</small></span>
    <span className="diff-count diff-count--add">+{additions}</span><span className="diff-count diff-count--remove">−{deletions}</span><ChevronRight size={14} />
  </button>
}

export function Transcript({ messages, git, loading, active = false, showReasoning = true, showTools = true, onOpenChanges, onSuggestion, suggestionsDisabled }: TranscriptProps) {
  const { announcement, hiddenCount, scrollRef, showEarlier, updatePinnedState, visibleMessages } = useTranscriptScroll(messages)
  const activeAssistantId = useMemo(() => active && messages.at(-1)?.role === 'assistant' ? messages.at(-1)?.id : undefined, [active, messages])

  return <>
    <div ref={scrollRef} className={`transcript scroll-area ${git.files.length ? 'has-pinned-changes' : ''}`} aria-busy={loading} onScroll={updatePinnedState}>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      <div className="transcript__inner">
        {loading ? <div className="transcript-loading"><LoaderCircle className="spin" size={16} /> Loading session…</div> : null}
        {!loading && messages.length === 0 ? <div className="session-welcome">
          <PrimeMark size={34} />
          <h1>What should we work on?</h1>
          <p>Prime can inspect this project, edit files, run tools, and keep working across sessions.</p>
          <div className="prompt-suggestions">
            <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Summarize this project')}>Summarize this project</button>
            <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Find a useful next task')}>Find a useful next task</button>
            <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Run the test suite')}>Run the test suite</button>
          </div>
        </div> : null}
        {hiddenCount > 0 ? <button type="button" className="transcript__show-earlier" onClick={showEarlier}>Show {Math.min(250, hiddenCount)} earlier messages</button> : null}
        {visibleMessages.map((message) => message.role === 'user' ? <UserMessage key={message.id} message={message} />
          : message.role === 'assistant' ? message.streaming || message.id === activeAssistantId
            ? <ActiveAssistantMessage key={message.id} message={message} showReasoning={showReasoning} showTools={showTools} />
            : <AssistantMessage key={message.id} message={message} git={EMPTY_GIT} isLast={false} showReasoning={showReasoning} showTools={showTools} onOpenChanges={onOpenChanges} />
          : message.role === 'agent' ? <AgentMessage key={message.id} message={message} />
          : message.role === 'goal' ? <GoalMessage key={message.id} message={message} />
          : message.role === 'tool' || message.role === 'system' ? <ActivityMessage key={message.id} message={message} />
          : <div className={`message message--${message.role}`} key={message.id}>{message.parts.map((part, partIndex) => part.type === 'text' ? <span key={partIndex}>{part.text}</span> : null)}</div>)}
        {active && !activeAssistantId ? <article className="message message--assistant transcript-active-placeholder" aria-live="polite">
          <div className="assistant-mark"><PrimeMark size={24} /></div><div className="streaming-state"><ThinkingDots /> Prime is working</div>
        </article> : null}
        <div />
      </div>
    </div>
    {git.files.length ? <div className="transcript-changes-pin"><ChangesCard git={git} onOpenChanges={onOpenChanges} /></div> : null}
  </>
}
