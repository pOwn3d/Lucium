// The name of the small one-page window ("mini window"), in the words of the interface. ONE place decides it: the catalogues (i18n-fr.ts,
// i18n-en.ts) build every sentence that names the window from these words, so changing the name is changing the two lines below.
//
// The window used to carry the name of another browser's feature; it does not any more (the product must not use another browser's names for its own
// functions). Internal identifiers keep their old spelling (`littlearc.html`, `LittleArc`, the setting `externalLinksInLittleArc`, the keys
// of the catalogues): they are not shown to anyone, and renaming them would only break saved settings and shortcuts.
//
// French sentences of the catalogue take the noun as FEMININE ("une mini-fenêtre", "la mini-fenêtre"): a masculine name needs its articles
// read again (i18n-fr.ts, search for `little.`).

export type LittleLanguage = 'fr' | 'en'

/** The noun, singular and plural, lower case, as it is written inside a sentence. */
export const LITTLE_NAME: Readonly<Record<LittleLanguage, { readonly singular: string; readonly plural: string }>> = {
  fr: { singular: 'mini-fenêtre', plural: 'mini-fenêtres' },
  en: { singular: 'mini window', plural: 'mini windows' }
}

export interface LittleForms {
  /** In a sentence: "mini-fenêtre", "mini window". */
  readonly s: string
  /** Plural, in a sentence: "mini-fenêtres", "mini windows". */
  readonly p: string
  /** Start of a sentence, or a title: "Mini-fenêtre", "Mini window". */
  readonly S: string
  /** A menu item in English is in title case: "Mini Window" (French menus only capitalise the first word, as `S`). */
  readonly title: string
  /** Same, plural: "Mini Windows". */
  readonly titles: string
}

const upperFirst = (text: string): string => (text === '' ? text : text[0]!.toUpperCase() + text.slice(1))
const upperWords = (text: string): string => text.replace(/(^|[\s-])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase())

/** The forms of the name in a language; the catalogues are the only readers. */
export function littleForms(language: LittleLanguage, names = LITTLE_NAME): LittleForms {
  const { singular, plural } = names[language]
  // French menus and titles keep the hyphenated noun as one word ("Mini-fenêtre"); English ones capitalise each word ("Mini Window").
  return language === 'en'
    ? { s: singular, p: plural, S: upperFirst(singular), title: upperWords(singular), titles: upperWords(plural) }
    : { s: singular, p: plural, S: upperFirst(singular), title: upperFirst(singular), titles: upperFirst(plural) }
}
