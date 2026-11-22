import type { ExtensionInfo } from './ipc'
import { settingsPaneLabel } from './settings-catalog'
import { extensionsPageOf } from './settings-target'
import { chromePageOf } from './chrome-pages'
import { DEFAULT_SITE_SEARCHES, SEARCH_ENGINES, tabName, type HistoryEntry, type SidebarState, type SiteSearch } from './model'
import { activeProfileId, profileSearch } from './profiles'
import { allBangs, bangSearchFor, bangSite } from './bangs'
import { calculatorRow } from './calc'
import { USAGE_KEY_PREFIX, activeTab } from './sidebar'
import { usageOnScreen } from './command-bar-usage'
import { splitOmniboxInput } from './omnibox'
import { hostOf, isTypedAddress, resolveInput } from './url'
import { takesTerm } from './site-search'
import type { NamedWindow } from './window-names'
import type { WindowSidebar } from './window-sidebar'
import type { PlatformId } from './platform'
import { t } from './i18n'
import { COMMAND_BAR_CARD } from './command-bar-surface'
import type { Candidate } from './command-bar-types'
import { onePerSplit, MAX_TABS, tabCandidate, actionCandidates, jotCandidate, spaceCandidates, MAX_ARCHIVED, readLaterCandidates, bookmarkCandidates, MAX_BANG_HINTS, MAX_SUGGESTIONS, MAX_HISTORY, searchOnlyActions, discoverActions, tabSearchActions, autoReloadActions, readLaterActions, containerActions, MAX_CONTAINER_ACTIONS, libraryActions, notesActions, webStoreActions, privacyActions, passwordActions, markdownActions, readableActions, shareActions, sessionActions, sessionCandidates, workViewCandidates, asideActions, lockActions, layoutActions, windowSidebarActions, webPanelCandidates, moveCandidates, paneCandidates, extensionCandidates, windowCandidates } from './command-bar-sources'
import { matchScore, fold, foldedQuery, nameScore, scoreFolded } from './command-bar-match'
import type { BarScope } from './command-bar-groups'

// Moved to modules of their own, still importable from here.
export { type CommandAction, type Candidate } from './command-bar-types'
export { foldedText, foldedQuery, matchScore, scoreFolded } from './command-bar-match'
export { windowSidebarActions, windowSidebarChangeOf, jotCandidate, bookmarkCandidates } from './command-bar-sources'
export { actionToDispatch, candidateDispatches } from './command-bar-actions'
export { candidateHint, actionShortcut, actionDetail } from './command-bar-shortcuts'
export { type CandidateGroup, candidateGroup, groupCandidates, groupStarts, groupTitle, type BarScope, SCOPE_PREFIX, splitScope, inScope } from './command-bar-groups'
export { BAR_WIDTH, PREVIEW_WIDTH, barLayout, BAR_LIST_HEIGHT, cleanBarSize, cleanBarShape, barBox } from './command-bar-box'
export { BAR_PASTE_MAX, type PasteResult, pasteIntoBar, textToCopy } from './command-bar-clipboard'
export { type PreviewKey, type CandidatePreview, type PreviewContext, pageFavicon, candidatePreview } from './command-bar-preview'
export { COMMAND_BAR_CARD, commandBarHeight, type CardSurface, pageColorBehind, cardSurface, SITE_POPOVER_MOTION, type PopoverSurface, popoverSurface } from './command-bar-surface'

const USAGE_BONUS_PER_PICK = 8
const USAGE_BONUS_CAP = 5

/** The name of a category of the Settings, in the language of the interface (settings-catalog.ts: the same words as the title of the window). */
export { settingsPaneLabel }

/**
 * "gh react hooks" when an extension of this profile declared the keyword `gh` (chrome.omnibox): the row that hands "react hooks" to it.
 * Null while the function is off, without a space after the keyword (the word is then an ordinary search), or when no extension that is
 * on in this profile has the keyword. Case is ignored; when two extensions share a keyword the first listed answers.
 */
