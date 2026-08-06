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

function render(messages: TranscriptMessage[], active = false): string {
  return renderToStaticMarkup(createElement(Transcript, {
    messages,
    git,
    active,
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
    expect(html).not.toContain('activity-tool__details')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('package.json')
    expect(html).toContain('thinking-dots')
    expect(html.match(/thinking-dots[\s\S]*?<span><\/span><span><\/span><span><\/span>/)).not.toBeNull()
  })


  it('keeps external active work readable until the whole agent turn is done', () => {
    const html = render([{
      id: 'external-active',
      role: 'assistant',
      timestamp: 1_000,
      completedAt: 2_000,
      parts: [
        { type: 'thinking', text: 'Following the external session.' },
        { type: 'text', text: 'Explaining the next step.' },
        { type: 'toolCall', id: 'tool-1', name: 'read_file', args: { path: 'src/App.tsx' } },
        { type: 'toolResult', name: 'read_file', text: 'read complete' },
      ],
    }], true)

    expect(html).toContain('Following the external session.')
    expect(html).toContain('Explaining the next step.')
    expect(html).toContain('read_file')
    expect(html).toContain('src/App.tsx')
    expect(html).not.toContain('read complete')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Prime work activity')
    expect(html).not.toContain('Worked for')
    expect(html).not.toContain('message-actions')
  })

  it('shows a fresh working placeholder instead of reopening the prior assistant after a user tail', () => {
    const html = render([{
      id: 'complete',
      role: 'assistant',
      timestamp: 1_000,
      completedAt: 2_000,
      parts: [{ type: 'thinking', text: 'Prior completed reasoning.' }],
    }, {
      id: 'new-user',
      role: 'user',
      timestamp: 3_000,
      parts: [{ type: 'text', text: 'Continue externally' }],
    }], true)

    expect(html).toContain('Worked for 1s')
    expect(html).not.toContain('Prior completed reasoning.')
    expect(html).toContain('transcript-active-placeholder')
    expect(html).toContain('Prime is working')
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


  it('renders one file changes card in the pinned transcript footer', () => {
    const html = renderToStaticMarkup(createElement(Transcript, {
      messages: [{ id: 'assistant', role: 'assistant', parts: [{ type: 'text', text: 'Done' }] }],
      git: { isRepo: true, files: [{ path: 'src/App.tsx', status: 'modified', additions: 2, deletions: 1, staged: false }] },
      onOpenChanges: noop,
      onSuggestion: noop,
    }))
    expect(html).toContain('transcript-changes-pin')
    expect(html.match(/class="changes-card"/g)).toHaveLength(1)
    expect(html).toContain('1 file changed')
  })

  it('renders valid user images and keeps truncated history as a safe placeholder', () => {
    const html = render([{
      id: 'user-image', role: 'user', parts: [
        { type: 'text', text: 'See this' },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'image', mimeType: 'image/png', data: 'truncated', dataTruncated: true },
      ],
    }])

    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    expect(html).toContain('Image attachment unavailable')
    expect(html).not.toContain('src="data:image/png;base64,truncated"')
  })

  it('renders goal summaries as collapsed disclosures rather than system errors', () => {
    const html = render([{
      id: 'goal',
      role: 'goal',
      timestamp: 1_000,
      parts: [{ type: 'text', text: 'Ship the blue goal summary.' }],
    }])

    expect(html).toContain('message--goal')
    expect(html).toContain('aria-label="Goal summary"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Ship the blue goal summary.')
    expect(html).not.toContain('message--system')
  })
  it('keeps a final answer visible and copyable when an agent message arrives late', () => {
    const html = render([{
      id: 'late-agent-message',
      role: 'assistant',
      timestamp: 1_000,
      completedAt: 2_000,
      parts: [
        { type: 'thinking', text: 'Earlier reasoning.' },
        { type: 'text', text: 'The final answer stays visible.' },
        { type: 'agentMessage', agentName: 'late-reviewer', text: 'Late details.' },
      ],
    }])

    expect(html).toContain('The final answer stays visible.')
    expect(html).toContain('Message from agent')
    expect(html).toContain('late-reviewer')
    expect(html).not.toContain('Late details.')
    expect(html).toContain('aria-label="Copy assistant message"')
  })

  it('nests agent messages in active work without opening their contents', () => {
    const html = render([{
      id: 'active-agent-message',
      role: 'assistant',
      streaming: true,
      parts: [
        { type: 'thinking', text: '**Coordinating agents**' },
        { type: 'agentMessage', agentName: 'reviewer', text: 'Detailed child-agent response.' },
        { type: 'toolCall', id: 'next', name: 'read_file', args: { path: 'src/App.tsx' } },
      ],
    }])

    expect(html).toContain('activity-line--agent')
    expect(html).toContain('Message from agent')
    expect(html).toContain('reviewer')
    expect(html).not.toContain('Detailed child-agent response.')
    expect(html).not.toContain('message--agent')
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2)
  })

  it('renders system failures as compact expandable activity instead of red boxes', () => {
    const html = render([{ id: 'failure', role: 'system', parts: [{ type: 'text', text: 'Request failed with details.' }] }])
    expect(html).toContain('message--activity')
    expect(html).toContain('Prime message')
    expect(html).toContain('failed')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Request failed with details.')
    expect(html).not.toContain('message--system')
  })

  it('renders standalone informational output as a collapsed tool row', () => {
    const html = render([{
      id: 'ipython-state',
      role: 'tool',
      parts: [
        { type: 'toolCall', id: 'ipython-state', name: 'IPython state restored' },
        { type: 'toolResult', name: 'IPython state restored', text: 'Large diagnostic details.' },
      ],
    }])

    expect(html).toContain('message--activity')
    expect(html).toContain('IPython state restored')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Large diagnostic details.')
    expect(html).not.toContain('message--system')
  })

})
