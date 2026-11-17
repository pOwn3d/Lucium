// The names of other browsers and of their makers that no shot of the import may show (`import`, `import-done`, `first-launch`), nor any image of
// the features page (features.ts; there, a few ordinary words in lower case are not names: `namesShown`). The public site speaks of « votre
// navigateur actuel », never of a brand. The list is the one the site checks its own pages with (pages.test.mjs of lucium-website, BROWSER_NAMES).
// scripts/site-captures.mjs reads the text of the window before taking such a shot and refuses it when one of these names is there; for the
// features page, it also reads the text of the image itself when tesseract is installed.
// Pure, and loaded by Node with type stripping: no runtime import, no enum, no parameter property.

export const OTHER_BROWSER_NAMES: readonly string[] = [
  'Arc', 'Chrome', 'Chromium', 'Safari', 'Firefox', 'Brave', 'Edge', 'Vivaldi', 'Zen', 'Opera', 'Dia', 'Orion', 'LibreWolf', 'Waterfox',
  'Floorp', 'Tor Browser', 'The Browser Company', 'Google', 'Mozilla', 'Microsoft', 'Apple', 'DuckDuckGo', 'Bing', 'Netflix', 'Widevine'
]

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A name counts only as a whole word, whatever its case: letters or digits of any script around it do not belong to it. */
const NAMES = new RegExp(`(?<![\\p{L}\\p{N}])(?:${OTHER_BROWSER_NAMES.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu')

/** The names of other browsers found in a text, each once, as written there. */
export function browserNamesIn(text: string): string[] {
  return [...new Set([...text.matchAll(NAMES)].map((match) => match[0]))]
}

/**
 * The text an image of the features page shows, without the ordinary words that are also a name once the case is ignored, written in lower case
 * (« the bottom edge of the page », « un arc »): the site makes the same exceptions, phrase by phrase (NAME_EXCEPTIONS of its pages.test.mjs). A
 * capitalised Edge or Arc, `arc://`, and the identifiers of the API of the extensions (`chrome.tabGroups`, `chrome.omnibox`) are still names: the
 * site shows none of them, nor the name of the store of the extensions.
 */
export const withoutOrdinaryWords = (text: string): string => text.replace(/(?<![\p{L}\p{N}])(?:edges?|arcs?|zen)(?![\p{L}\p{N}]|:\/\/)/gu, ' ')

/** The names of other browsers an image of the features page would show: in the text read on screen, or in the text read in the image itself. */
export const namesShown = (text: string): string[] => browserNamesIn(withoutOrdinaryWords(text))
