import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DropTarget } from '@shared/dnd'
import { activeTab, createInitialState, sidebarOrder, type Action } from '@shared/sidebar'
import { changesSession } from '@shared/tab-transfer'
import { t, tp } from '@shared/i18n'
import { blankSelection, selectionOf, visibleTabIds } from '@shared/window-selection'
import { StateStore, WindowView, liveCtx } from '../store'
import type { PageEvents } from '../engine/types'
import { relayEvents, runTransfer, type PageHistory, type TransferLock, type TransferSide } from './tab-transfer'

afterEach(() => vi.restoreAllMocks())

const NO_LOCK: TransferLock = { appLocked: () => false, spaceLocked: () => false }
const today: DropTarget = { kind: 'today' }

/**
 * Three normal windows over one state. "main" shows Communication (profile `default`) with a selected, "win" shows Work (profile Travail) with w2
 * selected, and "third" shows Communication too with c selected. Famille is a third space on the profile of Communication.
 * Communication: a, b, c. Work: w1, w2. Famille: f1. Pages are simulated: `pages` holds what each live page went through.
 */
function world(options: { independent?: boolean; shownByWin?: 'work' | 'comm' } = {}) {
  const base = new StateStore(createInitialState(liveCtx()), null)
  const comm = base.get().activeSpaceId
  base.dispatch({ type: 'space/create', name: 'Work', emoji: '💼', hue: 200, profileName: 'Travail' })
  const work = base.get().spaces.find((s) => s.name === 'Work')!.id
  base.dispatch({ type: 'space/create', name: 'Famille', emoji: '🏠', hue: 20, profileId: 'default' })
  const family = base.get().spaces.find((s) => s.name === 'Famille')!.id
  for (const [name, spaceId] of [['a', comm], ['b', comm], ['c', comm], ['w1', work], ['w2', work], ['f1', family]] as const) base.dispatch({ type: 'tab/open', url: `https://${name}.fr/`, spaceId, background: true })
  const id = (n: string) => base.get().tabs.find((tab) => tab.url === `https://${n}.fr/`)!.id
  if (options.independent) base.dispatch({ type: 'settings/update', patch: { independentWindows: true } })
  const shared = base
  const siblings = new Set<WindowView>()
  const main = new WindowView(shared, blankSelection(shared.get(), comm), siblings, true)
  const win = new WindowView(shared, blankSelection(shared.get(), options.shownByWin === 'comm' ? comm : work), siblings, false, 'window-1')
  const third = new WindowView(shared, blankSelection(shared.get(), comm), siblings, false, 'window-2')
  // Independent windows: the tabs belong to the window that opened them.
  if (options.independent) {
    shared.replace({ ...shared.get(), tabs: shared.get().tabs.map((tab) => (tab.spaceId === work ? { ...tab, windowKey: 'window-1' } : tab)) })
  }
  main.dispatch({ type: 'tab/select', id: id('a') })
  win.dispatch({ type: 'tab/select', id: id(options.shownByWin === 'comm' ? 'c' : 'w2') })
  third.dispatch({ type: 'tab/select', id: id(options.independent ? 'f1' : 'c') })

  const pages = new Map<string, PageHistory>()
  const released: string[] = []
  const carried = new Map<string, PageHistory>()
  const toasts: string[] = []
  const side = (view: WindowView, key: string, over: Partial<TransferSide> = {}): TransferSide => ({
    key,
    isPrivate: false,
    state: () => view.get(),
    // The browser of a window drops the page of a tab that changes profile (it is bound to the session it was made in).
    dispatch: (action: Action) => {
      const tab = view.get().tabs.find((t) => t.id === (action as { id?: string }).id)
      if (action.type === 'tab/move-to-space' && tab && changesSession(view.get(), tab, action.spaceId)) pages.delete(action.id)
      view.dispatch(action)
    },
    toast: (message) => void toasts.push(message),
    history: (tabId) => pages.get(tabId),
    release: (tabId) => {
      released.push(tabId)
      pages.delete(tabId)
    },
    carry: (tabId, history) => void carried.set(tabId, history),
    // A browser that cannot carry a page from another window, and a user who lets pages reload: what the window did before live pages could move.
    adopt: () => false,
    confirmReload: () => true,
    ...over
  })
  const live = (...names: string[]) => names.forEach((n) => pages.set(id(n), { entries: [{ title: n, url: `https://${n}.fr/` }, { title: `${n}2`, url: `https://${n}.fr/2` }], index: 1 }))
  return { shared, main, win, third, comm, work, family, id, pages, released, carried, toasts, side, live, mainSide: side(main, 'main'), winSide: side(win, 'window-1') }
}

