// Work views (« Vues de travail »): 2 to 4 sites chosen ahead, opened with one click as a split view, in their places and proportions. Pure rules: how
// the views of a file are read, which of them a space shows, where one opens, what a view keeps of a split view on screen, what its tile draws. The
// actions are in sidebar-work-views.ts; the tiles in renderer/WorkViewTiles.tsx, their menu in main/shell/context-menu-work-view.ts.
//
// A view keeps addresses, never pages: a click opens ordinary tabs of Today, joined in a split view that carries the view's id (`SplitView.viewId`), and a
// second click shows that split view again as it was left. Nothing runs for a view that is not open: the setting `workViewsEnabled` costs nothing.

import { type SidebarState, type SplitArrangement, type SplitView, type TabItem, type WorkView, type WorkViewPane, type WorkViewTarget, tabName } from './model'
import { SPLIT_MAX_PANES, SPLIT_MIN_RATIO, isGridCount, splitLayout, type Rect } from './split'
import { isSessionUrl } from './sessions'
import { cleanGrid, cleanId, cleanRatios, isRecord, printable, TITLE_MAX, uniqueRecords } from './state-clean'
import { isProfileId, knownProfiles } from './profiles'
import { spaceEmojiOr } from './space-emoji'
import { hostOf, resolveInput } from './url'
import { t, tp } from './i18n'
import type { Action } from './sidebar-actions'

/** The views a state keeps: past it a new one is refused (a view is the user's own work: none is pushed out). */
export const WORK_VIEWS_MAX = 50
export const WORK_VIEW_NAME_MAX = 60
/** A view is a split view: two panes at least, `SPLIT_MAX_PANES` at most. */
export const WORK_VIEW_PANES_MIN = 2
export const WORK_VIEW_PANES_MAX = SPLIT_MAX_PANES
/** The icon of a view saved without one. */
export const WORK_VIEW_EMOJI = '💼'
/** The icon of a pane is kept as a web address of this length at most: an inlined picture would swell the state file, and the page brings its own back. */
const PANE_ICON_MAX = 2048

/** The name a blank one becomes, in the language of the interface. */
export const defaultWorkViewName = (): string => t('work-view.vue-de-travail')

/** The name typed for a view: one line, trimmed, at most `WORK_VIEW_NAME_MAX` characters; empty when nothing is left. */
export const cleanWorkViewName = (value: unknown): string => printable(value, WORK_VIEW_NAME_MAX)?.trim() ?? ''

/** The icon a pane keeps: the web address of a picture within the bounds, else none (the tile then draws the first letter of the site). */
const paneIcon = (value: unknown): string | undefined => (typeof value === 'string' && value.length <= PANE_ICON_MAX && /^https?:\/\/[^\s]+$/i.test(value) ? value : undefined)

/**
 * One site of a view, as a file, the sheet or a split view hands it over: an address a session could open again (the web and local files, never
 * `about:blank`, a script, a `data:` page or a page of the application: a file can be edited by hand), a title, and perhaps an icon. Null otherwise.
 */
export function cleanWorkViewPane(raw: unknown): WorkViewPane | null {
  if (!isRecord(raw)) return null
  const url = raw['url']
  if (!isSessionUrl(url)) return null
  const title = (printable(raw['title'], TITLE_MAX)?.trim() || hostOf(url) || url).slice(0, TITLE_MAX)
  const icon = paneIcon(raw['faviconUrl'])
  return { url, title, ...(icon ? { faviconUrl: icon } : {}) }
}

/** Where a view opens, as a file or the sheet says it; anything else is the space on screen (undefined). */
export function cleanWorkViewTarget(raw: unknown): WorkViewTarget | undefined {
  if (!isRecord(raw)) return undefined
  if (raw['kind'] === 'window') return { kind: 'window' }
  if (raw['kind'] === 'new-space') return { kind: 'new-space' }
  const spaceId = cleanId(raw['spaceId'])
  return raw['kind'] === 'space' && spaceId !== null ? { kind: 'space', spaceId } : undefined
}

/** The layout of `count` panes, read as a split view's is (state-clean.ts): shares out of bounds are shared equally, a grid needs three or four panes. */
export function cleanWorkViewLayout(raw: Record<string, unknown>, count: number): Pick<WorkView, 'orientation' | 'ratios' | 'grid'> {
  const grid = cleanGrid(raw['grid'], count)
  return { orientation: raw['orientation'] === 'vertical' ? 'vertical' : 'horizontal', ratios: cleanRatios(raw['ratios'], count), ...(grid ? { grid } : {}) }
}

