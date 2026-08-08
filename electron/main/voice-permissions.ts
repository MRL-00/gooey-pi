function exactRendererUrl(actualUrl: string, expectedUrl: string): boolean {
  try {
    const actual = new URL(actualUrl)
    const expected = new URL(expectedUrl)
    actual.hash = ''
    expected.hash = ''
    return actual.href === expected.href
  } catch { return false }
}

export function isAllowedRendererAudioPermission(currentUrl: string, mainFrameUrl: string, expectedUrl: string, mediaTypes: readonly string[] | undefined): boolean {
  return Boolean(expectedUrl && mediaTypes?.length && mediaTypes.every((type) => type === 'audio')
    && exactRendererUrl(currentUrl, expectedUrl)
    && exactRendererUrl(mainFrameUrl, expectedUrl))
}
