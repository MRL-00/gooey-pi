import { useEffect, useState } from 'react'

export const TOAST_DURATION_MS = 2_500

export function useToast() {
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [toast])

  return { toast, setToast }
}
