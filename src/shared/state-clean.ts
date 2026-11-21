// Reading a saved state: a file can come from an older build, be edited by hand or be damaged, so every part of it is checked
// on its way in. Each cleaner takes `unknown` and hands back well-formed data: what cannot be repaired is dropped (one bad tab
// never costs the others), a field of the wrong kind falls back to its default, and nothing the file adds beyond the model is kept.
// Pure rules, shared by the main process (loading) and the reducer (restoring, importing).

import { SEARCH_DISCOVERY_SEEN_MAX, READ_LATER_FAVICON_MAX, READ_LATER_FAVICON_URL_MAX, READ_LATER_FOLDERS_LIMIT, READ_LATER_FOLDER_NAME_MAX, READ_LATER_LIMIT, READ_LATER_TITLE_MAX, READ_LATER_URL_MAX, TAB_NAME_MAX, TAB_REMINDER_LIMIT, type TabReminder, defaultSettings, type ArchiveSource, type ArchivedTab, type Favorite, type Folder, type HistoryEntry, type LinkRoute, type ReadLaterFolder, type ReadLaterItem, type Settings, type SiteSearch, type Space, type GridSpan, type SplitGrid, type SplitOrientation, type SplitView, type TabItem } from './model'
import { cleanAutoReload } from './auto-reload'
import { cleanClosedHistory } from './closed-history'
import { isContainerId } from './container-id'
import { isWindowKey } from './window-tabs'
import { isProfileId } from './profiles'
import { SPLIT_MAX_PANES, SPLIT_MIN_RATIO, equalRatios, isGridCount } from './split'
import { cleanTheme, defaultTheme, themeFromHue } from './theme'
import { hostOf, isViewSourceUrl } from './url'
import { isInternalPageUrl } from './internal-page'
import { isSearchAddress } from './site-search'
import { t } from './i18n'
import { rememberSiteHosts } from './site-data'
import { isSpaceImageName } from './space-image'
import { isSpaceEmoji, spaceEmojiOr } from './space-emoji'
import { cleanIconColor, cleanIconLetter, isSpaceIconKind } from './space-icon'
import { cleanWebPanels } from './web-panels'
import { LIVE_FOLDERS_MAX, cleanLiveFolder } from './live-folders'
import { cleanSpaceBackground } from './space-media'
import { isRecord } from './record'

// Kept here too: the readers of a state file import it with the other cleaners.
export { isRecord }

/** Ids are keys of records and Maps: `__proto__` is the one key that cannot be used safely as such. */
const ID_MAX = 256
/** How long a key the interface names for a record of the state may be (an origin, the name of a permission, the id of an extension). */
const RECORD_KEY_MAX = 2048

/** A text that can be the key of a record of the state: not empty, bounded, and not the one key that reaches the prototype. */
export const isRecordKey = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= RECORD_KEY_MAX && value !== '__proto__'

export const cleanId = (value: unknown): string | null => (typeof value === 'string' && value !== '' && value.length <= ID_MAX && value !== '__proto__' ? value : null)

const CONTROL = /\p{Cc}/gu
/** A line of text shown in the interface: control characters (a stray newline, NUL, escape) become spaces, and it stops at `max`. */
export const printable = (value: unknown, max: number): string | null => (typeof value === 'string' ? cutText(value.replace(CONTROL, ' '), max) : null)

/**
 * The text cut to `max` UTF-16 units, without splitting a pair: a cut between the two halves of an emoji leaves a lone surrogate, which is not text (Swift refuses a message
 * that holds one, so a state that kept it made every synchronisation session fail while it stayed in the state: review n° 15 of the synchronisation).
 */
export const cutText = (text: string, max: number): string => {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/**
 * The text cut to `max` BYTES of UTF-8, in whole characters: a bound the other device reads in bytes (the title and the address of an open tab, docs/synchronisation.md §7.3) is not
 * met by cutting at as many UTF-16 units, since one unit of a Japanese title is three bytes and one of an emoji four: the message that held it was refused whole.
 */
export const cutBytes = (text: string, max: number): string => {
  if (text.length * 3 <= max || Buffer.byteLength(text, 'utf8') <= max) return text
  let bytes = 0
  let end = 0
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > max) break
    bytes += size
    end += character.length
  }
  return text.slice(0, end)
}

/** A label that cannot be empty: blank or missing gives `fallback` (a name of the catalogue, in the language of the interface when the state is read: it is then saved as it is). */
const label = (value: unknown, max: number, fallback: string): string => {
  const text = printable(value, max)
  return text !== null && text.trim() !== '' ? text : fallback
}

export const finite = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

export const NAME_MAX = 200
export const TITLE_MAX = 1000
/**
 * The title of an entry that has none: the host of its address, or, for an address without a host (a local file, `about:`, `data:`), the
 * address itself, cut to the length of a title: an address may be sixty times longer than any title is.
 */
const fallbackTitle = (url: string): string => cutText(hostOf(url) || url, TITLE_MAX)
const FAVICON_MAX = 65_536