const names = (w: ReturnType<typeof world>, spaceId: string, state = w.shared.get()) => sidebarOrder(state, spaceId).map((tab) => tab.url.split('/')[2]!.replace('.fr', ''))

describe('a tab dropped on another window', () => {
  it('goes to the space that window shows, takes its place in Today, and is shown there', () => {
    const w = world()
    w.live('a')
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('a')], today)).toBe('moved')
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('a'))).toMatchObject({ spaceId: w.work, pinned: false })
    expect(names(w, w.work)).toEqual(['w1', 'w2', 'a'])
    expect(activeTab(w.win.get())?.id).toBe(w.id('a'))
  })

  it('is on screen in one window only, and the window it left shows the next tab', () => {
    const w = world()
    w.live('a')
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('a')], today)
    expect(visibleTabIds(w.win.get())).toEqual([w.id('a')])
    expect(visibleTabIds(w.main.get())).toEqual([w.id('b')])
    expect(visibleTabIds(w.third.get())).toEqual([w.id('c')])
    expect(w.released).toEqual([w.id('a')])
    expect(w.pages.has(w.id('a'))).toBe(false)
  })

  it('takes the place under the drop: before a row, on a pinned row, in a folder', () => {
    const w = world()
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('a')], { kind: 'tab', id: w.id('w2'), edge: 'before' })
    expect(names(w, w.work)).toEqual(['w1', 'a', 'w2'])
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('c')], { kind: 'tab', id: w.id('w1'), edge: 'before' })
    expect(names(w, w.work)).toEqual(['c', 'w1', 'a', 'w2'])
    w.win.dispatch({ type: 'tab/pin', id: w.id('w1') })
    w.win.dispatch({ type: 'folder/create', name: 'Dossier', spaceId: w.work })
    const folder = w.shared.get().folders.find((f) => f.name === 'Dossier')!.id
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('b')], { kind: 'folder', id: folder })).toBe('moved')
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('b'))).toMatchObject({ spaceId: w.work, pinned: true, folderId: folder })
  })

  it('unpins a pinned tab that goes to Today, and pins a Today tab dropped on a pinned row', () => {
    const w = world()
    w.main.dispatch({ type: 'tab/pin', id: w.id('c') })
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('c')], today)
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('c'))).toMatchObject({ spaceId: w.work, pinned: false })
    w.win.dispatch({ type: 'tab/pin', id: w.id('w1') })
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('b')], { kind: 'tab', id: w.id('w1'), edge: 'after' })
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('b'))).toMatchObject({ spaceId: w.work, pinned: true })
  })

  it('takes a whole selection as a block in the order it was given, and shows the first', () => {
    const w = world()
    w.live('a', 'c')
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('c'), w.id('a')], { kind: 'tab', id: w.id('w2'), edge: 'before' })
    expect(names(w, w.work)).toEqual(['w1', 'c', 'a', 'w2'])
    expect(activeTab(w.win.get())?.id).toBe(w.id('c'))
    expect(w.released.sort()).toEqual([w.id('a'), w.id('c')].sort())
    // a was on screen in the window it left: that window shows what is left.
    expect(activeTab(w.main.get())?.id).toBe(w.id('b'))
  })

  it('leaves the window it came from open and empty when it was the last tab there', () => {
    const w = world()
    w.shared.dispatch({ type: 'tab/close', id: w.id('b') })
    w.shared.dispatch({ type: 'tab/close', id: w.id('c') })
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('a')], today)
    expect(names(w, w.comm)).toEqual([])
    expect(activeTab(w.main.get())).toBeUndefined()
    expect(activeTab(w.win.get())?.id).toBe(w.id('a'))
  })

  it('takes the tab from a third window that showed it: that window shows nothing of it, and its page is let go', () => {
    const w = world()
    w.live('c')
    // c is on screen in the third window, though the list of the main window shows it too.
    expect(activeTab(w.third.get())?.id).toBe(w.id('c'))
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('c')], today)
    expect(activeTab(w.third.get())).toBeUndefined()
    expect(w.released).toEqual([w.id('c')])
    expect(w.win.get().tabs.find((tab) => tab.id === w.id('c'))?.spaceId).toBe(w.work)
    expect(activeTab(w.win.get())?.id).toBe(w.id('c'))
  })
})

