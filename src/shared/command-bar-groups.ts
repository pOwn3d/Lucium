// The rows of the command bar in groups, with their titles, and the scope a prefix narrows the list to. Moved out of command-bar.ts as it was.

import { t } from './i18n'
import type { Candidate } from './command-bar-types'

// ---------- groups, widths, genre filters and the preview of the highlighted line ----------

/** The genres the list of the bar is cut into, with a title before each. */
export type CandidateGroup = 'calc' | 'address' | 'tabs' | 'workviews' | 'bookmarks' | 'readlater' | 'history' | 'archive' | 'commands' | 'web'

/** The genre of a result. A typed address and a web search are two genres: Enter on an address opens it, it does not search for it. */
export function candidateGroup(candidate: Candidate): CandidateGroup {
  switch (candidate.kind) {
    case 'calc':
      return 'calc'
    case 'open':
      // The text typed as a search, and the site searches ("yt lofi", "!w foo"), are searches; an address, and the home of a site ("tw"), are pages.
      return candidate.search === true || candidate.id === 'open:site' || candidate.id === 'open:bang' ? 'web' : 'address'
    case 'suggestion':
    case 'site-search':
      return 'web'
    case 'tab':
      return 'tabs'
    case 'workview':
      return 'workviews'
    case 'bookmark':
      return 'bookmarks'
    case 'readlater':
      return 'readlater'
    case 'history':
      return 'history'
    case 'archived':
      return 'archive'
    default:
      return 'commands'
  }
}

/**
 * The results grouped by genre, each genre in one run. The genres come in the order their best result has in the ranking, and the results of a
 * genre keep their order: the first line stays the one the ranking chose, which is what Enter opens (a typed address leads, a tab leads only when
 * `tabLeadsSearch` says so), and a web search is never put ahead of it.
 */
export function groupCandidates<T extends Candidate>(candidates: readonly T[]): T[] {
  const order: CandidateGroup[] = []
  const buckets = new Map<CandidateGroup, T[]>()
  for (const candidate of candidates) {
    const group = candidateGroup(candidate)
    const bucket = buckets.get(group)
    if (bucket) bucket.push(candidate)
    else {
      order.push(group)
      buckets.set(group, [candidate])
    }
  }
  return order.flatMap((group) => buckets.get(group)!)
}

/** The genre each line starts (for its title), or null for a line that follows one of its genre. */
export function groupStarts(candidates: readonly Candidate[]): Array<CandidateGroup | null> {
  let previous: CandidateGroup | null = null
  return candidates.map((candidate) => {
    const group = candidateGroup(candidate)
    const starts = group !== previous
    previous = group
    return starts ? group : null
  })
}

/** The title of a genre. With nothing typed the bar lists what is at hand, and says so: "Onglets récents", "Commandes fréquentes". */
export function groupTitle(group: CandidateGroup, query: string): string {
  const nothingTyped = query.trim() === ''
  switch (group) {
    case 'calc':
      return t('cmd.groupe-calculatrice')
    case 'address':
      return t('cmd.groupe-adresse')
    case 'tabs':
      return nothingTyped ? t('cmd.groupe-onglets-recents') : t('cmd.groupe-onglets-ouverts')
    case 'workviews':
      return t('work-view.groupe-vues-de-travail')
    case 'bookmarks':
      return t('cmd.groupe-signets')
    case 'readlater':
      return t('cmd.groupe-lire-plus-tard')
    case 'history':
      return t('cmd.groupe-historique')
    case 'archive':
      return t('cmd.groupe-archive')
    case 'commands':
      return nothingTyped ? t('cmd.groupe-commandes-frequentes') : t('cmd.groupe-commandes')
    case 'web':
      return t('cmd.groupe-recherche-web')
  }
}

/**
 * A genre the bar can be narrowed to, by a chip or by what is typed first: `>` the commands, `@` the open tabs, `*` the bookmarks, `^` the history.
 * The words `@bookmarks` and `@history` name the last two as well. `#` stays the tag of a bookmark.
 */
export type BarScope = 'commands' | 'tabs' | 'history' | 'bookmarks'

export const SCOPE_PREFIX: Readonly<Record<BarScope, string>> = { commands: '>', tabs: '@', history: '^', bookmarks: '*' }

/** The words that name a genre after `@`; `@bookmarks` is not an open tab called "bookmarks". */
const SCOPE_WORD: Readonly<Record<string, BarScope>> = { '@bookmarks': 'bookmarks', '@history': 'history' }

/** The scope a first letter (or first word) names, and the text after it: `> thème` is the commands that answer "thème". A text with no such mark has no scope. */
export function splitScope(query: string): { scope: BarScope | null; text: string } {
  const word = /^\S+/.exec(query)?.[0].toLowerCase()
  const named = word === undefined ? undefined : SCOPE_WORD[word]
  if (named) return { scope: named, text: query.slice(word!.length).trimStart() }
  const first = query[0]
  const scope = (Object.keys(SCOPE_PREFIX) as BarScope[]).find((s) => SCOPE_PREFIX[s] === first)
  return scope ? { scope, text: query.slice(1).trimStart() } : { scope: null, text: query }
}

const COMMAND_KINDS: ReadonlySet<Candidate['kind']> = new Set(['action', 'pane', 'extension', 'extpage', 'internal', 'webpanel', 'container', 'session', 'space', 'move', 'window', 'workview'])

/** What a scope keeps of the results: the lines of its genre, and nothing else (a web search is not offered inside "Commandes"). */
export function inScope<T extends Candidate>(candidates: readonly T[], scope: BarScope | null): T[] {
  if (scope === null) return [...candidates]
  // An address typed in "Commandes" stays openable: its row is an action on the address, not a web search.
  return candidates.filter((c) => (scope === 'commands' ? COMMAND_KINDS.has(c.kind) || (c.kind === 'open' && c.id === 'open' && !c.search) : scope === 'tabs' ? c.kind === 'tab' : scope === 'bookmarks' ? c.kind === 'bookmark' : c.kind === 'history'))
}
