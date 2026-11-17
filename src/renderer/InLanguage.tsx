import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { Language } from '@shared/i18n'
import { api } from './api'
import { languageOfSnapshot } from './document-language'

/**
 * Draws its children once the language of the interface is known, for a view that reads no snapshot of its own: each view is a page apart, and a
 * page reads French until something sets its language. Read again when the view takes the focus, as the settings may have changed meanwhile;
 * the children are drawn afresh in the new language.
 */
export function InLanguage({ children }: { children: ReactNode }) {
  const [known, setKnown] = useState<Language | null>(null)
  useEffect(() => {
    let live = true
    const read = () => void languageOfSnapshot(document.documentElement, () => api().getSnapshot(), navigator.language).then((language) => live && setKnown(language))
    read()
    window.addEventListener('focus', read)
    return () => {
      live = false
      window.removeEventListener('focus', read)
    }
  }, [])
  return known ? <Fragment key={known}>{children}</Fragment> : null
}
