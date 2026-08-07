const COMPOSER_DRAFT_KEY = 'prime-work.composer-draft'

/** Snapshot the composer's current DOM value so a crash-and-reload keeps the draft. */
export function saveComposerDraftFromDom(): void {
  try {
    const textarea = document.querySelector<HTMLTextAreaElement>('.composer textarea')
    if (textarea?.value) window.sessionStorage.setItem(COMPOSER_DRAFT_KEY, textarea.value)
  } catch { /* storage unavailable */ }
}

/** Read and clear a preserved draft; returns '' when none exists. */
export function takeComposerDraft(): string {
  try {
    const draft = window.sessionStorage.getItem(COMPOSER_DRAFT_KEY) ?? ''
    if (draft) window.sessionStorage.removeItem(COMPOSER_DRAFT_KEY)
    return draft
  } catch { return '' }
}
