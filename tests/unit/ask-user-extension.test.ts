import { describe, expect, it } from 'vitest'
import askUser, { ASK_USER_RPC_MARKER, OTHER_OPTION } from '../../.prime/agent/extensions/ask-user'

function registeredAskUserTool(): any {
  let tool: any
  askUser({ registerTool(value: any) { tool = value } } as any)
  return tool
}

describe('ask_user extension', () => {
  it('asks multiple questions through the RPC fallback and returns context with each answer', async () => {
    const tool = registeredAskUserTool()
    const calls: Array<{ title: string; options: string[] }> = []
    const responses = [
      JSON.stringify({ answer: 'Beta', answerSource: 'option', context: 'Use it for the pilot.' }),
      JSON.stringify({ answer: 'A cautious rollout', answerSource: 'freeform' }),
    ]
    const result = await tool.execute('call-1', {
      questions: [
        { question: 'Which release channel?', options: ['Stable', 'Beta'] },
        { question: 'What should I optimize for?', options: ['Speed', 'Safety'] },
      ],
    }, new AbortController().signal, undefined, {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        select: async (title: string, options: string[]) => {
          calls.push({ title, options })
          return responses.shift()
        },
      },
    })

    expect(calls).toHaveLength(2)
    expect(calls[0].options[0]).toContain(ASK_USER_RPC_MARKER)
    expect(calls[0].options).toContain(OTHER_OPTION)
    expect(result.details.answers).toEqual([
      { question: 'Which release channel?', answer: 'Beta', answerSource: 'option', context: 'Use it for the pilot.' },
      { question: 'What should I optimize for?', answer: 'A cautious rollout', answerSource: 'freeform' },
    ])
    expect(result.content[0].text).toContain('Additional context: Use it for the pilot.')
  })

  it('returns a cancellation when any question is cancelled', async () => {
    const tool = registeredAskUserTool()
    const result = await tool.execute('call-2', {
      questions: [
        { question: 'Which release channel?', options: ['Stable', 'Beta'] },
        { question: 'What should I optimize for?', options: ['Speed', 'Safety'] },
      ],
    }, new AbortController().signal, undefined, {
      hasUI: true,
      ui: {
        custom: async () => undefined,
        select: async (_title: string, options: string[]) => options.length > 0 ? undefined : 'unexpected',
      },
    })

    expect(result.details).toMatchObject({ answers: [], cancelled: true })
    expect(result.content[0].text).toBe('The user cancelled the questionnaire.')
  })

  it('reports unavailable UI without attempting a question', async () => {
    const tool = registeredAskUserTool()
    const result = await tool.execute('call-3', {
      questions: [{ question: 'Which release channel?', options: ['Stable', 'Beta'] }],
    }, new AbortController().signal, undefined, {
      hasUI: false,
      ui: {},
    })

    expect(result.details).toMatchObject({ answers: [], cancelled: true })
    expect(result.content[0].text).toContain('not available')
  })

  it('keeps a multi-question questionnaire in one custom TUI and submits all answers', async () => {
    const tool = registeredAskUserTool()
    const renders: string[][] = []
    const result = await tool.execute('call-custom', {
      questions: [
        { question: 'First question?', options: ['A', 'B', 'Something else (freeform)', 'Other (type your own answer)'] },
        { question: 'Second question?', options: ['C', 'D'] },
      ],
    }, new AbortController().signal, undefined, {
      hasUI: true,
      ui: {
        custom: async (factory: any) => new Promise((resolve: (value: unknown) => void) => {
          const component = factory(
            { requestRender: () => undefined },
            { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value },
            {},
            resolve,
          )
          component.focused = true
          renders.push(component.render(80))
          component.handleInput('context')
          component.handleInput('\n')
          component.handleInput('\x1b[B')
          component.handleInput('\x1b[B')
          component.handleInput('custom')
          component.handleInput('\x1b[D')
          component.handleInput('\x1b[C')
          component.handleInput('\t')
          component.handleInput('\n')
        }),
        select: async () => { throw new Error('custom UI should handle the questionnaire') },
      },
    })

    expect(renders[0]?.join('\n')).toContain('Type to add context')
    expect(result.details.questions[0].options).toEqual(['A', 'B', OTHER_OPTION])
    expect(result.details.answers).toEqual([
      { question: 'First question?', answer: 'A', answerSource: 'option', context: 'context' },
      { question: 'Second question?', answer: 'custom', answerSource: 'freeform' },
    ])
  })
})
