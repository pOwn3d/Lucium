// The reducer of the sidebar: every change of the state goes through `reduce`, which asks one family per domain (sidebar-tabs.ts, sidebar-spaces.ts,
// sidebar-library.ts, sidebar-work-views.ts, sidebar-settings.ts) and then settles what holds for the whole state (the tree, the splits, the origins, the
// favourites, the work views).

import type { SidebarState } from './model'
import { pruneFavoriteProfiles } from './favorite-scope'
import { settleTree } from './tab-tree'
import type { Ctx, Action } from './sidebar-actions'
import { pruneSplits, pruneOrigins, pruneFavoriteTabs } from './sidebar-state'
import type { Reducers } from './sidebar-helpers'
import { reduceTabs } from './sidebar-tabs'
import { reduceSpaces } from './sidebar-spaces'
import { reduceLibrary } from './sidebar-library'
import { reduceWorkViews } from './sidebar-work-views'
import { pruneWorkViews } from './work-views'
import { reduceSettings } from './sidebar-settings'

// Moved to modules of their own, still importable from here.
export { USAGE_KEY_PREFIX } from './sidebar-helpers'

// The parts of the sidebar model that live in modules of their own, still importable from here.
export type { Ctx, Action } from './sidebar-actions'
export { createInitialState, restoredState, readRestoredState, NewerStateError, parseSavedState, withoutPrivateTabs, persistableState, normalize, PROFILE_NAME_MAX, pruneOrigins, pruneFavoriteTabs } from './sidebar-state'
export { sessionSourceTabs, sidebarOrder, visibleTabOrder, stepTab, stepSpace, splitFor, splitIsFull, originOf, backClosesTab, backClosesLookup, activeTab, tabOpenedSince, pickNeighbor } from './sidebar-selectors'

/**
 * Whether two values hold the same data. Parts that are the very same object are skipped, so the cost is that of what changed, and a field that is
 * `undefined` is a field that is not there (a spread that clears `anchorUrl` leaves the key behind).
 */
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameData(item, b[i]))
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left).filter((key) => left[key] !== undefined)
  return keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length && keys.every((key) => sameData(left[key], right[key]))
}

export function reduce(state: SidebarState, action: Action, ctx: Ctx): SidebarState {
  const next = reduceCore(state, action, ctx)
  if (next === state) return state
  const settled = pruneWorkViews(pruneFavoriteTabs(pruneFavoriteProfiles(pruneSplits(pruneOrigins(settleTree(state, next))))))
  // An action that ended up changing nothing (a toggle of a folder that is gone, a name set to the one it has) is no new state: nothing is saved,
  // published to the windows or drawn for it.
  return sameData(state, settled) ? state : settled
}

function reduceCore(state: SidebarState, action: Action, ctx: Ctx): SidebarState {
  // Each domain answers the actions it knows and gives undefined for every other one: a type is the case of one domain only. An unknown type (actions
  // arrive over IPC) is a no-op, never an undefined state.
  return reduceTabs(state, action, ctx, AGAIN) ?? reduceSpaces(state, action, ctx, AGAIN) ?? reduceLibrary(state, action, ctx, AGAIN) ?? reduceWorkViews(state, action, ctx, AGAIN) ?? reduceSettings(state, action, ctx) ?? state
}

/** What a family calls back for an action made of others (see `Reducers`). */
const AGAIN: Reducers = { reduce, core: reduceCore }