export function omniboxFor(query: string, state: SidebarState, extensions: readonly ExtensionInfo[]): Candidate | null {
  if (!state.settings.omniboxKeywords) return null
  const typed = splitOmniboxInput(query)
  if (!typed) return null
  const profileId = activeProfileId(state)
  const keyword = typed.keyword.toLowerCase()
  const found = extensions.find((e) => e.enabled && e.profileId === profileId && e.omniboxKeyword?.toLowerCase() === keyword)
  if (!found) return null
  return {
    kind: 'omnibox',
    id: `omnibox:${found.id}`,
    label: typed.text.trim() === '' ? found.name : t('command-bar.name-text', { name: found.name, text: typed.text.trim() }),
    detail: t('command-bar.mot-cle-d-extension'),
    extensionId: found.id,
    text: typed.text
  }
}

/** `yt lofi` → the YouTube search for "lofi". Null when the first word is not a known keyword. */
/**
 * The home page of a site search whose keyword is all that was typed: "tw" opens Twitch when "tw" is the keyword of a site search whose address is
 * https://www.twitch.tv/search?term=%s ; "tw loup" searches in it (siteSearchFor). The home page is the origin of the search address.
 */
const IMPLICIT_BARE_SITE_KEYWORDS = new Set(['yt'])

const sameSiteSearch = (a: SiteSearch, b: SiteSearch | undefined): boolean => !!b && a.keyword.toLowerCase() === b.keyword.toLowerCase() && a.name === b.name && a.url === b.url

function findBareSiteSearch(searches: readonly SiteSearch[], keyword: string, termful = true): SiteSearch | undefined {
  const key = keyword.toLowerCase()
  const defaultSearch = DEFAULT_SITE_SEARCHES.find((site) => site.keyword.toLowerCase() === key)
  for (let i = searches.length - 1; i >= 0; i--) {
    const site = searches[i]!
    if (site.keyword.toLowerCase() !== key) continue
    if (defaultSearch && sameSiteSearch(site, defaultSearch) && !IMPLICIT_BARE_SITE_KEYWORDS.has(key)) continue
    if (!termful || takesTerm(site.url)) return site
  }
  return undefined
}

export function siteHomeFor(query: string, state: SidebarState): { name: string; url: string } | null {
  const word = query.trim().toLowerCase()
  const site = word && !/\s/.test(word)
    ? findBareSiteSearch(state.settings.siteSearches, word, false) ?? (IMPLICIT_BARE_SITE_KEYWORDS.has(word) ? bangSite(word, state) : undefined)
    : undefined
  const probe = site?.url.replace('%s', 'x')
  if (!site || !probe || !URL.canParse(probe)) return null
  // A search address opens the home of its site; an address without `%s` is the shortcut itself and opens as written.
  return { name: site.name, url: takesTerm(site.url) ? `${new URL(probe).origin}/` : site.url }
}

export function siteSearchFor(query: string, state: SidebarState): { name: string; url: string } | null {
  const match = /^(\S+)\s+(.+)$/.exec(query.trim())
  if (!match) return null
  const keyword = match[1]!.toLowerCase()
  const site = findBareSiteSearch(state.settings.siteSearches, keyword, true) ?? (IMPLICIT_BARE_SITE_KEYWORDS.has(keyword) ? bangSite(keyword, state) : undefined)
  return site ? { name: site.name, url: site.url.replace('%s', encodeURIComponent(match[2]!)) } : null
}

/**
 * The site search a keyword typed in the bar opens as a pill: one of the user's own, or a "!keyword" (a keyword of the user's or of the
 * fixed list, when bangs are on). Undefined for any other word.
 */
export function scopeSiteFor(keyword: string, state: SidebarState): SiteSearch | undefined {
  const trimmed = keyword.trim()
  if (!trimmed || /\s/.test(trimmed)) return undefined
  const bang = trimmed.startsWith('!')
  // With the « ! » keywords off, a « ! » makes nothing, not even before a keyword of the user's (which still works without it): the text is searched as typed.
  if (bang && !state.settings.searchBangs) return undefined
  const bare = trimmed.replace(/^!/, '').toLowerCase()
  if (!bare) return undefined
  const custom = findBareSiteSearch(state.settings.siteSearches, bare, true)
  if (custom) return custom
  if (bang) return bangSite(bare, state)
  return IMPLICIT_BARE_SITE_KEYWORDS.has(bare) && state.settings.searchBangs ? bangSite(bare, state) : undefined
}

