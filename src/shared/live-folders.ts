// Live folders ("Dossiers en direct", setting `liveFolders`): a folder of the sidebar that fills itself with the latest items of a feed
// (RSS, Atom) or of a public GitHub repository. No account, no token, nothing sent but a plain GET, and only for the folders the user made.
// Pure rules shared by the reducer (sidebar.ts), the scheduler (main/shell/live-folders.ts) and the sheet that makes one; the reading of
// the answers is in feed.ts. Everything an answer holds is hostile: text is bounded and made printable, addresses are checked again.

import type { Folder } from './model'
import { getLanguage, t } from './i18n'

export type GithubWhat = 'releases' | 'tags' | 'commits' | 'issues' | 'pulls'

export const GITHUB_WHATS: ReadonlyArray<{ what: GithubWhat; label: string }> = [
  { what: 'releases', get label() { return t('live-folders.nouvelles-versions') } },
  { what: 'tags', get label() { return t('live-folders.etiquettes-tags') } },
  { what: 'commits', get label() { return t('live-folders.derniers-commits') } },
  { what: 'issues', get label() { return t('live-folders.tickets-ouverts') } },
  { what: 'pulls', get label() { return t('live-folders.demandes-de-fusion-ouvertes') } }
]

export type LiveSource = { kind: 'feed'; url: string } | { kind: 'github'; repo: string; what: GithubWhat }

/** One item of a live folder: what the sidebar shows (a title) and opens (an address). `at` is the date the feed gave it, in milliseconds. */
export interface LiveItem {
  title: string
  url: string
  at?: number
}

export interface LiveFolder {
  source: LiveSource
  items: LiveItem[]
  /** When the last look ended, successful or not. Absent: never looked at, so due at once. */
  checkedAt?: number
  /** The sentence about the last look that failed; absent when the last look worked. */
  failure?: string
}

/** Live folders in all: far more than anyone follows; a state that holds more keeps the first ones live. */
export const LIVE_FOLDERS_MAX = 20
/** Items kept by a folder. */
export const LIVE_ITEMS_MAX = 15
export const LIVE_TITLE_MAX = 200
export const LIVE_URL_MAX = 2048
export const LIVE_FAILURE_MAX = 200
/** A folder is looked at again after this long. */
export const LIVE_INTERVAL_MS = 30 * 60_000
/** …and after a look that failed, this long (a site that is down is not asked every half hour). */
export const LIVE_RETRY_MS = 2 * 3_600_000
/** Two looks of the single timer are at least this far apart, whatever is due: a Mac waking up with ten folders due does not send ten requests at once. */
export const LIVE_GAP_MS = 20_000
/** The first look after launch waits this long, so that it never competes with the pages being restored. */
export const LIVE_START_DELAY_MS = 30_000
/** An answer is read up to this many bytes; the rest is never downloaded. */
export const LIVE_BODY_MAX = 512 * 1024
export const LIVE_TIMEOUT_MS = 15_000
export const LIVE_REDIRECTS_MAX = 3

const CONTROL = /\p{Cc}/gu

/** A line of text for the sidebar: control characters become spaces, spaces collapse, and it stops at `max` characters. */
export function liveText(value: unknown, max: number): string {
  return typeof value === 'string' ? Array.from(value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim() : ''
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/** `owner/name`, as GitHub spells them. Not `.` or `..` for the name: those are paths. */
export function isGithubRepo(value: unknown): value is string {
  if (typeof value !== 'string' || !REPO.test(value)) return false
  const name = value.split('/')[1]!
  return name !== '.' && name !== '..' && !name.endsWith('.git')
}

/** An http(s) address with no login in it, of a length a sidebar can keep. */
export function isFeedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > LIVE_URL_MAX || /\p{Cc}/u.test(value) || !URL.canParse(value)) return false
  const url = new URL(value)
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '' && url.password === ''
}

const WHATS: ReadonlySet<string> = new Set(GITHUB_WHATS.map((w) => w.what))

/** A source as the state may hold it, or null. */
export function cleanLiveSource(raw: unknown): LiveSource | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  if (entry['kind'] === 'feed') return isFeedUrl(entry['url']) ? { kind: 'feed', url: new URL(entry['url']).href } : null
  if (entry['kind'] === 'github') return isGithubRepo(entry['repo']) && typeof entry['what'] === 'string' && WHATS.has(entry['what']) ? { kind: 'github', repo: entry['repo'], what: entry['what'] as GithubWhat } : null
  return null
}

const GITHUB_PATH_WHAT: ReadonlyArray<[RegExp, GithubWhat]> = [
  [/^releases\b/, 'releases'],
  [/^tags\b/, 'tags'],
  [/^commits?\b/, 'commits'],
  [/^issues\b/, 'issues'],
  [/^pulls?\b/, 'pulls']
]

/**
 * What a person typed in the sheet: `owner/name` or a `github.com/owner/name/…` address is a repository (the page it is on says what to
 * follow: `/releases`, `/issues`…; releases by default), any other http(s) address is a feed. Null when it is neither.
 */
export function parseLiveSource(input: string, what: GithubWhat = 'releases'): LiveSource | null {
  const text = input.trim()
  if (text === '' || text.length > LIVE_URL_MAX) return null
  if (isGithubRepo(text)) return { kind: 'github', repo: text, what }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : /^github\.com\//i.test(text) ? `https://${text}` : text
  if (!URL.canParse(withScheme)) return null
  const url = new URL(withScheme)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (/^(?:www\.)?github\.com$/i.test(url.hostname)) {
    const [owner, name, ...rest] = url.pathname.split('/').filter(Boolean)
    const repo = owner !== undefined && name !== undefined ? `${owner}/${name.replace(/\.git$/, '')}` : ''
    if (!isGithubRepo(repo)) return null
    const found = GITHUB_PATH_WHAT.find(([pattern]) => pattern.test(rest[0] ?? ''))
    return { kind: 'github', repo, what: found ? found[1] : what }
  }
  return cleanLiveSource({ kind: 'feed', url: text })
}

