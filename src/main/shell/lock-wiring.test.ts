// The lock as the window's browser applies it, run on the real methods of the class Browser (browser-actions.ts, browser-overlay.ts) with a lock
// set: an action on a locked space, an action of the interface that names what a lock hides, a panel asked for over the lock screen by the main
// process itself (the menu, a shortcut, the Dock's New Window). The rules alone are in shared/lock.test.ts; these lines are their use, which only
// an engine check held before.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import type { LockView } from '@shared/lock'
import { fakeBrowser, methodsOf, overlayHost, showedPanel } from './browser-fake.test-support'

vi.mock('electron', async () => (await import('./ipc-fake.test-support')).fakeElectron())
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))

const { Browser } = await import('./browser')
const { setLockService } = await import('../lock-service')
const shell = methodsOf(Browser.prototype)

/** Two spaces with a tab each; `work` is the space on screen. */
function sample(): SidebarState {
  const base = createInitialState({ now: 1, newId: () => 'home' })
  const home = base.spaces[0]!
  const tab = (id: string, spaceId: string) => ({ id, spaceId, url: `https://${id}.example/`, title: id, pinned: false, createdAt: 1, lastActiveAt: 1 })
  return { ...base, spaces: [{ ...home, id: 'home', name: 'Perso' }, { ...home, id: 'work', name: 'Travail' }], activeSpaceId: 'work', tabs: [tab('h1', 'home'), tab('w1', 'work')], activeTabBySpace: { home: 'h1', work: 'w1' } }
}

/** A lock that is on, with these spaces locked (or the whole application). */
function lockWith(lock: { appLocked?: boolean; lockedSpaces?: string[] }): void {
  const lockedSpaces = lock.lockedSpaces ?? []
  const view: LockView = { active: true, appLocked: lock.appLocked === true, lockedSpaces, guardedSpaces: lockedSpaces, touchId: false, retryInMs: 0 }
  setLockService({ isAppLocked: () => view.appLocked, lockedSpaces: () => lockedSpaces, view: () => view } as never)
}

/** A window over this state: the real `dispatch` and `dispatchFromInterface`, and a store that keeps what reaches it. */
function windowOver(state: SidebarState) {
  const reached: unknown[] = []
  const store = { get: () => state, root: () => store, dispatch: (action: unknown) => void reached.push(action) }
  const fake = fakeBrowser({
    store,
    group: new Set(),
    isPrivate: () => false,
    dispatch: shell['dispatch'],
    namesLockedTarget: shell['namesLockedTarget'],
    tabsShownInGroup: () => [],
    closedHistoryCtx: () => undefined,
    reopenedWithHistory: () => null,
    reopened: { begin: () => null, end: () => {} },
    sidebarTrace: { during: (_cause: unknown, run: () => void) => run() },
    pages: new Map(),
    // The interface's action goes on to `dispatch`, as the watch of the empty tabs lets it.
    blankTabs: { applyFromInterface: (_action: unknown, apply: () => void) => apply() }
  })
  return { fake, reached }
}

afterEach(() => {
  setLockService(null)
  vi.restoreAllMocks()
})

describe('an action on a locked space', () => {
  it('is refused by the window, whoever sent it: deleting the space, or copying its tabs into something that shows', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    lockWith({ lockedSpaces: ['work'] })
    const { fake, reached } = windowOver(sample())
    for (const action of [{ type: 'space/delete', id: 'work' }, { type: 'space/aside', id: 'work' }, { type: 'session/save' }, { type: 'readlater/add' }]) shell['dispatch']!.call(fake.self, action)
    expect(reached).toEqual([])
    expect(console.warn).toHaveBeenCalledTimes(4)
  })

  it('leaves the same actions alone on a space that is not locked, and once the lock is off', () => {
    lockWith({ lockedSpaces: ['work'] })
    const locked = windowOver(sample())
    shell['dispatch']!.call(locked.fake.self, { type: 'space/delete', id: 'home' })
    expect(locked.reached).toEqual([{ type: 'space/delete', id: 'home' }])

    setLockService(null)
    const open = windowOver(sample())
    shell['dispatch']!.call(open.fake.self, { type: 'space/delete', id: 'work' })
    expect(open.reached).toEqual([{ type: 'space/delete', id: 'work' }])
  })
})

