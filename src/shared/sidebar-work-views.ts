// A family of the reducer of the sidebar (sidebar.ts composes them in `reduceCore`): the work views (`view/*`, rules in work-views.ts). With the setting
// `workViewsEnabled` off, every one of these actions changes nothing; the views stay in the state.

import type { SidebarState, SplitView, WorkView, WorkViewPane, WorkViewTarget } from './model'
import { themeHue } from './theme'
import { spaceEmojiOr } from './space-emoji'
import { equalRatios } from './split'
import type { Ctx, Action } from './sidebar-actions'
import { tabOpenedSince } from './sidebar-selectors'
import { replaceTab, select } from './sidebar-helpers'
import type { Reducers } from './sidebar-helpers'
import { isRecord } from './state-clean'
import {
  WORK_VIEWS_MAX,
  WORK_VIEW_EMOJI,
  WORK_VIEW_PANES_MAX,
  WORK_VIEW_PANES_MIN,
  cleanWorkView,
  cleanWorkViewLayout,
  cleanWorkViewName,
  cleanWorkViewPane,
  cleanWorkViewTarget,
  defaultWorkViewName,
  openWorkView,
  workViewOfSplit,
  workViewSpace,
  workViewsOf
} from './work-views'

/** The actions on the work views (view/); undefined for the others. */
export function reduceWorkViews(state: SidebarState, action: Action, ctx: Ctx, again: Reducers): SidebarState | undefined {
  switch (action.type) {
    case 'view/save':
    case 'view/create':
    case 'view/edit':
    case 'view/open':
    case 'view/capture':
    case 'view/reset':
    case 'view/move':
    case 'view/remove':
    case 'view/restore':
      // Switched off, the views are kept but nothing is done with them: no tile, no entry, no action.
      return state.settings.workViewsEnabled ? reduceOn(state, action, ctx, again) : state
    default:
      return undefined
  }
}

type ViewAction = Extract<Action, { type: `view/${string}` }>

function reduceOn(state: SidebarState, action: ViewAction, ctx: Ctx, again: Reducers): SidebarState {
  switch (action.type) {
    case 'view/save': {
      // A view is the user's own work: past the limit nothing is pushed out, the save is refused.
      if (state.workViews.length >= WORK_VIEWS_MAX) return state
      const split = state.splits.find((each) => each.id === action.splitId)
      const space = split ? state.spaces.find((each) => each.id === split.spaceId) : undefined
      const kept = split ? workViewOfSplit(state, split) : null
      if (!split || !space || !kept) return state
      const made: WorkView = { id: ctx.newId(), name: cleanWorkViewName(action.name) || defaultWorkViewName(), emoji: spaceEmojiOr(action.emoji, WORK_VIEW_EMOJI), profileId: space.profileId, ...kept }
      const view = isRecord(action.patch) ? editedView(state, made, action.patch) : made
      if (!view) return state
      // The split view on screen is the view's from now on: its tile is lit, and a click on it shows this split view rather than opening the sites again.
      // Not when the sheet changed the sites: the split view on screen is then no longer what the view opens.
      const same = view.panes.length === kept.panes.length && view.panes.every((pane, at) => pane.url === kept.panes[at]!.url)
      return { ...state, workViews: [...state.workViews, view], splits: same ? state.splits.map((each) => (each === split ? { ...each, viewId: view.id } : each)) : state.splits }
    }
    case 'view/create': {
      if (state.workViews.length >= WORK_VIEWS_MAX || !isRecord(action.view)) return state
      const space = state.spaces.find((each) => each.id === (action.spaceId ?? state.activeSpaceId))
      if (!space) return state
      // Every site must be one a view can open: a site the sheet let through and the state refuses refuses the whole view (nothing is dropped unseen).
      const panes = Array.isArray(action.view.panes) ? action.view.panes : []
      if (panes.length < WORK_VIEW_PANES_MIN || panes.length > WORK_VIEW_PANES_MAX || !panes.every((pane) => cleanWorkViewPane(pane) !== null)) return state
      const view = cleanWorkView({ ...action.view, profileId: space.profileId }, ctx.newId())
      if (!view || (view.target?.kind === 'space' && !spaceOfProfile(state, view.target.spaceId, view.profileId))) return state
      return { ...state, workViews: [...state.workViews, view] }
    }
    case 'view/edit': {
      const view = state.workViews.find((each) => each.id === action.id)
      const edited = view && isRecord(action.patch) ? editedView(state, view, action.patch) : null
      return view && edited ? { ...state, workViews: state.workViews.map((each) => (each === view ? edited : each)) } : state
    }
    case 'view/open':
      return openView(state, action.id, action.spaceId, ctx, again)
    case 'view/capture': {
      // « Enregistrer ce qui est affiché »: the sites and the layout of the split view the view has open in the space, as they are on screen now.
      const view = state.workViews.find((each) => each.id === action.id)
      const split = view ? openWorkView(state, view.id, action.spaceId ?? state.activeSpaceId) : undefined
      const kept = split ? workViewOfSplit(state, split) : null
      if (!view || !kept) return state
      const { grid: _old, ...rest } = view
      return { ...state, workViews: state.workViews.map((each) => (each === view ? { ...rest, ...kept } : each)) }
    }
    case 'view/reset':
      return resetView(state, action.id, action.spaceId, ctx, again)
    case 'view/move': {
      const view = state.workViews.find((each) => each.id === action.id)
      // One place before or after among the views of its profile, nothing else: any other number would put a hole in the list.
      if (!view || (action.direction !== 1 && action.direction !== -1)) return state
      const mine = workViewsOf(state, view.profileId)
      const other = mine[mine.indexOf(view) + action.direction]
      if (!other) return state
      return { ...state, workViews: state.workViews.map((each) => (each === view ? other : each === other ? view : each)) }
    }
    case 'view/remove':
      // The tabs it opened stay: their split view is an ordinary one from now on (`pruneWorkViews` takes the mark off).
      return state.workViews.some((each) => each.id === action.id) ? { ...state, workViews: state.workViews.filter((each) => each.id !== action.id) } : state
    case 'view/restore': {
      // The « Annuler » of a removal: the view is read again like a file's, comes back at its place, and marks again the split views it had open.
      const view = isRecord(action.view) && typeof action.view.id === 'string' ? cleanWorkView(action.view as unknown as Record<string, unknown>, action.view.id) : null
      if (!view || state.workViews.some((each) => each.id === view.id) || state.workViews.length >= WORK_VIEWS_MAX) return state
      const at = Number.isInteger(action.index) ? Math.max(0, Math.min(action.index, state.workViews.length)) : state.workViews.length
      const marks = new Set(Array.isArray(action.splitIds) ? action.splitIds : [])
      return {
        ...state,
        workViews: [...state.workViews.slice(0, at), view, ...state.workViews.slice(at)],
        splits: state.splits.map((split) => (marks.has(split.id) && split.viewId === undefined ? { ...split, viewId: view.id } : split))
      }
    }
  }
}

