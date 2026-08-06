import { describe, expect, it } from 'vitest'
import { parseExtensionUiRequest } from '../../src/lib/extension-ui'
import { pendingExtensionUiForRuntime, type PendingExtensionUi } from '../../src/hooks/useExtensionUi'

describe('extension UI request parsing', () => {
  it('accepts a bounded multiple-choice request', () => {
    expect(parseExtensionUiRequest({
      type: 'extension_ui_request',
      id: 'question-1',
      method: 'select',
      title: 'Choose a release channel',
      options: ['Stable', 'Beta'],
      timeout: 30_000,
    })).toEqual({
      method: 'select',
      id: 'question-1',
      title: 'Choose a release channel',
      options: ['Stable', 'Beta'],
      timeout: 30_000,
    })
  })

  it('unwraps a grouped ask_user question marker for the questionnaire UI', () => {
    expect(parseExtensionUiRequest({
      type: 'extension_ui_request',
      id: 'question-1',
      method: 'select',
      title: 'Choose a release channel',
      options: ['__prime_ask_user__group-1:0:2', 'Stable', 'Beta', 'Other (type your own answer)'],
    })).toEqual({
      method: 'select',
      id: 'question-1',
      title: 'Choose a release channel',
      options: ['Stable', 'Beta', 'Other (type your own answer)'],
      questionnaire: { groupId: 'group-1', index: 0, total: 2 },
    })
  })

  it('rejects malformed or oversized options', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: [] })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['ok', 42] })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['x'.repeat(501)] })).toBeUndefined()
  })

  it('supports confirm and text input requests', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'Continue?', message: 'This will deploy.' })).toMatchObject({ method: 'confirm', id: 'confirm-1', title: 'Continue?', message: 'This will deploy.' })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'input-1', method: 'input', title: 'Name', placeholder: 'Project name' })).toMatchObject({ method: 'input', id: 'input-1', title: 'Name', placeholder: 'Project name' })
  })
})


describe('pending extension UI ownership', () => {
  it('retains background requests until their runtime becomes active', () => {
    const foreground: PendingExtensionUi = {
      runtimeId: 'runtime-a',
      request: { method: 'confirm', id: 'foreground', title: 'Continue?', message: 'Proceed' },
    }
    const background: PendingExtensionUi = {
      runtimeId: 'runtime-b',
      request: { method: 'input', id: 'background', title: 'Answer' },
    }
    const pending = new Map([
      [foreground.runtimeId, foreground],
      [background.runtimeId, background],
    ])

    expect(pendingExtensionUiForRuntime(pending, 'runtime-a')).toBe(foreground)
    expect(pendingExtensionUiForRuntime(pending, 'runtime-b')).toBe(background)
    expect(pendingExtensionUiForRuntime(pending, 'runtime-missing')).toBeNull()
    expect(pendingExtensionUiForRuntime(pending)).toBeNull()
  })
})
