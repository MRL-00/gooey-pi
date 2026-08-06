import { useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileCode2,
  Github,
  Globe2,
  LoaderCircle,
  MessageCircleQuestion,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import type { MessagePart, TranscriptMessage } from '@/types/api'
import { boundText } from '@/lib/render-bounds'
import { MarkdownText } from '../MarkdownText'
import { SyntaxText } from './syntax'

function timestamp(value?: string | number): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function formatWorkedDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes === 0) return `${seconds}s`
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours === 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
}

export type ToolKind = 'question' | 'terminal' | 'web' | 'git' | 'file' | 'mcp'

export function classifyTool(name: string): ToolKind {
  if (/ask[_\s.-]?user|ask\s+(?:a\s+)?question|ui\.select|request[_\s.-]?input/i.test(name)) return 'question'
  if (/bash|shell|terminal|command|exec|process/i.test(name)) return 'terminal'
  if (/github|\bgit\b|commit|branch|pull[_\s-]?request/i.test(name)) return 'git'
  if (/browser|web[_\s.-]?search|search[_\s.-]?web|fetch|https?|url|globe/i.test(name)) return 'web'
  if (/read|write|edit|file|path|directory|patch/i.test(name)) return 'file'
  return 'mcp'
}

function toolIcon(kind: ToolKind): ReactNode {
  if (kind === 'question') return <MessageCircleQuestion size={14} />
  if (kind === 'terminal') return <TerminalSquare size={14} />
  if (kind === 'web') return <Globe2 size={14} />
  if (kind === 'git') return <Github size={14} />
  if (kind === 'file') return <FileCode2 size={14} />
  return <Wrench size={14} />
}

function serialize(value: unknown, pretty = false): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, pretty ? 2 : undefined) } catch { return String(value) }
}

function toolPreview(part: Extract<MessagePart, { type: 'toolCall' }>): string {
  const raw = part.args
  if (raw && typeof raw === 'object') {
    const args = raw as Record<string, unknown>
    const preferred = args.question ?? args.command ?? args.query ?? args.url ?? args.path ?? args.cwd
    if (typeof preferred === 'string') return boundText(preferred.replace(/\s+/g, ' ').trim(), 180, '…')
  }
  return boundText(serialize(raw).replace(/\s+/g, ' ').trim(), 180, '…')
}

function ReasoningPart({ part }: { part: Extract<MessagePart, { type: 'thinking' }> }) {
  return <div className="activity-line activity-line--reasoning"><MarkdownText text={boundText(part.text, 40_000, '\n… [Reasoning truncated in the desktop view.]')} /></div>
}

export function ThinkingDots({ labelled = false }: { labelled?: boolean }) {
  return (
    <span className="thinking-dots" role={labelled ? 'status' : undefined} aria-label={labelled ? 'Prime is thinking' : undefined} aria-hidden={labelled ? undefined : true}>
      <span /><span /><span />
    </span>
  )
}

function ToolPart({ part, next }: { part: Extract<MessagePart, { type: 'toolCall' }>; next?: MessagePart }) {
  const [open, setOpen] = useState(false)
  const result = next?.type === 'toolResult' ? next : undefined
  const failed = result?.isError
  const kind = classifyTool(part.name)
  const args = serialize(part.args, true)
  const output = result?.text ?? ''
  const visibleOutput = boundText(`${args}${args && output ? '\n\n' : ''}${output}`, 200_000, '\n\n[Output truncated in the desktop view.]')
  const canExpand = Boolean(visibleOutput)
  const state = failed ? 'error' : result ? 'done' : kind === 'question' ? 'waiting' : 'running'
  const preview = toolPreview(part)
  return (
    <div className={`activity-line activity-line--tool activity-line--${kind} is-${state}`}>
      <button type="button" className="activity-tool__summary" disabled={!canExpand} onClick={() => setOpen((value) => !value)} aria-expanded={canExpand ? open : undefined}>
        <span className="activity-line__icon">{toolIcon(kind)}</span>
        <span className="activity-line__kind">{kind === 'question' ? 'Question' : part.name}</span>
        {preview ? <code className="activity-tool__preview"><SyntaxText text={preview} /></code> : null}
        <span className="activity-tool__state">{failed ? <><CircleAlert size={12} /> failed</> : result ? <><Check size={12} /> done</> : kind === 'question' ? 'needs input' : <><LoaderCircle className="spin" size={12} /> running</>}</span>
        {canExpand ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
      </button>
      {open && visibleOutput ? <pre className="activity-tool__details"><SyntaxText text={visibleOutput} /></pre> : null}
    </div>
  )
}

function StandaloneToolResult({ part }: { part: Extract<MessagePart, { type: 'toolResult' }> }) {
  return <div className={`activity-line activity-line--result ${part.isError ? 'is-error' : ''}`}><span className="activity-line__icon">{part.isError ? <CircleAlert size={13} /> : <Check size={13} />}</span><span>{boundText(part.text, 2_000, '…')}</span></div>
}

function WorkTimeline({ parts, showReasoning, showTools }: { parts: MessagePart[]; showReasoning: boolean; showTools: boolean }) {
  const pairedResults = new Set<number>()
  return <div className="work-timeline">{parts.map((part, index) => {
    if (part.type === 'toolResult' && pairedResults.has(index)) return null
    if (part.type === 'thinking') return showReasoning ? <ReasoningPart key={index} part={part} /> : null
    if (part.type === 'toolCall') {
      if (!showTools) return null
      const next = parts[index + 1]
      if (next?.type === 'toolResult') pairedResults.add(index + 1)
      return <ToolPart key={part.id ?? index} part={part} next={next} />
    }
    if (part.type === 'toolResult') return showTools ? <StandaloneToolResult key={index} part={part} /> : null
    if (part.type === 'text') return <div className="activity-line activity-line--note" key={index}><MarkdownText text={part.text} /></div>
    return null
  })}</div>
}

export function WorkDisclosure({ message, parts, showReasoning, showTools }: { message: TranscriptMessage; parts: MessagePart[]; showReasoning: boolean; showTools: boolean }) {
  const [open, setOpen] = useState(false)
  if (message.streaming) {
    return <section className="work-disclosure is-running" aria-label="Prime work activity"><WorkTimeline parts={parts} showReasoning={showReasoning} showTools={showTools} /><div className="work-disclosure__thinking"><ThinkingDots labelled /></div></section>
  }
  const startedAt = timestamp(message.startedAt ?? message.timestamp) ?? 0
  const completedAt = timestamp(message.completedAt) ?? startedAt
  const duration = formatWorkedDuration(Math.max(0, completedAt - startedAt))
  return (
    <section className="work-disclosure">
      <button type="button" className="work-disclosure__button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>Worked for {duration}</span>
      </button>
      {open ? <WorkTimeline parts={parts} showReasoning={showReasoning} showTools={showTools} /> : null}
    </section>
  )
}
