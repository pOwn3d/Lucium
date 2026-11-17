// Converts Arc's StorableSidebar.json into Lucium's model.
// Format observed on Arc 1.170.0. Every access is defensive:
// the format is not documented and can change without notice, so unknown shapes are counted, never fatal.

import { createHash } from 'node:crypto'
import { MAX_IMPORTED_DEPTH, MAX_IMPORTED_FAVORITES, MAX_IMPORTED_FOLDERS, MAX_IMPORTED_LINKS, MAX_IMPORTED_SPACES } from '@shared/import-sources'
import { t } from '@shared/i18n'
import type { Favorite, Folder, Space, SplitOrientation, SplitView, TabItem } from '@shared/model'
import { SPLIT_MAX_PANES, SPLIT_MIN_RATIO, equalRatios } from '@shared/split'
import { themeFromArc, themeFromHue } from '@shared/theme'
import type { Ctx } from '@shared/sidebar'
import { folderName, isWebUrl, linkTitle } from './limits'
import { isRecord } from '@shared/record'

/**
 * The id an item of the file gets here. It comes from the item's own id and nothing else, so importing the same file twice (or two files of
 * the same account) names the same things the same way, and `import/merge` leaves alone what it already holds.
 */
export function arcId(kind: 'space' | 'item' | 'split' | 'boost', id: string): string {
  return `arc-${createHash('sha256').update(`${kind}:${id}`).digest('hex').slice(0, 24)}`
}

/** Arc stores dates as seconds since 2001-01-01 (Apple reference date). */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
/** A date later than this is a damaged value, not a moment (1e308 seconds would otherwise become Infinity, and be saved as null). */
const LATEST_MS = Date.UTC(3000, 0, 1)
const toMs = (appleSeconds: unknown, fallback: number): number => {
  if (typeof appleSeconds !== 'number') return fallback
  const ms = APPLE_EPOCH_MS + appleSeconds * 1000
  // No such file holds a date before the reference date, so an earlier one is as damaged as one in the far future.
  return Number.isFinite(ms) && ms >= APPLE_EPOCH_MS && ms <= LATEST_MS ? ms : fallback
}

interface ArcItem {
  id: string
  parentID: string | null
  childrenIds: string[]
  title: string | null
  createdAt?: number
  data: Record<string, unknown>
}

export interface ArcImport {
  spaces: Space[]
  tabs: TabItem[]
  folders: Folder[]
  favorites: Favorite[]
  splits: SplitView[]
  /**
   * `overLimit`: valid tabs and folders left out because an import holds at most `MAX_IMPORTED_LINKS` of the first and `MAX_IMPORTED_FOLDERS` of the second.
   * `tabGroups`: the file's tab groups, whose tabs came in without the group (Lucium has none).
   */
  report: { spaces: number; tabs: number; folders: number; favorites: number; splits: number; tabGroups: number; skipped: number; overLimit: number }
}

/** The file interleaves ids and objects in the same array ([id, obj, id, obj...]): keep the objects. */
const objectsOf = (list: unknown): Record<string, unknown>[] => (Array.isArray(list) ? list.filter(isRecord) : [])

/** Hue (0-360) extracted from nothing reliable yet: spread spaces on the wheel so they stay distinguishable. */
const hueFor = (index: number): number => (250 + index * 47) % 360

/**
 * The share of the stage of each pane of a split view. The file lists `[id, factor, id, factor…]` (shares that sum to 1, not necessarily for
 * every pane and not in the order of the panes). A pane with no factor takes an equal part of what the others leave; anything that
 * does not make a plausible set of shares is an even split.
 */
function splitRatios(factors: unknown, paneIds: readonly string[]): number[] {
  const known = new Map<string, number>()
  if (Array.isArray(factors)) {
    for (let i = 0; i + 1 < factors.length; i += 2) {
      const id = factors[i]
      const factor = factors[i + 1]
      if (typeof id === 'string' && paneIds.includes(id) && typeof factor === 'number' && Number.isFinite(factor) && factor > 0) known.set(id, factor)
    }
  }
  const knownSum = [...known.values()].reduce((total, factor) => total + factor, 0)
  const missing = paneIds.length - known.size
  if (known.size === 0 || (missing > 0 && knownSum >= 1) || (missing === 0 && Math.abs(knownSum - 1) > 1e-6)) return equalRatios(paneIds.length)
  const rest = missing > 0 ? (1 - knownSum) / missing : 0
  const ratios = paneIds.map((id) => known.get(id) ?? rest)
  const total = ratios.reduce((sum, r) => sum + r, 0)
  const shares = ratios.map((r) => r / total)
  return shares.every((r) => r >= SPLIT_MIN_RATIO) ? shares : equalRatios(paneIds.length)
}