/** Key under which the command bar remembers that a page was picked. */
export const usageKey = (url: string) => `${USAGE_KEY_PREFIX}${url}`

// The bonus is read in the ranking of the profile of the space on screen: what was picked in another profile never moves a line here.
// It is read once per ranking (`bonusOf`), not once per line: the profile of the space on screen is looked for among the spaces each time.
const bonusOf = (state: SidebarState): ((url: string) => number) => {
  const usage = usageOnScreen(state)
  return (url) => Math.min(USAGE_BONUS_CAP, usage[usageKey(url)] ?? 0) * USAGE_BONUS_PER_PICK
}

/**
 * Whether a tab that answers the typed text leads the list over a plain web search ("Switch to Tab"): always in the bar that edits the current
 * tab's address, and in the bar opened for a new tab only when the setting `goToOpenTab` is on. Off, Enter in a bar opened for a new tab opens a
 * new tab with what was typed, and the open tabs (a favourite's page included) stay in the list, a keystroke away.
 */
export const tabLeadsSearch = (state: Pick<SidebarState, 'settings'>, newTab: boolean | undefined): boolean => newTab !== true || state.settings.goToOpenTab === true

/**
 * `options.newTab` says the bar was opened to open a new tab (⌘T, new window, split view) and not to change the page of the tab on screen: it is
 * what `tabLeadsSearch` asks about. `options.platform` is the system the keys of the commands are drawn for; without it the lines name no shortcut.
 */
