// Moves tabs dragged from one window onto the sidebar of another one (the decisions are shared/tab-transfer.ts; this does them, in order).
//
// A tab never exists in two windows and never disappears on the way: the state changes first (a tab always has a space, so it is always in some
// sidebar), the page follows, and whatever fails after that leaves the tab where the last step put it, with a notice. A live page that stays in its
// session goes to the window the tab lands in as it is (a call, a video, a form go on: see `Browser.adoptPage`); a page cannot leave the session it
// was made in, so the page of a tab that changes profile is let go and made again there (the user is asked first when it is in a call or playing).

import type { DropTarget } from '@shared/dnd'
import type { PageEvents } from '../engine/types'
import type { SidebarState } from '@shared/model'
import type { Action } from '@shared/sidebar'
import { activeTab, pickNeighbor } from '@shared/sidebar'
import { decideTransfer, type TransferDecision } from '@shared/tab-transfer'
import { giveTabs } from '@shared/window-tabs'
import { t, tp } from '@shared/i18n'

/**
 * The pages a tab went through and the one it is on (`Page.navigationEntries`). Handed to the page made in the window the tab lands in, so that Back
 * and Forward still work there. Only when the profile stays the same: with another profile the page starts again from the address.
 */
export interface PageHistory {
  entries: Array<{ title: string; url: string }>
  index: number
}

/** One window of a move, as the move needs it (the browser of the window implements it). */
export interface TransferSide {
  /** The key the window manager gives the window (`main`, `window-2`…). */
  readonly key: string
  /** A private or guest window. */
  readonly isPrivate: boolean
  /** This window's view of the shared state. */
  state(): SidebarState
  /** An action through the window's browser: its own rules (private window, lock) and what it does to its pages apply. */
  dispatch(action: Action): void
  /** A notice in this window. */
  toast(message: string): void
  /** The pages the live page of a tab went through, wherever in the group it lives; undefined when it has none (asleep). Does not touch the page. */
  history(id: string): PageHistory | undefined
  /** Lets the live page of a tab go, wherever in the group it lives. */
  release(id: string): void
  /** Brings the live page of a tab here, as it is, from the window of the group that holds it. False when there is none or it cannot come. */
  adopt(id: string): boolean
  /** The pages of these tabs are about to be made again in another profile: true goes on (none is in a call or playing, or the user said so). */
  confirmReload(ids: readonly string[]): boolean
  /** The page made for this tab in this window starts from these pages. */
  carry(id: string, history: PageHistory): void
}

export interface TransferShared {
  get(): SidebarState
  replace(next: SidebarState): void
}

/** What the lock hides: nothing is moved out of or into a space it covers. */
export interface TransferLock {
  appLocked(): boolean
  spaceLocked(spaceId: string): boolean
}

/** `moved`: at least one tab landed. `refused`: nothing changed (the drop meant nothing, or the lock forbids it). `failed`: something threw; the tabs are where the last step left them. */
export type TransferResult = 'moved' | 'refused' | 'failed'

export function runTransfer(shared: TransferShared, lock: TransferLock, from: TransferSide, to: TransferSide, ids: readonly string[], target: DropTarget): TransferResult {
  const decision: TransferDecision = decideTransfer({ shared: shared.get(), view: to.state(), from: { key: from.key, private: from.isPrivate }, to: { key: to.key, private: to.isPrivate }, ids, target })
  if (!decision.ok) return 'refused'

  const before = shared.get()
  const spaceOf = (id: string) => before.tabs.find((tab) => tab.id === id)?.spaceId
  if (lock.appLocked() || lock.spaceLocked(decision.spaceId) || decision.ids.some((id) => lock.spaceLocked(spaceOf(id) ?? ''))) {
    to.toast(t('tabtransfer.espace-verrouille'))
    return 'refused'
  }
  // A call or a video in a page that will be made again in another profile would be cut: the user says first (nothing has changed yet).
  if (decision.newSession.length > 0 && !to.confirmReload(decision.newSession)) return 'refused'

  try {
    // What a page went through is read before anything lets it go: `tab/move-to-space` drops the page of the window it is dispatched in.
    const history = new Map<string, PageHistory>()
    for (const id of decision.keepHistory) {
      try {
        const pages = from.history(id)
        if (pages) history.set(id, pages)
      } catch (error) {
        // A page that cannot tell (it crashed, it is going away) starts again from the address of its tab.
        console.warn(`[tabs] cannot read the pages tab ${id} went through; it starts from its address:`, error)
      }
    }

    // A tab on screen in the window it leaves, with no change of space (both windows show the same one): that window shows the tab next to it instead.
    const shown = activeTab(from.state())
    if (shown && decision.ids.includes(shown.id) && !decision.respace.includes(shown.id)) {
      // Counted among the tabs that stay, so that it is never one of those leaving with it.
      const next = pickNeighbor({ ...from.state(), tabs: from.state().tabs.filter((tab) => tab.id === shown.id || !decision.ids.includes(tab.id)) }, shown)
      if (next !== null) from.dispatch({ type: 'tab/select', id: next })
    }
    // The tabs leave in the window they come from, so that it picks another tab if one of them was on screen there.
    for (const id of decision.respace) from.dispatch({ type: 'tab/move-to-space', id, spaceId: decision.spaceId })
    const landed = decision.ids.filter((id) => shared.get().tabs.some((tab) => tab.id === id && tab.spaceId === decision.spaceId))
    if (landed.length === 0) return 'refused'

    // A live page that keeps its session comes as it is, from wherever it was (the window they came from, or a third one that showed them). The
    // others go, and the page made again starts from the same pages when the session stays.
    for (const id of landed) {
      if (!decision.newSession.includes(id) && to.adopt(id)) continue
      from.release(id)
      const pages = history.get(id)
      if (pages) to.carry(id, pages)
    }
    // Windows with tabs of their own: the window that lists a tab is the one that owns it, so ownership goes first for the target window to see them.
    if (decision.ownerKey !== null) shared.replace(giveTabs(shared.get(), landed, decision.ownerKey))

    const { placement } = decision
    to.dispatch({ type: 'tabs/move', ids: landed, toIndex: placement.toIndex, pinned: placement.pinned, folderId: placement.folderId, ...(placement.parentId !== undefined ? { parentId: placement.parentId } : {}) })
    // A folded branch the tab was dropped inside of opens by itself: the tab shown is never hidden in a folded branch (see `settleTree`).
    to.dispatch({ type: 'tab/select', id: landed.includes(decision.select) ? decision.select : landed[0]! })

    const reloaded = landed.filter((id) => decision.newSession.includes(id)).length
    if (reloaded > 0) to.toast(tp('tabtransfer.count-onglets-autre-profil', reloaded, { space: to.state().spaces.find((space) => space.id === decision.spaceId)?.name ?? '' }))
    return 'moved'
  } catch (error) {
    console.error('[tabs] cannot move the tabs to another window:', error)
    to.toast(t('tabtransfer.deplacement-echoue'))
    return 'failed'
  }
}

/**
 * The events a page is made with, handed to another window later: every call goes to the events given last (those of the browser of the window
 * the page is in now). A member the new events lack does nothing.
 */
export function relayEvents(events: PageEvents): { events: PageEvents; retarget(next: PageEvents): void } {
  let target: PageEvents = events
  const relay = Object.fromEntries(
    Object.keys(events).map((key) => [key, (...args: unknown[]) => (target[key as keyof PageEvents] as ((...args: unknown[]) => unknown) | undefined)?.(...args)])
  )
  return { events: relay as unknown as PageEvents, retarget: (next) => void (target = next) }
}