/** The address the look asks for. */
export function liveRequestUrl(source: LiveSource): string {
  if (source.kind === 'feed') return source.url
  const base = `https://api.github.com/repos/${source.repo}`
  switch (source.what) {
    case 'releases':
      return `${base}/releases?per_page=${LIVE_ITEMS_MAX}`
    case 'tags':
      return `${base}/tags?per_page=${LIVE_ITEMS_MAX}`
    case 'commits':
      return `${base}/commits?per_page=${LIVE_ITEMS_MAX}`
    case 'issues':
      // The issues list of GitHub also holds the pull requests; the parser leaves them out, so ask for a few more.
      return `${base}/issues?state=open&per_page=${LIVE_ITEMS_MAX * 2}`
    case 'pulls':
      return `${base}/pulls?state=open&per_page=${LIVE_ITEMS_MAX}`
  }
}

/** The headers of the look. Nothing that identifies the user: no cookie, no login, no referrer (the request is made without them). */
export function liveRequestHeaders(source: LiveSource): Record<string, string> {
  return source.kind === 'github' ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : { Accept: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' }
}

/** The name given to a new live folder when the person left it blank. */
export function defaultLiveName(source: LiveSource): string {
  if (source.kind === 'github') return `${source.repo} · ${GITHUB_WHATS.find((w) => w.what === source.what)!.label.toLowerCase()}`
  const host = URL.canParse(source.url) ? new URL(source.url).host.replace(/^www\./, '') : ''
  return liveText(host || source.url, 60) || t('live-folders.flux')
}

/** One item, repaired; null when it has no title or no address a tab could open. */
export function cleanLiveItem(raw: unknown): LiveItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as Record<string, unknown>
  const url = entry['url']
  const title = liveText(entry['title'], LIVE_TITLE_MAX)
  if (!isFeedUrl(url) || title === '') return null
  const at = entry['at']
  return { title, url, ...(typeof at === 'number' && Number.isFinite(at) && at > 0 ? { at: Math.floor(at) } : {}) }
}

/** The items of a folder: each address once, at most `LIVE_ITEMS_MAX`, in the order given. */
export function cleanLiveItems(raw: unknown): LiveItem[] {
  const out: LiveItem[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    const item = cleanLiveItem(entry)
    if (!item || seen.has(item.url)) continue
    seen.add(item.url)
    out.push(item)
    if (out.length >= LIVE_ITEMS_MAX) break
  }
  return out
}

/** The live part of a folder in a saved state, repaired; null when its source is not usable (the folder then is an ordinary one). */
export function cleanLiveFolder(raw: unknown): LiveFolder | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  const source = cleanLiveSource(entry['source'])
  if (!source) return null
  const checkedAt = entry['checkedAt']
  const failure = liveText(entry['failure'], LIVE_FAILURE_MAX)
  return {
    source,
    items: cleanLiveItems(entry['items']),
    ...(typeof checkedAt === 'number' && Number.isFinite(checkedAt) && checkedAt > 0 ? { checkedAt: Math.floor(checkedAt) } : {}),
    ...(failure ? { failure } : {})
  }
}

export const isLiveFolder = (folder: Folder): folder is Folder & { live: LiveFolder } => folder.live !== undefined

/** The live folders of a state, the first `LIVE_FOLDERS_MAX` (in the order of the state): the only ones looked at. */
export function liveFolders(folders: readonly Folder[]): Array<Folder & { live: LiveFolder }> {
  return folders.filter(isLiveFolder).slice(0, LIVE_FOLDERS_MAX)
}

/** When a folder is due: right away if never looked at, else an interval after its last look (a longer one after a failure). */
export function dueAt(live: LiveFolder): number {
  if (live.checkedAt === undefined) return 0
  return live.checkedAt + (live.failure ? LIVE_RETRY_MS : LIVE_INTERVAL_MS)
}

/** The folder to look at now: the one most overdue, or null when none is due. */
export function nextDueFolder(folders: readonly Folder[], now: number): (Folder & { live: LiveFolder }) | null {
  let best: (Folder & { live: LiveFolder }) | null = null
  for (const folder of liveFolders(folders)) {
    if (dueAt(folder.live) > now) continue
    if (best === null || dueAt(folder.live) < dueAt(best.live)) best = folder
  }
  return best
}

/** The moment the next folder falls due, or null when there is no live folder (then no timer is armed at all). */
export function nextWakeAt(folders: readonly Folder[]): number | null {
  const live = liveFolders(folders)
  return live.length === 0 ? null : Math.min(...live.map((f) => dueAt(f.live)))
}

/** The fields of a look that went well. */
export function afterLook(live: LiveFolder, items: readonly LiveItem[], now: number): LiveFolder {
  const { failure: _gone, ...rest } = live
  return { ...rest, items: cleanLiveItems(items), checkedAt: now }
}

/** The fields of a look that failed: the items stay (the last good ones are better than none), the sentence says why. */
export function afterFailure(live: LiveFolder, reason: string, now: number): LiveFolder {
  return { ...live, checkedAt: now, failure: liveText(reason, LIVE_FAILURE_MAX) || t('live-folders.lecture-impossible') }
}

/** Date of an item as the sidebar says it in its tooltip: "24/10/2026", and in English "24 Oct 2026" (the month as a word: figures alone do not say which is the day). */
export function liveItemDate(at: number | undefined): string {
  if (at === undefined) return ''
  return getLanguage() === 'fr' ? new Date(at).toLocaleDateString('fr-FR') : new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}
