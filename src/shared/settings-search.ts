// The search of the Settings window: what a typed query means, how well a row answers it, and which rows to show, best first. Pure; the window
// applies it to the rows it has drawn (`src/renderer/settings-filter.ts`), so the search covers exactly what a person reads, in the language they
// read it. A word that is not on screen may still find a row through the synonyms (settings-synonyms.ts): "sauvegarde" finds the automatic copies.
//
// What a query becomes:
// - the common words of French and English are left out, and an apostrophe splits: "taille du texte" looks for "taille texte", "ne pas me suivre"
//   for "suivre", "l'historique" for "historique";
// - a word is found at the start of a word of the row, plural, feminine and the usual endings aside: "onglet" finds "onglets", "télécharger" finds
//   "téléchargement", and "id" no longer finds "rapide";
// - where a word is found says how much it weighs: the label of the row, then the synonyms of its key, the choices of its menus, the title of its
//   group and its hint, what else it says last;
// - the rows that hold every word come first (the others only when none does); a row found by its label, a synonym or a choice hides the rows that
//   only mention the words in passing; the best one leads.

import { SETTINGS_SYNONYMS } from './settings-synonyms'
import { foldAccentsAndQuotes } from './fold'

/** The text as a search sees it: no accent, no case, straight quotes. "Mini-fenêtre" is found by "mini fenetre"'s words, "Réglages" by "reglages". */
export function foldText(text: string): string {
  return foldAccentsAndQuotes(text).replace(/[-–—_/]+/g, ' ')
}

/**
 * One character folded as `foldText` folds it, or '' for a combining mark: the folded form of a text is the concatenation, so the highlighting
 * (settings-filter.ts) can map a match in the folded text back to the characters on screen.
 */
export function foldChar(char: string): string {
  return foldAccentsAndQuotes(char).replace(/[-–—_/]/g, ' ')
}

/** The words of a text, folded: letters and digits, anything else (a space, an apostrophe, a dash, a symbol) between them. */
export function searchTokens(text: string): string[] {
  return foldText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
}

/**
 * The words a query does not look for, folded: articles, prepositions, pronouns, negations and the words of a question, in French and in English.
 * Never a word a setting is named by ("son" is a sound, "plus" is kept out, "sans" stays).
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  // French
  'a', 'au', 'aux', 'avec', 'c', 'ce', 'ces', 'cet', 'cette', 'comment', 'd', 'dans', 'de', 'des', 'du', 'elle', 'en', 'est', 'et', 'faire', 'il', 'ils',
  'j', 'je', 'l', 'la', 'le', 'les', 'leur', 'leurs', 'lui', 'm', 'ma', 'me', 'mes', 'moi', 'mon', 'n', 'ne', 'nos', 'notre', 'nous', 'on', 'ou', 'par', 'pas',
  'peux', 'plus', 'pour', 'qu', 'quand', 'que', 'quel', 'quelle', 'qui', 'quoi', 's', 'sa', 'se', 'ses', 'si', 'sont', 'sur', 't', 'ta', 'te', 'tes', 'toi',
  'ton', 'tu', 'un', 'une', 'veux', 'voudrais', 'vos', 'votre', 'vous', 'y',
  // English
  'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'don', 'for', 'from', 'how', 'i', 'in', 'into', 'is', 'it', 'its', 'my', 'no', 'not', 'of',
  'off', 'or', 'please', 'the', 'this', 'to', 'turn', 'want', 'what', 'when', 'where', 'with', 'you', 'your'
])

/** The words of a query: folded, apostrophes split, the common words left out; all of them when that leaves none (« le » alone is still looked for). */
export function queryWords(query: string): string[] {
  const all = searchTokens(query)
  const meaningful = all.filter((word) => !STOP_WORDS.has(word))
  return meaningful.length > 0 ? meaningful : all
}

// The endings taken off a word before two words are compared, longest first: the common endings of a verb and of the noun made from it
// (« télécharger », « téléchargement »; "blocking", "blocker"), after the plural. Only when what is left is still a word of four letters.
const ENDINGS = ['ements', 'ement', 'ations', 'ation', 'ings', 'ing', 'euses', 'euse', 'eurs', 'eur', 'ages', 'age', 'ees', 'ers', 'er', 'ez', 'ee', 'es', 'ed', 'e']

/** A word without its plural: "onglets" → "onglet", "ups" (of "pop-ups") → "up"; "access" keeps its two s. */
const singular = (word: string): string => (word.length > 2 && /[sx]$/.test(word) && !word.endsWith('ss') ? word.slice(0, -1) : word)

