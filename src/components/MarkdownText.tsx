import React, { memo, type MouseEvent } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownTextProps {
  text: string
}

function openMarkdownLink(event: MouseEvent<HTMLAnchorElement>, href?: string): void {
  if (!href) return
  event.preventDefault()
  if (href.startsWith('#')) {
    try { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' }) } catch { /* malformed fragment */ }
    return
  }
  if (!/^(https?:|mailto:)/i.test(href)) return
  if (window.prime) {
    void window.prime.app.openExternal(href)
    return
  }
  window.open(href, '_blank', 'noopener,noreferrer')
}

const markdownPlugins = [remarkGfm]
const markdownComponents: Components = {
  a: ({ node: _node, href, children, ...props }) => href && (/^(https?:|mailto:|#)/i.test(href))
    ? <a {...props} href={href} rel="noreferrer" onClick={(event) => openMarkdownLink(event, href)}>{children}</a>
    : <span className="markdown-link-unsupported" title={href ? `Project-relative link: ${href}` : undefined}>{children}</span>,
  img: ({ alt }) => <span className="markdown-image-placeholder">[Image: {alt || 'attachment'}]</span>,
}

/** Render model-authored Markdown without enabling raw HTML or remote images. */
export const MarkdownText = memo(function MarkdownText({ text }: MarkdownTextProps) {
  return <div className="prose"><ReactMarkdown remarkPlugins={markdownPlugins} skipHtml components={markdownComponents}>{text}</ReactMarkdown></div>
})