/**
 * A view of a file (or of an action, which is checked the same way). Its sites are read one by one: one that cannot be opened is left out, and so is a
 * fifth one; a view with fewer than two sites left is no view. Its profile is checked for its shape here; whether it exists is `pruneWorkViews`'s question.
 */
export function cleanWorkView(entry: Record<string, unknown>, id: string): WorkView | null {
  const panes = (Array.isArray(entry['panes']) ? entry['panes'] : []).map(cleanWorkViewPane).filter((pane): pane is WorkViewPane => pane !== null).slice(0, WORK_VIEW_PANES_MAX)
  if (panes.length < WORK_VIEW_PANES_MIN) return null
  const profileId = entry['profileId']
  const target = cleanWorkViewTarget(entry['target'])
  return {
    id,
    name: cleanWorkViewName(entry['name']) || defaultWorkViewName(),
    emoji: spaceEmojiOr(entry['emoji'], WORK_VIEW_EMOJI),
    profileId: isProfileId(profileId) ? profileId : 'default',
    panes,
    ...cleanWorkViewLayout(entry, panes.length),
    ...(target ? { target } : {})
  }
}

/** The views of a file, in their order: each id once, at most `WORK_VIEWS_MAX`. */
export function cleanWorkViews(raw: unknown): WorkView[] {
  const out: WorkView[] = []
  for (const [entry, id] of uniqueRecords(raw)) {
    if (out.length >= WORK_VIEWS_MAX) break
    const view = cleanWorkView(entry, id)
    if (view) out.push(view)
  }
  return out
}

const withoutTarget = ({ target: _gone, ...view }: WorkView): WorkView => view

/**
 * What keeps the views and the marks of the split views from dangling, after every action and when a file is read. A view of a profile that no longer
 * exists goes with it (as its favourites do); a view always opened in a space that is gone, or that changed profile, opens in the space on screen again;
 * a split view keeps the mark of a view only while the view exists, is of the profile of its space, and no other split view of that space has it.
 * Same object when nothing changes.
 */
export function pruneWorkViews(state: SidebarState): SidebarState {
  const marked = state.splits.some((split) => split.viewId !== undefined)
  if (state.workViews.length === 0 && !marked) return state
  let views = state.workViews
  const quick = new Set(['default', ...state.spaces.map((space) => space.profileId), ...Object.keys(state.settings.profileNames), ...Object.keys(state.settings.profiles)])
  if (!views.every((view) => quick.has(view.profileId))) {
    const known = new Set(knownProfiles(state))
    views = views.filter((view) => known.has(view.profileId))
  }
  const profileOf = new Map(state.spaces.map((space) => [space.id, space.profileId]))
  const lost = (view: WorkView): boolean => view.target?.kind === 'space' && profileOf.get(view.target.spaceId) !== view.profileId
  if (views.some(lost)) views = views.map((view) => (lost(view) ? withoutTarget(view) : view))
  let splits = state.splits
  if (marked) {
    const byId = new Map(views.map((view) => [view.id, view]))
    const seen = new Set<string>()
    let changed = false
    const next = splits.map((split) => {
      if (split.viewId === undefined) return split
      const view = byId.get(split.viewId)
      const key = `${split.spaceId}\n${split.viewId}`
      if (view && profileOf.get(split.spaceId) === view.profileId && !seen.has(key)) {
        seen.add(key)
        return split
      }
      changed = true
      const { viewId: _gone, ...rest } = split
      return rest
    })
    if (changed) splits = next
  }
  return views === state.workViews && splits === state.splits ? state : { ...state, workViews: views, splits }
}

// ---- which views a space shows, and where one opens ----

/** The views of a profile, in the order of their tiles. */
export const workViewsOf = (state: Pick<SidebarState, 'workViews'>, profileId: string): WorkView[] => state.workViews.filter((view) => view.profileId === profileId)

/** The views whose tiles a space shows: those of its profile, while the function is on. None for a space that does not exist. */
export function shownWorkViews(state: Pick<SidebarState, 'workViews' | 'spaces' | 'settings'>, spaceId: string): WorkView[] {
  if (!state.settings.workViewsEnabled || state.workViews.length === 0) return []
  const space = state.spaces.find((each) => each.id === spaceId)
  return space ? workViewsOf(state, space.profileId) : []
}

/** The split view a view has open in a space (the one that carries its mark), if any. */
export const openWorkView = (state: Pick<SidebarState, 'splits'>, viewId: string, spaceId: string): SplitView | undefined =>
  state.splits.find((split) => split.viewId === viewId && split.spaceId === spaceId)

