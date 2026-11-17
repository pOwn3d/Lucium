// "Ranger les onglets…" (by site): the Today tabs that share a site are proposed as folders, one folder per site, and the person
// validates the proposal before anything moves. Everything here is local and deterministic: the site of a tab is worked out from its address alone, the same tabs
// always give the same proposal in the same order, and nothing is asked of the network or learned from what the person does. The reducer applies what was
// validated (`tabs/tidy`, sidebar.ts) and `tidyOutcome` says how to take it back in one step (`tabs/untidy`).
//
// (Not to be confused with tidy.ts, which cleans the titles of pinned tabs and the names of downloaded files.)

import { isListedTab, type Folder, type SidebarState, type TabItem } from './model'
import { NAME_MAX, printable } from './state-clean'
import type { Action } from './sidebar'
import { t, tp } from './i18n'

/** A group of fewer tabs than this is not a folder: a tab alone stays where it is. */
export const TIDY_GROUP_MIN = 2
/** The longest name the proposal makes (a name typed by the person may be longer, up to a folder's own limit). */
export const TIDY_NAME_MAX = 40
/** The most groups and tabs one `tabs/tidy` reads: far more than anyone has open. */
export const TIDY_GROUPS_MAX = 500
export const TIDY_TABS_MAX = 5000

// ---------- which tabs can be put in order ----------

/**
 * The Today tabs of a space the proposal may move, in the order of Today. Not the pinned ones (a tab in a folder is pinned: it has its place already) nor the
 * favourites' pages, not a private tab (the pinned list is saved, a private tab never is), not a pane of a split view (a folder would tear it), and, with the tab
 * tree, not a tab that is part of a branch (the tree is the person's own arrangement of Today).
 */
export function tidyCandidates(state: SidebarState, spaceId: string): TabItem[] {
  const inSplit = new Set(state.splits.flatMap((split) => split.tabIds))
  const tree = state.settings.tabTree === true
  const parents = new Set(tree ? state.tabs.flatMap((tab) => (tab.parentId === undefined ? [] : [tab.parentId])) : [])
  return state.tabs.filter(
    (tab) => tab.spaceId === spaceId && isListedTab(tab) && !tab.pinned && tab.private !== true && !inSplit.has(tab.id) && !(tree && (tab.parentId !== undefined || parents.has(tab.id)))
  )
}

// ---------- the site of an address ----------

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/**
 * Public suffixes of the platforms where every subdomain is somebody else's site (`alice.github.io` and `bob.github.io` have nothing in common). The public
 * suffix list is what the main process reads (party.ts `siteOf`), and it is too heavy for a panel: this is the short list of the platforms people open most,
 * and the test of tab-grouping.test.ts compares the whole function with the list on a table of hosts.
 */
export const PRIVATE_SUFFIXES: ReadonlySet<string> = new Set([
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'blogspot.com', 'web.app', 'firebaseapp.com', 'onrender.com', 'fly.dev',
  'repl.co', 'replit.app', 'azurewebsites.net', 'appspot.com', 'cloudfront.net', 'notion.site', 'myshopify.com', 'wixsite.com', 'ngrok-free.app', 'streamlit.app'
])

/** Second-level labels that, under a country code, make a public suffix of two labels (`co.uk`, `com.au`, `gouv.fr`, `ne.jp`…). */
const COUNTRY_SECOND_LEVEL: ReadonlySet<string> = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gouv', 'asso', 'nom', 'mil', 'sch', 'ltd', 'plc', 'me', 'govt', 'id'])

/** A host without a dot (`localhost`, a machine of the network), an IPv4 or an IPv6 address: its own site, there is no domain to take it back to. */
const isBareHost = (host: string): boolean => !host.includes('.') || host.startsWith('[') || IPV4.test(host)

/**
 * The registrable domain of a host (`docs.google.com` → `google.com`, `bbc.co.uk`, `alice.github.io`): the name a person bought, or, on a platform that
 * rents subdomains, the subdomain. A host that is no domain (an address, `localhost`) comes back as it is.
 */
export function registrableDomain(host: string): string {
  if (isBareHost(host)) return host
  const labels = host.split('.')
  for (let i = 0; i < labels.length - 1; i++) if (PRIVATE_SUFFIXES.has(labels.slice(i).join('.'))) return labels.slice(Math.max(0, i - 1)).join('.')
  const last = labels[labels.length - 1]!
  const before = labels[labels.length - 2]!
  const twoPart = labels.length >= 3 && /^[a-z]{2}$/.test(last) && COUNTRY_SECOND_LEVEL.has(before)
  return labels.slice(twoPart ? -3 : -2).join('.')
}

