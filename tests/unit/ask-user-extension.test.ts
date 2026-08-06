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
    let inputTitle = ''
    const result = await tool.execute('call-1', {
      question: 'Which release channel?',
      context: 'The release will start with a small pilot.',
      options: ['Stable', 'Beta'],
    }, new AbortController().signal, undefined, {
      hasUI: true,
      ui: {
        select: async (title: string, options: string[]) => { presentedQuestion = title; presentedOptions = options; return OTHER_OPTION },
        input: async (title: string) => { inputTitle = title; return 'Canary for a small pilot' },
      },
    })

    expect(presentedQuestion).toBe('Which release channel?')
    expect(presentedOptions).toEqual(['Stable', 'Beta', OTHER_OPTION])
    expect(inputTitle).toBe('Type your answer')
    expect(result.details).toMatchObject({ answer: 'Canary for a small pilot', answerSource: 'freeform', context: 'The release will start with a small pilot.' })
  })

  it('returns a listed choice without opening freeform input', async () => {
    const tool = registeredAskUserTool()
    let inputOpened = false
    const result = await tool.execute('call-2', {
      question: 'Which release channel?',
      options: ['Stable', 'Beta'],
    }, new AbortController().signal, undefined, {
      hasUI: true,
      ui: {
        select: async () => 'Beta',
        input: async () => { inputOpened = true; return 'unexpected' },
      },
    })

    expect(inputOpened).toBe(false)
    expect(result.details).toMatchObject({ answer: 'Beta', answerSource: 'option' })
  })
})