describe('the profile of the space the tab lands in', () => {
  it('tells the user when the tab reloads in another profile, and brings no history with it', () => {
    const w = world()
    w.live('a', 'c')
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('a')], today)
    expect(w.toasts).toEqual([tp('tabtransfer.count-onglets-autre-profil', 1, { space: 'Work' })])
    expect(w.carried.size).toBe(0)
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('b'), w.id('c')], today)
    expect(w.toasts[1]).toBe(tp('tabtransfer.count-onglets-autre-profil', 2, { space: 'Work' }))
    expect(w.toasts[1]).not.toBe(w.toasts[0])
  })

  it('keeps the Back and Forward pages of a tab that stays in the same profile, without a notice', () => {
    const w = world()
    w.live('a')
    const familyWindow = new WindowView(w.shared, blankSelection(w.shared.get(), w.family), new Set(), false, 'window-3')
    // The window it leaves cannot carry the page here (`adopt` refuses): the tab loads again from the pages it went through.
    const out = runTransfer(w.shared, NO_LOCK, w.mainSide, w.side(familyWindow, 'window-3'), [w.id('a')], today)
    expect(out).toBe('moved')
    expect(w.carried.get(w.id('a'))).toEqual({ entries: [{ title: 'a', url: 'https://a.fr/' }, { title: 'a2', url: 'https://a.fr/2' }], index: 1 })
    expect(w.toasts).toEqual([])
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('a'))?.spaceId).toBe(w.family)
  })

  it('brings the live page of a tab that keeps its session as it is (a call goes on): nothing is let go, carried or asked', () => {
    const w = world()
    w.live('a')
    const familyWindow = new WindowView(w.shared, blankSelection(w.shared.get(), w.family), new Set(), false, 'window-3')
    const adopted: string[] = []
    const to = w.side(familyWindow, 'window-3', { adopt: (id) => adopted.push(id) > 0, confirmReload: () => false })
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, to, [w.id('a')], today)).toBe('moved')
    expect(adopted).toEqual([w.id('a')])
    expect(w.released).toEqual([])
    expect(w.carried.size).toBe(0)
    expect(activeTab(familyWindow.get())?.id).toBe(w.id('a'))
  })

  it('asks before a page is made again in another profile, changes nothing when the user cancels, and never carries that page', () => {
    const w = world()
    w.live('a')
    const asked: string[][] = []
    let answer = false
    const to = w.side(w.win, 'window-1', { adopt: () => true, confirmReload: (ids) => asked.push([...ids]) > 0 && answer })
    const before = w.shared.get()
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, to, [w.id('a')], today)).toBe('refused')
    expect(asked).toEqual([[w.id('a')]])
    expect(w.shared.get()).toBe(before)
    answer = true
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, to, [w.id('a')], today)).toBe('moved')
    expect(w.released).toEqual([w.id('a')])
  })

  it('starts the page again from its address when the pages cannot be read, and says why in the log', () => {
    const w = world()
    w.live('a')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const familyWindow = new WindowView(w.shared, blankSelection(w.shared.get(), w.family), new Set(), false, 'window-3')
    const from = w.side(w.main, 'main', {
      history: () => {
        throw new Error('the page is gone')
      }
    })
    expect(runTransfer(w.shared, NO_LOCK, from, w.side(familyWindow, 'window-3'), [w.id('a')], today)).toBe('moved')
    expect(w.carried.size).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(w.id('a')), expect.any(Error))
  })

  it('shows, in the window it leaves, a tab that stays when its neighbour leaves too', () => {
    const w = world({ shownByWin: 'comm' })
    runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('a'), w.id('b')], today)
    expect(names(w, w.comm)).toEqual(['c', 'a', 'b'])
    expect(activeTab(w.main.get())?.id).toBe(w.id('c'))
    expect(activeTab(w.win.get())?.id).toBe(w.id('a'))
  })

  it('moves a tab to a window that shows the same space: it only changes window, and the window it leaves shows the tab next to it', () => {
    const w = world({ shownByWin: 'comm' })
    w.live('a')
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('a')], { kind: 'tab', id: w.id('c'), edge: 'before' })).toBe('moved')
    expect(names(w, w.comm)).toEqual(['b', 'a', 'c'])
    expect(activeTab(w.win.get())?.id).toBe(w.id('a'))
    expect(activeTab(w.main.get())?.id).toBe(w.id('b'))
    expect(w.toasts).toEqual([])
    expect(w.carried.has(w.id('a'))).toBe(true)
    expect(w.released).toEqual([w.id('a')])
  })
})

