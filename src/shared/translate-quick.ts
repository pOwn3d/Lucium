// The translation in one click: the toolbar button and its popover, « Traduire en <langue> » in the page's menu and in File, « Toujours traduire
// <langue> », « Ne jamais traduire ce site ». The rules that do not depend on Electron. The translation itself is the panel's (main/translate/controller.ts):
// the same engines in the same order (macOS's own when the pair is installed, Bergamot, the glossary), nothing sent anywhere; only the pair is chosen
// without the panel (`proposedPair`), and the panel stays one click away (« Plus d'options… »).
//
// Cost: the language of a page is read once per document and only while 'translate-local' is on (engine/electron-page.ts, as before), and it is published
// only for a page in another language than the target (`foreignLanguageOf`): a page in the language pages are translated into costs nothing more.

import { getLanguage, t } from './i18n'
import type { Settings, TabRuntime } from './model'
import { cleanSleepHosts, isSiteExcluded, normalizeSleepHost, setSiteExcluded } from './sleep'
import { primaryLanguage } from './translate-local'

// ---------- the settings ----------

/** The most languages « Toujours traduire » keeps (there are not that many languages a person reads). The sites are bounded as every list of sites. */
export const TRANSLATE_LANGUAGES_MAX = 64

/** What « Toujours traduire » may hold: language codes (two or three lower-case letters, not "und" and the like), each once, in order. Anything else is dropped. */
export function cleanTranslateLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const languages = new Set<string>()
  for (const entry of value) {
    if (typeof entry === 'string' && primaryLanguage(entry) === entry) languages.add(entry)
    if (languages.size >= TRANSLATE_LANGUAGES_MAX) break
  }
  return [...languages]
}

export type QuickTranslateSettings = Pick<Settings, 'translateAlways' | 'translateNeverSites' | 'translateSystemNoticeSeen'>

/** The settings of the one-click translation, read back from the file: the two lists cleaned, the memory of the notice true only for `true`. */
export function cleanQuickTranslateSettings(settings: QuickTranslateSettings): QuickTranslateSettings {
  return {
    translateAlways: cleanTranslateLanguages(settings.translateAlways),
    translateNeverSites: cleanSleepHosts(settings.translateNeverSites),
    translateSystemNoticeSeen: settings.translateSystemNoticeSeen === true
  }
}

/** « Toujours traduire » with a language put in or taken out. A code that is not one changes nothing. */
export function withAlwaysLanguage(list: readonly string[], language: string, on: boolean): string[] {
  const code = primaryLanguage(language)
  if (code === null || code !== language) return [...list]
  const others = list.filter((entry) => entry !== code)
  return on ? cleanTranslateLanguages([...others, code]) : others
}

/** The site of a page as « Ne jamais traduire ce site » keeps it (its host, lower case, without `www.`), or null for a page that is not on the web. */
export function translateSiteOf(url: string | undefined): string | null {
  return url !== undefined && /^https?:\/\//i.test(url) ? normalizeSleepHost(url) : null
}

/** « Ne jamais traduire ce site » with the site of a page put in or taken out (taking it out removes a parent domain that covered it too). */
export function withNeverSite(list: readonly string[], url: string, on: boolean): string[] {
  const host = translateSiteOf(url)
  return host === null ? [...list] : setSiteExcluded(list, host, on)
}

/** Whether a page is on a site that is never translated by itself: its host or a parent domain is in the list. */
export const neverTranslated = (sites: readonly string[], url: string): boolean => isSiteExcluded(url, sites)

// ---------- which pages ----------

const PDF_PATH = /\.pdf$/i

