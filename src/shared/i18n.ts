// The translation layer of the interface: messages are looked up by key in a catalogue, French being the language of origin.
//
//   t('menu.nouvel-onglet')                     -> 'Nouvel onglet…' (French) or 'New Tab…' (English)
//   t('toolbar.zoom-de-la-page', { mark })      -> {name} placeholders are replaced by the variables
//   tp('sidebar.tabs', count)                   -> picks 'sidebar.tabs.one' or 'sidebar.tabs.other' by the language's plural rules
//
// Rules of design:
//  - The catalogue of French (i18n-fr.ts) holds the very texts the code used to hold, typed with ordinary spaces: a French text is shown with the
//    non-breaking spaces of its typography (french-typography.ts), put in when the key is first read.
//  - Every other catalogue (i18n-en.ts) has exactly the keys of the French one (i18n.test.ts fails for one more or one less, and for a placeholder that differs).
//  - A key missing from a catalogue is read in French (and reported once), never shown as a bare key and never a blank.
//  - The language is a process-wide state: one per renderer window, one for the main process. The settings decide it (`interfaceTranslated`,
//    `language`), the system's language decides "automatic". Off, the interface is French whatever the system says.
//  - Text the user or a page wrote (tab titles, names of spaces) is never looked up: only the words of the interface itself.

import { fr } from './i18n-fr'
import { en } from './i18n-en'
import { frenchSpaces, NBSP } from './french-typography'

export const LANGUAGES = ['fr', 'en'] as const
export type Language = (typeof LANGUAGES)[number]
export const SOURCE_LANGUAGE: Language = 'fr'

/** What the setting offers: the system's language, or one of the catalogues. */
export const LANGUAGE_SETTINGS = ['auto', ...LANGUAGES] as const
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number]

/** The keys of the interface: those of the French catalogue (a key written in code that is not there does not compile). */
export type MessageKey = keyof typeof fr
export type Vars = Readonly<Record<string, string | number>>
/** A catalogue may be partial (a language being translated): the French one fills the gaps. */
export type Catalogue = Readonly<Partial<Record<string, string>>>
export type Catalogues = Readonly<Record<string, Catalogue>>

export const CATALOGUES: Catalogues = { fr, en }

/** How each language is named in its own words, for the choice in the settings. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = { fr: 'Français', en: 'English' }

/** The catalogue language a system locale ("fr-CA", "en_US", "de-DE") falls on: French for any French, English for everything else (no other catalogue yet). */
export function languageOfLocale(locale: string): Language {
  return /^fr(?:[-_]|$)/i.test(String(locale).trim()) ? 'fr' : 'en'
}

/** The setting is a language of the list, or "auto"; anything else is "auto". */
export function cleanLanguageSetting(value: unknown): LanguageSetting {
  return (LANGUAGE_SETTINGS as readonly unknown[]).includes(value) ? (value as LanguageSetting) : 'auto'
}

/** The settings the language depends on. */
export interface LanguageSettings {
  interfaceTranslated: boolean
  language: LanguageSetting
}

/**
 * The language the interface is shown in. With the function off it is French, whatever the system's language: translating is something the
 * user asks for, and nobody who did not ask sees a change.
 */
export function resolveLanguage(settings: LanguageSettings, systemLocale: string): Language {
  if (settings.interfaceTranslated !== true) return SOURCE_LANGUAGE
  const setting = cleanLanguageSetting(settings.language)
  return setting === 'auto' ? languageOfLocale(systemLocale) : setting
}

/** `{name}` is replaced by the variable of that name; one that was not given stays as written, so that the gap is visible rather than blank. */
export function format(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole))
}

/** The names of the placeholders of a message, in order of appearance, each once. */
export function placeholdersOf(template: string): string[] {
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!))]
}

export type Report = (message: string) => void

export interface Translator {
  readonly language: Language
  (key: MessageKey, vars?: Vars): string
  /** A message with a count: `key.one` or `key.other`, by the plural rules of the language (`{count}` is given). */
  plural(key: PluralBase, count: number, vars?: Vars): string
}

/** The keys that have a `.one` and a `.other` form. */
type OneFormBase<K> = K extends `${infer Base}.one` ? Base : never
export type PluralBase = OneFormBase<MessageKey>

const reportToConsole: Report = (message) => console.warn(message)

/**
 * A translator for a language over some catalogues (the real ones, or ones a test hands in). A key the language does not have is read in French
 * and reported once per key and translator; a key nobody has is shown as itself, which can only be a bug the report names.
 */
