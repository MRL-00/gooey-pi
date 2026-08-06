import { describe, expect, it } from 'vitest'
import { parseExtensionUiRequest } from '../../src/lib/extension-ui'

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
