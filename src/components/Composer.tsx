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
import { useEffect, useRef, useState } from 'react'
import type { SkillRecord } from '@/types/api'
import { IconButton, PrimeMark, SelectControl } from './ui'

interface ComposerProps {
  busy: boolean
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

export function Composer({ busy, disabled, model, effort, skills, onModelChange, onEffortChange, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState('')
  const [menu, setMenu] = useState<'add' | 'skill' | 'command' | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const enabledSkills = skills.filter((skill) => skill.enabled).slice(0, 6)

  useEffect(() => {
    setMenu(value.startsWith('/') && !value.includes(' ') ? 'command' : value.endsWith('@') ? 'skill' : null)
  }, [value])

  const submit = async () => {
    const prompt = value.trim()
    if (!prompt || disabled) return
    setValue('')
    setMenu(null)
    await onSend(prompt)
  }

  const insert = (text: string) => {
    setValue((current) => `${current}${text}`)
    setMenu(null)
    textareaRef.current?.focus()
  }

  return (
    <div className="composer-wrap">
      <div className={`composer ${busy ? 'composer--busy' : ''}`}>
        <textarea
          ref={textareaRef}
          value={value}
          disabled={disabled}
          rows={2}
          placeholder={disabled ? 'Add a project to begin' : 'Ask Prime anything, @ for skills, / for commands'}
          aria-label="Message Prime"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
            if (event.key === 'Escape') setMenu(null)
          }}
        />
        {menu ? (
          <div className="composer-menu" aria-label={menu === 'command' ? 'Commands' : menu === 'skill' ? 'Skills' : 'Add context'}>
            {menu === 'command' ? commands.filter((item) => item.command.startsWith(value)).map((item) => <button type="button" key={item.command} onClick={() => { setValue(`${item.command} `); setMenu(null); textareaRef.current?.focus() }}><Command size={14} /><span><strong>{item.command}</strong><small>{item.detail}</small></span></button>) : null}
            {menu === 'skill' ? enabledSkills.map((skill) => <button type="button" key={skill.id} onClick={() => insert(`${skill.name} `)}><AtSign size={14} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></button>) : null}
            {menu === 'add' ? <button type="button" onClick={() => insert('@')}><AtSign size={14} /><span><strong>Mention a skill</strong><small>Add an enabled Prime capability</small></span></button> : null}
          </div>
        ) : null}
        <div className="composer__footer">
          <div className="composer__controls">
            <IconButton label="Add skill" onClick={() => setMenu((current) => current === 'add' ? null : 'add')}><Plus size={17} /></IconButton>
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
            {busy ? <button type="button" className="send-button send-button--stop" aria-label="Stop Prime" onClick={() => void onStop()}><CircleStop size={17} fill="currentColor" /></button> : <button type="button" className="send-button" aria-label="Send message" disabled={!value.trim() || disabled} onClick={() => void submit()}><ArrowUp size={17} /></button>}
          </div>
        </div>
      </div>
      <p className="composer-note">Prime can make mistakes. Review commands and changes before committing.</p>
    </div>
  )
}
