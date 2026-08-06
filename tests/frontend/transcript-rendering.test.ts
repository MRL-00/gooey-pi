import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Transcript } from '../../src/components/Transcript'
import type { TranscriptMessage } from '../../src/types/api'

vi.mock('../../src/components/ui', async () => {
  const { createElement: element } = await import('react')
  return { PrimeMark: ({ size = 24 }: { size?: number }) => element('span', { className: 'prime-mark', style: { width: size, height: size } }) }
})

const git = { isRepo: false, files: [] }
const noop = () => undefined

function render(messages: TranscriptMessage[]): string {
  return renderToStaticMarkup(createElement(Transcript, {
    messages,
    git,
    onOpenChanges: noop,
    onSuggestion: noop,
  }))
}

describe('transcript rendering', () => {
  it('streams reasoning as ordinary markdown text with animated thinking dots', () => {
    const html = render([{
      id: 'active',
      role: 'assistant',
      timestamp: 1_000,
      startedAt: 1_000,
      streaming: true,
      parts: [
        { type: 'thinking', text: 'Checking **the workspace** now.' },
        { type: 'toolCall', id: 'tool-1', name: 'read_file', args: { path: 'package.json' } },
      ],
    }])

    expect(html).toContain('activity-line--reasoning')
    expect(html).toContain('Checking <strong>the workspace</strong> now.')
    expect(html).not.toContain('**the workspace**')
    expect(html).not.toContain('>Reasoning<')
    expect(html).not.toContain('Worked for')
    expect(html).toContain('activity-line--tool')
    expect(html).toContain('thinking-dots')
    expect(html.match(/thinking-dots[\s\S]*?<span><\/span><span><\/span><span><\/span>/)).not.toBeNull()
  })

  it('collapses all work behind the caret as soon as the response yields', () => {
    const html = render([{
      id: 'complete',
      role: 'assistant',
      timestamp: 1_000,
      startedAt: 1_000,
      completedAt: 4_000,
      parts: [{ type: 'thinking', text: 'This stays collapsed until requested.' }],
    }])

    expect(html).toContain('Worked for 3s')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('This stays collapsed until requested.')
    expect(html).not.toContain('thinking-dots')
  })
})
