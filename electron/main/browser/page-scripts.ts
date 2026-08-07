/**
 * JavaScript source strings injected into agent-controlled browser guests.
 * Everything these scripts return is untrusted page data: callers must bound
 * and sanitize it before it reaches the agent or the renderer. Dynamic values
 * are embedded via JSON.stringify (strings) or validated integers only, so
 * hostile inputs cannot break out of the script text.
 */

const INTERACTIVE_SELECTOR = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="combobox"], [role="option"], [role="switch"], [contenteditable="true"], [onclick]'

function boundedInt(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  return value
}

/**
 * Collects visible interactive elements, numbers them, and stashes the live
 * element list on the page so later ref-based actions can find them again.
 * Refs are invalidated by navigation (the stored URL no longer matches).
 */
export function readPageScript(mode: 'interactive' | 'text', maxTextChars: number, maxElements: number): string {
  const textLimit = boundedInt(maxTextChars, 0, 200_000, 'maxTextChars')
  const elementLimit = boundedInt(maxElements, 0, 1_000, 'maxElements')
  const includeText = mode === 'text'
  return `(() => {
    const selector = ${JSON.stringify(INTERACTIVE_SELECTOR)}
    const bound = (value, limit) => typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim().slice(0, limit) : ''
    const visible = (el) => {
      if (!el.isConnected) return false
      const rects = el.getClientRects()
      if (!rects.length) return false
      const style = window.getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none'
    }
    const name = (el) => {
      const aria = el.getAttribute('aria-label')
      if (aria) return bound(aria, 120)
      if (el.labels && el.labels.length) return bound(el.labels[0].textContent, 120)
      const placeholder = el.getAttribute('placeholder')
      if (placeholder) return bound(placeholder, 120)
      const alt = el.getAttribute('alt')
      if (alt) return bound(alt, 120)
      const text = bound(el.textContent, 120)
      if (text) return text
      const title = el.getAttribute('title')
      if (title) return bound(title, 120)
      return bound(el.getAttribute('name') || el.id || '', 120)
    }
    const refs = []
    const elements = []
    for (const el of document.querySelectorAll(selector)) {
      if (elements.length >= ${elementLimit}) break
      if (!visible(el)) continue
      const ref = refs.length
      refs.push(el)
      const entry = {
        ref,
        tag: el.tagName.toLowerCase(),
        name: name(el),
      }
      const role = el.getAttribute('role')
      if (role) entry.role = bound(role, 32)
      if (entry.tag === 'a') entry.href = bound(el.getAttribute('href') || '', 200)
      if (entry.tag === 'input') {
        entry.inputType = bound(el.getAttribute('type') || 'text', 32)
        if (entry.inputType !== 'password' && typeof el.value === 'string') entry.value = bound(el.value, 120)
        if (el.checked === true) entry.checked = true
      }
      if (entry.tag === 'select' && typeof el.value === 'string') entry.value = bound(el.value, 120)
      if (el.disabled === true) entry.disabled = true
      elements.push(entry)
    }
    window.__primeWorkAgentRefs = refs
    window.__primeWorkAgentRefsUrl = location.href
    const result = {
      url: String(location.href).slice(0, 2000),
      title: bound(document.title, 300),
      elements,
    }
    if (${includeText}) result.text = (document.body ? document.body.innerText : '').slice(0, ${textLimit})
    return JSON.stringify(result)
  })()`
}

/**
 * Scrolls the referenced element into view and reports its viewport-relative
 * center so the caller can dispatch trusted input events at that point.
 */
export function refPointScript(ref: number, focus: boolean): string {
  const index = boundedInt(ref, 0, 999, 'ref')
  return `(() => {
    const refs = window.__primeWorkAgentRefs
    if (!Array.isArray(refs) || window.__primeWorkAgentRefsUrl !== location.href) return JSON.stringify({ error: 'Element refs are stale. Call browser_read_page again to refresh them.' })
    const el = refs[${index}]
    if (!el || !el.isConnected) return JSON.stringify({ error: 'That element ref no longer exists on the page. Call browser_read_page again.' })
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    ${focus ? 'if (typeof el.focus === "function") el.focus()' : ''}
    const rect = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) })
  })()`
}

export function scrollByScript(deltaX: number, deltaY: number): string {
  const dx = boundedInt(deltaX, -100_000, 100_000, 'deltaX')
  const dy = boundedInt(deltaY, -100_000, 100_000, 'deltaY')
  return `(() => {
    window.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' })
    const root = document.scrollingElement || document.documentElement
    return JSON.stringify({ scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), scrollHeight: root ? root.scrollHeight : 0, viewportHeight: window.innerHeight })
  })()`
}

export function pageInfoScript(): string {
  return `(() => JSON.stringify({
    url: String(location.href).slice(0, 2000),
    title: (document.title || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollY: Math.round(window.scrollY),
    scrollHeight: (document.scrollingElement || document.documentElement || {}).scrollHeight || 0,
    readyState: document.readyState,
  }))()`
}

/** Runs agent-authored code as an async function body and returns bounded JSON. */
export function evaluateScript(code: string, maxResultChars: number): string {
  const limit = boundedInt(maxResultChars, 1, 100_000, 'maxResultChars')
  return `(async () => {
    try {
      const value = await (async () => { ${code} })()
      let rendered
      try { rendered = JSON.stringify(value) } catch { rendered = undefined }
      if (rendered === undefined) rendered = String(value)
      return JSON.stringify({ ok: true, value: rendered.slice(0, ${limit}) })
    } catch (error) {
      return JSON.stringify({ ok: false, error: String(error).slice(0, 2000) })
    }
  })()`
}