/** The plural and the final « e » taken off: "publicités" → "publicit", "sombre" → "sombr". What a word may be the start of. */
export function lightStem(word: string): string {
  const w = singular(word)
  return w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w
}

/** A word without its ending: "onglets" → "onglet", "téléchargement" and "télécharger" → "telecharg", "bloqueur" and "bloquer" → "bloqu". */
export function stem(word: string): string {
  const w = singular(word)
  for (const ending of ENDINGS) {
    if (w.endsWith(ending) && w.length - ending.length >= 4) return w.slice(0, -ending.length)
  }
  return w
}

/** The most letters a word may add after the start of a query word that lost its plural and its « e »: an ending, not another word. */
const ENDING_MAX = 4

/**
 * Whether `token` (a word of a row) is the query word `word` or begins with it: the start of the word itself, or of the word without its plural and its
 * « e » followed by a short ending ("publicités" finds "publicitaires", "gestes" does not find "gestionnaire"), or the same word with another ending
 * ("télécharger" finds "téléchargement"). A longer ending taken off never widens the start: "partage" does not find "partiel".
 */
export function wordStarts(token: string, word: string): boolean {
  if (token.startsWith(word)) return true
  const light = lightStem(word)
  const tokenLight = lightStem(token)
  return (light.length >= 3 && tokenLight.startsWith(light) && tokenLight.length - light.length <= ENDING_MAX) || stem(token) === stem(word)
}

/** Whether two words are the same word, plural, feminine and endings aside. */
export const sameWord = (a: string, b: string): boolean => a === b || stem(a) === stem(b)

/** Whether `tokens` hold a word that begins with `word`. */
const holdsStart = (tokens: readonly string[], word: string): boolean => tokens.some((token) => wordStarts(token, word))

/** Whether every word of `text` is in the text, each at the start of one of its words (the words may come in any order, anywhere in the text). */
export function matchesWords(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const tokens = searchTokens(text)
  return words.every((word) => holdsStart(tokens, word))
}

/**
 * The words of a phrase (a synonym, an answer) that the query must hold: its meaningful words, or all of them when it is made of common words only.
 */
export const phraseWords = (phrase: string): string[] => queryWords(phrase)

/**
 * Which query words name the phrase: each word of the phrase must be one of the query's (the same word, or, for the last word typed, its start of
 * `minPrefix` letters or more), in any order. Empty when one is missing.
 */
export function namingWords(words: readonly string[], phrase: readonly string[], minPrefix = 3): string[] {
  if (phrase.length === 0) return []
  const last = words.length - 1
  const named: string[] = []
  for (const part of phrase) {
    const at = words.findIndex((word, index) => sameWord(word, part) || (index === last && word.length >= minPrefix && part.startsWith(word)))
    if (at < 0) return []
    named.push(words[at]!)
  }
  return named
}

/** Whether the query is the phrase and nothing else: as many words, each the same word. */
function isWholePhrase(words: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length !== words.length) return false
  const naming = namingWords(words, phrase)
  return naming.length === words.length && new Set(naming).size === words.length
}

type Synonyms = Readonly<Record<string, readonly string[]>>

// ---------- what a row says, and how well it answers ----------

/** What a row says, by where it says it: each place weighs differently. */
export interface SearchFields {
  /** What the row is called: its label (the text of a button, or the name given to a screen reader, for a row that has no label). */
  label: string
  /** The choices of its menus and of the buttons that pick one value among several. */
  options?: string
  /** The title of the group it is drawn in. */
  group?: string
  /** The name of its category. */
  category?: string
  /** The line of help under its label. */
  hint?: string
  /** Everything else it says: the sentence of its « i », the names its controls give a screen reader, its buttons. */
  more?: string
}

/** A row as the search reads it. */
export interface SearchUnit {
  fields: SearchFields
  /** The keys the row itself carries (`data-setting`, `data-search`): the setting it is, or the search id of a row that is none. */
  ownKeys: readonly string[]
  /** The keys of the group it is drawn in: a synonym of one finds the row, but weighs as the title of its group does. */
  groupKeys?: readonly string[]
}

/**
 * How much a word weighs where it is found. The label weighs most, then a synonym of the row's own key (the words people use for it), then a choice of a
 * menu; the title of the group, a synonym of the group's key and the hint weigh as a mention; the name of the category and the rest, least.
 */
export const WEIGHTS = { label: 6, synonym: 6, options: 3, group: 2, groupSynonym: 2, hint: 2, category: 1, more: 1 } as const

