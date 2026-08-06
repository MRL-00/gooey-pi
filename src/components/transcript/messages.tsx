import { memo, useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, FileCode2, Target } from 'lucide-react'
import type { GitStatus, MessagePart, TranscriptMessage } from '@/types/api'
import { boundText } from '@/lib/render-bounds'
import { MarkdownText } from '../MarkdownText'
import { PrimeMark } from '../ui'
import { InlineText } from './syntax'
import { ThinkingDots, WorkDisclosure } from './timeline'

function renderNarrative(parts: MessagePart[], keyPrefix: string) {
  return parts.map((part, index) => {
    if (part.type === 'text') return <MarkdownText key={`${keyPrefix}-${index}`} text={part.text} />
    if (part.type === 'image') return <div key={`${keyPrefix}-${index}`} className="image-part">Image attachment</div>
    return null
  })
}

function messageText(message: TranscriptMessage): string {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall back to the document copy command when clipboard permission is unavailable.
    }
  }
  const input = document.createElement('textarea')
  input.value = text
  input.setAttribute('readonly', '')
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.append(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error('Copy is unavailable')
}

function MessageActions({ message, text: suppliedText }: { message: TranscriptMessage; text?: string }) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  const text = suppliedText ?? messageText(message)
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'agent' ? 'agent' : 'user'

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
  }, [])

  if (!text) return null

  const copyMessage = async () => {
    try {
      await writeClipboardText(text)
      setCopied(true)
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="message-actions">
      <button type="button" disabled={!text} aria-label={`${copied ? 'Copied' : 'Copy'} ${role} message`} onClick={() => void copyMessage()}>
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
      </button>
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

export const AssistantMessage = memo(function AssistantMessage({ message, git, isLast, showReasoning, showTools, onOpenChanges }: { message: TranscriptMessage; git: GitStatus; isLast: boolean; showReasoning: boolean; showTools: boolean; onOpenChanges(): void }) {
  const firstActivity = message.parts.findIndex((part) => part.type === 'thinking' || part.type === 'toolCall' || part.type === 'toolResult')
  let lastActivity = -1
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    if (message.parts[index].type === 'thinking' || message.parts[index].type === 'toolCall' || message.parts[index].type === 'toolResult') { lastActivity = index; break }
  }
  const hasVisibleActivity = firstActivity >= 0 && (showReasoning && message.parts.some((part) => part.type === 'thinking') || showTools && message.parts.some((part) => part.type === 'toolCall' || part.type === 'toolResult'))
  const before = firstActivity < 0 ? message.parts : message.parts.slice(0, firstActivity)
  const work = firstActivity < 0 ? [] : message.parts.slice(firstActivity, lastActivity + 1)
  const after = firstActivity < 0 ? [] : message.parts.slice(lastActivity + 1)
  const hiddenMiddleNarrative = !hasVisibleActivity ? work.filter((part) => part.type === 'text' || part.type === 'image') : []
  const copyableNarrative = hasVisibleActivity ? [...before, ...after] : [...before, ...hiddenMiddleNarrative, ...after]
  const copyableText = copyableNarrative.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
  return (
    <article className="message message--assistant">
      <div className="assistant-mark"><PrimeMark size={24} /></div>
      <div className="message__content">
        {renderNarrative(before, 'before')}
        {hasVisibleActivity ? <WorkDisclosure message={message} parts={work} showReasoning={showReasoning} showTools={showTools} /> : renderNarrative(hiddenMiddleNarrative, 'middle')}
        {renderNarrative(after, 'after')}
        {isLast && git.files.length > 0 && !message.streaming ? <ChangesCard git={git} onOpenChanges={onOpenChanges} /> : null}
        {message.streaming && !hasVisibleActivity ? <div className="streaming-state" aria-live="polite"><ThinkingDots /> Prime is working</div> : null}
        {!message.streaming ? <MessageActions message={message} text={copyableText} /> : null}
      </div>
    </article>
  )
}, (previous, next) => previous.message === next.message && previous.isLast === next.isLast && previous.showReasoning === next.showReasoning && previous.showTools === next.showTools && (!next.isLast || previous.git === next.git && previous.onOpenChanges === next.onOpenChanges))

export const UserMessage = memo(function UserMessage({ message }: { message: TranscriptMessage }) {
  return <article className="message message--user"><div className="user-bubble">{message.parts.map((part, partIndex) => part.type === 'text' ? <InlineText key={partIndex} text={part.text} /> : null)}</div><MessageActions message={message} /></article>
})

export const AgentMessage = memo(function AgentMessage({ message }: { message: TranscriptMessage }) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const text = messageText(message)
  const label = message.agentName ? `Message from agent: ${message.agentName}` : 'Message from agent'
  return (
    <article className={`message message--agent ${open ? 'is-open' : ''}`}>
      <button type="button" className="agent-message__summary" aria-expanded={open} aria-controls={contentId} aria-label={label} onClick={() => setOpen((value) => !value)}>
        <PrimeMark size={18} /><span className="agent-message__label">Message from agent</span>
        {message.agentName ? <span className="agent-message__name">{message.agentName}</span> : null}
        {open ? <ChevronDown className="agent-message__chevron" size={13} /> : <ChevronRight className="agent-message__chevron" size={13} />}
      </button>
      {open ? <div className="agent-message__content" id={contentId}><MarkdownText text={boundText(text, 40_000, '\n… [Agent message truncated in the desktop view.]')} /><MessageActions message={message} /></div> : null}
    </article>
  )
})

export const GoalMessage = memo(function GoalMessage({ message }: { message: TranscriptMessage }) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const text = messageText(message)
  return (
    <article className={`message message--goal ${open ? 'is-open' : ''}`}>
      <button type="button" className="goal-message__summary" aria-expanded={open} aria-controls={contentId} aria-label="Goal summary" onClick={() => setOpen((value) => !value)}>
        <span className="goal-message__icon"><Target size={15} /></span><span className="goal-message__label">Goal summary</span>
        {open ? <ChevronDown className="goal-message__chevron" size={13} /> : <ChevronRight className="goal-message__chevron" size={13} />}
      </button>
      {open ? <div className="goal-message__content" id={contentId}><MarkdownText text={boundText(text, 40_000, '\n… [Goal summary truncated in the desktop view.]')} /></div> : null}
    </article>
  )
})