/** The families of sites under several domains: whichever of them a tab is on, its site is the family. */
const FAMILIES: ReadonlyArray<{ key: string; name: string; domains: readonly string[] }> = [
  { key: 'microsoft', name: 'Microsoft', domains: ['microsoft.com', 'live.com', 'office.com', 'office365.com', 'microsoftonline.com', 'sharepoint.com', 'outlook.com'] },
  { key: 'github', name: 'GitHub', domains: ['github.com', 'githubusercontent.com', 'githubassets.com'] },
  { key: 'atlassian', name: 'Atlassian', domains: ['atlassian.com', 'atlassian.net', 'bitbucket.org'] },
  { key: 'apple', name: 'Apple', domains: ['apple.com', 'icloud.com'] }
]
const FAMILY_OF_DOMAIN: ReadonlyMap<string, (typeof FAMILIES)[number]> = new Map(FAMILIES.flatMap((family) => family.domains.map((domain) => [domain, family] as const)))

/** Brands that have a site in every country (`google.fr`, `amazon.co.uk`): one family whichever the country, but only under `.com` or a country code. */
const COUNTRY_BRANDS: Readonly<Record<string, string>> = { google: 'Google', amazon: 'Amazon', ebay: 'eBay', yahoo: 'Yahoo' }
const COUNTRY_SUFFIX = /^(?:com|[a-z]{2}|(?:co|com)\.[a-z]{2})$/

/** The names whose capital letters are not the first one's alone (`youtube` → "YouTube"); any other name is the domain with its first letters raised. */
const BRAND_NAMES: Readonly<Record<string, string>> = {
  youtube: 'YouTube', linkedin: 'LinkedIn', stackoverflow: 'Stack Overflow', gitlab: 'GitLab', openai: 'OpenAI', chatgpt: 'ChatGPT', paypal: 'PayPal', whatsapp: 'WhatsApp', tiktok: 'TikTok',
  bbc: 'BBC', cnn: 'CNN', ibm: 'IBM', npmjs: 'npm', ycombinator: 'Y Combinator', duckduckgo: 'DuckDuckGo', wikipedia: 'Wikipedia'
}

/** What a site is called: the first label of its domain, in words (`service-public.fr` → "Service Public"). A name in punycode (an internationalised domain) is shown as it is, so that a look-alike stays visible as one. */
function nameOfLabel(label: string): string {
  if (label.startsWith('xn--')) return label
  const brand = BRAND_NAMES[label]
  if (brand !== undefined) return brand
  return label
    .split('-')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export interface TidySite {
  /** What two tabs have in common when they are of the same site: the family, or the registrable domain. */
  key: string
  /** The name of the folder they would make. */
  name: string
}

/**
 * The site an address belongs to, or null when it has none (`about:blank`, `file:`, the application's own pages: only web pages have a site). A subdomain
 * is the site of its domain, the port is not part of it, and a family of domains is one site.
 */
export function siteOfAddress(address: string): TidySite | null {
  if (!URL.canParse(address)) return null
  const url = new URL(address)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host === '') return null
  const domain = registrableDomain(host)
  if (isBareHost(domain)) return { key: domain, name: domain.slice(0, TIDY_NAME_MAX) }
  const family = FAMILY_OF_DOMAIN.get(domain)
  if (family) return { key: family.key, name: family.name }
  const dot = domain.indexOf('.')
  const label = domain.slice(0, dot)
  const suffix = domain.slice(dot + 1)
  const country = COUNTRY_BRANDS[label]
  if (country !== undefined && COUNTRY_SUFFIX.test(suffix)) return { key: label, name: country }
  // A rented subdomain (`alice.github.io`) is told by the whole name: "Alice" alone would say nothing of where it is.
  const rented = PRIVATE_SUFFIXES.has(suffix)
  return { key: domain, name: (rented ? domain : nameOfLabel(label)).slice(0, TIDY_NAME_MAX) || domain }
}

// ---------- names ----------

/** What two folder names have to share to be the same name: no difference of case, of the spaces around or inside. */
export const nameKey = (name: string): string => name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

/** The name a folder gets from a name typed or proposed: one line, trimmed, at most a folder's limit, and "Nouveau dossier" when nothing is left. */
export const tidyFolderName = (raw: unknown): string => printable(raw, NAME_MAX)?.trim() || t('menu.nouveau-dossier-2')

/**
 * The folder of a space that already has this name (compared as `nameKey` does), if any: the tabs go there rather than into a second folder of the same name.
 * One at the root is preferred to one inside another; a live folder fills itself, nothing is put in it.
 */