/** Whether a view is on screen in a space: the tab shown there is a pane of its split view. Its tile is lit then. */
export function workViewShown(state: Pick<SidebarState, 'splits' | 'activeTabBySpace'>, viewId: string, spaceId: string): boolean {
  const split = openWorkView(state, viewId, spaceId)
  const shown = state.activeTabBySpace[spaceId]
  return split !== undefined && typeof shown === 'string' && split.tabIds.includes(shown)
}

/**
 * The space a view opens in, asked from a window that shows `shown`: the space it is always opened in, else the space shown. Null for a view that opens in
 * a space of its own not made yet (`new-space`), and when the space is not one of the view's profile (its pages would have another profile's cookies).
 */
export function workViewSpace(state: Pick<SidebarState, 'spaces'>, view: Pick<WorkView, 'profileId' | 'target'>, shown: string): string | null {
  if (view.target?.kind === 'new-space') return null
  const wanted = view.target?.kind === 'space' ? view.target.spaceId : shown
  const space = state.spaces.find((each) => each.id === wanted)
  return space && space.profileId === view.profileId ? space.id : null
}

/**
 * The entries of the menu of the Dock: the views of the profile of the space a window shows, each named with its icon. None while the
 * function is off; none for a private window either, whose state keeps none.
 */
export function dockWorkViews(state: Pick<SidebarState, 'workViews' | 'spaces' | 'settings' | 'activeSpaceId'>): Array<{ id: string; label: string }> {
  return shownWorkViews(state, state.activeSpaceId).map((view) => ({ id: view.id, label: `${view.emoji} ${view.name}` }))
}

/** Whether a click opens the view in a window of its own (its place is « Dans une nouvelle fenêtre »): the main process opens the window first. */
export function opensInNewWindow(state: Pick<SidebarState, 'workViews' | 'settings'>, viewId: string): boolean {
  return state.settings.workViewsEnabled && state.workViews.find((view) => view.id === viewId)?.target?.kind === 'window'
}

// ---- the notices ----

/** The view an action just saved, if it saved one: the one the state after has and the state before had not. */
export const workViewSaved = (before: Pick<SidebarState, 'workViews'>, after: Pick<SidebarState, 'workViews'>): WorkView | undefined =>
  after.workViews.find((view) => !before.workViews.some((old) => old.id === view.id))

/**
 * After a view was removed: the notice (« Vue de travail « Matin » retirée ») and the action of its « Annuler », which puts the view back at its place with
 * the split views it had open, so that its tile is lit again and a click shows them. Null when the action removed nothing.
 */
export function workViewRemovedUndo(before: Pick<SidebarState, 'workViews' | 'splits'>, after: Pick<SidebarState, 'workViews'>, action: Action): { notice: string; undo: Action } | null {
  if (action.type !== 'view/remove') return null
  const index = before.workViews.findIndex((view) => view.id === action.id)
  const view = before.workViews[index]
  if (!view || after.workViews.some((each) => each.id === view.id)) return null
  const splitIds = before.splits.filter((split) => split.viewId === view.id).map((split) => split.id)
  return { notice: t('work-view.vue-retiree', { name: view.name }), undo: { type: 'view/restore', view, index, splitIds } }
}

// ---- what a view keeps of a split view ----

/** A tab as a pane of a view: where it is now, the name it shows, its icon when that is a web address. */
function paneOf(tab: TabItem): WorkViewPane {
  const icon = paneIcon(tab.faviconUrl)
  return { url: tab.url, title: (tabName(tab).trim() || hostOf(tab.url) || tab.url).slice(0, TITLE_MAX), ...(icon ? { faviconUrl: icon } : {}) }
}

/**
 * What a view keeps of a split view on screen: its pages (address, name, icon) in their order, and its layout. Null when one of its pages is not one a
 * view can open again (an empty tab, a page of the application or of an extension, a private tab).
 */
export function workViewOfSplit(state: Pick<SidebarState, 'tabs'>, split: SplitView): Pick<WorkView, 'panes' | 'orientation' | 'ratios' | 'grid'> | null {
  const tabs = split.tabIds.map((id) => state.tabs.find((tab) => tab.id === id))
  if (tabs.length < WORK_VIEW_PANES_MIN || tabs.length > WORK_VIEW_PANES_MAX) return null
  if (!tabs.every((tab): tab is TabItem => tab !== undefined && tab.private !== true && isSessionUrl(tab.url))) return null
  return { panes: tabs.map(paneOf), orientation: split.orientation, ratios: [...split.ratios], ...(split.grid ? { grid: { ...split.grid } } : {}) }
}

