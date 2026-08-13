import { describe, expect, it } from 'vitest'
import { detectRendererPlatform, shortcutLabel } from '../../src/lib/platform-shortcuts'

describe('platform shortcut labels', () => {
  it('uses macOS keyboard symbols only on macOS', () => {
    expect(shortcutLabel('darwin', ['Primary', 'N'])).toBe('⌘N')
    expect(shortcutLabel('darwin', ['Primary', 'Shift', 'B'])).toBe('⌘⇧B')
    expect(shortcutLabel('darwin', ['Primary', 'Enter'])).toBe('⌘↩')
  })

  it.each(['linux', 'win32'] as const)('uses PC keyboard names on %s', (platform) => {
    expect(shortcutLabel(platform, ['Primary', 'N'])).toBe('Ctrl+N')
    expect(shortcutLabel(platform, ['Primary', 'Shift', 'B'])).toBe('Ctrl+Shift+B')
    expect(shortcutLabel(platform, ['Primary', 'Enter'])).toBe('Ctrl+Enter')
  })

  it('detects all three desktop platforms before app metadata arrives', () => {
    expect(detectRendererPlatform('MacIntel Mozilla/5.0 (Macintosh)')).toBe('darwin')
    expect(detectRendererPlatform('Win32 Mozilla/5.0 (Windows NT 10.0)')).toBe('win32')
    expect(detectRendererPlatform('Linux x86_64 Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
  })
})
