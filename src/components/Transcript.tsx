import { useMemo } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { GitStatus, TranscriptMessage } from '@/types/api'
import { PrimeMark } from './ui'
import { AgentMessage, AssistantMessage, GoalMessage, UserMessage } from './transcript/messages'
import { useTranscriptScroll } from './transcript/scroll'

export { classifyTool, formatWorkedDuration } from './transcript/timeline'
export { tokenizeSyntax } from './transcript/syntax'

interface TranscriptProps {
  messages: TranscriptMessage[]
  git: GitStatus
  loading?: boolean
  showReasoning?: boolean
  showTools?: boolean
  onOpenChanges(): void
  onSuggestion(prompt: string): void
  suggestionsDisabled?: boolean
}

export function Transcript({ messages, git, loading, showReasoning = true, showTools = true, onOpenChanges, onSuggestion, suggestionsDisabled }: TranscriptProps) {
  const { announcement, hiddenCount, scrollRef, showEarlier, updatePinnedState, visibleMessages } = useTranscriptScroll(messages)
  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') return messages[index].id
    }
    return undefined
  }, [messages])

  return (
    <div ref={scrollRef} className="transcript scroll-area" aria-busy={loading} onScroll={updatePinnedState}>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      <div className="transcript__inner">
        {loading ? <div className="transcript-loading"><LoaderCircle className="spin" size={16} /> Loading session…</div> : null}
        {!loading && messages.length === 0 ? (
          <div className="session-welcome">
            <PrimeMark size={34} />
            <h1>What should we work on?</h1>
            <p>Prime can inspect this project, edit files, run tools, and keep working across sessions.</p>
            <div className="prompt-suggestions">
              <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Summarize this project')}>Summarize this project</button>
              <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Find a useful next task')}>Find a useful next task</button>
              <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Run the test suite')}>Run the test suite</button>
            </div>
          </div>
        ) : null}
        {hiddenCount > 0 ? <button type="button" className="transcript__show-earlier" onClick={showEarlier}>Show {Math.min(250, hiddenCount)} earlier messages</button> : null}
        {visibleMessages.map((message) => message.role === 'user' ? (
          <UserMessage key={message.id} message={message} />
        ) : message.role === 'assistant' ? (
          <AssistantMessage key={message.id} message={message} git={git} isLast={message.id === lastAssistantId} showReasoning={showReasoning} showTools={showTools} onOpenChanges={onOpenChanges} />
        ) : message.role === 'agent' ? (
          <AgentMessage key={message.id} message={message} />
        ) : message.role === 'goal' ? (
          <GoalMessage key={message.id} message={message} />
        ) : (
          <div className={`message message--${message.role}`} key={message.id}>{message.parts.map((part, partIndex) => part.type === 'text' ? <span key={partIndex}>{part.text}</span> : null)}</div>
        ))}
        <div />
      </div>
    </div>
  )
}