/**
 * The longest address a tab, a favourite or an archive entry keeps. A server refuses far less (8 Ko is a usual limit), but a page can write any address
 * it likes into its own history (`history.replaceState` takes up to 2 Mo): every one of those would be saved with the state, sent to the interface at each
 * change and copied into the history, until the file is too big to be read again. A longer address is not opened, not read from a file and not put in
 * the archive; a page that goes to one keeps its tab on that site, at the address cut to this length (`cutAddress`, url.ts): a tab never names a site its page has left.
 */
export const TAB_URL_MAX = 65_536

/** What a tab can hold: the same schemes the engine agrees to load (a tab holding anything else would throw when it is shown), at most `TAB_URL_MAX` characters. */
const LOADABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:', 'chrome-extension:', 'devtools:'])
export const isLoadableUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= TAB_URL_MAX && (isViewSourceUrl(value) || (URL.canParse(value) && LOADABLE_PROTOCOLS.has(new URL(value).protocol)))

/**
 * What a tab (and the address a pinned tab goes back to) can hold: a loadable address, or the Extensions page. A favourite, an archive entry, a saved session
 * and the place a closed tab brings back are read with `isLoadableUrl` and never hold the page: it opens from the shell alone, in a window that is not private.
 */
const isTabUrl = (value: unknown): value is string => isLoadableUrl(value) || isInternalPageUrl(value)

/**
 * The icon a tab or a favourite shows: a web address or a `data:` image, at most 64 Ko. Anything else (`file:`, a script, another scheme, a
 * page's multi-megabyte data URL) is dropped, whoever wrote it: the interface draws these as `<img src>` and the state file keeps them.
 */
export const cleanFaviconUrl = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= FAVICON_MAX && (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) ? value : undefined

/** Entries that are records with an id nobody else has: the first one of an id wins, the rest are not what the others refer to. */
export function* uniqueRecords(raw: unknown): Generator<[Record<string, unknown>, string]> {
  if (!Array.isArray(raw)) return
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = cleanId(entry['id'])
    if (id === null || seen.has(id)) continue
    seen.add(id)
    yield [entry, id]
  }
}

/** The spaces of a file. A space saved before themes were a colour-wheel gradient only had a hue, an intensity and a grain amount. */
export function cleanSpaces(raw: unknown): Space[] {
  const out: Space[] = []
  for (const [entry, id] of uniqueRecords(raw)) {
    const hue = entry['hue']
    const base =
      typeof hue === 'number' && Number.isFinite(hue)
        ? { ...themeFromHue(hue, finite(entry['saturation'], 42) / 100 + 0.13), noise: Math.min(1, Math.max(0, finite(entry['grain'], 0) / 100)) }
        : defaultTheme()
    const theme = entry['theme']
    const profileId = entry['profileId']
    const space: Space = {
      id,
      name: label(entry['name'], NAME_MAX, t('state-clean.espace')),
      // One emoji, as the picker gives: a hand-edited file or an import must not put a line of text in a box drawn for one glyph.
      emoji: spaceEmojiOr(entry['emoji'], '✨'),
      theme: cleanTheme(isRecord(theme) ? theme : null, base),
      // The profile names a storage partition on disk: anything that is not a plain id is the default one.
      profileId: isProfileId(profileId) ? profileId : 'default'
    }
    if (typeof entry['hideHeader'] === 'boolean') space.hideHeader = entry['hideHeader']
    // A picture is only ever a file of our own folder, by its own name; a list of panels is repaired entry by entry, and kept only when it has any.
    if (isSpaceImageName(entry['image'])) space.image = entry['image']
    // The coloured-letter icon: letters and colour are checked like anything typed; a kind whose data is missing (letters that are not letters, a picture
    // that is not one of our files) is dropped, so the space shows its emoji rather than an empty box.
    const letter = cleanIconLetter(entry['iconLetter'])
    if (letter !== null) space.iconLetter = letter
    const color = cleanIconColor(entry['iconColor'])
    if (color !== null) space.iconColor = color
    if (typeof entry['iconRound'] === 'boolean') space.iconRound = entry['iconRound']
    const kind = entry['iconKind']
    if (isSpaceIconKind(kind) && (kind === 'emoji' || (kind === 'letter' && space.iconLetter !== undefined) || (kind === 'image' && space.image !== undefined))) space.iconKind = kind
    const webPanels = cleanWebPanels(entry['webPanels'])
    if (webPanels.length > 0) space.webPanels = webPanels
    const background = cleanSpaceBackground(entry['background'])
    if (background) space.background = background
    out.push(space)
  }
  return out
}

/** Folders kept from a file, the first ones: far more than a sidebar can show, and few enough for the walks of the tree to stay quick. */
export const FOLDERS_MAX = 5000

