// What the shell itself draws from the state (the menu bar, the title of a window) is made from the state the interface is given, not from the real one: with
// a space locked, the tab on screen is not there for the menu either (no address to copy, nothing to share or bookmark), and the window is not titled with its page.
// Nothing here imports Electron.

import { redactForLock, type LockView } from '@shared/lock'
import type { SidebarState } from '@shared/model'

type LockFacts = Pick<LockView, 'appLocked' | 'lockedSpaces'>

/** The state of a store as the interface sees it: the same object when nothing is locked. */
export function shownState(state: SidebarState, view: LockFacts | undefined): SidebarState {
  return view ? redactForLock(state, view) : state
}

/**
 * The store with a `get` that answers the state the interface is given; everything else (dispatch, subscribe) is the store's own, bound to it. The menu is
 * built from this, so that no entry of it names a tab the lock hides.
 */
export function lockedView<T extends { get(): SidebarState }>(store: T, view: () => LockFacts | undefined): T {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'get') return () => shownState(target.get(), view())
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    }
  })
}