export function rankCandidates(
  query: string,
  state: SidebarState,
  history: HistoryEntry[] = [],
  suggestions: string[] = [],
  extensions: readonly ExtensionInfo[] = [],
  options: { private?: boolean; windows?: readonly NamedWindow[]; newTab?: boolean; windowSidebar?: WindowSidebar; platform?: PlatformId } = {}
): Candidate[] {
  const q = query.trim()
  const { suggestHistory, suggestTabs, suggestArchive, suggestReadLater } = state.settings
  const activeId = state.activeTabBySpace[state.activeSpaceId]
  // A source that is switched off offers nothing, not even in the list shown before anything is typed.
  const tabs = suggestTabs ? [...state.tabs].filter((t) => t.id !== activeId) : []
  const bonus = bonusOf(state)

  if (!q) {
    const recent = onePerSplit(
      tabs.sort((a, b) => bonus(b.url) - bonus(a.url) || b.lastActiveAt - a.lastActiveAt),
      (t) => t,
      state
    )
      .slice(0, MAX_TABS + 2)
      .map((t) => tabCandidate(t, state))
    return [...recent, ...actionCandidates(state, options.platform)]
  }

  const result: Candidate[] = []
  // `matchScore(text, q)` for the long lists (tabs, archive, history): the query is folded once, not once per line and per field.
  const needle = foldedQuery(q)
  const score = (text: string): number => (needle ? scoreFolded(fold(text), needle) : 0)
  const site = siteSearchFor(q, state)
  if (site) {
    const term = q.replace(/^\S+\s+/, '')
    result.push({ kind: 'open', id: 'open:site', label: t('cmd.site-term', { name: site.name, term }), detail: t('cmd.recherche-sur-le-site'), url: site.url })
  }
  // The keyword alone ("tw") opens the site of that search: the first answer, before the pages the history would offer for the same letters.
  const home = site ? null : siteHomeFor(q, state)
  if (home) result.push({ kind: 'open', id: 'open:site-home', label: home.name, detail: t('cmd.ouvrir-le-site'), url: home.url })
  // "!w foo" says the same with a "!" (and "!w" alone opens the site); a keyword nothing answers to is just text for the search engine.
  const bang = site ? null : bangSearchFor(q, state)
  if (bang) {
    result.push(
      bang.terms
        ? { kind: 'open', id: 'open:bang', label: t('cmd.site-term', { name: bang.name, term: bang.terms }), detail: t('cmd.recherche-sur-le-site'), url: bang.url }
        : { kind: 'open', id: 'open:bang', label: bang.name, detail: t('cmd.ouvrir-le-site'), url: bang.url }
    )
  }
  // An extension's keyword comes after the user's own (site searches, "!" keywords) and, when it answers, stands for the search too.
  const omnibox = site || bang ? null : omniboxFor(query, state, extensions)
  if (omnibox) result.push(omnibox)
  // `chrome://extensions` is no address to search for: the extensions have a page of their own, and this is the way there.
  const extensionsPage = site || bang || omnibox ? null : extensionsPageOf(q)
  if (extensionsPage) result.push({ kind: 'extpage', id: 'extpage', label: t('cmd.page-extensions'), detail: '', target: extensionsPage })
  // `chrome://history`, `chrome://settings/privacy`, `arc://flags`…: the page of Lucium that stands for it, or a row that says there is none. Alone: no search, no tab.
  const chromePage = site || bang || omnibox || extensionsPage ? null : chromePageOf(q, { private: options.private === true, settings: state.settings })
  if (chromePage) return [{ kind: 'internal', id: 'internal', label: chromePage.label, detail: chromePage.detail, ...(chromePage.request ? { request: chromePage.request } : {}) }]
  const resolved = site || bang || omnibox || extensionsPage ? null : resolveInput(q, profileSearch(state.settings, activeProfileId(state)).url)
  if (resolved) {
    result.push({
      kind: 'open',
      id: 'open',
      // What was typed, as is, with a magnifier when it is a search and a globe when it is an address.
      label: resolved.kind === 'url' ? hostOf(resolved.url) || resolved.url : q,
      detail: '',
      url: resolved.url,
      ...(resolved.kind === 'search' ? { search: true } : {})
    })
    // An address: a shortcut for its site can be made from the bar, the same sheet as the page's menu.
    if (resolved.kind === 'url') result.push({ kind: 'action', id: 'action:create-shortcut', label: t('cmd.creer-un-raccourci-pour-ce-site'), detail: t('cmd.action-raccourci'), action: 'create-shortcut', url: resolved.url })
  }
  // "note <text>" follows what Enter opens (the search, an address), never ahead of it; a keyword of the user's or of an extension answering "note" wins.
  const jot = site || bang || omnibox || extensionsPage ? null : jotCandidate(q, state, options.private === true)
  if (jot) result.push(jot)

  const matchedTabs = onePerSplit(
    tabs
      .map((t) => ({ t, score: Math.max(Math.max(score(tabName(t)), score(t.title)), score(t.url)) }))
      .filter((m) => m.score > 0)
      // Pages the user keeps picking for this kind of input float up, but a bonus never rescues a non-match.
      .map((m) => ({ ...m, score: m.score + bonus(m.t.url) }))
      .sort((a, b) => b.score - a.score || b.t.lastActiveAt - a.t.lastActiveAt),
    (m) => m.t,
    state
  ).slice(0, MAX_TABS)
  // A strong tab match beats a plain web search, but never beats a URL the user typed in full, and not at all in a bar opened for a new tab (see `tabLeadsSearch`).
  const tabCandidates = matchedTabs.map(({ t }) => tabCandidate(t, state))
  const strongTab = resolved?.kind === 'search' && !!matchedTabs[0] && matchedTabs[0].score >= 70 && tabLeadsSearch(state, options.newTab)
  if (strongTab) result.unshift(...tabCandidates.splice(0, 1))
  result.push(...tabCandidates)

  // Other spaces named like the query follow the tabs. Typing a space's name in full is meant as going there: it leads,
  // just behind a strong tab match, as long as the text is not an address.
  const spaces = spaceCandidates(q, state)
  const named = resolved?.kind === 'search' ? state.spaces.find((sp) => fold(sp.name) === fold(q)) : undefined
  const exact = named ? spaces.findIndex((c) => c.spaceId === named.id) : -1
  if (exact >= 0) result.splice(strongTab ? 1 : 0, 0, ...spaces.splice(exact, 1))
  result.push(...spaces)
  // The work views named like the query follow the spaces: like a space, a view is a place to go to.
  result.push(...workViewCandidates(q, state, options.private === true))

  result.push(
    ...(suggestArchive ? state.archive : [])
      .map((a) => ({ a, score: Math.max(score(a.title), score(a.url)) }))
      .filter((m) => m.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, MAX_ARCHIVED)
      .map(({ a }): Candidate => ({ kind: 'archived', id: `archived:${a.id}`, label: a.title, detail: t('cmd.archived-host', { host: hostOf(a.url) }), archivedId: a.id }))
  )
  if (suggestReadLater) result.push(...readLaterCandidates(q, state))
  result.push(...bookmarkCandidates(q, state, options.private === true))
  const lower = q.toLowerCase()
  const bangPrefix = state.settings.searchBangs ? /^!([a-z0-9_-]{0,30})$/i.exec(q) : null
  if (bangPrefix) {
    // "!" and the first letters of a keyword: the keywords that answer, to complete with Tab.
    const typed = bangPrefix[1]!.toLowerCase()
    for (const s of allBangs(state).filter((b) => b.keyword.toLowerCase().startsWith(typed) || b.name.toLowerCase().startsWith(typed)).slice(0, MAX_BANG_HINTS)) {
      result.push({ kind: 'site-search', id: `bang:${s.keyword}`, label: t('cmd.search-on', { name: s.name }), detail: t('cmd.tab'), keyword: `!${s.keyword}` })
    }
  } else if (!/\s/.test(q)) {
    // A row is offered only when Tab opens its pill (scopeSiteFor finds this very search): a keyword of the default list is a "!" keyword, not a bare one.
    for (const s of state.settings.siteSearches.filter((x) => takesTerm(x.url) && sameSiteSearch(x, scopeSiteFor(x.keyword, state)))) {
      if (s.keyword.startsWith(lower) || s.name.toLowerCase().startsWith(lower)) {
        result.push({ kind: 'site-search', id: `site:${s.keyword}`, label: t('cmd.search-on', { name: s.name }), detail: t('cmd.tab'), keyword: s.keyword })
      }
    }
  }

  // Web search suggestions (already fetched by the caller from the search engine).
  const seen = new Set<string>([q.toLowerCase()])
  for (const text of suggestions) {
    const key = text.toLowerCase()
    if (seen.has(key) || result.filter((c) => c.kind === 'suggestion').length >= MAX_SUGGESTIONS) continue
    seen.add(key)
    result.push({ kind: 'suggestion', id: `suggestion:${text}`, label: text, detail: t('cmd.suggestion'), query: text })
  }

  const openUrls = new Set(suggestTabs ? state.tabs.map((t) => t.url) : [])
  result.push(
    ...(suggestHistory ? history : [])
      .filter((h) => !openUrls.has(h.url))
      .map((h) => ({ h, score: Math.max(score(h.title), score(h.url)) }))
      .filter((m) => m.score > 0)
      .map((m) => ({ ...m, score: m.score + bonus(m.h.url) }))
      .sort((x, y) => y.score - x.score || y.h.visitCount - x.h.visitCount || y.h.lastVisitAt - x.h.lastVisitAt)
      .slice(0, MAX_HISTORY)
      .map(({ h }): Candidate => ({ kind: 'history', id: `history:${h.url}`, label: h.title || h.url, detail: t('cmd.historique-host', { host: hostOf(h.url) }), url: h.url }))
  )
  result.push(...actionCandidates(state, options.platform).filter((c) => matchScore(c.label, q) > 0))
  result.push(...searchOnlyActions(state, options.platform).filter((c) => nameScore(c.label, q) > 0))
  result.push(...discoverActions(options.private === true).filter((c) => nameScore(c.label, q) > 0))
  result.push(...tabSearchActions(state).filter((c) => nameScore(c.label, q) > 0))
  result.push(...autoReloadActions(state).filter((c) => nameScore(c.label, q) > 0))
  result.push(...readLaterActions(state, options.private === true).filter((c) => nameScore(c.label, q) > 0))
  result.push(...containerActions(state, options.private === true).filter((c) => nameScore(c.label, q) > 0).slice(0, MAX_CONTAINER_ACTIONS))
  result.push(...libraryActions(state, options.private === true).filter((c) => nameScore(c.label, q) > 0))
  result.push(...notesActions(state, options.private === true).filter((c) => nameScore(c.label, q) > 0))
  result.push(...webStoreActions(state, options.private === true).filter((c) => nameScore(c.label, q) > 0))
  result.push(...privacyActions(state, options.private === true).filter((c) => nameScore(c.label, q) > 0))
  result.push(...passwordActions(state, options.private === true).filter((c) => nameScore(c.label, q) > 0))
  result.push(...markdownActions(state).filter((c) => nameScore(c.label, q) > 0))
  // The function had another name ("Mode lisible", "Readable mode"): typed, it still finds the commands.
  const formerReadableName = nameScore(t('cmd.mode-lisible-synonymes'), q) > 0
  result.push(...readableActions(state, options.private === true).filter((c) => formerReadableName || nameScore(c.label, q) > 0))
  result.push(...shareActions(options.private === true, state.settings.boostSharing).filter((c) => nameScore(c.label, q) > 0))
  result.push(...sessionActions(options.private === true).filter((c) => nameScore(c.label, q) > 0), ...sessionCandidates(q, state, options.private === true))
  result.push(...asideActions(state, options.private === true).filter((c) => nameScore(c.label, q) > 0))
  result.push(...lockActions(state, options.private === true).filter((c) => nameScore(c.label, q) > 0))
  result.push(...layoutActions(state).filter((c) => nameScore(c.label, q) > 0))
  result.push(...windowSidebarActions(state, options.windowSidebar).filter((c) => nameScore(c.label, q) > 0))
  result.push(...webPanelCandidates(q, state, options.private === true))
  result.push(...moveCandidates(q, state), ...paneCandidates(q), ...extensionCandidates(q, extensions, activeProfileId(state)), ...windowCandidates(q, options.windows))
  // A calculation leads the list, ahead of the strongest tab or the search itself. A switched-off calculator never reads the text.
  const calc = state.settings.commandBarCalc ? calculatorRow(q) : null
  if (calc) result.unshift({ kind: 'calc', id: 'calc', label: `= ${calc.display}`, detail: calc.expression, copy: calc.copy })
  return result
}

