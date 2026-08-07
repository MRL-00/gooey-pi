import { useCallback, useRef, useState } from 'react'
import { addAnnotation, type BrowserAnnotationInput, createAnnotation, MAX_BROWSER_ANNOTATIONS, reconcileAnnotationsForUrl, removeAnnotation } from '@/lib/browser-annotations'
import type { BrowserAnnotation } from '@/types/api'

export interface BrowserAnnotationsApi {
  annotations: BrowserAnnotation[]
  atCapacity: boolean
  /** Returns false when the 20-annotation cap blocks the add. */
  add(input: BrowserAnnotationInput): boolean
  remove(id: string): void
  clear(): void
  /** Marks annotations from other pages stale after a full navigation; returning to a page revives its markers. */
  handleNavigation(url: string): void
}

/** Owns the browser annotation set shared by the inspector BrowserPanel (capture, markers) and the Composer (attachment, prompt payload). */
export function useBrowserAnnotations(): BrowserAnnotationsApi {
  const [annotations, setAnnotations] = useState<BrowserAnnotation[]>([])
  const annotationsRef = useRef(annotations)
  const commit = useCallback((next: BrowserAnnotation[]) => {
    annotationsRef.current = next
    setAnnotations(next)
  }, [])

  const add = useCallback((input: BrowserAnnotationInput) => {
    const result = addAnnotation(annotationsRef.current, createAnnotation(input, crypto.randomUUID(), Date.now()))
    if (!result.ok) return false
    commit(result.annotations)
    return true
  }, [commit])
  const remove = useCallback((id: string) => commit(removeAnnotation(annotationsRef.current, id)), [commit])
  const clear = useCallback(() => commit([]), [commit])
  const handleNavigation = useCallback((url: string) => commit(reconcileAnnotationsForUrl(annotationsRef.current, url)), [commit])

  return { annotations, atCapacity: annotations.length >= MAX_BROWSER_ANNOTATIONS, add, remove, clear, handleNavigation }
}
