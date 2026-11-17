// "Lire plus tard": keep a page for later and close its tab (the behaviour of the Chrome Toolkit module of that name).
// Pure rules shared by the reducer (sidebar.ts), the menus, the command bar and the list panel; the shape of an entry and what the
// state file may hold are in model.ts and state-clean.ts.

import { READ_LATER_LIMIT, tabName, type ReadLaterFolder, type ReadLaterItem, type TabItem } from './model'
import type { Ctx } from './sidebar'
import { cleanReadLaterItem, isReadLaterUrl } from './state-clean'
import { t, tp } from './i18n'
import { foldAccents } from './fold'

export { isReadLaterUrl }

/**
 * What saving a tab does to the list. The Toolkit refuses what is not a web page and never duplicates an address: a page already in the
 * list stays where it is (same date, same place) and the tab is closed all the same. The limit is the one thing the Toolkit does not have:
 * a full list refuses the new page, so that nothing the user saved is dropped behind their back, and the tab then stays open.
 */
export type ReadLaterOutcome = 'saved' | 'already' | 'full' | 'unsupported'

export function readLaterOutcome(list: readonly ReadLaterItem[], tab: Pick<TabItem, 'url'>): ReadLaterOutcome {
  if (!isReadLaterUrl(tab.url)) return 'unsupported'
  if (list.some((item) => item.url === tab.url)) return 'already'
  return list.length >= READ_LATER_LIMIT ? 'full' : 'saved'
}

/** The entry for a tab: the name the user sees for it (their own, else the page's title), its icon, and the time. Null for a tab that cannot be saved. */
export function readLaterItemOf(tab: TabItem, ctx: Ctx): ReadLaterItem | null {
  return cleanReadLaterItem({ url: tab.url, title: tabName(tab), faviconUrl: tab.faviconUrl, savedAt: ctx.now }, ctx.newId())
}

/** The sentence of the toast that tells what saving did (the tab has just closed, or stays open when the page was refused). */
export function readLaterNotice(outcome: ReadLaterOutcome): string {
  switch (outcome) {
    case 'saved':
      return t('read-later.enregistre-dans-lire-plus-tard')
    case 'already':
      return t('read-later.deja-dans-lire-plus-tard')
    case 'full':
      return t('read-later.la-liste-lire-plus-tard-est-pleine-read-later', { READ_LATER_LIMIT })
    case 'unsupported':
      return t('read-later.seules-les-pages-web-peuvent-etre-lues-plus-tard')
  }
}

/** Whether the notice of saving offers to open the list: every outcome but a page that cannot be kept at all (the list is where the page went, is already, or where the user must make room). */
export const readLaterOffersList = (outcome: ReadLaterOutcome): boolean => outcome !== 'unsupported'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** "il y a 3 jours": how long ago a page was saved. A date in the future (the clock moved) reads as just now. The minutes and hours are the sessions' words. */
export function readLaterAge(savedAt: number, now: number): string {
  const elapsed = Number.isFinite(savedAt) && Number.isFinite(now) ? now - savedAt : 0
  if (elapsed < MINUTE_MS) return t('sessions.a-l-instant')
  if (elapsed < HOUR_MS) return t('sessions.il-y-a-count-min', { count: Math.floor(elapsed / MINUTE_MS) })
  if (elapsed < DAY_MS) return t('sessions.il-y-a-count-h', { count: Math.floor(elapsed / HOUR_MS) })
  const days = Math.floor(elapsed / DAY_MS)
  if (days === 1) return t('read-later.hier')
  if (days < 7) return tp('read-later.il-y-a-count-jours', days)
  if (days < 30) return tp('read-later.il-y-a-count-semaines', Math.floor(days / 7))
  if (days < 365) return tp('read-later.il-y-a-count-mois', Math.floor(days / 30))
  return tp('read-later.il-y-a-count-ans', Math.floor(days / 365))
}

/** The entries whose title or address contain what was typed (case and accents are ignored, like the other filters); all of them for an empty filter. */
export function filterReadLater(list: readonly ReadLaterItem[], filter: string): ReadLaterItem[] {
  const needle = fold(filter.trim())
  return needle === '' ? [...list] : list.filter((item) => fold(item.title).includes(needle) || fold(item.url).includes(needle))
}

const fold = foldAccents

/**
 * The list with the page `id` moved into a folder (null: loose). `beforeId` names the page of that folder it goes before; undefined puts it
 * first of its folder, null last of it. Pages keep their order among themselves otherwise. The same array comes back when nothing would
 * change (unknown page or folder, or a move to where the page already is).
 */
export function moveReadLater(list: ReadLaterItem[], folders: readonly ReadLaterFolder[], id: string, folderId: string | null, beforeId?: string | null): ReadLaterItem[] {
  const item = list.find((i) => i.id === id)
  if (!item || (folderId !== null && !folders.some((f) => f.id === folderId))) return list
  const rest = list.filter((i) => i.id !== id)
  const inGroup = (i: ReadLaterItem): boolean => (i.folderId ?? null) === folderId
  const { folderId: _old, ...loose } = item
  const placed: ReadLaterItem = folderId === null ? loose : { ...loose, folderId }
  let at: number
  const anchor = beforeId ? rest.findIndex((i) => i.id === beforeId && inGroup(i)) : -1
  if (anchor >= 0) at = anchor
  else if (beforeId === null) {
    const last = rest.findLastIndex(inGroup)
    at = last >= 0 ? last + 1 : rest.length
  } else {
    const first = rest.findIndex(inGroup)
    at = first >= 0 ? first : 0
  }
  const next = [...rest.slice(0, at), placed, ...rest.slice(at)]
  return sameArrangement(list, next) ? list : next
}

/** The pages of each folder (and the loose ones) in order: two lists with the same arrangement show the same, whatever their absolute order. */
function sameArrangement(a: readonly ReadLaterItem[], b: readonly ReadLaterItem[]): boolean {
  const columns = (list: readonly ReadLaterItem[]): string => {
    const groups = new Map<string, string[]>()
    for (const i of list) groups.set(i.folderId ?? '', [...(groups.get(i.folderId ?? '') ?? []), i.id])
    return JSON.stringify([...groups.entries()].sort(([x], [y]) => (x < y ? -1 : 1)))
  }
  return a.length === b.length && columns(a) === columns(b)
}

/** What the list shows: each folder with its pages (in list order), then the loose pages. Pages of a folder that does not exist are loose. */
export function readLaterGroups(list: readonly ReadLaterItem[], folders: readonly ReadLaterFolder[]): { folders: Array<{ folder: ReadLaterFolder; items: ReadLaterItem[] }>; loose: ReadLaterItem[] } {
  const known = new Set(folders.map((f) => f.id))
  return {
    folders: folders.map((folder) => ({ folder, items: list.filter((i) => i.folderId === folder.id) })),
    loose: list.filter((i) => i.folderId === undefined || !known.has(i.folderId))
  }
}

/**
 * Where the page `id` goes when it moves one place up or down among the pages of its group (`items`, in the order shown): the page it lands
 * before, null for the end of the group, as `moveReadLater` reads it. Null when the page is already at that end, or is not of the group.
 */
export function readLaterStep(items: readonly ReadLaterItem[], id: string, direction: 'up' | 'down'): { beforeId: string | null } | null {
  const at = items.findIndex((i) => i.id === id)
  if (at < 0) return null
  if (direction === 'up') return at === 0 ? null : { beforeId: items[at - 1]!.id }
  return at === items.length - 1 ? null : { beforeId: items[at + 2]?.id ?? null }
}