export function cleanFolders(raw: unknown): Folder[] {
  const out: Folder[] = []
  let live = 0
  for (const [entry, id] of uniqueRecords(raw)) {
    if (out.length >= FOLDERS_MAX) break
    const spaceId = cleanId(entry['spaceId'])
    if (spaceId === null) continue
    const parentId = cleanId(entry['parentId'])
    // A live part with an unusable source, or past the limit, is dropped: the folder is then an ordinary one.
    const liveFolder = live < LIVE_FOLDERS_MAX ? cleanLiveFolder(entry['live']) : null
    if (liveFolder) live++
    // The side is kept as it is read (`atBottom` before `atTodayStart` when a hand-edited file says both: a folder has one): a folder that turns out to be inside
    // another has it taken off by `normalizeFolders`, which knows where the folder ends up.
    const side = entry['atBottom'] === true ? { atBottom: true as const } : entry['atTodayStart'] === true ? { atTodayStart: true as const } : {}
    out.push({ id, spaceId, name: label(entry['name'], NAME_MAX, t('import.dossier-sans-nom')), collapsed: entry['collapsed'] === true, ...(parentId ? { parentId } : {}), ...(liveFolder ? { live: liveFolder } : {}), ...side, ...(entry['noWake'] === true ? { noWake: true as const } : {}), ...(isSpaceEmoji(entry['icon']) ? { icon: entry['icon'] } : {}) })
  }
  return out
}

/**
 * The tabs of a file. A tab needs an id, a space that exists and an address the engine can load; its folder must be one of its own
 * space (`folderSpace`: folder id → space id). Everything else is repaired field by field.
 */
export function cleanTabs(raw: unknown, spaceIds: ReadonlySet<string>, folderSpace: ReadonlyMap<string, string>): TabItem[] {
  const out: TabItem[] = []
  for (const [entry, id] of uniqueRecords(raw)) {
    const spaceId = cleanId(entry['spaceId'])
    const url = entry['url']
    if (spaceId === null || !spaceIds.has(spaceId) || !isTabUrl(url)) continue
    // The Extensions page is never in a private tab (the file keeps none: a line that says so is not one of ours) and never in a container, which a file may still name.
    const internal = isInternalPageUrl(url)
    if (internal && entry['private'] === true) continue
    const createdAt = finite(entry['createdAt'], 0)
    const tab: TabItem = {
      id,
      spaceId,
      url,
      title: printable(entry['title'], TITLE_MAX) ?? (internal ? t('extpage.extensions') : fallbackTitle(url)),
      pinned: entry['pinned'] === true,
      createdAt,
      lastActiveAt: finite(entry['lastActiveAt'], createdAt)
    }
    const favicon = cleanFaviconUrl(entry['faviconUrl'])
    if (favicon) tab.faviconUrl = favicon
    const customTitle = printable(entry['customTitle'], TAB_NAME_MAX)?.trim()
    if (customTitle) tab.customTitle = customTitle
    const icon = printable(entry['icon'], 64)
    const glyphs = icon === null ? '' : [...icon.trim()].slice(0, 8).join('')
    if (glyphs) tab.icon = glyphs
    if (isSpaceImageName(entry['image'])) tab.image = entry['image']
    // The Extensions page is an anchor only for the tab that is on it: a file that gives another tab (a tab of the web, one of a container) that address as its anchor would send it
    // there the day the tab is closed or sent back to its anchor.
    const anchor = entry['anchorUrl']
    if (isLoadableUrl(anchor) || (internal && isInternalPageUrl(anchor))) tab.anchorUrl = anchor
    if (entry['keepAwake'] === true) tab.keepAwake = true
    const deadKept = entry['deadKept']
    if (isRecord(deadKept) && isLoadableUrl(deadKept['url']) && typeof deadKept['at'] === 'number' && Number.isFinite(deadKept['at']) && deadKept['at'] >= 0) tab.deadKept = { url: deadKept['url'], at: deadKept['at'] }
    // A private tab is represented in memory (the state a window shows), never in a file: `persistableState` leaves it out.
    if (entry['private'] === true) tab.private = true
    // Only the shape of the id is checked here; whether the container exists is `pruneContainers`'s question (the settings are read apart).
    if (!internal && isContainerId(entry['container'])) tab.container = entry['container']
    // The window a tab belongs to lasts as long as the windows do; a file that names one is read for it (a state is repaired in memory too), then never writes it.
    if (isWindowKey(entry['windowKey'])) tab.windowKey = entry['windowKey']
    const autoReload = cleanAutoReload(entry['autoReload'])
    if (autoReload) tab.autoReload = autoReload
    // A folder holds pinned tabs: a Today tab that names one (an import, a hand-edited file) is outside it.
    const folderId = cleanId(entry['folderId'])
    if (tab.pinned && folderId !== null && folderSpace.get(folderId) === spaceId) tab.folderId = folderId
    // Whether the tab it names exists, is another tab, and whether this one is pinned is `pruneOrigins`'s question (the tabs of a file are not all read yet).
    const openerId = cleanId(entry['openerId'])
    if (openerId !== null) tab.openerId = openerId
    // The same for the tab tree: whether the parent exists and may be one, and whether the setting is on, is `settleTree`'s question.
    const parentId = cleanId(entry['parentId'])
    if (parentId !== null) tab.parentId = parentId
    if (entry['treeCollapsed'] === true) tab.treeCollapsed = true
    // Whether the favourite exists is `pruneFavoriteTabs`'s question (the favourites of a file are not all read yet).
    const favoriteId = cleanId(entry['favoriteId'])
    if (favoriteId !== null) tab.favoriteId = favoriteId
    out.push(tab)
  }
  return out
}

