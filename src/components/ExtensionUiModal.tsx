import { useEffect, useState } from 'react'
import type { ExtensionUiRequest } from '@/lib/extension-ui'
import { Modal } from './ui'

export type ExtensionUiResponse =
  | { cancelled: true }
  | { value: string }
  | { confirmed: boolean }

interface ExtensionUiModalProps {
  request: ExtensionUiRequest
  onRespond(response: ExtensionUiResponse): void
}

export function ExtensionUiModal({ request, onRespond }: ExtensionUiModalProps) {
  const prefill = request.method === 'editor' ? request.prefill : undefined
  const [value, setValue] = useState(prefill ?? '')
  const [selected, setSelected] = useState(0)

  useEffect(() => {
    setValue(prefill ?? '')
    setSelected(0)
  }, [prefill, request])

  const cancel = () => onRespond({ cancelled: true })

  return (
    <Modal title={request.title} onClose={cancel} footer={(
      <>
        <button type="button" className="button" onClick={cancel}>Cancel</button>
        {request.method === 'confirm' ? <button type="button" className="button button--primary" onClick={() => onRespond({ confirmed: true })}>Confirm</button> : null}
        {request.method === 'input' || request.method === 'editor' ? <button type="button" className="button button--primary" disabled={!value.trim()} onClick={() => onRespond({ value })}>Continue</button> : null}
      </>
    )}>
      {request.method === 'select' ? (
        <div className="extension-question">
          <p className="modal-intro">Choose an option to let Prime continue.</p>
          <div className="extension-question__options" role="listbox" aria-label={request.title}>
            {request.options.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={selected === index}
                className={selected === index ? 'is-selected' : ''}
                key={`${option}-${index}`}
                onClick={() => { setSelected(index); onRespond({ value: option }) }}
                onFocus={() => setSelected(index)}
              >
                <span className="extension-question__option-index">{index + 1}</span>
                <span>{option}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {request.method === 'confirm' ? <p className="modal-intro extension-question__message">{request.message}</p> : null}
      {request.method === 'input' ? <label className="field extension-question__field"><span>Response</span><input autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && value.trim()) { event.preventDefault(); onRespond({ value }) } }} /></label> : null}
      {request.method === 'editor' ? <label className="field extension-question__field"><span>Response</span><textarea autoFocus rows={7} value={value} onChange={(event) => setValue(event.target.value)} /></label> : null}
    </Modal>
  )
}
