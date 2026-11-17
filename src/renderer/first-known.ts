import { useRef, type RefObject } from 'react'

/**
 * What a value was the first time it was known (`known`: the snapshot has come), kept for as long as the panel is open: what "Réinitialiser" and Escape go
 * back to. The value is taken once, whatever it is: a value that was absent then (a space with no background) stays absent, and what the panel adds later
 * is not mistaken for how things were.
 */
export function useFirstKnown<T>(known: boolean, value: T): RefObject<T | undefined> {
  const first = useRef<T | undefined>(undefined)
  const taken = useRef(false)
  if (known && !taken.current) {
    taken.current = true
    first.current = value
  }
  return first
}
