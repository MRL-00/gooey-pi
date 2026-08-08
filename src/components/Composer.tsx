import { ArrowUp, AtSign, ChevronDown, Clock3, Command, Edit3, FolderGit2, Gauge, ImageIcon, MessageCirclePlus, Plus, ShieldCheck, Square, SquareTerminal, Trash2, X, Zap } from 'lucide-react'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  BrowserAnnotation,
  MessageEnterAction,
  PrimeContextUsage,
  PrimeModelDescriptor,
  PrimeProviderDescriptor,
  PrimeThinkingLevel,
  PromptDeliveryIntent,
  PromptImage,
  QueuedPrompt,
  SkillRecord,
  TerminalPromptContext,
  TerminalSelectionContext,
} from '@/types/api'
import { appendAnnotationsToPrompt } from '@/lib/browser-annotations'
import { appendTerminalContextToPrompt } from '@/lib/terminal-context'
import { takeComposerDraft } from '@/lib/composer-draft'
import { messageActionForKey } from '@/lib/message-shortcuts'
import { IconButton, PrimeMark, SelectControl } from './ui'

interface ComposerProps {
  busy: boolean
  submitting?: boolean
  loading?: boolean
  disabled?: boolean
  model: string
  effort: PrimeThinkingLevel
  modelsByProvider: ReadonlyMap<string, PrimeModelDescriptor[]>
  providers: PrimeProviderDescriptor[]
  reasoningLevels: PrimeThinkingLevel[]
  fast: boolean
  fastSupported: boolean
  fastAvailable: boolean
  /** Active harness agent name for tooltips ("Prime Agent" / "OMP"). */
  agentName?: string
  /** Active harness short name for inline copy ("Prime" / "OMP"). */
  shortName?: string
  imageInputSupported: boolean
  /** @deprecated Shortcuts are fixed: Enter queues and Ctrl+Enter steers. */
  messageEnterAction?: MessageEnterAction
  contextUsage?: PrimeContextUsage
  skills: SkillRecord[]
  /** Browser annotations auto-attach as a composer attachment while any exist. */
  annotations?: BrowserAnnotation[]
  /** The active terminal is visible as context; selected text expands this attachment. */
  terminalSelection?: TerminalSelectionContext
  /** Reads the active xterm buffer only at submit time, avoiding output-driven renderer updates. */
  getTerminalContext?(): TerminalPromptContext | undefined
  /** Messages accepted by Prime but waiting for a turn boundary. */
  queuedMessages?: QueuedPrompt[]
  onDeleteQueuedMessage?(message: QueuedPrompt): void
  onEditQueuedMessage?(message: QueuedPrompt): void
  /** Each bump submits the current draft immediately (Ctrl/Cmd+Enter from the annotation popover). */
  sendSignal?: number
  onModelChange(value: string): void
  onEffortChange(value: PrimeThinkingLevel): void
  onFastChange(value: boolean): void
  onSend(prompt: string, images: PromptImage[], intent: PromptDeliveryIntent): Promise<void> | void
  onStop(): Promise<void> | void
  onRemoveAnnotation?(id: string): void
  /** Called after a send that included the annotations, and by the attachment's remove control. */
  onClearAnnotations?(): void
  onClearTerminalSelection?(): void
}

const commands = [
  { command: '/review', detail: 'Review current changes' },
  { command: '/plan', detail: 'Create an implementation plan' },
  { command: '/compact', detail: 'Compact session context' },
  { command: '/status', detail: 'Show runtime status' },
]

const reasoningLabels: Record<PrimeThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Standard',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_COUNT = 8
const MAX_IMAGE_SOURCE_BYTES = 1_350_000
const MAX_IMAGE_PROMPT_BYTES = 2 * 1024 * 1024

interface ComposerImage extends PromptImage {
  id: string
  name: string
  size: number
}

function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return window.btoa(binary)
}

const EMPTY_ANNOTATIONS: BrowserAnnotation[] = []
const noop = () => undefined