export function existingFolderFor(folders: readonly Folder[], spaceId: string, name: string): Folder | undefined {
  const key = nameKey(name)
  const same = folders.filter((folder) => folder.spaceId === spaceId && folder.live === undefined && nameKey(folder.name) === key)
  return same.find((folder) => folder.parentId === undefined) ?? same[0]
}

// ---------- the proposal ----------

export interface TidyGroup {
  /** The site (see `TidySite.key`): what the choices of the panel are kept under. */
  key: string
  name: string
  /** The tabs of the group, in the order of Today. */
  tabIds: string[]
}

export interface TidyProposal {
  groups: TidyGroup[]
  /** How many tabs could be put in order, grouped or not. */
  candidates: number
}

/**
 * The folders to propose for a space: one per site that has `TIDY_GROUP_MIN` tabs or more among its candidates, in the order of the first tab of each. A tab
 * alone, or whose address has no site, stays where it is. Two sites that would get the same name (example.com and example.org) are told apart by their domain
 * rather than ending in one folder.
 */
export function proposeTidy(state: SidebarState, spaceId: string): TidyProposal {
  const candidates = tidyCandidates(state, spaceId)
  const sites = new Map<string, TidyGroup>()
  for (const tab of candidates) {
    const site = siteOfAddress(tab.url)
    if (!site) continue
    const group = sites.get(site.key)
    if (group) group.tabIds.push(tab.id)
    else sites.set(site.key, { key: site.key, name: site.name, tabIds: [tab.id] })
  }
  const groups = [...sites.values()].filter((group) => group.tabIds.length >= TIDY_GROUP_MIN)
  const named = new Map<string, number>()
  for (const group of groups) named.set(nameKey(group.name), (named.get(nameKey(group.name)) ?? 0) + 1)
  return { candidates: candidates.length, groups: groups.map((group) => (named.get(nameKey(group.name))! > 1 ? { ...group, name: group.key.slice(0, TIDY_NAME_MAX) } : group)) }
}

// ---------- what the person validates ----------

/** What the person changed in the proposal: the name of a group (by its key), the groups unticked whole, the tabs unticked one by one. */
export interface TidyChoices {
  names: ReadonlyMap<string, string>
  offGroups: ReadonlySet<string>
  offTabs: ReadonlySet<string>
}

export const NO_TIDY_CHOICES: TidyChoices = { names: new Map(), offGroups: new Set(), offTabs: new Set() }

export interface TidyRow {
  key: string
  /** The name as it stands (typed, or proposed). */
  name: string
  /** Every tab of the group that can still be moved, and the ones that stay ticked. */
  tabIds: string[]
  kept: string[]
  /** The group is ticked as a whole. */
  on: boolean
  /** The folder of that name that exists already, which takes the tabs. */
  into: Folder | undefined
  /** Ticked, but with too few tabs left for a new folder. */
  few: boolean
  /** The row takes part in the result. */
  applies: boolean
}

export interface TidyTarget {
  name: string
  tabIds: string[]
  /** The folder that takes the tabs when one of that name exists (absent: a new folder is made). */
  folderId?: string
}

/**
 * Where groups of tabs go: a folder of the space that has the name when there is one, else a new folder; groups of the same name go to the same folder
 * (so the reducer, which makes no second folder of a name, and the panel, which counts, agree). A tab named twice goes with the first group that names it.
 */
export function tidyTargets(folders: readonly Folder[], spaceId: string, groups: ReadonlyArray<{ name: unknown; tabIds: readonly string[] }>): TidyTarget[] {
  const targets = new Map<string, TidyTarget>()
  const placed = new Set<string>()
  for (const group of groups) {
    const ids = group.tabIds.filter((id) => !placed.has(id))
    ids.forEach((id) => placed.add(id))
    if (ids.length === 0) continue
    const name = tidyFolderName(group.name)
    const key = nameKey(name)
    const known = targets.get(key)
    if (known) known.tabIds.push(...ids)
    else {
      const existing = existingFolderFor(folders, spaceId, name)
      targets.set(key, { name, tabIds: [...ids], ...(existing ? { folderId: existing.id } : {}) })
    }
  }
  return [...targets.values()]
}

export interface TidyPlan {
  rows: TidyRow[]
  /** What `tabs/tidy` is sent: the groups that take part, under the names they have now. */
  apply: Array<{ name: string; tabIds: string[] }>
  /** New folders, existing folders that take tabs, and tabs moved. */
  created: number
  extended: number
  moved: number
}

