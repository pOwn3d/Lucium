// Whether motion should be kept down now: the system's wish (macOS « Réduire les animations », the media query prefers-reduced-motion), followed as it
// changes. Lucium's own switch (`forceReduceMotion`, shared/accessibility.ts) only adds to it: callers OR it with the setting.

import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/** The system asks for less motion; false where there is no window to ask (the static render of a test). */
export function useSystemReducedMotion(): boolean {
  const [asks, setAsks] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(QUERY)
    const listen = () => setAsks(list.matches)
    listen()
    list.addEventListener('change', listen)
    return () => list.removeEventListener('change', listen)
  }, [])
  return asks
}
