import {
  ArrowUp,
  AtSign,
  CircleStop,
  Command,
  FolderGit2,
  Gauge,
  Plus,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { SkillRecord } from '@/types/api'
import { IconButton, PrimeMark, SelectControl } from './ui'

interface ComposerProps {
  busy: boolean
  submitting?: boolean
  loading?: boolean
  disabled?: boolean
  model: string
  effort: string
  skills: SkillRecord[]
  onModelChange(value: string): void
  onEffortChange(value: string): void
  onSend(prompt: string): Promise<void> | void
  onStop(): Promise<void> | void
}

const commands = [
  { command: '/review', detail: 'Review current changes' },
  { command: '/plan', detail: 'Create an implementation plan' },
  { command: '/compact', detail: 'Compact session context' },
  { command: '/status', detail: 'Show runtime status' },
]

export function Composer({ busy, submitting = false, loading = false, disabled, model, effort, skills, onModelChange, onEffortChange, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState('')
  const [menu, setMenu] = useState<'add' | 'skill' | 'command' | null>(null)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const menuId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const submittingRef = useRef(false)
  const enabledSkills = skills.filter((skill) => skill.enabled).slice(0, 6)

  useEffect(() => {
    setMenu(value.startsWith('/') && !value.includes(' ') ? 'command' : value.endsWith('@') ? 'skill' : null)
  }, [value])

  const submit = async () => {
    const prompt = value.trim()
    if (!prompt || busy || submitting || loading || disabled || submittingRef.current) return
    submittingRef.current = true
    setValue('')
    setMenu(null)
    try { await onSend(prompt) } finally { submittingRef.current = false }
  }

  const insert = (text: string) => {
    setValue((current) => `${current}${text}`)
    setMenu(null)
    textareaRef.current?.focus()
  }

  const suggestions = menu === 'command'
    ? commands.filter((item) => item.command.startsWith(value)).map((item) => ({
        key: item.command, label: item.command, detail: item.detail, icon: <Command size={14} />,
        choose: () => { setValue(`${item.command} `); setMenu(null); textareaRef.current?.focus() },
      }))
    : menu === 'skill'
      ? enabledSkills.map((skill) => ({ key: skill.id, label: skill.name, detail: skill.description, icon: <AtSign size={14} />, choose: () => insert(`${skill.name} `) }))
      : menu === 'add'
        ? [{ key: 'mention', label: 'Mention a skill', detail: 'Add an enabled Prime capability', icon: <AtSign size={14} />, choose: () => insert('@') }]
        : []

  useEffect(() => { setActiveSuggestion(0) }, [menu, value, suggestions.length])
  const chooseSuggestion = (index: number) => suggestions[index]?.choose()

  return (
    <div className="composer-wrap">
      <div className={`composer ${busy || submitting ? 'composer--busy' : ''}`}>
        <textarea
          ref={textareaRef}
          value={value}
          disabled={disabled || submitting || loading}
          rows={2}
          placeholder={disabled ? 'Add a project to begin' : loading ? 'Loading session…' : submitting ? 'Starting Prime…' : 'Ask Prime anything, @ for skills, / for commands'}
          aria-label="Message Prime"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(menu && suggestions.length)}
          aria-controls={menu ? menuId : undefined}
          aria-activedescendant={menu && suggestions.length ? `${menuId}-option-${activeSuggestion}` : undefined}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (menu && suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              setActiveSuggestion((current) => event.key === 'ArrowDown' ? (current + 1) % suggestions.length : (current - 1 + suggestions.length) % suggestions.length)
              return
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (menu && suggestions.length) chooseSuggestion(activeSuggestion)
              else void submit()
            }
            if (event.key === 'Escape') { event.preventDefault(); setMenu(null) }
          }}
        />
        {menu && suggestions.length ? (
          <div id={menuId} className="composer-menu" role="listbox" aria-label={menu === 'command' ? 'Commands' : menu === 'skill' ? 'Skills' : 'Add context'}>
            {suggestions.map((suggestion, index) => <button
              id={`${menuId}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={activeSuggestion === index}
              className={activeSuggestion === index ? 'is-active' : ''}
              key={suggestion.key}
              onMouseEnter={() => setActiveSuggestion(index)}
              onClick={suggestion.choose}
            >{suggestion.icon}<span><strong>{suggestion.label}</strong><small>{suggestion.detail}</small></span></button>)}
          </div>
        ) : null}
        <div className="composer__footer">
          <div className="composer__controls">
            <IconButton label="Add skill" aria-expanded={menu === 'add'} aria-controls={menu === 'add' ? menuId : undefined} onClick={() => { setMenu((current) => current === 'add' ? null : 'add'); requestAnimationFrame(() => textareaRef.current?.focus()) }}><Plus size={17} /></IconButton>
            <SelectControl label="Model" compact icon={<PrimeMark size={14} />} value={model} onChange={(event) => onModelChange(event.target.value)}>
              <option value="auto">Auto</option><option value="gpt-5.6-sol">GPT-5.6 Sol</option><option value="gpt-5.4">GPT-5.4</option><option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            </SelectControl>
            <SelectControl label="Reasoning effort" compact icon={<Gauge size={12} />} value={effort} onChange={(event) => onEffortChange(event.target.value)}>
              <option value="low">Low</option><option value="medium">Standard</option><option value="high">High</option><option value="max">Max</option>
            </SelectControl>
            <span className="permissions-chip" title="Local environment"><FolderGit2 size={12} /><span>Local</span></span>
            <span className="permissions-chip" title="Workspace write access"><ShieldCheck size={12} /><span>Workspace</span></span>
          </div>
          <div className="composer__actions">
            {busy ? <button type="button" className="send-button send-button--stop" aria-label="Stop Prime" onClick={() => void onStop()}><CircleStop size={17} fill="currentColor" /></button> : <button type="button" className="send-button" aria-label="Send message" disabled={!value.trim() || submitting || loading || disabled} onClick={() => void submit()}><ArrowUp size={17} /></button>}
          </div>
        </div>
      </div>
      <p className="composer-note">Prime can make mistakes. Review commands and changes before committing.</p>
    </div>
  )
}
