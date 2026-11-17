// The language of the interface, said on the root of the document as well as set for the texts: a screen reader takes its voice from `lang`, and every
// page of the renderer is written with `lang="fr"`. A window that sets its language any other way reads English with the French pronunciation, so
// this module is the only place of the renderer that sets it (document-language.test.ts keeps it so).

import { applyLanguage, getLanguage, setLanguage, type Language, type LanguageSettings } from '@shared/i18n'

/** The root of a document, as far as its language goes. */
export interface LanguageRoot {
  lang: string
  hasAttribute(name: string): boolean
}

/** Writes `language` on the root. The Settings window is translated in part only: its root keeps the language of origin and its translated parts say their own (see SettingsWindow). */
export function sayLanguage(root: LanguageRoot, language: Language): Language {
  if (!root.hasAttribute('data-lang-parts') && root.lang !== language) root.lang = language
  return language
}

/** For a view that draws a snapshot: the language its settings ask for, set for the texts and said on the root. */
export function followLanguage(root: LanguageRoot, settings: LanguageSettings, systemLocale: string): Language {
  return sayLanguage(root, applyLanguage(settings, systemLocale))
}

/** For a small window that is told its language in its address (`?lang=en`): set for the texts and said on the root. An unknown one is the language of origin. */
export function languageFromAddress(root: LanguageRoot, search: string): Language {
  setLanguage(new URLSearchParams(search).get('lang') as Language)
  return sayLanguage(root, getLanguage())
}

/**
 * For a view that draws no snapshot of its own (the views of a mini window, the header of a site opened as an application): reads one for its
 * settings alone, sets the language for the texts and says it on the root. A reading that fails is written to the log and leaves the language
 * the view already has: it is drawn all the same.
 */
export async function languageOfSnapshot(root: LanguageRoot, read: () => Promise<{ state: { settings: LanguageSettings } } | null | undefined>, systemLocale: string): Promise<Language> {
  try {
    const snapshot = await read()
    if (snapshot) return followLanguage(root, snapshot.state.settings, systemLocale)
    console.error(`[language] no snapshot was given to read the language of the interface from: this view keeps ${getLanguage()}`)
  } catch (error) {
    console.error(`[language] the language of the interface could not be read, this view keeps ${getLanguage()}:`, error)
  }
  return getLanguage()
}