/** A web page whose text is in its document: an http(s) address that is not a PDF (the viewer draws a PDF, its text is not the page's). */
export function translatablePage(url: string | undefined): boolean {
  if (url === undefined || !/^https?:\/\//i.test(url) || !URL.canParse(url)) return false
  return !PDF_PATH.test(new URL(url).pathname)
}

/**
 * The language a page is published with (`TabRuntime.pageLanguage`): its primary language when it is another one than `target`, else '' (a page in the
 * target language, or in no language that can be told, is published as nothing).
 */
export function foreignLanguageOf(pageLanguage: string, target: string): string {
  const code = primaryLanguage(pageLanguage)
  return code !== null && code !== primaryLanguage(target) ? code : ''
}

/** What the toolbar button (and the File menu) offer for a tab. */
export interface TranslateOffer {
  /** `offered`: a page in another language, not translated; `working`: being translated; `translated`: its translation is on screen. */
  state: 'offered' | 'working' | 'translated'
  /** The language of the page: what it is translated from. */
  from: string
  /** What it is, or would be, translated into. */
  to: string
}

/**
 * What the button offers for a tab, or null where it is not drawn: the function off, no page, a page that is not on the web or is a PDF, a page in the target
 * language (or one whose language was not told). A page being translated or translated keeps it, whatever its text reads like now.
 */
export function translateOffer(on: boolean, url: string | undefined, entry: Pick<TabRuntime, 'pageLanguage' | 'translation'> | undefined, target: string): TranslateOffer | null {
  if (!on || !translatablePage(url) || entry === undefined) return null
  if (entry.translation) return { state: entry.translation.state, from: entry.translation.from, to: entry.translation.to }
  const language = entry.pageLanguage ?? ''
  if (language === '' || language === target) return null
  return { state: 'offered', from: language, to: target }
}

/**
 * Whether a page that loaded is translated by itself: the function on, a web page that is not a PDF, written in a language of « Toujours traduire » that is not
 * the target, and not on a site of « Ne jamais traduire ce site », which wins.
 */
export function translatesByItself(settings: Pick<Settings, 'translateLocal' | 'translateAlways' | 'translateNeverSites'>, url: string, language: string, target: string): boolean {
  if (!settings.translateLocal || !translatablePage(url)) return false
  if (language === '' || language === target || !settings.translateAlways.includes(language)) return false
  return !neverTranslated(settings.translateNeverSites, url)
}

// ---------- the names of the languages ----------

/** The name of a language in the language of the interface ("anglais", "English"); the code itself when the system has no name for it. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([getLanguage()], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/** A French name that takes « l' » rather than « le »: a vowel, or a mute h (« l'hébreu », « l'hindi »; « le hongrois »). */
const ELIDED = /^([aeiouyàâäéèêëîïôöùûü]|h[éeiy])/i

/**
 * A language's name as a sentence takes it. In French, every language is masculine and takes its article: `the` gives « l'anglais », « le français »;
 * `of` gives « de l'anglais », « du japonais ». In English, the name alone (« Translated from English to French »): the catalogue says which.
 */
export function languagePhrase(code: string, form: 'the' | 'of'): string {
  const language = languageName(code)
  const elided = ELIDED.test(language)
  if (form === 'the') return elided ? t('translate.lang-the-elided', { language }) : t('translate.lang-the', { language })
  return elided ? t('translate.lang-of-elided', { language }) : t('translate.lang-of', { language })
}

/**
 * The translation entry of a page's menu (right click): « Afficher l'original » for a page translated or being translated, « Traduire en <target> » for a page
 * in another language than the target; null for any other page (no entry). `pageLanguage`: what the page's `lang` (or its text, without one) says.
 */
export function translateEntryLabel(pageLanguage: string, target: string, translated: boolean): string | null {
  if (translated) return t('translate.show-original')
  return foreignLanguageOf(pageLanguage, target) !== '' ? t('translate.menu-to', { language: languageName(target) }) : null
}

/** What the toolbar button and its popover say of a page: « Page en anglais », « Traduction de l'anglais vers le français… », « Traduit de l'anglais vers le français ». */
export function translateSentence(offer: TranslateOffer): string {
  if (offer.state === 'offered') return t('translate.quick-page-in', { language: languageName(offer.from) })
  const pair = { from: languagePhrase(offer.from, 'of'), to: languagePhrase(offer.to, 'the') }
  return offer.state === 'working' ? t('translate.quick-working', pair) : t('translate.quick-translated', pair)
}

/** The languages offered when the page's own is not known, or to translate into another one (« Autre langue… »): the common ones. */
export const OTHER_LANGUAGES: readonly string[] = ['fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'sv', 'pl', 'ru', 'uk', 'ja', 'zh', 'ko', 'ar']
