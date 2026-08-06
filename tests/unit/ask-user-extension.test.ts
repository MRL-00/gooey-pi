import { describe, expect, it } from 'vitest'
import askUser, { OTHER_OPTION } from '../../.prime/agent/extensions/ask-user'

function registeredAskUserTool(): any {
  let tool: any
  askUser({ registerTool(value: any) { tool = value } } as any)
  return tool
}

describe('ask_user extension', () => {
  it('adds a freeform option and returns the typed answer with its source', async () => {
    const tool = registeredAskUserTool()
    let presentedOptions: string[] = []
    let presentedQuestion = ''
    const inputTitles: string[] = []
    const inputValues = ['Canary for a small pilot', 'The pilot needs a cautious rollout.']
    const result = await tool.execute('call-1', {
      question: 'Which release channel?',
      options: ['Stable', 'Beta'],
    }, new AbortController().signal, undefined, {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => { presentedQuestion = title; presentedOptions = options; return OTHER_OPTION },
        input: async (title: string) => { inputTitles.push(title); return inputValues.shift() },
      },
    })

    expect(presentedQuestion).toBe('Which release channel?')
    expect(presentedOptions).toEqual(['Stable', 'Beta', OTHER_OPTION])
    expect(inputTitles).toEqual(['Type your answer', 'Add context (optional)'])
    expect(result.details).toMatchObject({ answer: 'Canary for a small pilot', answerSource: 'freeform', context: 'The pilot needs a cautious rollout.' })
    expect(result.content[0].text).toContain('Additional context: The pilot needs a cautious rollout.')
  })

  it('returns a listed choice and collects optional context', async () => {
    const tool = registeredAskUserTool()
    const inputTitles: string[] = []
    const result = await tool.execute('call-2', {
      question: 'Which release channel?',
      options: ['Stable', 'Beta'],
    }, new AbortController().signal, undefined, {
      hasUI: true,
      ui: {
        select: async () => 'Beta',
        input: async (title: string) => { inputTitles.push(title); return 'Because the pilot needs a cautious rollout.' },
      },
    })

    expect(inputTitles).toEqual(['Add context (optional)'])
    expect(result.details).toMatchObject({ answer: 'Beta', answerSource: 'option', context: 'Because the pilot needs a cautious rollout.' })
    expect(result.content[0].text).toContain('Additional context: Because the pilot needs a cautious rollout.')
  })

  it('omits context when the optional field is blank', async () => {
    const tool = registeredAskUserTool()
    const result = await tool.execute('call-3', {
      question: 'Which release channel?',
      options: ['Stable', 'Beta'],
    }, new AbortController().signal, undefined, {
      hasUI: true,
      ui: {
        select: async () => 'Beta',
        input: async () => '   ',
      },
    })

    expect(result.details).toMatchObject({ answer: 'Beta', answerSource: 'option' })
    expect(result.details).not.toHaveProperty('context')
    expect(result.content[0].text).toBe('The user selected: Beta')
  })
})