/** Whether a space exists and is of a profile. */
const spaceOfProfile = (state: SidebarState, spaceId: string, profileId: string): boolean => state.spaces.some((space) => space.id === spaceId && space.profileId === profileId)

/**
 * The view as the sheet changed it, or null when the change is refused. A blank name keeps the one it has. The sites are all or nothing: one that cannot be
 * opened, fewer than two or more than four refuse the patch. A layout that does not fit the sites is shared equally, as a file's would be. A space to open in
 * must be one of the view's profile.
 */
function editedView(state: SidebarState, view: WorkView, patch: Record<string, unknown>): WorkView | null {
  const name = patch['name'] === undefined ? view.name : cleanWorkViewName(patch['name']) || view.name
  const emoji = patch['emoji'] === undefined ? view.emoji : spaceEmojiOr(patch['emoji'], view.emoji)
  const given = patch['panes']
  let read: Array<WorkViewPane | null> = view.panes
  if (given !== undefined) {
    if (!Array.isArray(given) || given.length < WORK_VIEW_PANES_MIN || given.length > WORK_VIEW_PANES_MAX) return null
    read = given.map(cleanWorkViewPane)
  }
  if (!read.every((pane): pane is WorkViewPane => pane !== null)) return null
  const panes: WorkViewPane[] = read
  const sameCount = panes.length === view.panes.length
  const layout = cleanWorkViewLayout(
    {
      orientation: patch['orientation'] ?? view.orientation,
      ratios: patch['ratios'] ?? (sameCount ? view.ratios : undefined),
      grid: patch['grid'] === null ? undefined : (patch['grid'] ?? (sameCount ? view.grid : undefined))
    },
    panes.length
  )
  let target = view.target
  if (patch['target'] === null) target = undefined
  else if (patch['target'] !== undefined) {
    target = cleanWorkViewTarget(patch['target'])
    if (!target || (target.kind === 'space' && !spaceOfProfile(state, target.spaceId, view.profileId))) return null
  }
  const { grid: _grid, target: _target, ...rest } = view
  return { ...rest, name, emoji, panes, ...layout, ...(target ? { target } : {}) }
}