describe('windows that must not exchange tabs', () => {
  it('refuses a private window on either side, and changes nothing', () => {
    const w = world()
    w.live('a')
    const before = w.shared.get()
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.side(w.win, 'private-1', { isPrivate: true }), [w.id('a')], today)).toBe('refused')
    expect(runTransfer(w.shared, NO_LOCK, w.side(w.main, 'guest-1', { isPrivate: true }), w.winSide, [w.id('a')], today)).toBe('refused')
    expect(w.shared.get()).toBe(before)
    expect(w.released).toEqual([])
    expect(w.toasts).toEqual([])
  })

  it('refuses a tab dropped back on its own window', () => {
    const w = world()
    const before = w.shared.get()
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.side(w.main, 'main'), [w.id('a')], today)).toBe('refused')
    expect(w.shared.get()).toBe(before)
  })

  it('keeps a private tab private and out of the pinned list', () => {
    const w = world()
    w.shared.dispatch({ type: 'tab/open', url: 'https://secret.fr/', spaceId: w.comm, private: true, background: true })
    const secret = w.shared.get().tabs.find((tab) => tab.url === 'https://secret.fr/')!.id
    const before = w.shared.get()
    w.win.dispatch({ type: 'tab/pin', id: w.id('w1') })
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [secret], { kind: 'tab', id: w.id('w1'), edge: 'after' })).toBe('refused')
    expect(w.shared.get().tabs.find((tab) => tab.id === secret)?.spaceId).toBe(w.comm)
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [secret], today)).toBe('moved')
    expect(w.shared.get().tabs.find((tab) => tab.id === secret)).toMatchObject({ spaceId: w.work, private: true, pinned: false })
    // A private tab changes no profile: the page never lived in one, so there is nothing to tell.
    expect(w.toasts).toEqual([])
    expect(before).not.toBe(w.shared.get())
  })
})

describe('the tab tree', () => {
  it('opens the branch a tab is dropped inside of, and hangs the tab under it', () => {
    const w = world()
    w.win.dispatch({ type: 'settings/update', patch: { tabTree: true } })
    w.win.dispatch({ type: 'tab/open', url: 'https://kid.fr/', spaceId: w.work, parentId: w.id('w1'), background: true })
    w.win.dispatch({ type: 'tab/tree-collapse', id: w.id('w1'), collapsed: true })
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('w1'))?.treeCollapsed).toBe(true)
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('a')], { kind: 'tab', id: w.id('w1'), edge: 'inside' })).toBe('moved')
    const after = w.shared.get().tabs
    expect(after.find((tab) => tab.id === w.id('a'))).toMatchObject({ spaceId: w.work, parentId: w.id('w1') })
    expect(after.find((tab) => tab.id === w.id('w1'))?.treeCollapsed).toBeUndefined()
  })
})

