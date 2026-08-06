import React, { type MouseEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownTextProps {
  text: string
}

function openMarkdownLink(event: MouseEvent<HTMLAnchorElement>, href?: string): void {
  if (!href || href.startsWith('#')) return
  event.preventDefault()
  if (!/^(https?:|mailto:)/i.test(href)) return
  if (window.prime) {
    void window.prime.app.openExternal(href)
    return
  }
  window.open(href, '_blank', 'noopener,noreferrer')
}

/** Render model-authored Markdown without enabling raw HTML or remote images. */
export function MarkdownText({ text }: MarkdownTextProps) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node: _node, href, children, ...props }) => <a {...props} href={href} rel="noreferrer" onClick={(event) => openMarkdownLink(event, href)}>{children}</a>,
          img: ({ alt }) => <span className="markdown-image-placeholder">[Image: {alt || 'attachment'}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
