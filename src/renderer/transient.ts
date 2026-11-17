// A value shown for a moment, then put back: the tick of "copied", the sentence of something undone. One timer per use, started again by each
// showing and cancelled when the component goes: a timer left running would set the state of a component that is no longer there.

import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the tick of an address that was copied stays. */
export const COPIED_MS = 1200

/** `idle` until `show(value)` is called; `value` is then kept for `ms` milliseconds, counted from the last call. */
export function useTransient<T>(idle: T, ms: number): [T, (value: T) => void] {
  const [value, setValue] = useState(idle)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback(
    (next: T) => {
      if (timer.current !== null) clearTimeout(timer.current)
      setValue(next)
      timer.current = setTimeout(() => {
        timer.current = null
        setValue(idle)
      }, ms)
    },
    [idle, ms]
  )
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
    },
    []
  )
  return [value, show]
}