/**
 * How directly a row answers: it is named (a word in its label, a synonym of its own key, a choice of its menu), it belongs to what is named (the title
 * of its group, a synonym of the group's key), or it only mentions the words (its hint, its category, what else it says).
 */
export const LEVEL = { mention: 0, group: 1, named: 2 } as const
export type MatchLevel = (typeof LEVEL)[keyof typeof LEVEL]

/** What the label adds when it is the query (+4) or starts with it (+2), and what a synonym adds to the row it names first (+1; +3 when the query is that synonym). */
export const BONUS = { exactLabel: 4, labelStart: 2, firstSynonym: 1, exactSynonym: 3 } as const

/**
 * Taken off a row that carries no key of its own: an entry of a list, a line of a summary, a link, a copy in another place. At equal words the setting
 * itself comes first ("Proxy" in Profils after « Utiliser un proxy HTTP ou SOCKS »).
 */
export const NO_KEY_PENALTY = 4

/** Below this share of the best score, a row is left out: a row that only shares a word in passing is not shown beside the ones that answer. */
export const RELATIVE_CUT = 0.5

/** A query made ready to score the rows: its words, and the rows its synonyms name. */
export interface PreparedQuery {
  words: string[]
  /** For each word (same index), the keys a synonym names, and whether it names it first (the row the synonym is mostly about). */
  named: Array<Map<string, 'first' | 'other'>>
  /** The keys a synonym names first when the whole query is that synonym ("sauvegarde", "mode sombre"). */
  exact: Set<string>
}

/** Reads a query once for all the rows it is compared with. */
export function prepareQuery(query: string, synonyms: Synonyms = SETTINGS_SYNONYMS): PreparedQuery {
  const words = queryWords(query)
  const named = words.map(() => new Map<string, 'first' | 'other'>())
  const exact = new Set<string>()
  for (const [key, targets] of Object.entries(synonyms)) {
    const phrase = phraseWords(key)
    const naming = namingWords(words, phrase)
    if (naming.length === 0) continue
    for (const word of naming) {
      const index = words.indexOf(word)
      targets.forEach((target, rank) => {
        if (rank === 0 || named[index]!.get(target) !== 'first') named[index]!.set(target, rank === 0 ? 'first' : 'other')
      })
    }
    if (targets.length > 0 && isWholePhrase(words, phrase)) exact.add(targets[0]!)
  }
  return { words, named, exact }
}

/** How a row answers a query. */
export interface UnitScore {
  score: number
  /** How many words of the query it holds, anywhere. */
  matched: number
  /** How many of them name it or its group (`LEVEL.group` or more): a word of its hint alone does not count. */
  named: number
  /** The most direct way one of them was found (`LEVEL`). */
  level: MatchLevel
}

interface Tokens {
  label: string[]
  options: string[]
  group: string[]
  category: string[]
  hint: string[]
  more: string[]
}

const tokensOf = (fields: SearchFields): Tokens => ({
  label: searchTokens(fields.label),
  options: searchTokens(fields.options ?? ''),
  group: searchTokens(fields.group ?? ''),
  category: searchTokens(fields.category ?? ''),
  hint: searchTokens(fields.hint ?? ''),
  more: searchTokens(fields.more ?? '')
})

/** The label's meaningful words. */
const labelWords = (tokens: Tokens): string[] => {
  const meaningful = tokens.label.filter((word) => !STOP_WORDS.has(word))
  return meaningful.length > 0 ? meaningful : tokens.label
}

function scoreTokens(unit: SearchUnit, tokens: Tokens, query: PreparedQuery): UnitScore {
  const { words, named, exact } = query
  const groupKeys = unit.groupKeys ?? []
  let score = 0
  let matched = 0
  let namedWords = 0
  let level: MatchLevel = LEVEL.mention
  let firstNamed = false
  words.forEach((word, index) => {
    let best = 0
    let found: MatchLevel = LEVEL.mention
    if (holdsStart(tokens.label, word)) best = WEIGHTS.label
    const names = named[index]!
    for (const key of unit.ownKeys) {
      const rank = names.get(key)
      if (rank === undefined) continue
      best = Math.max(best, WEIGHTS.synonym)
      if (rank === 'first') firstNamed = true
    }
    if (best < WEIGHTS.options && holdsStart(tokens.options, word)) best = WEIGHTS.options
    if (best > 0) found = LEVEL.named
    else if (holdsStart(tokens.group, word)) [best, found] = [WEIGHTS.group, LEVEL.group]
    else if (groupKeys.some((key) => names.has(key))) [best, found] = [WEIGHTS.groupSynonym, LEVEL.group]
    else if (holdsStart(tokens.hint, word)) best = WEIGHTS.hint
    else if (holdsStart(tokens.category, word)) best = WEIGHTS.category
    else if (holdsStart(tokens.more, word)) best = WEIGHTS.more
    if (best > 0) matched++
    if (best > 0 && found >= LEVEL.group) namedWords++
    if (best > 0 && found > level) level = found
    score += best
  })
  if (matched === 0) return { score: 0, matched: 0, named: 0, level: LEVEL.mention }
  // The label: the query itself, or its beginning (the words in order, the common ones aside).
  const label = labelWords(tokens)
  if (label.length > 0 && label.length >= words.length && words.every((word, index) => wordStarts(label[index]!, word))) {
    score += label.length === words.length && words.every((word, index) => sameWord(label[index]!, word)) ? BONUS.exactLabel : BONUS.labelStart
  }
  if (unit.ownKeys.some((key) => exact.has(key))) score += BONUS.exactSynonym
  else if (firstNamed) score += BONUS.firstSynonym
  if (unit.ownKeys.length === 0) score -= NO_KEY_PENALTY
  return { score, matched, named: namedWords, level }
}