export function cleanFavorites(raw: unknown): Favorite[] {
  const out: Favorite[] = []
  for (const [entry, id] of uniqueRecords(raw)) {
    const url = entry['url']
    if (!isLoadableUrl(url)) continue
    const favicon = cleanFaviconUrl(entry['faviconUrl'])
    // A file from before the favourites were kept per profile names none: `normalize` gives each profile in use its copy (favorite-scope.ts).
    const profileId = isProfileId(entry['profileId']) ? entry['profileId'] : undefined
    out.push({ id, url, title: printable(entry['title'], TITLE_MAX) ?? fallbackTitle(url), ...(favicon ? { faviconUrl: favicon } : {}), ...(profileId !== undefined ? { profileId } : {}) })
  }
  return out
}

/** Entries kept in the archive, newest first (the reducer's own bound). */
export const ARCHIVE_LIMIT = 500
const ARCHIVE_SOURCES: readonly ArchiveSource[] = ['auto', 'manual', 'little', 'sync']

export function cleanArchive(raw: unknown, spaceIds: ReadonlySet<string>): ArchivedTab[] {
  const out: ArchivedTab[] = []
  for (const [entry, id] of uniqueRecords(raw)) {
    const spaceId = cleanId(entry['spaceId'])
    const url = entry['url']
    if (spaceId === null || !spaceIds.has(spaceId) || !isLoadableUrl(url)) continue
    const source = ARCHIVE_SOURCES.find((s) => s === entry['source'])
    const history = cleanClosedHistory(entry['history'], url)
    const container = isContainerId(entry['container']) ? entry['container'] : undefined
    // A tab that was pinned keeps where it was pinned: its anchor address and its folder (the folder may be gone by the time it is reopened).
    const pinned = entry['pinned'] === true
    const anchorUrl = pinned && isLoadableUrl(entry['anchorUrl']) ? entry['anchorUrl'] : undefined
    const folderId = pinned ? (cleanId(entry['folderId']) ?? undefined) : undefined
    out.push({ id, spaceId, url, title: printable(entry['title'], TITLE_MAX) ?? fallbackTitle(url), archivedAt: finite(entry['archivedAt'], 0), ...(source ? { source } : {}), ...(history ? { history } : {}), ...(container ? { container } : {}), ...(pinned ? { pinned: true as const } : {}), ...(anchorUrl ? { anchorUrl } : {}), ...(folderId ? { folderId } : {}) })
    if (out.length >= ARCHIVE_LIMIT) break
  }
  return out
}

/** An http or https address of at most `max` characters (a longer one cannot be stored whole, and a cut address is another address). */
export const isWebAddress = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && /^https?:\/\//i.test(value) && URL.canParse(value) && /^https?:$/.test(new URL(value).protocol)

/** A page worth keeping for later is a web page (http or https) whose address is short enough to be stored whole. */
export const isReadLaterUrl = (value: unknown): value is string => isWebAddress(value, READ_LATER_URL_MAX)

/** An image the interface can show as an icon and that stays small: a `data:` URL of an image type, bounded. */
const READ_LATER_FAVICON_DATA = /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/

/** The icon of a saved page: a small `data:` image or a web address (what a tab holds), nothing else (no `file:`, no script, no other scheme). */
export const readLaterFavicon = (value: unknown): string | undefined =>
  typeof value === 'string' && ((value.length <= READ_LATER_FAVICON_MAX && READ_LATER_FAVICON_DATA.test(value)) || isWebAddress(value, READ_LATER_FAVICON_URL_MAX)) ? value : undefined

/**
 * One entry of the read-later list, repaired; null when it has no usable id or address (the list never holds a page the engine could not open).
 * Its folder is kept when `folderIds` has it: a list from before the folders, or one whose folder is gone, has its pages loose.
 */
export function cleanReadLaterItem(entry: Record<string, unknown>, id: string, folderIds: ReadonlySet<string> = new Set()): ReadLaterItem | null {
  const url = entry['url']
  if (!isReadLaterUrl(url)) return null
  const favicon = readLaterFavicon(entry['faviconUrl'])
  const item: ReadLaterItem = {
    id,
    url,
    title: printable(entry['title'], READ_LATER_TITLE_MAX)?.trim() || cutText(hostOf(url) || url, READ_LATER_TITLE_MAX),
    savedAt: finite(entry['savedAt'], 0)
  }
  if (favicon) item.faviconUrl = favicon
  const folderId = cleanId(entry['folderId'])
  if (folderId !== null && folderIds.has(folderId)) item.folderId = folderId
  return item
}

