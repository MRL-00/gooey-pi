import { useCallback, useLayoutEffect, useRef } from 'react'

/** Keep callback identity stable while always invoking the latest render's implementation. */
export function useStableCallback<Arguments extends unknown[], ReturnValue>(
  callback: (...args: Arguments) => ReturnValue,
): (...args: Arguments) => ReturnValue {
  const callbackRef = useRef(callback)
  useLayoutEffect(() => { callbackRef.current = callback })
  return useCallback((...args: Arguments) => callbackRef.current(...args), [])
}
