import { describe, expect, it, vi } from 'vitest'
import askUser, { type OmpExtensionApi } from '../../assets/extensions/omp-work-ask-user'

interface ToolContext {
  hasUI: boolean
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>
  }
}

interface RegisteredTool {
  name: string
  label: string
  description: string
  parameters: unknown
  execute(
    toolCallId: string,
    params: { questions: Array<{ question: string; options: string[] }> },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ToolContext,
  ): Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>
}

function fixture() {
  const tools: RegisteredTool[] = []
  const schema = (kind: string) => (...args: unknown[]) => ({ kind, args })
  const pi = {
    typebox: { Type: { Object: schema('object'), String: schema('string'), Array: schema('array') } },
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  }
  askUser(pi as unknown as OmpExtensionApi)
  const tool = tools[0]
  if (!tool) throw new Error('ask_user was not registered')
  return { tools, tool }
}

describe('omp-work-ask-user extension', () => {
  it('registers a standalone sequential ask_user tool', () => {
    const { tools, tool } = fixture()
    expect(tools).toHaveLength(1)
    expect(tool).toMatchObject({ name: 'ask_user', label: 'Ask user' })
    expect(tool.description).toContain('one to five')
    expect(tool.parameters).toBeDefined()
  })

  it('groups OMP select requests and decodes app answers with context', async () => {
    const { tool } = fixture()
    const select = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ answer: 'Beta', answerSource: 'option', context: 'For the pilot' }))
      .mockResolvedValueOnce(JSON.stringify({ answer: 'A custom priority', answerSource: 'freeform' }))
    const result = await tool.execute('call-1', { questions: [
      { question: 'Which release channel?', options: ['Stable', 'Beta'] },
      { question: 'What should I optimize for?', options: ['Speed', 'Other'] },
    ] }, undefined, undefined, { hasUI: true, ui: { select } })

    expect(select).toHaveBeenCalledTimes(2)
    const firstOptions = select.mock.calls[0][1] as string[]
    const secondOptions = select.mock.calls[1][1] as string[]
    expect(firstOptions[0]).toMatch(/^__prime_ask_user__[a-z0-9-]+:0:2$/)
    expect(secondOptions[0]).toBe(firstOptions[0].replace(/:0:2$/, ':1:2'))
    expect(firstOptions.slice(1)).toEqual(['Stable', 'Beta', 'Other (type your own answer)'])
    expect(secondOptions.slice(1)).toEqual(['Speed', 'Other (type your own answer)'])
    expect(result.content[0].text).toBe('1. The user selected: Beta\nAdditional context: For the pilot\n\n2. The user answered: A custom priority')
    expect(result.details).toMatchObject({ cancelled: false, answers: [
      { answer: 'Beta', answerSource: 'option', context: 'For the pilot' },
      { answer: 'A custom priority', answerSource: 'freeform' },
    ] })
  })

  it('returns a bounded cancellation result when UI is unavailable', async () => {
    const { tool } = fixture()
    const result = await tool.execute('call-1', {
      questions: [{ question: 'Continue?', options: ['Yes', 'No'] }],
    }, undefined, undefined, { hasUI: false, ui: { select: vi.fn() } })
    expect(result.content[0].text).toContain('not available')
    expect(result.details).toMatchObject({ answers: [], cancelled: true })
  })
})
