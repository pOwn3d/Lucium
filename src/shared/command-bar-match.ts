// How the command bar compares what is typed with a name: folded text (case, accents, quotes) and the score of a match. Moved out of
// command-bar.ts as it was.

import { foldAccentsAndQuotes } from './fold'

/** Names (spaces, panes, extensions) are not offered for a single letter: it would list half of them for every keystroke. */
const MIN_NAME_QUERY = 2

/** Lower case, without accents, with the typographic apostrophe typed as the keyboard's: "deplacer" finds "Déplacer", "l'onglet" finds "l’onglet". */
export const fold = foldAccentsAndQuotes

/** The text as `matchScore` compares it, for a list that keeps it with each item (see `scoreFolded`). */
export const foldedText = fold

/** The query as `matchScore` compares it: folded and trimmed. Empty when the query holds nothing to look for. */
export const foldedQuery = (query: string): string => fold(query).trim()

/** 100 prefix match, 70 word start, 50 substring, 20 in-order letters, 0 no match. Case and accents are ignored. */
export function matchScore(text: string, query: string): number {
  const needle = foldedQuery(query)
  return needle ? scoreFolded(fold(text), needle) : 0
}

/** `matchScore` for a text and a query that are already folded (the query not empty): a list searched at every keystroke folds its texts once, not each time. */
export function scoreFolded(haystack: string, needle: string): number {
  if (haystack.startsWith(needle)) return 100
  const at = haystack.indexOf(needle)
  if (at > 0 && /[\s/._'-]/.test(haystack[at - 1]!)) return 70
  if (at >= 0) return 50
  let from = 0
  for (const ch of needle) {
    from = haystack.indexOf(ch, from) + 1
    if (from === 0) return 0
  }
  return 20
}

/**
 * How well a name (space, pane, extension, command) answers what is typed: 0 when it does not. Either the whole text is in
 * the name, or one of its words of 3 letters or more starts the name or one of its words ("aller travail" finds the space
 * "Travail"). Loose in-order letters never count, unlike for tabs.
 */
export function nameScore(name: string, query: string): number {
  if (query.length < MIN_NAME_QUERY) return 0
  const whole = matchScore(name, query)
  const words = query.split(/\s+/).filter((w) => w.length >= 3).map((w) => matchScore(name, w))
  return Math.max(whole >= 50 ? whole : 0, ...words.filter((w) => w >= 70))
}

/** Highest score first; ties keep their order. */
export const byScore = <T extends { score: number }>(a: T, b: T) => b.score - a.score