/** The folders of the read-later list: a name (blank gives "Dossier"), an id nobody else has, at most `READ_LATER_FOLDERS_LIMIT`, in the order saved. */
export function cleanReadLaterFolders(raw: unknown): ReadLaterFolder[] {
  const out: ReadLaterFolder[] = []
  for (const [entry, id] of uniqueRecords(raw)) {
    out.push({ id, name: label(entry['name'], READ_LATER_FOLDER_NAME_MAX, t('import.dossier-sans-nom')).trim(), ...(entry['collapsed'] === true ? { collapsed: true } : {}) })
    if (out.length >= READ_LATER_FOLDERS_LIMIT) break
  }
  return out
}

/** The read-later list of a file: as saved, each address once (the first entry of an address wins), at most `READ_LATER_LIMIT` pages, each in a folder that exists or loose. */
export function cleanReadLater(raw: unknown, folderIds: ReadonlySet<string> = new Set()): ReadLaterItem[] {
  const out: ReadLaterItem[] = []
  const urls = new Set<string>()
  for (const [entry, id] of uniqueRecords(raw)) {
    const item = cleanReadLaterItem(entry, id, folderIds)
    if (!item || urls.has(item.url)) continue
    urls.add(item.url)
    out.push(item)
    if (out.length >= READ_LATER_LIMIT) break
  }
  return out
}

/** The pending reminders of a file: a web page, a time, the space it was in (a gone space: the first valid space reads it as the active one, see tab-reminder.ts), soonest first, at most `TAB_REMINDER_LIMIT`. */
export function cleanTabReminders(raw: unknown, spaceIds: ReadonlySet<string>): TabReminder[] {
  const out: TabReminder[] = []
  for (const [entry, id] of uniqueRecords(raw)) {
    const url = entry['url']
    const dueAt = entry['dueAt']
    if (!isReadLaterUrl(url) || typeof dueAt !== 'number' || !Number.isFinite(dueAt)) continue
    const favicon = readLaterFavicon(entry['faviconUrl'])
    const spaceId = cleanId(entry['spaceId'])
    out.push({
      id,
      url,
      title: printable(entry['title'], READ_LATER_TITLE_MAX)?.trim() || cutText(hostOf(url) || url, READ_LATER_TITLE_MAX),
      ...(favicon ? { faviconUrl: favicon } : {}),
      spaceId: spaceId !== null && spaceIds.has(spaceId) ? spaceId : '',
      dueAt,
      createdAt: finite(entry['createdAt'], 0)
    })
  }
  return out.sort((a, b) => a.dueAt - b.dueAt).slice(0, TAB_REMINDER_LIMIT)
}

const ORIENTATIONS: readonly SplitOrientation[] = ['horizontal', 'vertical']
const RATIO_TOLERANCE = 1e-6

/** Ratios are the share of the stage of each pane: one per pane, none under the minimum, summing to 1. Anything else is shared equally. */
export function cleanRatios(raw: unknown, count: number): number[] {
  if (!Array.isArray(raw) || raw.length !== count) return equalRatios(count)
  const ratios = raw as unknown[]
  if (!ratios.every((r): r is number => typeof r === 'number' && Number.isFinite(r) && r >= SPLIT_MIN_RATIO - RATIO_TOLERANCE && r <= 1)) return equalRatios(count)
  return Math.abs(ratios.reduce((total, r) => total + r, 0) - 1) <= RATIO_TOLERANCE ? ratios : equalRatios(count)
}

const GRID_SPANS: readonly GridSpan[] = ['top', 'bottom', 'left', 'right']

/** A share of a grid's divider: a number that leaves each side at least the minimum. Anything else is the middle. */
function cleanShare(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= SPLIT_MIN_RATIO - RATIO_TOLERANCE && raw <= 1 - SPLIT_MIN_RATIO + RATIO_TOLERANCE ? raw : 0.5
}

/**
 * The grid of a split view of `count` panes, or undefined: a file written before grids has none (its split views are rows and columns, as they were),
 * and a grid needs three or four panes (a grid that lists two is read as their row or column; a pane whose tab is gone is `pruneSplits`'s, which
 * closes it as `withoutPane` would). A grid of three without a known side gets two panes on top and one under them; one of four never has a side.
 */
export function cleanGrid(raw: unknown, count: number): SplitGrid | undefined {
  if (!isRecord(raw) || !isGridCount(count)) return undefined
  const span = GRID_SPANS.find((s) => s === raw['span']) ?? 'bottom'
  return { column: cleanShare(raw['column']), row: cleanShare(raw['row']), ...(count === 3 ? { span } : {}) }
}

