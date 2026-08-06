import { ArrowLeft, ArrowRight, ExternalLink, History, MessageCirclePlus, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { createElement, useEffect, useRef, useState } from 'react'
import { IconButton } from '../ui'

type WebviewElement = HTMLElement & {
  loadURL(url: string): Promise<void>
  getURL(): string
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  stop(): void
  executeJavaScript(code: string): Promise<unknown>
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

function normalizeUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return 'about:blank'
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('about:')) return trimmed
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(trimmed)) return `http://${trimmed}`
  if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

export function BrowserPanel({ home, onOpenExternal }: { home: string; onOpenExternal(url: string): void }) {
  const webviewRef = useRef<WebviewElement | null>(null)
  const [address, setAddress] = useState(home)
  const [currentUrl, setCurrentUrl] = useState(home)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [annotation, setAnnotation] = useState(false)
  const [annotationText, setAnnotationText] = useState('')
  const [annotations, setAnnotations] = useState<Array<{ id: number; text: string }>>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<string[]>(() => [home])

  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    const sync = () => {
      try { const url = view.getURL() || home; setCurrentUrl(url); setAddress(url); setCanBack(view.canGoBack()); setCanForward(view.canGoForward()); setHistory((items) => items.at(-1) === url ? items : [...items.slice(-19), url]) } catch { /* webview not ready */ }
    }
    const didStart = () => setLoading(true)
    const didStop = () => { setLoading(false); sync() }
    view.addEventListener('did-start-loading', didStart)
    view.addEventListener('did-stop-loading', didStop)
    view.addEventListener('did-navigate', sync)
    view.addEventListener('did-navigate-in-page', sync)
    return () => { view.removeEventListener('did-start-loading', didStart); view.removeEventListener('did-stop-loading', didStop); view.removeEventListener('did-navigate', sync); view.removeEventListener('did-navigate-in-page', sync) }
  }, [home])

  const navigate = (value: string) => {
    const url = normalizeUrl(value)
    setAddress(url); setCurrentUrl(url)
    void webviewRef.current?.loadURL(url).catch((error: unknown) => {
      if (!String(error).includes('ERR_ABORTED')) console.error('Browser navigation failed', error)
    })
  }

  const saveAnnotation = () => {
    if (!annotationText.trim()) return
    setAnnotations((items) => [...items, { id: items.length + 1, text: annotationText.trim() }]); setAnnotationText(''); setAnnotation(false)
  }

  const webview = createElement('webview' as never, {
    ref: (node: WebviewElement | null) => { webviewRef.current = node },
    src: home,
    className: 'browser-webview',
    partition: 'persist:prime-work-browser',
    webpreferences: 'contextIsolation=yes,sandbox=yes,nodeIntegration=no',
  })

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <IconButton label="Back" disabled={!canBack} onClick={() => webviewRef.current?.goBack()}><ArrowLeft size={14} /></IconButton><IconButton label="Forward" disabled={!canForward} onClick={() => webviewRef.current?.goForward()}><ArrowRight size={14} /></IconButton><IconButton label={loading ? 'Stop loading' : 'Reload'} onClick={() => loading ? webviewRef.current?.stop() : webviewRef.current?.reload()}>{loading ? <X size={14} /> : <RefreshCw size={14} />}</IconButton>
        <form className="address-field" onSubmit={(event) => { event.preventDefault(); navigate(address) }}><ShieldCheck size={12} /><input value={address} onChange={(event) => setAddress(event.target.value)} aria-label="Browser address" spellCheck={false} /><button type="button" aria-label="Browser history" onClick={() => setHistoryOpen((value) => !value)}><History size={13} /></button></form>
        <IconButton className={annotation ? 'is-active annotation-active' : ''} label="Annotate page" onClick={() => setAnnotation((value) => !value)}><MessageCirclePlus size={15} /></IconButton><IconButton label="Open in default browser" onClick={() => onOpenExternal(currentUrl)}><ExternalLink size={14} /></IconButton>
      </div>
      {historyOpen ? <div className="browser-history"><div><strong>Recent pages</strong><button type="button" onClick={() => setHistory([])}>Clear</button></div>{history.slice().reverse().map((url, index) => <button type="button" key={`${url}-${index}`} onClick={() => { navigate(url); setHistoryOpen(false) }}><History size={12} /><span>{url}</span></button>)}</div> : null}
      <div className={`browser-viewport ${annotation ? 'is-annotating' : ''}`}>
        {webview}
        {annotation ? <div className="annotation-layer"><div className="annotation-target"><span>{annotations.length + 1}</span></div><div className="annotation-popover"><div><MessageCirclePlus size={14} /><strong>Page comment</strong><button type="button" onClick={() => setAnnotation(false)}><X size={13} /></button></div><textarea autoFocus value={annotationText} onChange={(event) => setAnnotationText(event.target.value)} placeholder="Describe what should change…"/><div><button type="button" className="button" onClick={() => setAnnotation(false)}>Cancel</button><button type="button" className="button button--primary" disabled={!annotationText.trim()} onClick={saveAnnotation}>Add comment</button></div></div></div> : null}
        {annotations.length ? <div className="annotation-count"><MessageCirclePlus size={12} /> {annotations.length} comment{annotations.length === 1 ? '' : 's'}</div> : null}
      </div>
    </div>
  )
}