export const Composer = memo(function Composer({
  busy,
  submitting = false,
  loading = false,
  disabled,
  model,
  effort,
  modelsByProvider,
  providers,
  reasoningLevels,
  fast,
  fastSupported,
  fastAvailable,
  agentName = 'Prime Agent',
  shortName = 'Prime',
  imageInputSupported,
  contextUsage,
  skills,
  annotations = EMPTY_ANNOTATIONS,
  terminalSelection,
  getTerminalContext,
  queuedMessages = [],
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  sendSignal = 0,
  onModelChange,
  onEffortChange,
  onFastChange,
  onSend,
  onStop,
  onRemoveAnnotation = noop,
  onClearAnnotations = noop,
  onClearTerminalSelection = noop,
}: ComposerProps) {
  const [value, setValue] = useState(takeComposerDraft)
  const [menu, setMenu] = useState<'add' | 'skill' | 'command' | null>(null)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [images, setImages] = useState<ComposerImage[]>([])
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [terminalSelectionOpen, setTerminalSelectionOpen] = useState(false)
  const [attachmentError, setAttachmentError] = useState('')
  const [processingImages, setProcessingImages] = useState(false)
  const menuId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const submittingRef = useRef(false)
  const pendingImagesRef = useRef(0)
  const imagesRef = useRef<ComposerImage[]>([])
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const mountedRef = useRef(true)
  const enabledSkills = skills.filter((skill) => skill.enabled).slice(0, 6)

  useEffect(() => {
    setMenu(value.startsWith('/') && !value.includes(' ') ? 'command' : value.endsWith('@') ? 'skill' : null)
  }, [value])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (annotations.length === 0) setAnnotationsOpen(false)
  }, [annotations.length])
  useEffect(() => {
    if (!terminalSelection?.text) setTerminalSelectionOpen(false)
  }, [terminalSelection?.text])

  // Ctrl/Cmd+Enter in the annotation popover bumps sendSignal to submit the
  // draft (with the just-saved annotation) without switching focus here.
  const lastSendSignalRef = useRef(sendSignal)
  useEffect(() => {
    if (sendSignal === lastSendSignalRef.current) return
    lastSendSignalRef.current = sendSignal
    void submit()
  }, [sendSignal])

  const submit = async (intent: PromptDeliveryIntent = 'queue') => {
    const currentImages = imagesRef.current
    const currentAnnotations = annotationsRef.current
    const currentTerminalContext = terminalSelection?.text ? getTerminalContext?.() : undefined
    const hasTerminalSelection = Boolean(currentTerminalContext?.text)
    const prompt = value.trim() || (currentImages.length > 0
      ? (currentImages.length === 1 ? '[Attached image]' : '[Attached images]')
      : currentAnnotations.length > 0 ? '[Page annotations]' : '[Terminal selection]')
    if ((!value.trim() && currentImages.length === 0 && currentAnnotations.length === 0 && !hasTerminalSelection) || loading || disabled || (intent !== 'steer' && !busy && (submitting || submittingRef.current))) return
    if (pendingImagesRef.current > 0) {
      setAttachmentError('Wait for the pasted image to finish processing before sending.')
      return
    }
    if (currentImages.length > 0 && !imageInputSupported) {
      setAttachmentError('This model does not accept images. Remove the attachment or choose a vision model.')
      return
    }
    const submittedImages = currentImages.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
    // Annotations ride along inside the prompt as a delimited plain-text block.
    const promptWithAnnotations = appendAnnotationsToPrompt(prompt, currentAnnotations)
    const promptWithContext = appendTerminalContextToPrompt(promptWithAnnotations, currentTerminalContext)
    const frame = `${JSON.stringify({ type: intent === 'steer' ? 'steer' : 'follow_up', message: promptWithContext, ...(submittedImages.length ? { images: submittedImages } : {}), id: '00000000-0000-0000-0000-000000000000' })}\n`
    if (new TextEncoder().encode(frame).byteLength > MAX_IMAGE_PROMPT_BYTES) {
      setAttachmentError('This message and its attachments are too large to send. Shorten the message or remove an attachment.')
      return
    }
    submittingRef.current = true
    const submittedValue = value
    const submittedComposerImages = currentImages
    setValue('')
    imagesRef.current = []
    setImages([])
    setAttachmentError('')
    setMenu(null)
    try {
      await onSend(promptWithContext, submittedImages, intent)
      // The annotations were delivered: clear the attachment and page markers.
      if (currentAnnotations.length > 0) onClearAnnotations()
    } catch {
      if (mountedRef.current) {
        setValue((current) => current || submittedValue)
        if (imagesRef.current.length === 0) {
          imagesRef.current = submittedComposerImages
          setImages(submittedComposerImages)
        }
        setAttachmentError('Message was not sent. Your draft and images were restored.')
      }
    } finally {
      submittingRef.current = false
      if (mountedRef.current) textareaRef.current?.focus()
    }
  }

  const addPastedImages = async (files: File[]) => {
    pendingImagesRef.current += 1
    setProcessingImages(true)
    try {
      if (!imageInputSupported) {
        setAttachmentError('This model does not accept images. Choose a vision model before pasting an image.')
        return
      }
      const supported = files.filter((file) => supportedImageTypes.has(file.type.toLowerCase()))
      if (supported.length !== files.length) {
        setAttachmentError(`${shortName} supports pasted PNG, JPEG, GIF, and WebP images.`)
        return
      }
      const added = await Promise.all(
        supported.map(
          async (file, index): Promise<ComposerImage> => ({
            id: crypto.randomUUID(),
            name: file.name || `Pasted image ${index + 1}`,
            size: file.size,
            type: 'image',
            mimeType: file.type.toLowerCase(),
            data: base64FromBuffer(await file.arrayBuffer()),
          }),
        ),
      )
      if (!mountedRef.current) return
      const current = imagesRef.current
      if (current.length + added.length > MAX_IMAGE_COUNT) {
        setAttachmentError(`You can attach up to ${MAX_IMAGE_COUNT} images.`)
        return
      }
      const totalBytes = current.reduce((sum, image) => sum + image.size, 0) + added.reduce((sum, image) => sum + image.size, 0)
      if (totalBytes > MAX_IMAGE_SOURCE_BYTES) {
        setAttachmentError('These images are too large to send. Paste a smaller image (about 1.3 MB total).')
        return
      }
      const next = [...current, ...added]
      imagesRef.current = next
      setImages(next)
      setAttachmentError('')
    } catch {
      if (mountedRef.current) setAttachmentError(`${shortName} could not read the pasted image.`)
    } finally {
      pendingImagesRef.current -= 1
      if (mountedRef.current && pendingImagesRef.current === 0) setProcessingImages(false)
    }
  }

  const insertAtCaret = (textarea: HTMLTextAreaElement, text: string) => {
    const start = textarea.selectionStart ?? textarea.value.length
    const end = textarea.selectionEnd ?? textarea.value.length
    textarea.setRangeText(text, start, end, 'end')
    setValue(textarea.value)
  }
  const insert = (text: string) => {
    const textarea = textareaRef.current
    if (textarea) insertAtCaret(textarea, text)
    else setValue((current) => `${current}${text}`)
    setMenu(null)
    textarea?.focus()
  }

  const suggestions =
    menu === 'command'
      ? commands
          .filter((item) => item.command.startsWith(value))
          .map((item) => ({
            key: item.command,
            label: item.command,
            detail: item.detail,
            icon: <Command size={14} />,
            choose: () => {
              setValue(`${item.command} `)
              setMenu(null)
              textareaRef.current?.focus()
            },
          }))
      : menu === 'skill'
        ? enabledSkills.map((skill) => ({ key: skill.id, label: skill.name, detail: skill.description, icon: <AtSign size={14} />, choose: () => insert(`${skill.name} `) }))
        : menu === 'add'
          ? [{ key: 'mention', label: 'Mention a skill', detail: 'Add an enabled Prime capability', icon: <AtSign size={14} />, choose: () => insert('@') }]
          : []

  useEffect(() => {
    setActiveSuggestion(0)
  }, [menu, value, suggestions.length])
  const chooseSuggestion = (index: number) => suggestions[index]?.choose()
  // The option tree only depends on catalog identity, not on per-keystroke state.
  const modelOptions = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled && provider.modelCount > 0)
        .map((provider) => (
          <optgroup key={provider.id} label={`${provider.name}${provider.configured ? '' : ' · not connected'}`}>
            {(modelsByProvider.get(provider.id) ?? []).map((candidate) => (
              <option key={candidate.key} value={candidate.key} disabled={!candidate.available}>
                {candidate.name}
                {candidate.available ? '' : ' · connect provider'}
              </option>
            ))}
          </optgroup>
        )),
    [modelsByProvider, providers],
  )
  const contextPercent = contextUsage?.percent === null || contextUsage?.percent === undefined ? null : Math.min(100, Math.max(0, contextUsage.percent))
  const contextLabel =
    contextUsage && contextUsage.tokens !== null
      ? `${contextUsage.tokens.toLocaleString('en-US')} / ${contextUsage.contextWindow.toLocaleString('en-US')} tokens`
      : 'Context usage unavailable until the next response'
  const contextDisplayPercent = contextPercent === null ? null : Math.min(99, Math.round(contextPercent))
  const contextStyle = { '--context-percent': `${contextPercent ?? 0}%` } as CSSProperties

  return (
    <div className="composer-wrap">
      {queuedMessages.length ? (
        <section className="composer-queue" aria-label="Queued messages" aria-live="polite">
          <div className="composer-queue__header">
            <span><Clock3 size={13} />Queued messages</span>
            <strong>{queuedMessages.length}</strong>
          </div>
          <div className="composer-queue__list">
            {queuedMessages.map((queued) => (
              <div className="composer-queue__item" key={queued.id}>
                <span className="composer-queue__text">{queued.text}</span>
                <span className="composer-queue__actions">
                  <button type="button" className="composer-queue__action" aria-label={`Edit queued message: ${queued.text}`} title="Edit queued message" onClick={() => { onEditQueuedMessage?.(queued); setValue(queued.text); requestAnimationFrame(() => textareaRef.current?.focus()) }}><Edit3 size={13} /></button>
                  <button type="button" className="composer-queue__action composer-queue__action--delete" aria-label={`Delete queued message: ${queued.text}`} title="Delete queued message" onClick={() => onDeleteQueuedMessage?.(queued)}><Trash2 size={13} /></button>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <div className={`composer ${busy || submitting ? 'composer--busy' : ''}`}>
        <textarea
          ref={textareaRef}
          value={value}
          disabled={disabled || loading}
          rows={2}
          placeholder={disabled ? 'Add a project to begin' : loading ? 'Loading session…' : submitting ? `Starting ${shortName}…` : `Ask ${shortName} anything, @ for skills, / for commands`}
          aria-label={`Message ${shortName}`}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(menu && suggestions.length)}
          aria-controls={menu ? menuId : undefined}
          aria-activedescendant={menu && suggestions.length ? `${menuId}-option-${activeSuggestion}` : undefined}
          onChange={(event) => setValue(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.items]
              .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
              .flatMap((item) => {
                const file = item.getAsFile()
                return file ? [file] : []
              })
            if (!files.length) return
            const pastedText = event.clipboardData.getData('text/plain')
            event.preventDefault()
            if (pastedText) insertAtCaret(event.currentTarget, pastedText)
            void addPastedImages(files)
          }}
          onKeyDown={(event) => {
            if (menu && suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              setActiveSuggestion((current) => (event.key === 'ArrowDown' ? (current + 1) % suggestions.length : (current - 1 + suggestions.length) % suggestions.length))
              return
            }
            if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing && menu && suggestions.length) {
              event.preventDefault()
              chooseSuggestion(activeSuggestion)
              return
            }
            const intent = messageActionForKey(
              {
                key: event.key,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
              },
            )
            if (intent) {
              event.preventDefault()
              void submit(intent)
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setMenu(null)
            }
          }}
        />
        {menu && suggestions.length ? (
          <div id={menuId} className="composer-menu" role="listbox" aria-label={menu === 'command' ? 'Commands' : menu === 'skill' ? 'Skills' : 'Add context'}>
            {suggestions.map((suggestion, index) => (
              <button
                id={`${menuId}-option-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={activeSuggestion === index}
                className={activeSuggestion === index ? 'is-active' : ''}
                key={suggestion.key}
                onMouseEnter={() => setActiveSuggestion(index)}
                onClick={suggestion.choose}
              >
                {suggestion.icon}
                <span>
                  <strong>{suggestion.label}</strong>
                  <small>{suggestion.detail}</small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {annotationsOpen && annotations.length ? (
          <div className="composer-annotations" role="region" aria-label="Page annotation details">
            {annotations.map((annotation, index) => {
              return (
                <div className="composer-annotation" key={annotation.id}>
                  <span className="composer-annotation__badge" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="composer-annotation__body">
                    <p>{annotation.comment}</p>
                    {annotation.stale ? <small>page changed since capture</small> : null}
                  </div>
                  <button type="button" aria-label={`Remove annotation ${index + 1}`} onClick={() => onRemoveAnnotation(annotation.id)}>
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}
        {terminalSelectionOpen && terminalSelection?.text ? (
          <div className="composer-terminal-selection" role="region" aria-label="Selected terminal text">
            <div>
              <SquareTerminal size={14} aria-hidden="true" />
              <strong>{terminalSelection.label}</strong>
              {terminalSelection.truncated ? <small>start truncated</small> : null}
            </div>
            <pre>{terminalSelection.text}</pre>
          </div>
        ) : null}
        {images.length || annotations.length || terminalSelection?.text ? (
          <div className="composer-attachments" aria-label="Attachments">
            {annotations.length ? (
              <div className="composer-attachment composer-attachment--annotations" title={`${annotations.length} page annotation${annotations.length === 1 ? '' : 's'}`}>
                <button
                  type="button"
                  className="composer-attachment__expand"
                  aria-expanded={annotationsOpen}
                  aria-label={`Inspect ${annotations.length} page annotation${annotations.length === 1 ? '' : 's'}`}
                  onClick={() => setAnnotationsOpen((open) => !open)}
                >
                  <MessageCirclePlus size={13} />
                  <span>{annotations.length}</span>
                  <ChevronDown size={11} className={annotationsOpen ? 'is-open' : ''} />
                </button>
                <button
                  type="button"
                  className="composer-attachment__clear"
                  aria-label="Remove page annotations"
                  onClick={() => {
                    setAnnotationsOpen(false)
                    onClearAnnotations()
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ) : null}
            {terminalSelection?.text ? (
              <div className="composer-attachment composer-attachment--terminal has-selection" title={`Selected text from ${terminalSelection.label}`}>
                <button
                  type="button"
                  className="composer-attachment__expand"
                  aria-expanded={terminalSelectionOpen}
                  aria-label={`Inspect selected text from ${terminalSelection.label}`}
                  onClick={() => setTerminalSelectionOpen((open) => !open)}
                >
                  <SquareTerminal size={13} />
                  <span>{terminalSelection.label}</span>
                  <><small>selected</small><ChevronDown size={11} className={terminalSelectionOpen ? 'is-open' : ''} /></>
                </button>
                <button type="button" className="composer-attachment__clear" aria-label="Clear terminal selection" onClick={onClearTerminalSelection}><X size={12} /></button>
              </div>
            ) : null}
            {images.map((image) => (
              <div className="composer-attachment" key={image.id}>
                <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
                <span>
                  <ImageIcon size={12} />
                  {image.name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => {
                    const next = imagesRef.current.filter((item) => item.id !== image.id)
                    imagesRef.current = next
                    setImages(next)
                    setAttachmentError('')
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {attachmentError ? (
          <p className="composer-attachment-error" role="alert">
            {attachmentError}
          </p>
        ) : null}
        <div className="composer__footer">
          <div className="composer__controls">
            <IconButton
              label="Add skill"
              aria-expanded={menu === 'add'}
              aria-controls={menu === 'add' ? menuId : undefined}
              onClick={() => {
                setMenu((current) => (current === 'add' ? null : 'add'))
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}
            >
              <Plus size={17} />
            </IconButton>
            <SelectControl label="Model" compact icon={<PrimeMark size={14} />} value={model} onChange={(event) => onModelChange(event.target.value)}>
              <option value="auto">Auto</option>
              {modelOptions}
            </SelectControl>
            <SelectControl label="Reasoning effort" compact icon={<Gauge size={12} />} value={effort} onChange={(event) => onEffortChange(event.target.value as PrimeThinkingLevel)}>
              {reasoningLevels.map((level) => (
                <option key={level} value={level}>
                  {reasoningLabels[level]}
                </option>
              ))}
            </SelectControl>
            {fastSupported ? (
              <button
                type="button"
                className={`fast-mode-toggle ${fast ? 'is-active' : ''}`}
                aria-pressed={fast}
                disabled={!fastAvailable}
                title={fastAvailable ? `Use ${agentName} priority service tier` : `The installed ${agentName} RPC runtime does not expose fast mode`}
                onClick={() => onFastChange(!fast)}
              >
                <Zap size={12} fill={fast ? 'currentColor' : 'none'} /> Fast
              </button>
            ) : null}
            <span className="permissions-chip" title="Local environment">
              <FolderGit2 size={12} />
              <span>Local</span>
            </span>
            <span className="permissions-chip" title="Workspace write access">
              <ShieldCheck size={12} />
              <span>Workspace</span>
            </span>
          </div>
          <div className="composer__actions">
            <span
              className={`context-usage-dial ${contextPercent === null ? 'is-unavailable' : contextPercent >= 95 ? 'is-critical' : contextPercent >= 80 ? 'is-warning' : ''}`}
              role="meter"
              tabIndex={0}
              aria-label="Context usage"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={contextPercent === null ? undefined : Math.round(contextPercent)}
              aria-valuetext={contextLabel}
              title={contextLabel}
              data-tooltip={contextLabel}
              style={contextStyle}
            >
              <span>{contextDisplayPercent ?? '—'}</span>
            </span>
            {busy ? (
              <button type="button" className="send-button send-button--stop" aria-label="Stop Prime" onClick={() => void onStop()}>
                <Square size={10} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                aria-label="Send message"
                disabled={(!value.trim() && images.length === 0 && annotations.length === 0 && !terminalSelection?.text) || processingImages || submitting || loading || disabled}
                onClick={() => void submit()}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="composer-note">{shortName} can make mistakes. Review commands and changes before committing.</p>
    </div>
  )
})