describe('the lock', () => {
  const locks: Array<[string, (w: ReturnType<typeof world>) => TransferLock]> = [
    ['the application is locked', () => ({ appLocked: () => true, spaceLocked: () => false })],
    ['the space it lands in is locked', (w) => ({ appLocked: () => false, spaceLocked: (spaceId) => spaceId === w.work })],
    ['the space it comes from is locked', (w) => ({ appLocked: () => false, spaceLocked: (spaceId) => spaceId === w.comm })]
  ]

  it.each(locks)('moves nothing, and says so, when %s', (_name, lockOf) => {
    const w = world()
    w.live('a')
    const before = w.shared.get()
    expect(runTransfer(w.shared, lockOf(w), w.mainSide, w.winSide, [w.id('a')], today)).toBe('refused')
    expect(w.shared.get()).toBe(before)
    expect(w.toasts).toEqual([t('tabtransfer.espace-verrouille')])
    expect(w.released).toEqual([])
    expect(w.pages.has(w.id('a'))).toBe(true)
  })
})

describe('windows with tabs of their own', () => {
  it('hands the tab to the window it lands in, which lists it where it was dropped; the window it left does not list it any more', () => {
    const w = world({ independent: true })
    expect(w.main.get().tabs.some((tab) => tab.id === w.id('a'))).toBe(true)
    expect(w.win.get().tabs.some((tab) => tab.id === w.id('a'))).toBe(false)
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('a')], { kind: 'tab', id: w.id('w2'), edge: 'before' })).toBe('moved')
    expect(w.win.get().tabs.some((tab) => tab.id === w.id('a'))).toBe(true)
    expect(w.main.get().tabs.some((tab) => tab.id === w.id('a'))).toBe(false)
    expect(sidebarOrder(w.win.get(), w.work).map((tab) => tab.url.split('/')[2]!.replace('.fr', ''))).toEqual(['w1', 'a', 'w2'])
    expect(activeTab(w.win.get())?.id).toBe(w.id('a'))
  })
})

describe('windows with tabs of their own showing the same space', () => {
  it('only changes the window the tab belongs to: it leaves the list of one and joins the list of the other, where it was dropped', () => {
    const w = world({ independent: true, shownByWin: 'comm' })
    expect(w.win.get().tabs.some((tab) => tab.id === w.id('a'))).toBe(false)
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, [w.id('a')], today)).toBe('moved')
    const listed = (view: WindowView) => sidebarOrder(view.get(), w.comm).map((tab) => tab.url.split('/')[2]!.replace('.fr', ''))
    expect(listed(w.win)).toEqual(['a'])
    expect(listed(w.main)).toEqual(['b', 'c'])
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('a'))?.spaceId).toBe(w.comm)
    expect(activeTab(w.win.get())?.id).toBe(w.id('a'))
    expect(w.released).toEqual([w.id('a')])
  })
})