export function createTranslator(language: Language, catalogues: Catalogues = CATALOGUES, report: Report = reportToConsole): Translator {
  const own = catalogues[language] ?? {}
  const source = catalogues[SOURCE_LANGUAGE] ?? {}
  const reported = new Set<string>()
  // A French text gets its non-breaking spaces here, once per key: the catalogue is typed with ordinary ones (french-typography.ts).
  const typeset = new Map<string, string>()
  const french = (key: string, text: string): string => {
    let done = typeset.get(key)
    if (done === undefined) {
      done = frenchSpaces(text)
      typeset.set(key, done)
    }
    return done
  }
  const lookup = (key: string): string => {
    const found = own[key]
    if (found !== undefined) return language === 'fr' ? french(key, found) : found
    if (language !== SOURCE_LANGUAGE && !reported.has(key)) {
      reported.add(key)
      report(`[i18n] no "${language}" text for "${key}": the French one is shown`)
    }
    const fallback = source[key]
    if (fallback !== undefined) return french(key, fallback)
    if (!reported.has(`!${key}`)) {
      reported.add(`!${key}`)
      report(`[i18n] unknown key "${key}"`)
    }
    return key
  }
  const rules = new Intl.PluralRules(language)
  const translate = ((key: MessageKey, vars?: Vars) => format(lookup(key), vars)) as Translator
  Object.defineProperty(translate, 'language', { value: language, enumerable: true })
  Object.defineProperty(translate, 'plural', {
    value: (key: string, count: number, vars?: Vars) => {
      // "many" (French, for millions) reads as "other": the catalogues have the two forms the code needs.
      const form = rules.select(count) === 'one' ? 'one' : 'other'
      return format(lookup(`${key}.${form}`), { count, ...vars })
    },
    enumerable: true
  })
  return translate
}

// ---------- the language of this process ----------

const translators = new Map<Language, Translator>()
let current: Language = SOURCE_LANGUAGE

function translatorFor(language: Language): Translator {
  let found = translators.get(language)
  if (!found) {
    found = createTranslator(language)
    translators.set(language, found)
  }
  return found
}

/** Sets the language of this process (idempotent, and safe to call while a view renders: it notifies nobody, the views re-render from their state). */
export function setLanguage(language: Language): void {
  current = (LANGUAGES as readonly string[]).includes(language) ? language : SOURCE_LANGUAGE
}

export function getLanguage(): Language {
  return current
}

/** Sets the language from the settings and the system's locale; returns it. */
export function applyLanguage(settings: LanguageSettings, systemLocale: string): Language {
  const language = resolveLanguage(settings, systemLocale)
  setLanguage(language)
  return language
}

/** The text of a key in the language of this process. */
export const t = (key: MessageKey, vars?: Vars): string => translatorFor(current)(key, vars)

/** `text` between the quotation marks of a language (this process's by default): « text » in French, spaced the French way, “text” in English. */
export const quoted = (text: string, language: Language = current): string => (language === 'en' ? `“${text}”` : `«${NBSP}${text}${NBSP}»`)

/** The text of a key that depends on a count, in the language of this process. */
export const tp = (key: PluralBase, count: number, vars?: Vars): string => translatorFor(current).plural(key, count, vars)

/** The text of a key in a given language, whatever the one of this process is (the settings show each language's own name; tests compare). */
export const tIn = (language: Language, key: MessageKey, vars?: Vars): string => translatorFor(language)(key, vars)

// ---------- the catalogues' own consistency (what the test of i18n.test.ts runs; exported so that it can be run on any pair) ----------

export interface CatalogueDiff {
  /** Keys of the reference the other does not have. */
  missing: string[]
  /** Keys the other has that the reference does not. */
  extra: string[]
  /** Keys whose placeholders differ from the reference's. */
  placeholders: string[]
  /** Keys with a blank text. */
  blank: string[]
}

export function diffCatalogues(reference: Catalogue, other: Catalogue): CatalogueDiff {
  const refKeys = Object.keys(reference)
  const otherKeys = Object.keys(other)
  return {
    missing: refKeys.filter((key) => !Object.hasOwn(other, key)),
    extra: otherKeys.filter((key) => !Object.hasOwn(reference, key)),
    placeholders: refKeys.filter((key) => Object.hasOwn(other, key) && placeholdersOf(reference[key] ?? '').sort().join() !== placeholdersOf(other[key] ?? '').sort().join()),
    blank: otherKeys.filter((key) => (other[key] ?? '').trim() === '')
  }
}

export const isConsistent = (diff: CatalogueDiff): boolean => Object.values(diff).every((list) => list.length === 0)