/** The shape of each split view; whether its tabs exist and share a space is `pruneSplits`'s question. */
export function cleanSplits(raw: unknown): SplitView[] {
  const out: SplitView[] = []
  for (const [entry, id] of uniqueRecords(raw)) {
    const spaceId = cleanId(entry['spaceId'])
    const listed = entry['tabIds']
    if (spaceId === null || !Array.isArray(listed)) continue
    const tabIds = [...new Set(listed.map(cleanId).filter((t): t is string => t !== null))].slice(0, SPLIT_MAX_PANES)
    const orientation = ORIENTATIONS.find((o) => o === entry['orientation']) ?? 'horizontal'
    const grid = cleanGrid(entry['grid'], tabIds.length)
    // Whether the work view it names exists, and is of the profile of its space, is `pruneWorkViews`'s question (the views of a file are not read yet).
    const viewId = cleanId(entry['viewId'])
    out.push({ id, spaceId, tabIds, orientation, ratios: cleanRatios(entry['ratios'], tabIds.length), ...(grid ? { grid } : {}), ...(viewId !== null ? { viewId } : {}) })
  }
  return out
}

// ---------- dictionaries ----------

/** The entries of a dictionary whose value `valueOf` accepts (it returns undefined to refuse), rebuilt without ever setting a prototype. */
function cleanDictionary<V>(raw: unknown, valueOf: (value: unknown) => V | undefined): Record<string, V> {
  if (!isRecord(raw)) return {}
  const entries: Array<[string, V]> = []
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__proto__') continue
    const clean = valueOf(value)
    if (clean !== undefined) entries.push([key, clean])
  }
  return Object.fromEntries(entries)
}

/** How many sites keep a remembered answer, and how many answers each: past it the oldest go (the page is asked again). */
export const SITE_PERMISSIONS_MAX = 2000
export const PERMISSIONS_PER_SITE_MAX = 64

/** The newest `limit` entries of a record (the order of its keys is the order they were added in). */
function newest<V>(record: Record<string, V>, limit: number): Record<string, V> {
  const keys = Object.keys(record)
  return keys.length <= limit ? record : Object.fromEntries(keys.slice(-limit).map((key) => [key, record[key]!]))
}

/** The remembered answers within their ceilings: the last sites added to the record, and the last answers of each (the reducer puts what it touches at the end). */
export function boundSitePermissions<D>(permissions: Record<string, Record<string, D>>): Record<string, Record<string, D>> {
  // The answer for every site is not a site: it is never the one that goes when the ceiling is reached.
  const { '*': forAll, ...perSite } = permissions
  const kept = newest(perSite, SITE_PERMISSIONS_MAX - (forAll ? 1 : 0))
  const sites = forAll ? { ...kept, '*': forAll } : kept
  return Object.values(sites).every((decisions) => Object.keys(decisions).length <= PERMISSIONS_PER_SITE_MAX)
    ? sites
    : Object.fromEntries(Object.entries(sites).map(([origin, decisions]) => [origin, newest(decisions, PERMISSIONS_PER_SITE_MAX)]))
}

/** Remembered answers to permission prompts: origin → permission → "allow" or "deny". */
export function cleanSitePermissions(raw: unknown): Record<string, Record<string, 'allow' | 'deny'>> {
  return boundSitePermissions(
    cleanDictionary(raw, (perms) => {
      const decisions = cleanDictionary(perms, (d) => (d === 'allow' || d === 'deny' ? d : undefined))
      return Object.keys(decisions).length > 0 ? decisions : undefined
    })
  )
}

/**
 * The answers of a file from elsewhere, as this installation takes them: a refusal is kept (it opens nothing), an « allow » only where this
 * installation had given the same one. A file cannot hand the camera, the microphone or the position to a site: only the person does, at the prompt.
 */
export function withoutForeignGrants<D extends string>(fromFile: Record<string, Record<string, D>>, here: Record<string, Record<string, D>>): Record<string, Record<string, D>> {
  const out: Record<string, Record<string, D>> = {}
  for (const [origin, decisions] of Object.entries(fromFile)) {
    const kept = Object.entries(decisions).filter(([permission, decision]) => decision !== 'allow' || here[origin]?.[permission] === 'allow')
    if (kept.length > 0) out[origin] = Object.fromEntries(kept)
  }
  return out
}

const isDevtoolsAddress = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  const address = value.trim().replace(/^view-source:/i, '')
  return URL.canParse(address) && new URL(address).protocol === 'devtools:'
}

/**
 * A state read from a file from elsewhere, without what points at the developer tools: a tab, a favourite, an archive or session entry whose address
 * is `devtools:` goes, wherever it is. Such a page is the tools' own interface, and its address says what it connects to: that is for the person to
 * open from a page, not for a file to bring along. The caller repairs what pointed at the entries that went (`normalize`).
 */
export function withoutDevtoolsEntries<T>(value: T, depth = 0): T {
  if (depth > 12) return value
  const pointsAtTools = (entry: unknown): boolean => isRecord(entry) && isDevtoolsAddress(entry['url'])
  if (Array.isArray(value)) return value.filter((entry) => !pointsAtTools(entry)).map((entry) => withoutDevtoolsEntries(entry, depth + 1)) as T
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (pointsAtTools(entry) || (key === 'anchorUrl' && isDevtoolsAddress(entry))) continue
    out[key] = withoutDevtoolsEntries(entry, depth + 1)
  }
  return out as T
}