describe('when something goes wrong', () => {
  it('keeps the tab where it is, says so, and logs why, when the window it leaves cannot move it', () => {
    const w = world()
    w.live('a')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = w.side(w.main, 'main', {
      dispatch: () => {
        throw new Error('the reducer failed')
      }
    })
    expect(runTransfer(w.shared, NO_LOCK, broken, w.winSide, [w.id('a')], today)).toBe('failed')
    expect(w.toasts).toEqual([t('tabtransfer.deplacement-echoue')])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('another window'), expect.any(Error))
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('a'))?.spaceId).toBe(w.comm)
    // Nothing was let go: the page is still where it was.
    expect(w.released).toEqual([])
    expect(w.pages.has(w.id('a'))).toBe(true)
  })

  it('does not lose the tab when the window it lands in cannot place it: it is in the space that window shows', () => {
    const w = world()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = w.side(w.win, 'window-1', {
      dispatch: (action) => {
        if (action.type === 'tabs/move') throw new Error('the reducer failed')
        w.win.dispatch(action)
      }
    })
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, broken, [w.id('a')], today)).toBe('failed')
    expect(w.toasts).toEqual([t('tabtransfer.deplacement-echoue')])
    const tab = w.shared.get().tabs.find((x) => x.id === w.id('a'))
    expect(tab?.spaceId).toBe(w.work)
    // It is listed once, in one space, and on screen nowhere.
    expect(w.shared.get().tabs.filter((x) => x.id === w.id('a'))).toHaveLength(1)
    expect([w.main, w.win, w.third].flatMap((view) => visibleTabIds(view.get())).includes(w.id('a'))).toBe(false)
  })

  it('moves the tabs that could leave and leaves the others where they are', () => {
    const w = world()
    w.live('a', 'c')
    const stubborn = w.side(w.main, 'main', {
      dispatch: (action) => {
        if (action.type === 'tab/move-to-space' && action.id === w.id('c')) return
        w.main.dispatch(action)
      }
    })
    expect(runTransfer(w.shared, NO_LOCK, stubborn, w.winSide, [w.id('a'), w.id('c')], today)).toBe('moved')
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('a'))?.spaceId).toBe(w.work)
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('c'))?.spaceId).toBe(w.comm)
    expect(w.released).toEqual([w.id('a')])
  })

  it('tells how many tabs changed profile among those that did leave, and shows the first of them', () => {
    const w = world()
    w.live('a', 'c')
    const stubborn = w.side(w.main, 'main', {
      dispatch: (action) => {
        if (action.type === 'tab/move-to-space' && action.id === w.id('a')) return
        w.main.dispatch(action)
      }
    })
    expect(runTransfer(w.shared, NO_LOCK, stubborn, w.winSide, [w.id('a'), w.id('c')], today)).toBe('moved')
    expect(w.toasts).toEqual([tp('tabtransfer.count-onglets-autre-profil', 1, { space: 'Work' })])
    // a, the first, stayed: the one that is shown is the first that arrived.
    expect(activeTab(w.win.get())?.id).toBe(w.id('c'))
  })

  it('does nothing when no tab could leave', () => {
    const w = world()
    w.live('a')
    const stubborn = w.side(w.main, 'main', { dispatch: () => {} })
    const before = w.shared.get()
    expect(runTransfer(w.shared, NO_LOCK, stubborn, w.winSide, [w.id('a')], today)).toBe('refused')
    expect(w.shared.get()).toBe(before)
    expect(w.released).toEqual([])
    expect(w.pages.has(w.id('a'))).toBe(true)
  })
})

describe('what is dragged', () => {
  it('is only what the window held, as named: ids that are not tabs move nothing', () => {
    const w = world()
    const before = w.shared.get()
    expect(runTransfer(w.shared, NO_LOCK, w.mainSide, w.winSide, ['nope', ''], today)).toBe('refused')
    expect(w.shared.get()).toBe(before)
    expect(selectionOf(w.main.get()).spaceId).toBe(w.comm)
  })
})

describe('the events of a page carried to another window', () => {
  it('go to the window it is in now, and a member that window lacks does nothing', () => {
    const calls: string[] = []
    const events = (name: string, extra: Partial<PageEvents> = {}) => ({ update: () => void calls.push(`${name}:update`), ...extra }) as unknown as PageEvents
    const relay = relayEvents(events('first', { mediaChanged: () => void calls.push('first:media') }))
    relay.events.update({})
    relay.retarget(events('second'))
    relay.events.update({})
    relay.events.mediaChanged?.()
    expect(calls).toEqual(['first:update', 'second:update'])
  })
})