export function convertArcSidebar(raw: unknown, ctx: Ctx): ArcImport {
  const empty: ArcImport = { spaces: [], tabs: [], folders: [], favorites: [], splits: [], report: { spaces: 0, tabs: 0, folders: 0, favorites: 0, splits: 0, tabGroups: 0, skipped: 0, overLimit: 0 } }
  const containers = isRecord(raw) && isRecord(raw.sidebar) ? objectsOf(raw.sidebar.containers) : []
  const main = containers.find((c) => Array.isArray(c.items) && Array.isArray(c.spaces))
  if (!main) return empty

  const items = new Map<string, ArcItem>()
  for (const o of objectsOf(main.items)) {
    if (typeof o.id === 'string' && isRecord(o.data)) {
      items.set(o.id, {
        id: o.id,
        parentID: typeof o.parentID === 'string' ? o.parentID : null,
        childrenIds: Array.isArray(o.childrenIds) ? o.childrenIds.filter((c): c is string => typeof c === 'string') : [],
        title: typeof o.title === 'string' ? o.title : null,
        createdAt: typeof o.createdAt === 'number' ? o.createdAt : undefined,
        data: o.data
      })
    }
  }

  const result: ArcImport = { ...empty, report: { ...empty.report } }

  // The file gives every item one parent. A file where two parents share a child (or a child is its own ancestor) is damaged or made on
  // purpose: followed naively, 19 items sharing their children expand into 131 072 tabs. Each item is imported once.
  const seen = new Set<string>()

  /** The item, the first time it is reached; null (and counted as left out) when it does not exist or was already imported. */
  const claim = (id: string): ArcItem | null => {
    const item = items.get(id)
    if (!item || seen.has(id)) {
      result.report.skipped++
      return null
    }
    seen.add(id)
    return item
  }

  /** The tab a `tab` item of the file makes, or null when the import holds as many tabs as it may (counted as over the limit). */
  const makeTab = (child: ArcItem, tabData: Record<string, unknown> & { savedURL: string }, spaceId: string, pinned: boolean, folderId: string | undefined): TabItem | null => {
    if (result.tabs.length >= MAX_IMPORTED_LINKS) {
      result.report.overLimit++
      return null
    }
    const created = toMs(child.createdAt, ctx.now)
    const tab: TabItem = {
      id: arcId('item', child.id),
      spaceId,
      url: tabData.savedURL,
      title: linkTitle(typeof tabData.savedTitle === 'string' && tabData.savedTitle ? tabData.savedTitle : child.title, tabData.savedURL),
      pinned,
      anchorUrl: pinned ? tabData.savedURL : undefined,
      folderId,
      createdAt: created,
      // A Today tab arrives as one the person has just had open: with the date of the file it would be older than the auto-archive delay (12 hours by
      // default; the file can hold tabs up to 30 days old) and the first sweep would send it to the archive, which holds 500 and pushes out the oldest.
      lastActiveAt: pinned ? toMs(tabData.timeLastActiveAt, created) : ctx.now
    }
    result.tabs.push(tab)
    return tab
  }

  const webTab = (item: ArcItem): (Record<string, unknown> & { savedURL: string }) | null => {
    const tabData = item.data.tab
    return isRecord(tabData) && isWebUrl(tabData.savedURL) ? (tabData as Record<string, unknown> & { savedURL: string }) : null
  }

  /** A split view: its tabs come in as tabs of the place it sits in, side by side as the file has them. */
  const importSplit = (split: ArcItem, spaceId: string, pinned: boolean, folderId: string | undefined, over: boolean): void => {
    const panes: Array<{ arc: string; tab: TabItem }> = []
    for (const childId of split.childrenIds) {
      const child = claim(childId)
      if (!child) continue
      const tabData = webTab(child)
      if (!tabData) {
        result.report.skipped++
        continue
      }
      if (over) {
        result.report.overLimit++
        continue
      }
      const tab = makeTab(child, tabData, spaceId, pinned, folderId)
      if (tab) panes.push({ arc: child.id, tab })
    }
    if (over) return
    const shown = panes.slice(0, SPLIT_MAX_PANES)
    // One tab (or none) is no split: the tab stays, the split is counted as left out.
    if (shown.length < 2) {
      result.report.skipped++
      return
    }
    const view = isRecord(split.data.splitView) ? split.data.splitView : {}
    const orientation: SplitOrientation = typeof view.layoutOrientation === 'string' && view.layoutOrientation.toLowerCase() === 'vertical' ? 'vertical' : 'horizontal'
    result.splits.push({
      id: arcId('split', split.id),
      spaceId,
      tabIds: shown.map((p) => p.tab.id),
      orientation,
      ratios: splitRatios(view.itemWidthFactors, shown.map((p) => p.arc))
    })
  }

  /** `over`: the folder this goes in was left out by the limit, so what is inside is counted, not imported. */
  const importChildren = (parentId: string, spaceId: string, pinned: boolean, folderId?: string, over = false, depth = 0): void => {
    // Lists inside lists inside lists: past the depth a sidebar can show it is a loop of the file, and the stack is not made for it.
    if (depth > MAX_IMPORTED_DEPTH) {
      result.report.overLimit++
      return
    }
    for (const childId of items.get(parentId)?.childrenIds ?? []) {
      const child = claim(childId)
      if (!child) continue
      const tabData = webTab(child)
      if (tabData) {
        if (over) result.report.overLimit++
        else makeTab(child, tabData, spaceId, pinned, folderId)
      } else if (isRecord(child.data.splitView)) {
        importSplit(child, spaceId, pinned, folderId, over)
      } else if (isRecord(child.data.tabGroup)) {
        // Lucium has no tab groups: the tabs stay where the group was, in the same order.
        result.report.tabGroups++
        importChildren(child.id, spaceId, pinned, folderId, over, depth + 1)
      } else if (isRecord(child.data.list) && pinned) {
        if (over || result.folders.length >= MAX_IMPORTED_FOLDERS) {
          result.report.overLimit++
          importChildren(child.id, spaceId, true, undefined, true, depth + 1)
          continue
        }
        // A list inside a list stays inside it; the merge cuts what goes deeper than the sidebar allows (folders.ts).
        const folder: Folder = { id: arcId('item', child.id), spaceId, name: folderName(child.title), collapsed: false, ...(folderId ? { parentId: folderId } : {}) }
        result.folders.push(folder)
        importChildren(child.id, spaceId, true, folder.id, false, depth + 1)
      } else {
        // chrome:// or extension tabs, a list in Today: not representable.
        result.report.skipped++
      }
    }
  }

  const rawSpaces = objectsOf(main.spaces)
  result.report.overLimit += Math.max(0, rawSpaces.length - MAX_IMPORTED_SPACES)
  rawSpaces.slice(0, MAX_IMPORTED_SPACES).forEach((rawSpace, index) => {
    if (typeof rawSpace.id !== 'string') return
    const info = isRecord(rawSpace.customInfo) ? rawSpace.customInfo : {}
    const icon = isRecord(info.iconType) ? info.iconType : {}
    const space: Space = {
      id: arcId('space', rawSpace.id),
      name: folderName(rawSpace.title, t('import.espace-n', { n: index + 1 })),
      emoji: typeof icon.emoji_v2 === 'string' && icon.emoji_v2 ? icon.emoji_v2 : '✨',
      // The real colours, harmony, intensity and texture when the file holds a blended gradient; a hue otherwise.
      theme: themeFromArc(info.windowTheme) ?? themeFromHue(hueFor(index)),
      profileId: 'default'
    }
    result.spaces.push(space)

    // containerIDs = ['pinned', <id>, 'unpinned', <id>]
    const ids = Array.isArray(rawSpace.containerIDs) ? rawSpace.containerIDs : []
    for (let i = 0; i + 1 < ids.length; i += 2) {
      const kind = ids[i]
      const containerId = ids[i + 1]
      if (typeof containerId !== 'string' || (kind !== 'pinned' && kind !== 'unpinned')) continue
      importChildren(containerId, space.id, kind === 'pinned')
    }
  })

  // Favorites (the "top apps" of the file): the tabs of the top-apps container of each profile, shared by every space of that profile.
  const favoriteUrls = new Set<string>()
  for (const containerId of Array.isArray(main.topAppsContainerIDs) ? main.topAppsContainerIDs : []) {
    if (typeof containerId !== 'string') continue
    for (const childId of items.get(containerId)?.childrenIds ?? []) {
      const child = items.get(childId)
      if (!child) continue
      const tabData = child.data.tab
      if (!isRecord(tabData) || !isWebUrl(tabData.savedURL)) {
        result.report.skipped++
        continue
      }
      if (favoriteUrls.has(tabData.savedURL)) continue
      if (result.favorites.length >= MAX_IMPORTED_FAVORITES) {
        result.report.overLimit++
        continue
      }
      favoriteUrls.add(tabData.savedURL)
      result.favorites.push({
        id: ctx.newId(),
        // Every imported space browses with the default profile (above): its top apps are that profile's favourites.
        profileId: 'default',
        url: tabData.savedURL,
        title: linkTitle(typeof tabData.savedTitle === 'string' && tabData.savedTitle ? tabData.savedTitle : child.title, tabData.savedURL)
      })
    }
  }

  result.report.spaces = result.spaces.length
  result.report.tabs = result.tabs.length
  result.report.folders = result.folders.length
  result.report.favorites = result.favorites.length
  result.report.splits = result.splits.length
  return result
}