export function cleanSidePanelBehavior(raw: unknown): Record<string, boolean> {
  return cleanDictionary(raw, (v) => (typeof v === 'boolean' ? v : undefined))
}

/**
 * How often each page was picked in the command bar, by profile: at most `limit` keys per profile (the most picked), each of at most 400 characters.
 * A file from before the ranking was kept per profile has one list for every profile (numbers where the profiles are now): none of it is kept, since
 * nothing says in which profile an address was picked, and giving it to one would show there what was browsed in another.
 */
export function cleanCommandBarUsage(raw: unknown, limit: number): Record<string, Record<string, number>> {
  return cleanDictionary(raw, (own) => {
    if (!isRecord(own)) return undefined
    const usage = cleanProfileUsage(own, limit)
    return Object.keys(usage).length > 0 ? usage : undefined
  })
}

function cleanProfileUsage(raw: Record<string, unknown>, limit: number): Record<string, number> {
  const usage = cleanDictionary(raw, (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined))
  const keys = Object.keys(usage).filter((key) => key.length <= 400)
  if (keys.length === Object.keys(usage).length && keys.length <= limit) return usage
  return Object.fromEntries(keys.sort((a, b) => usage[b]! - usage[a]!).slice(0, limit).map((key) => [key, usage[key]!]))
}

// ---------- settings ----------

/**
 * The settings of a file as the model has them: every setting is there, nothing else is, and each one is of the kind its default is
 * (a flag, a finite number, a text, a list, a record). What is more specific than a kind is the business of the cleaners that follow.
 */
export function coerceSettings(raw: Record<string, unknown>): Settings {
  const defaults = defaultSettings()
  const kept: Array<[string, unknown]> = Object.entries(defaults).map(([key, fallback]) => {
    const value = raw[key]
    // The site searches are the user's list: an empty one stays empty. Only a list that cannot be read (not a list, or entries none of
    // which is usable) gives the defaults back, as a repair.
    if (key === 'siteSearches') {
      if (!Array.isArray(value)) return [key, fallback]
      const cleaned = cleanSiteSearches(value)
      return [key, cleaned.length === 0 && value.length > 0 ? fallback : cleaned]
    }
    // `blockTrackers` is the explicit tracker alias kept beside `blockAds`; old files and hand-edited saves may only carry the alias,
    // and the cleaned settings must keep its typed boolean rather than dropping it as an unknown field.
    if (key === 'blockTrackers') {
      return [key, typeof value === 'boolean' ? value : fallback]
    }
    const fits =
      typeof fallback === 'number' ? typeof value === 'number' && Number.isFinite(value) : Array.isArray(fallback) ? Array.isArray(value) : isRecord(fallback) ? isRecord(value) : typeof value === typeof fallback
    return [key, fits ? value : fallback]
  })
  return Object.fromEntries(kept) as unknown as Settings
}

// ---------- what a file holds that this version does not know ----------

/**
 * The fields of a state file that this version does not know: at its top level, and in its settings. The state in memory never holds them (the
 * cleaners above drop them, and nothing reads them); the file keeps them, written back as they were read, so that going back to an older build and
 * forward again does not lose the settings the newer one added. Their values are JSON as the file had it: this version never looks inside them.
 */
export interface ForeignFields {
  top: Record<string, unknown>
  settings: Record<string, unknown>
}

/** The most the fields kept for a later version may weigh (their JSON): beyond, they are dropped and the drop is logged. A real setting is a few bytes. */
export const FOREIGN_FIELDS_MAX_BYTES = 256 * 1024
/** Names never kept: they would set a prototype in a reader that copies them carelessly. */
const NEVER_KEPT: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])
/** Fields this version reads on purpose and migrates into others (sidebar-state.ts `migrateSettings`): known, even though the model has no such field. */
export const MIGRATED_SETTINGS: ReadonlySet<string> = new Set(['autoArchiveHoursByProfile', 'forceDarkSites', 'forceDarkOnlyWhenSystemDark', 'forceDarkExceptions'])

const unknownOf = (raw: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(raw)) if (!known.has(key) && !NEVER_KEPT.has(key) && raw[key] !== undefined) out[key] = raw[key]
  return out
}

/**
 * The fields of a parsed state file (`raw`) that are not in `knownTop` (the top-level fields of the model) nor, inside `settings`, in `knownSettings` or
 * `MIGRATED_SETTINGS`. Null when there are none, or when they weigh more than `FOREIGN_FIELDS_MAX_BYTES` (logged: they are then lost, as before).
 */
