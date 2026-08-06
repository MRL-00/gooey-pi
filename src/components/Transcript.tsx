import {
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  FileCode2,
  LoaderCircle,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { GitStatus, MessagePart, TranscriptMessage } from '@/types/api'
import { MarkdownText } from './MarkdownText'
import { PrimeMark } from './ui'

function InlineText({ text }: { text: string }) {
  const lines = text.split('\n')
  return <>{lines.map((line, lineIndex) => <Fragment key={`${lineIndex}-${line.slice(0, 12)}`}>{line.split(/(`[^`]+`)/g).map((fragment, index) => fragment.startsWith('`') && fragment.endsWith('`') ? <code key={index}>{fragment.slice(1, -1)}</code> : <Fragment key={index}>{fragment}</Fragment>)}{lineIndex < lines.length - 1 ? <br /> : null}</Fragment>)}</>
}

function ThinkingPart({ part, running }: { part: Extract<MessagePart, { type: 'thinking' }>; running: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="thinking-block">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {running ? <LoaderCircle className="spin" size={13} /> : <BrainCircuit size={13} />}
        <span>{running ? 'Thinking' : 'Reasoning'}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open ? <div className="thinking-block__body"><InlineText text={part.text} /></div> : null}
    </div>
  )
}

function ToolPart({ part, next }: { part: Extract<MessagePart, { type: 'toolCall' }>; next?: MessagePart }) {
  const [open, setOpen] = useState(false)
  const result = next?.type === 'toolResult' ? next : undefined
  const failed = result?.isError
  const args = part.args === undefined ? '' : typeof part.args === 'string' ? part.args : JSON.stringify(part.args, null, 2)
  const isTerminal = /shell|command|bash|terminal/i.test(part.name)
  return (
    <div className={`tool-card ${failed ? 'tool-card--error' : ''}`}>
      <button type="button" className="tool-card__summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`tool-card__status ${result ? failed ? 'is-error' : 'is-done' : 'is-running'}`}>
          {result ? failed ? <CircleAlert size={13} /> : <Check size={13} /> : <LoaderCircle className="spin" size={13} />}
        </span>
        {isTerminal ? <TerminalSquare size={14} /> : <Wrench size={14} />}
        <span className="tool-card__label">{part.name}</span>
        <span className="tool-card__duration">{result ? 'done' : 'running'}</span>
        {(args || result?.text) ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
      </button>
      {open && (args || result?.text) ? <pre className="tool-card__output">{args}{args && result?.text ? '\n\n' : ''}{result?.text}</pre> : null}
    </div>
  )
}

function ChangesCard({ git, onOpenChanges }: { git: GitStatus; onOpenChanges(): void }) {
  const additions = git.files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = git.files.reduce((sum, file) => sum + file.deletions, 0)
  return (
    <button type="button" className="changes-card" onClick={onOpenChanges}>
      <span className="changes-card__icon"><FileCode2 size={16} /></span>
      <span className="changes-card__text"><strong>{git.files.length} {git.files.length === 1 ? 'file' : 'files'} changed</strong><small>Review changes in the inspector</small></span>
      <span className="diff-count diff-count--add">+{additions}</span><span className="diff-count diff-count--remove">−{deletions}</span><ChevronRight size={14} />
    </button>
  )
}

function AssistantMessage({ message, git, isLast, onOpenChanges }: { message: TranscriptMessage; git: GitStatus; isLast: boolean; onOpenChanges(): void }) {
  const visibleToolResultIds = new Set<number>()
  return (
    <article className="message message--assistant">
      <div className="assistant-mark"><PrimeMark size={24} /></div>
      <div className="message__content">
        {message.parts.map((part, index) => {
          if (part.type === 'toolResult' && visibleToolResultIds.has(index)) return null
          if (part.type === 'text') return <MarkdownText key={index} text={part.text} />
          if (part.type === 'thinking') return <ThinkingPart key={index} part={part} running={Boolean(message.streaming)} />
          if (part.type === 'toolCall') {
            const next = message.parts[index + 1]
            if (next?.type === 'toolResult') visibleToolResultIds.add(index + 1)
            return <ToolPart key={part.id ?? index} part={part} next={next} />
          }
          if (part.type === 'toolResult') return <pre key={index} className={`standalone-output ${part.isError ? 'is-error' : ''}`}>{part.text}</pre>
          if (part.type === 'image') return <div key={index} className="image-part">Image attachment</div>
          return null
        })}
        {isLast && git.files.length > 0 && !message.streaming ? <ChangesCard git={git} onOpenChanges={onOpenChanges} /> : null}
        {message.streaming ? <div className="streaming-state" aria-live="polite"><span className="streaming-cursor" /> Prime is working</div> : null}
        {!message.streaming ? <div className="message-actions"><button type="button" onClick={() => navigator.clipboard?.writeText(message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n'))}><Copy size={12} /> Copy</button><span><Clock3 size={11} /> completed</span></div> : null}
      </div>
    </article>
  )
}

interface TranscriptProps {
  messages: TranscriptMessage[]
  git: GitStatus
  loading?: boolean
  onOpenChanges(): void
  onSuggestion(prompt: string): void
  suggestionsDisabled?: boolean
}

export function Transcript({ messages, git, loading, onOpenChanges, onSuggestion, suggestionsDisabled }: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousCountRef = useRef(0)
  const streaming = messages.some((message) => message.streaming)
  useEffect(() => {
    const firstLoadedTranscript = previousCountRef.current === 0 && messages.length > 0
    if (firstLoadedTranscript || streaming) {
      const scroller = scrollRef.current
      scroller?.scrollTo({ top: scroller.scrollHeight, behavior: streaming ? 'smooth' : 'auto' })
    }
    previousCountRef.current = messages.length
  }, [messages, streaming])

  return (
    <div ref={scrollRef} className="transcript scroll-area" aria-busy={loading}>
      <div className="transcript__inner">
        {loading ? <div className="transcript-loading"><LoaderCircle className="spin" size={16} /> Loading session…</div> : null}
        {!loading && messages.length === 0 ? (
          <div className="session-welcome">
            <PrimeMark size={34} />
            <h1>What should we work on?</h1>
            <p>Prime can inspect this project, edit files, run tools, and keep working across sessions.</p>
            <div className="prompt-suggestions"><button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Summarize this project')}>Summarize this project</button><button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Find a useful next task')}>Find a useful next task</button><button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Run the test suite')}>Run the test suite</button></div>
          </div>
        ) : null}
        {messages.map((message, index) => message.role === 'user' ? (
          <article className="message message--user" key={message.id}><div className="user-bubble">{message.parts.map((part, partIndex) => part.type === 'text' ? <InlineText key={partIndex} text={part.text} /> : null)}</div></article>
        ) : message.role === 'assistant' ? (
          <AssistantMessage key={message.id} message={message} git={git} isLast={!messages.slice(index + 1).some((item) => item.role === 'assistant')} onOpenChanges={onOpenChanges} />
        ) : (
          <div className={`message message--${message.role}`} key={message.id}>{message.parts.map((part, partIndex) => part.type === 'text' ? <span key={partIndex}>{part.text}</span> : null)}</div>
        ))}
        <div />
      </div>
    </div>
  )
}
