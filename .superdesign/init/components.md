# Shared UI Primitives

## `src/components/ui.tsx`
Custom React primitives shared throughout the desktop workspace: icon buttons, Prime mark, badges, empty states, and segmented controls.

```tsx
import { ChevronDown, X } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'small' | 'regular'
}

export function IconButton({ label, size = 'regular', className = '', children, ...props }: IconButtonProps) {
  return (
    <button type="button" className={`icon-button icon-button--${size} ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  )
}

interface SelectControlProps extends SelectHTMLAttributes<HTMLSelectElement> {
  icon?: ReactNode
  compact?: boolean
  label: string
}

export function SelectControl({ icon, compact, className = '', label, children, ...props }: SelectControlProps) {
  return (
    <label className={`select-control ${compact ? 'select-control--compact' : ''} ${className}`} title={label}>
      {icon}
      <span className="sr-only">{label}</span>
      <select aria-label={label} {...props}>{children}</select>
      <ChevronDown size={12} aria-hidden="true" />
    </label>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange(value: T): void
  label: string
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? 'is-active' : ''}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state__icon">{icon}</div> : null}
      <h2>{title}</h2>
      <p>{children}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  )
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose(): void; footer?: ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div className="modal__header"><h2 id="modal-title">{title}</h2><IconButton label="Close" onClick={onClose}><X size={16} /></IconButton></div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </section>
    </div>
  )
}

export function PrimeMark({ size = 24 }: { size?: number }) {
  return (
    <span className="prime-mark" style={{ width: size, height: size }} aria-label="Prime">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.4 13.4 10.1 3.2c.5-.9 1.9-.5 1.8.5l-.4 5.5h7.3c.9 0 1.3 1.1.7 1.7L10 21c-.7.8-2-.1-1.5-1l2.3-4.6H5.3c-1 0-1.4-1.2-.9-2Z" fill="currentColor"/></svg>
    </span>
  )
}

```