describe('an action of the interface that names what a lock hides', () => {
  it('is refused: the interface never saw the tab, so the request is not an honest one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    lockWith({ lockedSpaces: ['home'] })
    const { fake, reached } = windowOver(sample())
    for (const action of [{ type: 'tab/close', id: 'h1' }, { type: 'tab/move-to-space', id: 'h1', spaceId: 'work' }, { type: 'tabs/archive-many', ids: ['w1', 'h1'] }]) shell['dispatchFromInterface']!.call(fake.self, action)
    expect(reached).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('it names a tab or a folder a lock hides'))
  })

  it('goes through for a tab the interface shows, and for every tab once nothing is locked', () => {
    lockWith({ lockedSpaces: ['home'] })
    const locked = windowOver(sample())
    shell['dispatchFromInterface']!.call(locked.fake.self, { type: 'tab/select', id: 'w1' })
    expect(locked.reached).toEqual([{ type: 'tab/select', id: 'w1' }])

    setLockService(null)
    const open = windowOver(sample())
    shell['dispatchFromInterface']!.call(open.fake.self, { type: 'tab/select', id: 'h1' })
    expect(open.reached).toEqual([{ type: 'tab/select', id: 'h1' }])
  })

  it('tells the handlers of the menus whether a request names a hidden tab (`namesLockedTarget`)', () => {
    const { fake } = windowOver(sample())
    expect(shell['namesLockedTarget']!.call(fake.self, { id: 'h1' })).toBe(false)
    lockWith({ lockedSpaces: ['home'] })
    expect(shell['namesLockedTarget']!.call(fake.self, { id: 'h1' })).toBe(true)
    expect(shell['namesLockedTarget']!.call(fake.self, { ids: ['w1', 'h1'] })).toBe(true)
    expect(shell['namesLockedTarget']!.call(fake.self, { id: 'w1' })).toBe(false)
    lockWith({ appLocked: true })
    expect(shell['namesLockedTarget']!.call(fake.self, { id: 'w1' })).toBe(true)
  })
})

describe('a panel asked for by the main process while the application is locked', () => {
  it('does not open over the lock screen: the command bar, the history, the archive, the settings of a space', () => {
    lockWith({ appLocked: true })
    for (const request of [{ panel: 'commandbar', mode: 'new', initial: '' }, { panel: 'history' }, { panel: 'archive' }, { panel: 'bookmarks' }, { panel: 'downloads' }]) {
      const fake = overlayHost({ bookmarkManager: true })
      shell['openOverlay']!.call(fake.self, request)
      expect(showedPanel(fake, request.panel), request.panel).toBe(false)
      expect(fake.self['overlayRequest'], request.panel).toBeNull()
    }
  })

  it('opens as before once the application is unlocked, and while only a space is locked', () => {
    for (const lock of [{ appLocked: false }, { lockedSpaces: ['home'] }]) {
      lockWith(lock)
      const fake = overlayHost()
      shell['openOverlay']!.call(fake.self, { panel: 'commandbar', mode: 'new', initial: '' })
      expect(showedPanel(fake, 'commandbar')).toBe(true)
    }
  })

  it('still shows the panel of ⌃Tab, made from the state the interface is given (a skeleton while locked)', () => {
    lockWith({ appLocked: true })
    const fake = overlayHost()
    shell['openOverlay']!.call(fake.self, { panel: 'tabcycle', tabs: [], index: 0 })
    expect(showedPanel(fake, 'tabcycle')).toBe(true)
  })
})