/**
 * Why a split view cannot be saved as a view now, in words for the menu; null when it can. A private window never offers it (it keeps nothing), and
 * the function off, the entry is not there at all.
 */
export function workViewSaveRefusal(state: Pick<SidebarState, 'tabs' | 'workViews'>, split: SplitView): string | null {
  if (state.workViews.length >= WORK_VIEWS_MAX) return t('work-view.trop-de-vues', { max: WORK_VIEWS_MAX })
  return workViewOfSplit(state, split) ? null : t('work-view.page-impossible-a-garder')
}

// ---- what the tile and the sheet show ----

/** The arrangement of a view: a row, a column, or a grid (three or four panes). */
const workViewArrangement = (view: Pick<WorkView, 'panes' | 'orientation' | 'grid'>): SplitArrangement => (view.grid && isGridCount(view.panes.length) ? 'grid' : view.orientation)

const percent = (share: number): number => Math.round(share * 100)

/** « 2 sites, côte à côte, 60 / 40 »: what the sheet says of the layout a view keeps. */
export function workViewSummary(view: Pick<WorkView, 'panes' | 'orientation' | 'ratios' | 'grid'>): string {
  const count = view.panes.length
  const arrangement = workViewArrangement(view)
  if (arrangement === 'grid' && view.grid) {
    const columns = `${percent(view.grid.column)} / ${100 - percent(view.grid.column)}`
    const rows = `${percent(view.grid.row)} / ${100 - percent(view.grid.row)}`
    return tp('work-view.resume-grille', count, { columns, rows })
  }
  const shares = view.ratios.map(percent).join(' / ')
  return tp(arrangement === 'vertical' ? 'work-view.resume-en-colonne' : 'work-view.resume-cote-a-cote', count, { shares })
}

/** Where a view opens, in a sentence (the preview of the command bar, the sheet). */
export function workViewPlace(view: Pick<WorkView, 'target'>, state: Pick<SidebarState, 'spaces'>): string {
  switch (view.target?.kind) {
    case 'space': {
      const spaceId = view.target.spaceId
      return t('work-view.lieu-espace', { name: state.spaces.find((space) => space.id === spaceId)?.name ?? '' })
    }
    case 'new-space':
      return t('work-view.lieu-nouvel-espace')
    case 'window':
      return t('work-view.lieu-fenetre')
    default:
      return t('work-view.lieu-espace-affiche')
  }
}

/** The name a tile gives to a screen reader: the view's name, what it is, and how many sites it opens. */
export const workViewLabel = (view: Pick<WorkView, 'name' | 'panes'>): string => t('work-view.tuile', { name: view.name, sites: tp('work-view.sites', view.panes.length) })

/** The panes of a view in a box of 100 × 100 with gaps of `gap`: the rectangles of its split view, which the tile draws in percent. */
export const workViewThumbnail = (view: Pick<WorkView, 'orientation' | 'ratios' | 'grid'>, gap = 8): Rect[] => splitLayout({ width: 100, height: 100 }, view, gap)

// ---- what the sheet reads from what is typed ----

/**
 * The address a site typed in the sheet stands for: what the command bar would open for it (`mail.example.fr` is `https://mail.example.fr/`), when that is
 * an address a view keeps (the web and local files). Null for words to search for and for any other address.
 */
export function typedWorkViewUrl(text: string): string | null {
  const resolved = resolveInput(text, '%s')
  return resolved?.kind === 'url' && isSessionUrl(resolved.url) ? resolved.url : null
}

/**
 * The shares of the panes from the percents typed in the sheet, scaled to make the whole (60 and 40, or 3 and 2, are both 60 / 40): null when one is not a
 * number above zero, or leaves a pane under the minimum (12 %), as the dividers of a split view refuse it.
 */
export function sharesOfPercents(percents: readonly number[]): number[] | null {
  if (percents.length < WORK_VIEW_PANES_MIN || !percents.every((p) => Number.isFinite(p) && p > 0)) return null
  const sum = percents.reduce((total, p) => total + p, 0)
  const shares = percents.map((p) => p / sum)
  return shares.every((share) => share >= SPLIT_MIN_RATIO - 1e-9) ? shares : null
}

/** The share of a divider of a grid from the percent typed: null outside 12 to 88 %. */
export function gridShareOfPercent(percent: number): number | null {
  const share = percent / 100
  return Number.isFinite(share) && share >= SPLIT_MIN_RATIO - 1e-9 && share <= 1 - SPLIT_MIN_RATIO + 1e-9 ? share : null
}