/**
 * Home or End in the field of the bar: the index of the first or the last result when the key has no caret left to move, that is when the caret is
 * already at that end of the text (nothing selected, and the field empty counts for both ends). Otherwise null: the key moves the caret, as in any
 * field, and so does a key with a modifier (⇧ selects, ⌘ and ⌥ jump by line or by word).
 */
export function resultAtEdge(
  key: string,
  modifiers: { shiftKey: boolean; metaKey: boolean; altKey: boolean; ctrlKey: boolean },
  field: { value: string; selectionStart: number | null; selectionEnd: number | null },
  count: number
): number | null {
  if (count < 1 || (key !== 'Home' && key !== 'End') || modifiers.shiftKey || modifiers.metaKey || modifiers.altKey || modifiers.ctrlKey) return null
  if (field.selectionStart !== field.selectionEnd) return null
  const at = key === 'Home' ? 0 : field.value.length
  return field.selectionStart === at ? (key === 'Home' ? 0 : count - 1) : null
}

/**
 * What the command bar completes the typed text to, inline (the rest of the address is selected as you type): the host of the
 * best result when it starts with what was typed. Null when nothing should be completed.
 */
export function inlineCompletion(query: string, candidates: readonly Candidate[]): string | null {
  const typed = query
  // Only a word that could be the start of a host: no spaces, no path, not an address with a scheme.
  if (!typed || /[\s/:?#]/.test(typed)) return null
  const best = candidates.find((c) => c.kind === 'tab' || c.kind === 'history' || (c.kind === 'open' && !c.search))
  if (!best || !('url' in best) || typeof best.url !== 'string') return null
  const host = hostOf(best.url).replace(/^www\./, '')
  const lower = typed.toLowerCase()
  if (host.length <= typed.length || !host.toLowerCase().startsWith(lower.replace(/^www\./, ''))) return null
  // Keep the user's own letters (their case), then the rest of the host.
  return typed + host.slice(typed.replace(/^www\./i, '').length)
}

/**
 * The row to put first while the field shows an address the bar completed ("youtu" → "youtube.com"): Enter must open what is on screen, not search for
 * the letters typed. Null when the first row already is something else than the plain search of the typed text (a tab, a page, a command: the
 * ranking chose it on purpose) or when the completion is not an address. The search stays in the list, one arrow down.
 */
export function completedRow(candidates: readonly Candidate[], completion: string | null): Candidate | null {
  const first = candidates[0]
  if (!completion || first?.kind !== 'open' || first.search !== true) return null
  const resolved = resolveInput(completion, '%s')
  if (resolved?.kind !== 'url') return null
  return { kind: 'open', id: 'open:completed', label: hostOf(resolved.url) || completion, detail: '', url: resolved.url }
}

const INSTANT_LINK_MAX = 5

/**
 * Instant links (⇧↩ in the command bar): each comma-separated term opens the first result of a web search instead of the
 * results page. An address stays an address; engines that have no "first result" feature give their results page.
 */
export function instantLinkUrls(input: string, searchTemplate: string): string[] {
  const urls: string[] = []
  for (const term of input.split(',').map((t) => t.trim()).filter(Boolean).slice(0, INSTANT_LINK_MAX)) {
    const resolved = resolveInput(term, searchTemplate)
    if (!resolved) continue
    const engine = SEARCH_ENGINES.find((e) => e.url === searchTemplate)?.name
    if (resolved.kind === 'url') urls.push(resolved.url)
    else if (engine === 'Google') urls.push(`${resolved.url}&btnI=1`)
    // DuckDuckGo's "!" shortcut for the first result is a backslash in front of the query.
    else if (engine === 'DuckDuckGo') urls.push(searchTemplate.replace('%s', encodeURIComponent(`\\${term}`)))
    else urls.push(resolved.url)
  }
  return urls
}

// ---------- the bar of a mini window ----------

/** The kinds of result the bar of a mini window can act on besides the open tabs: web pages and searches (the window has no spaces or commands). */
const LITTLE_KINDS: ReadonlySet<Candidate['kind']> = new Set(['open', 'history', 'suggestion', 'site-search'])

/** How many open tabs the bar lists, above the other pages. */
export const LITTLE_TABS = 3

/**
 * The open tabs the bar lists ("Onglets ouverts"): the ones the command bar of the main window would offer for this text,
 * the most recent first while nothing is typed. Seen from this window nothing is on screen, so the tab shown in the main window is one of them
 * (the way to bring it back to the front). A private tab is never listed. Nothing while the setting that offers tabs in the bar is off (`rankCandidates` honours it).
 */
function littleTabs(query: string, state: SidebarState): Candidate[] {
  const seen: SidebarState = { ...state, tabs: state.tabs.filter((t) => t.private !== true), activeTabBySpace: {} }
  return rankCandidates(query, seen)
    .filter((c) => c.kind === 'tab')
    .slice(0, LITTLE_TABS)
}

/**
 * What the bar of the first state of a mini window lists: the open tabs, then the pages visited lately while nothing is typed, or what the
 * command bar would offer for the text (the text itself, searches, history), without what only makes sense in the main window (spaces, commands,
 * the archive). A web address typed in full leads: Enter opens what was typed, not a tab the text only resembles.
 */
export function littleCandidates(query: string, state: SidebarState, history: HistoryEntry[], suggestions: string[]): Candidate[] {
  const tabs = littleTabs(query, state)
  if (!query.trim()) {
    return [...tabs, ...(state.settings.suggestHistory ? history : []).slice(0, COMMAND_BAR_CARD.listRows).map((h): Candidate => ({ kind: 'history', id: `history:${h.url}`, label: h.title || h.url, detail: hostOf(h.url), url: h.url }))]
  }
  const pages = rankCandidates(query, state, history, suggestions).filter((c) => LITTLE_KINDS.has(c.kind))
  const first = pages[0]
  return first?.kind === 'open' && first.search !== true ? [...pages, ...tabs] : [...tabs, ...pages]
}

export type LittleGroup = 'tabs' | 'suggestions'

/**
 * The group each row of the bar starts, or null for a row that follows one of its group: the title "Onglets ouverts" stands before the first open
 * tab and "Suggestions" before the first other page. A group that comes in two runs (a typed address leads, the tabs follow) is titled at each run.
 */
export function littleGroupStarts(candidates: readonly Candidate[]): Array<LittleGroup | null> {
  let previous: LittleGroup | null = null
  return candidates.map((c) => {
    const group: LittleGroup = c.kind === 'tab' ? 'tabs' : 'suggestions'
    const starts = group !== previous
    previous = group
    return starts ? group : null
  })
}

/**
 * The text the bar asks the search engine suggestions for, or null when nothing is asked. Nothing is asked for what stays on this machine (a private
 * window, a private tab), inside a genre (`@notes` is a tab, not a search), for an address, or for a text too short to mean anything. Nothing either while
 * the text is scoped to the search of a site (the pill): what is typed there is a question for that site, the default engine has no business reading
 * it letter by letter, and the list shows no suggestion of the default engine.
 */
export function suggestionQuery(query: string, where: { staysPrivate: boolean; genre: BarScope | null; siteSearch: boolean }): string | null {
  const text = query.trim()
  if (where.staysPrivate || where.genre !== null || where.siteSearch || text.length < 2 || /\s{2,}/.test(text) || isTypedAddress(text)) return null
  return text
}

/**
 * What ⌘↩ does with a line: the page of the line in a new tab (`submit`), a new private tab for the line of a private tab (`private`: its address must not
 * come out in an ordinary tab, which is saved and goes to the history), or what ↩ does for a line that has no page (`run`).
 */
export function newTabOf(candidate: Candidate, state: SidebarState): { how: 'submit' | 'private'; url: string } | { how: 'run' } {
  if (candidate.kind === 'tab') return { how: state.tabs.find((tab) => tab.id === candidate.tabId)?.private === true ? 'private' : 'submit', url: candidate.url }
  if (candidate.kind === 'open' || candidate.kind === 'history') return { how: 'submit', url: candidate.url }
  return { how: 'run' }
}

/**
 * Whether what is typed in the command bar must stay on this machine: in a private window, and in a normal window while the tab on screen is a
 * private one. The bar of a new private tab is in that case too: the blank private tab is made first, and the bar is put over it. Nothing typed
 * is then sent to the search engine for suggestions, whatever the setting of the profile says; what the machine itself proposes stays (open
 * tabs, commands, the calculator).
 */
export function typedStaysPrivate(state: SidebarState, privateWindow: boolean): boolean {
  return privateWindow || activeTab(state)?.private === true
}

/**
 * Whether an address is one this window knows only from a private tab: a private tab is at it, and no ordinary tab is. ⌘↩ on the line of a
 * private tab asks for that page in a new tab: opened as an ordinary one, the address would go to the saved state and to the history, which is
 * what the private tab was opened to avoid. Such an address opens in a private tab.
 */
export function knownOnlyPrivately(state: Pick<SidebarState, 'tabs'>, url: string): boolean {
  return state.tabs.some((tab) => tab.private === true && tab.url === url) && !state.tabs.some((tab) => tab.private !== true && tab.url === url)
}
