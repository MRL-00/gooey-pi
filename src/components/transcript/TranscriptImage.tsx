import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useAppShellOverlay, useFocusTrap } from '../ui'

interface TranscriptImageProps {
  source: string
  alt: string
}

export function TranscriptImage({ source, alt }: TranscriptImageProps) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const lightboxRef = useFocusTrap<HTMLElement>(open, () => setOpen(false))
  useAppShellOverlay(open)

  return <>
    <button type="button" className="image-part__preview" aria-label="Expand pasted image" onClick={() => setOpen(true)}>
      <img className="image-part" src={source} alt={alt} />
    </button>
    {open ? createPortal(
      <div className="image-lightbox" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}>
        <section ref={lightboxRef} className="image-lightbox__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false)
        }}>
          <h2 id={titleId} className="sr-only">Expanded pasted image</h2>
          <button type="button" className="image-lightbox__close" aria-label="Close expanded image" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
          <img className="image-lightbox__image" src={source} alt={alt} />
        </section>
      </div>,
      document.body,
    ) : null}
  </>
}