export function foreignFieldsOf(raw: unknown, knownTop: ReadonlySet<string>, knownSettings: ReadonlySet<string>): ForeignFields | null {
  if (!isRecord(raw)) return null
  const top = unknownOf(raw, knownTop)
  const settings = isRecord(raw['settings']) ? unknownOf(raw['settings'], new Set([...knownSettings, ...MIGRATED_SETTINGS])) : {}
  if (Object.keys(top).length === 0 && Object.keys(settings).length === 0) return null
  const size = JSON.stringify({ top, settings }).length
  if (size > FOREIGN_FIELDS_MAX_BYTES) {
    console.error(`[store] the state file holds ${size} bytes of fields this version does not know, more than the ${FOREIGN_FIELDS_MAX_BYTES} it keeps for a later version: they are not kept (${[...Object.keys(top), ...Object.keys(settings).map((key) => `settings.${key}`)].slice(0, 20).join(', ')})`)
    return null
  }
  return { top, settings }
}

/**
 * The state as the file holds it: `state` (already what may leave memory, see persistableState) with the fields of a later version put back. What this
 * version knows always wins, so a field it knows is never replaced by one kept from the file. The same object when there is nothing to put back.
 */
export function withForeignFields<T extends { settings: object }>(state: T, foreign: ForeignFields | null): T {
  if (!foreign) return state
  return { ...foreign.top, ...state, settings: { ...foreign.settings, ...state.settings } }
}

export const SITE_SEARCHES_MAX = 50
const KEYWORD = /^[^\s\p{Cc}]{1,30}$/u

/** The quick searches and shortcuts of the command bar: a keyword nobody else has, a name, and an address (with `%s` it takes the query, without it the keyword opens the site). */
export function cleanSiteSearches(raw: unknown): SiteSearch[] {
  const out: SiteSearch[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= SITE_SEARCHES_MAX) break
    if (!isRecord(entry)) continue
    const keyword = entry['keyword']
    const name = printable(entry['name'], 60)?.trim()
    const url = entry['url']
    if (typeof keyword !== 'string' || !KEYWORD.test(keyword)) continue
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue
    if (!name || !isSearchAddress(url)) continue
    out.push({ keyword, name, url })
    seen.add(key)
  }
  return out
}

export const LINK_ROUTES_MAX = 200

/** The rules sending links from other apps to a space: a host and the id of a space. */
export function cleanLinkRoutes(raw: unknown): LinkRoute[] {
  const out: LinkRoute[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= LINK_ROUTES_MAX) break
    if (!isRecord(entry)) continue
    const host = entry['host']
    const spaceId = cleanId(entry['spaceId'])
    if (typeof host === 'string' && /^[^\s\p{Cc}]{1,253}$/u.test(host) && spaceId) out.push({ host, spaceId })
  }
  return out
}

export const EXTENSION_PATHS_MAX = 100
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/

/** Folders of unpacked extensions, loaded at launch: absolute paths only, each once. */
export function cleanExtensionPaths(raw: unknown): string[] {
  const paths = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (paths.size >= EXTENSION_PATHS_MAX) break
    if (typeof entry === 'string' && entry.length <= 1024 && ABSOLUTE_PATH.test(entry) && !/\p{Cc}/u.test(entry)) paths.add(entry)
  }
  return [...paths]
}

/** The sites erased last: valid hosts only, spelled as the URL parser prints them, each once, newest first, no more than the list keeps. */
export const cleanSiteDataRecents = (raw: unknown): string[] => rememberSiteHosts([], Array.isArray(raw) ? raw.filter((host): host is string => typeof host === 'string') : [])

/** The sites already offered their search (`searchDiscoverySeen`): host names as the URL parser prints them, each once, the newest kept when the list is too long. */
export function cleanSearchDiscoverySeen(raw: unknown): string[] {
  const hosts = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry !== 'string' || entry.length > 253 || !/^[a-z0-9.-]+$/.test(entry) || !URL.canParse(`https://${entry}/`) || new URL(`https://${entry}/`).hostname !== entry) continue
    // A host seen again moves to the end, as when it is recorded.
    hosts.delete(entry)
    hosts.add(entry)
  }
  return [...hosts].slice(-SEARCH_DISCOVERY_SEEN_MAX)
}

/** A delay in hours (or minutes): a finite number, zero or more. */
export const cleanDelay = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback)

// ---------- history ----------

/** The longest address the visit history keeps (the length bookmarks and the read-later list allow): the file holds up to 20 000 of them. */
export const HISTORY_URL_MAX = 4096

/** The pages of a history file: web addresses only, each with a title, a visit count of at least one and a date. One bad entry costs only itself. */
export function cleanHistory(raw: unknown): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isRecord(entry)) continue
    const url = entry['url']
    const lastVisitAt = entry['lastVisitAt']
    if (typeof url !== 'string' || url.length > HISTORY_URL_MAX || !/^https?:\/\//i.test(url) || typeof lastVisitAt !== 'number' || !Number.isFinite(lastVisitAt)) continue
    const title = printable(entry['title'], TITLE_MAX)
    const visits = finite(entry['visitCount'], 1)
    out.push({ url, title: title || url, visitCount: Math.max(1, Math.round(visits)), lastVisitAt })
  }
  return out
}
