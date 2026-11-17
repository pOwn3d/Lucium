// The search of the Settings window, applied to the rows it has drawn (shared/settings-search.ts says how well each answers): the categories are drawn
// one under the other, and what the search does not keep is hidden. The search thus covers what a person reads, in the language they read it, and a
// row that is found is the real row, with its switch; a word that is not on screen still finds a row through the synonyms of its key
// (shared/settings-synonyms.ts). Each row is read by parts (its label, the choices of its menus, its hint, the title of its group…), since a word in
// the label says more than a word in passing. The words found are highlighted with the Custom Highlight API, which paints ranges without touching
// the markup React owns. Plain DOM, no state: the window calls it after every draw, since a list that grew has new rows.

import { foldChar, foldText, lightStem, rankUnits, stem, type SearchFields, type SearchUnit } from '@shared/settings-search'

/** The rows of a pane: a row, a callout, the line that holds buttons, the grid of the icons. The notes, titles and heroes around them are hidden by the sheet while a search shows. */
export const UNIT_SELECTOR = '.pref-row, .pref-callout, .pref-buttons, .icon-grid'

/** The name of the highlight the sheet paints (`::highlight(settings-hit)`). */
export const HIGHLIGHT_NAME = 'settings-hit'

/** The mark of the row a search puts first: Enter in the search field opens it (SettingsWindow.tsx). */
export const BEST_ATTRIBUTE = 'data-search-best'

export interface Unit extends SearchUnit {
  el: HTMLElement
  /** What the unit says, with the title of its group and of its category: what a word offered when nothing matches is counted on. */
  text: string
  /** The settings the unit stands for (its own, its group's), and its search id: what a synonym may name. */
  keys: string[]
  /** Where it lives, as the window names it: its category, the subpage it is on ('' for none), and the title of its group ('' for a group without one). */
  place: { category: string; subpage: string; group: string }
}

/**
 * What every line of « Fonctions en option » says, whatever the feature: its cost in a sentence and the button « En savoir plus ». Never read: a search
 * for « réseau » or « mémoire » is not after every feature that uses them.
 */
const SAID_OF_EVERY_FEATURE = '.pref-cost, .pref-more-toggle'

/** What is inside a row and is not its name: its hint, the way to where it lives, its « i », the marks after its name, the cost and the whole text of a feature. */
const NOT_LABEL = `.pref-hint, .pref-open, .pref-info, .pref-changed, .pref-profile, .pref-count, .sr-only, .pref-more-text, ${SAID_OF_EVERY_FEATURE}, select, option, textarea, script, style`

/** The text of the text nodes under `el`, without those inside what `skip` names. */
function textUnder(el: Element, skip: string): string {
  const parts: string[] = []
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest(skip) || !el.contains(node.parentElement.closest(skip))) parts.push(node.nodeValue ?? '')
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** The words of an element as a person reads them: its text without the entries of its menus, and the labels and tooltips of what it holds. */
function textOf(el: Element): string {
  const parts = [textUnder(el, `select, option, textarea, script, style, .pref-open, ${SAID_OF_EVERY_FEATURE}`)]
  for (const holder of [el, ...Array.from(el.querySelectorAll('[aria-label], [title], [placeholder]'))]) {
    for (const name of ['aria-label', 'title', 'placeholder']) {
      const value = holder.getAttribute(name)
      if (value) parts.push(value)
    }
  }
  return parts.join(' ')
}

/**
 * What the unit is called: the text of its label; for a unit without one, the name it gives a screen reader, or the text of its buttons (« Exporter les
 * données »). Empty for a message of a list or a form, which are found by what else they say.
 */
function labelOf(el: HTMLElement): string {
  const label = el.matches('.pref-label') ? el : el.querySelector('.pref-label')
  if (label) return textUnder(label, NOT_LABEL)
  const named = el.getAttribute('aria-label')
  if (named) return named
  if (el.matches('.pref-buttons')) return Array.from(el.querySelectorAll('button'), (button) => button.textContent ?? '').join(' ').trim()
  return ''
}

/** The choices the unit offers: the entries of its menus, and the buttons that pick one value among several (the icons of the application). */
const choicesOf = (el: HTMLElement): string[] => Array.from(el.querySelectorAll('option, [role="radio"]'), (choice) => choice.textContent ?? '')

/** What is said of a choice between brackets (« 10 px (par défaut) », « Aucun (fenêtre opaque) »): a remark, not the name of the choice. */
const REMARK = /\([^)]*\)/g

/** The keys an element carries: `data-setting` (one or several, space-separated) and `data-search`. */
const keysOn = (el: HTMLElement | null | undefined): string[] => [el?.dataset['setting'], el?.dataset['search']].flatMap((value) => (value ? value.split(' ') : []))