/**
 * The proposal as the person has edited it: each row says whether it takes part (ticked, and enough tabs left: two for a new folder, one for a folder that
 * exists), and the totals are those of the result. A tab that is no longer a candidate (closed, pinned or moved since the proposal was made) is left out.
 */
export function tidyPlan(state: SidebarState, spaceId: string, proposal: TidyProposal, choices: TidyChoices = NO_TIDY_CHOICES): TidyPlan {
  const live = new Set(tidyCandidates(state, spaceId).map((tab) => tab.id))
  const rows = proposal.groups.map((group): TidyRow => {
    const name = choices.names.get(group.key) ?? group.name
    const tabIds = group.tabIds.filter((id) => live.has(id))
    const kept = tabIds.filter((id) => !choices.offTabs.has(id))
    const on = !choices.offGroups.has(group.key)
    const into = existingFolderFor(state.folders, spaceId, tidyFolderName(name))
    const few = on && kept.length < (into ? 1 : TIDY_GROUP_MIN)
    return { key: group.key, name, tabIds, kept, on, into, few, applies: on && !few }
  })
  const apply = rows.filter((row) => row.applies).map((row) => ({ name: row.name, tabIds: row.kept }))
  const targets = tidyTargets(state.folders, spaceId, apply)
  return { rows, apply, created: targets.filter((target) => target.folderId === undefined).length, extended: targets.filter((target) => target.folderId !== undefined).length, moved: targets.reduce((sum, target) => sum + target.tabIds.length, 0) }
}

/**
 * What "Ranger" sends: the validated groups, with the side of the new folders when that is not the one remembered (it is remembered from then on, once it has
 * been used: cancelling the panel leaves every setting as it was). Nothing at all when no group takes part.
 */
export function tidyActions(plan: Pick<TidyPlan, 'apply'>, spaceId: string, position: 'top' | 'bottom', remembered: 'top' | 'bottom'): Action[] {
  if (plan.apply.length === 0) return []
  return [
    ...(position !== remembered ? [{ type: 'settings/update' as const, patch: { tidyFoldersPosition: position } }] : []),
    { type: 'tabs/tidy', groups: plan.apply, spaceId, ...(position === 'bottom' ? { atBottom: true } : {}) }
  ]
}

// ---------- what was done, and taking it back ----------

export interface TidyOutcome {
  created: number
  extended: number
  moved: number
  /** The action that puts everything back in one step. */
  undo: Action
}

/**
 * What `tabs/tidy` did, read from the state before and after it: null when no tab moved. The undo names the folders that were made and, for each tab that
 * went into a folder, where it stood among the Today tabs, so that `tabs/untidy` (which puts them back from the first place to the last) restores the same place.
 */
export function tidyOutcome(before: SidebarState, after: SidebarState): TidyOutcome | null {
  const next = new Map<string, number>()
  const todayIndex = new Map<string, number>()
  for (const tab of before.tabs) {
    if (tab.pinned || !isListedTab(tab)) continue
    const index = next.get(tab.spaceId) ?? 0
    next.set(tab.spaceId, index + 1)
    todayIndex.set(tab.id, index)
  }
  const opener = new Map(before.tabs.flatMap((tab) => (tab.openerId === undefined ? [] : [[tab.id, tab.openerId] as const])))
  const moved = after.tabs
    .filter((tab) => tab.pinned && tab.folderId !== undefined && todayIndex.has(tab.id))
    .map((tab) => ({ id: tab.id, folderId: tab.folderId!, index: todayIndex.get(tab.id)!, ...(opener.has(tab.id) ? { openerId: opener.get(tab.id)! } : {}) }))
  if (moved.length === 0) return null
  const known = new Set(before.folders.map((folder) => folder.id))
  const created = after.folders.filter((folder) => !known.has(folder.id)).map((folder) => folder.id)
  const extended = new Set(moved.map((tab) => tab.folderId).filter((id) => !created.includes(id)))
  return { created: created.length, extended: extended.size, moved: moved.length, undo: { type: 'tabs/untidy', tabs: moved, folderIds: created } }
}

/** The notice that follows: "3 dossiers créés", plus the existing folders that took tabs when there were some. */
export function tidyNotice(outcome: Pick<TidyOutcome, 'created' | 'extended'>): string {
  const parts: string[] = []
  if (outcome.created > 0) parts.push(tp('tidy-panel.dossiers-crees', outcome.created))
  if (outcome.extended > 0) parts.push(tp('tidy-panel.dossiers-completes', outcome.extended))
  return parts.join(', ')
}
