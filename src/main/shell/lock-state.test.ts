import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { activeTab } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { lockedView, shownState } from './lock-state'

// The window manager and the shell reach Electron only when a method runs: the clipboard records what it is given, the other names only need to exist.
const writeText = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('electron', () => new Proxy({ clipboard: { writeText } } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) }))
const { setLockService } = await import('../lock-service')
const { WindowManager } = await import('./windows')
const { Browser } = await import('./browser')
type Method = (this: unknown, ...args: unknown[]) => unknown
const windowMethods = WindowManager.prototype as unknown as Record<string, Method>
const shellMethods = Browser.prototype as unknown as Record<string, Method>

/** Two spaces, a tab on screen in each (the work space is the one on screen). */
function sample(): SidebarState {
  const base = createInitialState({ now: 1, newId: () => 'home' })
  const home = base.spaces[0]!
  const tab = (id: string, spaceId: string) => ({ id, spaceId, url: `https://${id}.example/secret`, title: `Titre ${id}`, pinned: false, createdAt: 1, lastActiveAt: 1 })
  return {
    ...base,
    spaces: [{ ...home, id: 'home', name: 'Perso' }, { ...home, id: 'work', name: 'Travail' }],
    activeSpaceId: 'work',
    tabs: [tab('h1', 'home'), tab('w1', 'work')],
    activeTabBySpace: { home: 'h1', work: 'w1' }
  }
}

class FakeStore {
  dispatched: unknown[] = []
  constructor(private readonly state: SidebarState) {}
  get(): SidebarState {
    return this.state
  }
  dispatch(action: unknown): void {
    this.dispatched.push(action)
  }
  readonly note = 'kept'
}

describe('shownState', () => {
  it('is the state itself when nothing is locked (no copy, no cost)', () => {
    const state = sample()
    expect(shownState(state, undefined)).toBe(state)
    expect(shownState(state, { appLocked: false, lockedSpaces: [] })).toBe(state)
  })

  it('has no tab on screen when the space on screen is locked', () => {
    const shown = shownState(sample(), { appLocked: false, lockedSpaces: ['work'] })
    expect(activeTab(shown)).toBeUndefined()
    expect(shown.tabs.map((tab) => tab.id)).toEqual(['h1'])
  })

  it('has no tab at all when the application is locked', () => {
    const shown = shownState(sample(), { appLocked: true, lockedSpaces: [] })
    expect(shown.tabs).toEqual([])
    expect(activeTab(shown)).toBeUndefined()
  })
})

describe('lockedView', () => {
  it('answers the state the interface is given: the tab of a locked space is not in the menu’s reach', () => {
    const store = new FakeStore(sample())
    const view = lockedView(store, () => ({ appLocked: false, lockedSpaces: ['work'] }))
    expect(activeTab(view.get())).toBeUndefined()
    // The real state is untouched.
    expect(activeTab(store.get())?.id).toBe('w1')
  })

  it('follows the lock as it changes (a space unlocked shows its tab again), and reads the lock at each `get`', () => {
    const store = new FakeStore(sample())
    const lockedSpaces = vi.fn(() => ['work'])
    const view = lockedView(store, () => ({ appLocked: false, lockedSpaces: lockedSpaces() }))
    expect(activeTab(view.get())).toBeUndefined()
    lockedSpaces.mockReturnValue([])
    expect(activeTab(view.get())?.id).toBe('w1')
  })

  it('leaves the store’s other members to the store itself (an action dispatched through the view reaches the real one)', () => {
    const store = new FakeStore(sample())
    const view = lockedView(store, () => ({ appLocked: true, lockedSpaces: [] }))
    view.dispatch({ type: 'x' })
    expect(store.dispatched).toEqual([{ type: 'x' }])
    expect(view.note).toBe('kept')
  })
})

/** A lock in place: the whole application, or some spaces. */
function lock(appLocked: boolean, lockedSpaces: string[]): void {
  const service = {
    isActive: () => true,
    isAppLocked: () => appLocked,
    isSpaceLocked: (id: string) => lockedSpaces.includes(id),
    view: () => ({ active: true, appLocked, lockedSpaces, guardedSpaces: lockedSpaces, touchId: false, retryInMs: 0 })
  }
  setLockService(service as never)
}

describe('how the shell uses the shown state', () => {
  afterEach(() => setLockService(null))

  it('titles a window from the shown state: a locked tab’s title is not in the system’s list of windows', () => {
    const title = (): string => {
      const win = { title: 'Lucium', isDestroyed: () => false, getTitle: () => win.title, setTitle: (next: string) => void (win.title = next) }
      const record = { win, kind: 'normal', store: { get: sample } }
      windowMethods['followPage']!.call({ namesEnabled: () => false }, record)
      return win.title
    }
    expect(title()).toContain('Titre w1')
    lock(false, ['work'])
    expect(title()).not.toContain('Titre w1')
    lock(false, ['home'])
    expect(title()).toContain('Titre w1')
  })

  it('gives the system no title for a private tab: Mission Control and the menu of the Dock show the usual one', () => {
    const titleOf = (state: SidebarState): string => {
      const win = { title: 'Lucium', isDestroyed: () => false, getTitle: () => win.title, setTitle: (next: string) => void (win.title = next) }
      windowMethods['followPage']!.call({ namesEnabled: () => false }, { win, kind: 'normal', store: { get: () => state } })
      return win.title
    }
    const state = sample()
    expect(titleOf(state)).toContain('Titre w1')
    const hidden = { ...state, tabs: state.tabs.map((tab) => (tab.id === 'w1' ? { ...tab, private: true } : tab)) }
    expect(titleOf(hidden)).not.toContain('Titre w1')
  })

  it('opens no panel over the lock screen', () => {
    const opened = vi.fn()
    const shell = { tooltipWindow: { hide: () => undefined }, littleBarOpener: null, zapping: false, isPrivate: () => false, overlayRequest: null, store: { get: sample }, settingsOpener: opened }
    lock(true, [])
    shellMethods['openOverlay']!.call(shell, { panel: 'settings', pane: 'general' })
    expect(opened).not.toHaveBeenCalled()
    setLockService(null)
    shellMethods['openOverlay']!.call(shell, { panel: 'settings', pane: 'general' })
    expect(opened).toHaveBeenCalledWith('general', undefined)
  })

  it('copies no address of a tab the lock hides', async () => {
    writeText.mockClear()
    const shell = { store: { get: sample }, isTabLocked: shellMethods['isTabLocked'], activePage: () => undefined, followPaneFocus: () => undefined, copyable: (url: string) => url, showToast: () => undefined }
    lock(false, ['work'])
    await shellMethods['copyUrl']!.call(shell, 'plain')
    lock(true, [])
    await shellMethods['copyUrl']!.call(shell, 'markdown')
    expect(writeText).not.toHaveBeenCalled()
    lock(false, ['home'])
    await shellMethods['copyUrl']!.call(shell, 'plain')
    expect(writeText).toHaveBeenCalledWith('https://w1.example/secret')
  })
})

// How the menu bar uses the shown state, and that the Dock offers no window and a second launch opens none while the application is locked: app-menu-lock.test.ts and
// single-instance.test.ts (run, not read).