/**
 * Opens a view, or shows again what it has open. The space is the one it is always opened in, else the one shown in the window that asks (`shown`);
 * a view of a space of its own makes that space the first time. When the view has a split view open in that space, the pane last on screen comes back
 * and nothing is opened twice; else its sites open as ordinary tabs of Today (a site open elsewhere gets a tab of its own here), joined in a split view
 * marked as the view's, at the layout it keeps.
 */
function openView(state: SidebarState, id: string, shown: string | undefined, ctx: Ctx, again: Reducers): SidebarState {
  const view = state.workViews.find((each) => each.id === id)
  if (!view) return state
  let base = state
  let spaceId = workViewSpace(state, view, shown ?? state.activeSpaceId)
  if (view.target?.kind === 'new-space') {
    // Made once, in the profile and the colours of a space of that profile, then remembered: the next click opens there.
    const source = state.spaces.find((space) => space.id === (shown ?? state.activeSpaceId) && space.profileId === view.profileId) ?? state.spaces.find((space) => space.profileId === view.profileId)
    const made = again.reduce(state, { type: 'space/create', name: view.name, emoji: view.emoji, hue: source ? themeHue(source.theme) : 250, profileId: view.profileId, ...(source ? { theme: source.theme } : {}) }, ctx)
    const space = made.spaces.length === state.spaces.length + 1 ? made.spaces[made.spaces.length - 1] : undefined
    if (!space) return state
    spaceId = space.id
    const target: WorkViewTarget = { kind: 'space', spaceId: space.id }
    base = { ...made, workViews: made.workViews.map((each) => (each.id === view.id ? { ...each, target } : each)) }
  }
  if (spaceId === null) return state
  const open = openWorkView(base, view.id, spaceId)
  if (open) {
    const panes = open.tabIds.flatMap((tabId) => base.tabs.filter((tab) => tab.id === tabId))
    const last = panes.reduce((best, tab) => (tab.lastActiveAt > best.lastActiveAt ? tab : best), panes[0]!)
    return select(base, last.id, ctx.now)
  }
  let next = base
  const tabIds: string[] = []
  for (const pane of view.panes) {
    const opened = again.core(next, { type: 'tab/open', url: pane.url, spaceId, background: true }, ctx)
    const made = tabOpenedSince(next, opened)
    if (!made) continue
    // The row shows the name and the icon the view keeps until the page has loaded and gives its own.
    next = replaceTab(opened, made.id, (tab) => ({ ...tab, title: pane.title, ...(pane.faviconUrl ? { faviconUrl: pane.faviconUrl } : {}) }))
    tabIds.push(made.id)
  }
  // A split view needs two panes: when the engine would not take the sites, nothing is left half done.
  if (tabIds.length < WORK_VIEW_PANES_MIN) return state
  const whole = tabIds.length === view.panes.length
  const split: SplitView = {
    id: ctx.newId(),
    spaceId,
    tabIds,
    orientation: view.orientation,
    ratios: whole ? [...view.ratios] : equalRatios(tabIds.length),
    ...(whole && view.grid ? { grid: { ...view.grid } } : {}),
    viewId: view.id
  }
  return select({ ...next, splits: [...next.splits, split] }, tabIds[0]!, ctx.now)
}

/**
 * « Revenir aux adresses enregistrées »: each pane of the split view the view has open in the space goes back to its address (the main process loads it),
 * and the layout to the one kept. A split view that lost or gained a pane is left as an ordinary one, and the view opens again whole; with none open, it
 * simply opens.
 */
function resetView(state: SidebarState, id: string, shown: string | undefined, ctx: Ctx, again: Reducers): SidebarState {
  const view = state.workViews.find((each) => each.id === id)
  const spaceId = view ? workViewSpace(state, view, shown ?? state.activeSpaceId) : null
  const split = view && spaceId !== null ? openWorkView(state, view.id, spaceId) : undefined
  if (!view || !split) return openView(state, id, shown, ctx, again)
  if (split.tabIds.length !== view.panes.length) {
    const { viewId: _gone, ...plain } = split
    return openView({ ...state, splits: state.splits.map((each) => (each === split ? plain : each)) }, id, shown, ctx, again)
  }
  let next = state
  split.tabIds.forEach((tabId, at) => {
    const pane = view.panes[at]!
    next = replaceTab(next, tabId, (tab) => (tab.url === pane.url ? tab : { ...tab, url: pane.url, title: pane.title }))
  })
  const { grid: _grid, ...line } = split
  const reset: SplitView = { ...line, orientation: view.orientation, ratios: [...view.ratios], ...(view.grid ? { grid: { ...view.grid } } : {}) }
  return select({ ...next, splits: next.splits.map((each) => (each === split ? reset : each)) }, split.tabIds[0]!, ctx.now)
}
