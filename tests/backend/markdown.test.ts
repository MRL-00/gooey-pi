import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from '../../src/components/MarkdownText'

describe('chat Markdown rendering', () => {
  it('renders common Markdown structures instead of exposing their markers', () => {
    const html = renderToStaticMarkup(createElement(MarkdownText, {
      text: '## Result\n\n**Done** with `code`.\n\n- one\n- two\n\n```ts\nconst ok = true\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |',
    }))

    expect(html).toContain('<h2>Result</h2>')
    expect(html).toContain('<strong>Done</strong>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<pre><code class="language-ts">')
    expect(html).toContain('<table>')
  })

  it('does not enable raw HTML or remote image loading', () => {
    const html = renderToStaticMarkup(createElement(MarkdownText, {
      text: '<script>bad()</script>\n\n![tracking](https://example.com/pixel.png)',
    }))

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('[Image: tracking]')
  })
})
