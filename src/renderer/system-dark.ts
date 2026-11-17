// Whether macOS is in its dark appearance, for the themes whose appearance is "automatic". A hook, so that a surface that stays open (the lock
// screen, a peek, the theme editor, the mini window, the sheet of a new space) is drawn again when the system changes, without waiting for
// something else to draw it.

import { useEffect, useState } from 'react'

const QUERY = '(prefers-color-scheme: dark)'

/** Follows the system appearance: true while it is dark. */
export function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(QUERY)
    const onChange = () => setDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return dark
}