/** Every unit under `root`, with what a search reads in it, part by part. */
export function collectUnits(root: HTMLElement): Unit[] {
  const elements = Array.from(root.querySelectorAll<HTMLElement>(UNIT_SELECTOR))
  const sections = elements.map((el) => el.closest<HTMLElement>('.pref-section'))
  const rowsOf = new Map<HTMLElement | null, number>()
  for (const section of sections) rowsOf.set(section, (rowsOf.get(section) ?? 0) + 1)
  return elements.map((el, index) => {
    const section = sections[index]!
    const group = section?.querySelector(':scope > h3 .pref-title, :scope > details > summary > h3 .pref-title')?.textContent ?? ''
    const category = el.closest<HTMLElement>('[data-category-label]')?.dataset['categoryLabel'] ?? ''
    const subpage = el.closest<HTMLElement>('[data-subpage-label]')?.dataset['subpageLabel'] ?? ''
    const own = keysOn(el)
    const groupKeys = keysOn(section)
    // A group that says its setting and draws one row (« Langue », « Fenêtres autorisées ») says it of that row.
    const ownKeys = own.length === 0 && section !== null && rowsOf.get(section) === 1 ? groupKeys : own
    const said = textOf(el)
    const choices = choicesOf(el)
    const fields: SearchFields = {
      label: labelOf(el),
      options: choices.map((choice) => choice.replace(REMARK, ' ')).join(' '),
      group,
      category,
      hint: Array.from(el.querySelectorAll('.pref-hint'), (hint) => hint.textContent ?? '').join(' '),
      more: [said, ...choices.flatMap((choice) => choice.match(REMARK) ?? [])].join(' ')
    }
    return { el, text: `${said} ${group} ${category}`, keys: [...own, ...groupKeys], ownKeys, groupKeys, fields, place: { category, subpage, group } }
  })
}

/** What a search did to the rows: all of them, how many it shows, those it shows in the order of how well they answer, the best one first. */
export interface SearchOutcome {
  units: Unit[]
  shown: number
  ranked: Unit[]
  best: Unit | null
}

/**
 * Hides what the query does not keep, and the groups and categories left empty; shows the rest, marks the best one, and highlights the words found.
 * `answered`: the query has an answer of its own (shared/settings-answers.ts), so a row that only mentions its words is not shown beside it.
 */
export function applySearch(root: HTMLElement, query: string, words: readonly string[], options: { answered?: boolean } = {}): SearchOutcome {
  const units = collectUnits(root)
  const ranked = rankUnits(units, query, { answered: options.answered }).map((one) => one.unit)
  const kept = new Set(ranked)
  for (const unit of units) {
    unit.el.hidden = !kept.has(unit)
    unit.el.removeAttribute(BEST_ATTRIBUTE)
  }
  const best = ranked[0] ?? null
  best?.el.setAttribute(BEST_ATTRIBUTE, '')
  for (const section of Array.from(root.querySelectorAll<HTMLElement>('.pref-section'))) {
    section.hidden = section.querySelector(`:is(${UNIT_SELECTOR}):not([hidden])`) === null
  }
  for (const category of Array.from(root.querySelectorAll<HTMLElement>('[data-category-label]'))) {
    category.hidden = category.querySelector(`:is(${UNIT_SELECTOR}):not([hidden])`) === null
  }
  highlightWords(
    ranked.map((unit) => unit.el),
    words
  )
  return { units, shown: ranked.length, ranked, best }
}

/** The length of the start of the folded word `token` that the query word `word` covers: the word itself, or its stem; 0 when it does not start it. */
function startCovered(token: string, word: string): number {
  if (token.startsWith(word)) return word.length
  const light = lightStem(word)
  if (light.length >= 3 && token.startsWith(light)) return light.length
  const root = stem(word)
  return root.length >= 3 && stem(token) === root ? root.length : 0
}

/**
 * The ranges of `words` in the text nodes of `el`, found at the start of its words on the folded text and mapped back to the characters on screen
 * ("Mini-fenêtre" for "fenetre"): a word inside another ("id" in "rapide") is not painted, as it is not found.
 */
export function wordRanges(el: HTMLElement, words: readonly string[]): Range[] {
  const ranges: Range[] = []
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(`select, option, textarea, script, style, .pref-open, .pref-count, ${SAID_OF_EVERY_FEATURE}`)) continue
    const text = node.nodeValue ?? ''
    // The folded text, and for each of its characters the index of the character of the screen it comes from.
    let folded = ''
    const origin: number[] = []
    for (let index = 0; index < text.length; index++) {
      const piece = foldChar(text[index]!)
      for (let k = 0; k < piece.length; k++) origin.push(index)
      folded += piece
    }
    for (const match of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
      const covered = Math.max(0, ...words.filter((word) => word.length >= 2).map((word) => startCovered(match[0], word)))
      if (covered === 0) continue
      const range = el.ownerDocument.createRange()
      range.setStart(node, origin[match.index]!)
      range.setEnd(node, origin[match.index + Math.min(covered, match[0].length) - 1]! + 1)
      ranges.push(range)
    }
  }
  return ranges
}

/** Paints the words found in the units shown, with the Custom Highlight API; nothing where the browser lacks it (nothing is lost: the rows are still there). */
export function highlightWords(units: readonly HTMLElement[], words: readonly string[]): void {
  const registry = (globalThis as { CSS?: { highlights?: { set: (name: string, highlight: unknown) => void; delete: (name: string) => void } } }).CSS?.highlights
  const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  if (!registry || !HighlightCtor) return
  const found = words.map((word) => foldText(word)).filter((word) => word !== '')
  const ranges = units.flatMap((el) => wordRanges(el, found))
  if (ranges.length === 0) registry.delete(HIGHLIGHT_NAME)
  else registry.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges))
}

/** Forgets the highlight (the search was cleared). */
export function clearHighlight(): void {
  ;(globalThis as { CSS?: { highlights?: { delete: (name: string) => void } } }).CSS?.highlights?.delete(HIGHLIGHT_NAME)
}
