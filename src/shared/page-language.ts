// The language a page is written in, as the translation menu reads it.

import { detectLanguage } from './translate-local'

/**
 * The language the menu judges a page by. The `lang` attribute decides when the page declares one. Without it, the words of the visible
 * text decide, with the same local detector as the translation panel (a clear sentence of another language is enough; nothing is sent).
 * Empty when neither says a language clearly.
 */
export function pageLanguageOf(declared: string, sampleText: string): string {
  if (declared.trim() !== '') return declared
  return detectLanguage(sampleText, null).language ?? ''
}
