// Moving tabs from one window to another by dragging them onto its sidebar (the tab lands in the space the other window shows, so in that
// space's profile). Pure decisions only: the main process does the moving (shell/tab-transfer.ts) and tells the interface what is being dragged.
//
// What a move is, step by step: the tabs change space in the window they leave (that window picks another tab if one of them was on screen), their
// live pages go to the window they land in as they are when the session stays the same (a call, a video, a form go on), and are made again there
// otherwise (a page belongs to the session it was made in), they take their place in the sidebar of the target window, and the first of them is shown.

import { isListedTab, type SidebarState, type TabItem, type TabRuntime } from './model'
import { containerOfTab } from './containers'
import { profileOfSpace } from './profiles'
import { placeFromWindow, type DropTarget, type Placement, type WindowTab } from './dnd'
import { MAIN_WINDOW_KEY, onlyTabsOf, windowsAreIndependent } from './window-tabs'

/** A window taking part in a move. */
export interface TransferWindow {
  /** The key the window manager gives it (`main`, `window-2`…). */
  key: string
  /** A private or guest window: its tabs live in a state, a session and an engine scope of its own, which never mix with the other windows'. */
  private: boolean
}

export interface TransferRequest {
  /** The state every normal window shares: all the tabs and spaces. */
  shared: SidebarState
  /** What the window the tabs land in sees of it: the places in its sidebar are counted there. Its current space is where the tabs go. */
  view: SidebarState
  from: TransferWindow
  to: TransferWindow
  /** The dragged tabs, in the order of the sidebar they come from. */
  ids: readonly string[]
  /** Where in the sidebar of the target window they were dropped. */
  target: DropTarget
}

/** Why nothing is moved: the drop is refused and every tab stays where it was. */
export type TransferRefusal = 'private-window' | 'same-window' | 'no-tabs' | 'no-place'

export interface TransferOrder {
  ok: true
  /** The tabs that move (those that exist and have a row), in the order they came in. */
  ids: string[]
  /** The space the target window shows: where they land. */
  spaceId: string
  /** The ones that are in another space now (the others are already in the one the target window shows and only change window). */
  respace: string[]
  /** The ones whose page is made again in the session of another profile: their cookies and logins stay behind, and the user is told. */
  newSession: string[]
  /** The ones whose session stays the same: their live page follows the tab as it is, or, when it cannot, their Back / Forward list does. */
  keepHistory: string[]
  /** Windows with tabs of their own: the key of the window the tabs belong to from now on; null when every window lists the same tabs. */
  ownerKey: string | null
  /** The place they take in the sidebar of the target window. */
  placement: Placement
  /** The tab the target window shows once the move is done. */
  select: string
}

export type TransferDecision = TransferOrder | { ok: false; reason: TransferRefusal }

/** Whether the page of a tab is made in its space's profile: a private tab has its throw-away session and a tab of a container its own, whichever space they sit in. */
const usesProfileSession = (state: SidebarState, tab: TabItem): boolean => tab.private !== true && containerOfTab(state.settings, tab) === undefined

/** Whether a tab that goes to `spaceId` needs a page made in another session (its space's profile changes): its live page cannot follow it there. */
export const changesSession = (state: SidebarState, tab: TabItem, spaceId: string): boolean =>
  usesProfileSession(state, tab) && profileOfSpace(state, tab.spaceId) !== profileOfSpace(state, spaceId)

/** A page that would lose something under way if it were made again: it plays sound (a call, a video) or a media element of it plays. */
export const tabIsLive = (runtime: TabRuntime | undefined): boolean => runtime?.audible === true || runtime?.playing === true

export function decideTransfer(request: TransferRequest): TransferDecision {
  const { shared, view, from, to, target } = request
  // A private window (and a guest one) is its own world: nothing leaves it for a normal window, nothing comes in from one.
  if (from.private || to.private) return { ok: false, reason: 'private-window' }
  if (from.key === to.key) return { ok: false, reason: 'same-window' }

  const spaceId = view.activeSpaceId
  const wanted = new Set(request.ids)
  const tabs = shared.tabs.filter((t) => wanted.has(t.id) && isListedTab(t))
  // In the order the sidebar had them, as the caller gave them.
  const ordered = request.ids.flatMap((id) => tabs.find((t) => t.id === id) ?? [])
  const unique = ordered.filter((tab, i) => ordered.findIndex((t) => t.id === tab.id) === i)
  if (unique.length === 0) return { ok: false, reason: 'no-tabs' }

  const moving: WindowTab[] = unique.map((t) => ({ id: t.id, ...(t.private === true ? { private: true as const } : {}) }))
  const placement = placeFromWindow(view, moving, spaceId, target)
  if (!placement) return { ok: false, reason: 'no-place' }

  const respace = unique.filter((t) => t.spaceId !== spaceId)
  const newSession = respace.filter((t) => changesSession(shared, t, spaceId)).map((t) => t.id)
  const stays = new Set(newSession)
  return {
    ok: true,
    ids: unique.map((t) => t.id),
    spaceId,
    respace: respace.map((t) => t.id),
    newSession,
    keepHistory: unique.filter((t) => !stays.has(t.id)).map((t) => t.id),
    ownerKey: windowsAreIndependent(shared) ? to.key : null,
    placement,
    select: unique[0]!.id
  }
}

/**
 * Whether the window the tabs left closes once a move is done. Only after a move that landed: a refused or failed one changes nothing, and a window is
 * never closed on a tab that may not have arrived. With the setting off every window lists the same tabs, so none is ever left empty.
 * With windows that have tabs of their own, the window must list no tab at all (the pinned ones are everybody's, so a window that still shows one stays);
 * the main window is never closed this way, it is the one the application lives in (macOS puts it away, elsewhere
 * closing it quits), and it stays open, empty.
 */
export function leavesWindowEmpty(result: 'moved' | 'refused' | 'failed', shared: SidebarState, fromKey: string): boolean {
  if (result !== 'moved' || fromKey === MAIN_WINDOW_KEY) return false
  // With the setting off every window lists the same tabs (no tab carries a window key): none of them is ever left empty by a move.
  if (!windowsAreIndependent(shared)) return false
  return !onlyTabsOf(shared, fromKey).tabs.some(isListedTab)
}