/** A row kept by a search, with how it answered and where it was in the list given. */
export interface Ranked<T extends SearchUnit> extends UnitScore {
  unit: T
  index: number
}

export interface RankOptions {
  /** The query has an answer of its own (settings-answers.ts): the rows that only mention its words are not shown beside it. */
  answered?: boolean
  synonyms?: Synonyms
}

/**
 * The rows that answer the query, best first. Kept: the rows that the most words name (in their label, a synonym, a choice, or the title of their
 * group), the words they only mention adding to their score; when no word names any row, the rows that mention the most words. When the query has an
 * answer of its own, only the rows every word names are shown beside it. Among them, those found the most directly (`LEVEL`: named before the rows of a
 * group named), and only the rows whose score reaches half of the best. A row with no key of its own that says what a kept setting says is the same
 * thing twice (the summary of the protections above their switches) and is left out. Order: the score, then a setting before a row with no key of its
 * own, then the shorter label (« Gérer les extensions » before a long sentence that mentions them), then the order of the window.
 */
export function rankUnits<T extends SearchUnit>(units: readonly T[], query: string, options: RankOptions = {}): Array<Ranked<T>> {
  const prepared = prepareQuery(query, options.synonyms)
  if (prepared.words.length === 0) return []
  const tokens = units.map((unit) => tokensOf(unit.fields))
  const scored = units.map((unit, index) => ({ unit, index, ...scoreTokens(unit, tokens[index]!, prepared) })).filter((one) => one.matched > 0)
  const mostNamed = Math.max(0, ...scored.map((one) => one.named))
  const most = Math.max(0, ...scored.map((one) => one.matched))
  let kept = options.answered ? scored.filter((one) => one.named === prepared.words.length) : mostNamed > 0 ? scored.filter((one) => one.named === mostNamed) : scored.filter((one) => one.matched === most)
  const direct = Math.max(LEVEL.mention, ...kept.map((one) => one.level))
  kept = kept.filter((one) => one.level === direct)
  const top = Math.max(...kept.map((one) => one.score))
  if (top > 0) kept = kept.filter((one) => one.score >= top * RELATIVE_CUT)
  const keyedLabels = new Set(kept.filter((one) => one.unit.ownKeys.length > 0).map((one) => labelWords(tokens[one.index]!).join(' ')))
  kept = kept.filter((one) => one.unit.ownKeys.length > 0 || !keyedLabels.has(labelWords(tokens[one.index]!).join(' ')))
  const labelLength = (one: Ranked<T>): number => one.unit.fields.label.trim().length || Number.MAX_SAFE_INTEGER
  const keyless = (one: Ranked<T>): number => (one.unit.ownKeys.length === 0 ? 1 : 0)
  return kept.sort((a, b) => b.score - a.score || keyless(a) - keyless(b) || labelLength(a) - labelLength(b) || a.index - b.index)
}

/**
 * The words to offer when a search finds nothing: the candidates that would find something, then the names of the categories, never the word that
 * was just typed. `found` tells how many rows a word finds (the window counts them on the rows it has drawn).
 */
export function searchSuggestions(typed: string, candidates: readonly string[], categories: readonly string[], found: (word: string) => number, max = 6): string[] {
  const seen = new Set<string>([foldText(typed).trim()])
  const out: string[] = []
  for (const word of [...candidates.filter((candidate) => found(candidate) > 0), ...categories]) {
    const key = foldText(word).trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length === max) break
  }
  return out
}
