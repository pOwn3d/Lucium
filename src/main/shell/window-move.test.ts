// "Déplacer vers la fenêtre": the move of the drag (runTransfer) with the tabs and the place the menu decides, between real views of one shared state. The
// pages are simulated: `adopt` says whether the live page could follow the tab as it is.

import { describe, expect, it } from 'vitest'
import { activeTab, createInitialState, sidebarOrder, type Action } from '@shared/sidebar'
import { blankSelection, visibleTabIds } from '@shared/window-selection'
import { StateStore, WindowView, liveCtx } from '../store'
import type { TransferLock, TransferSide } from './tab-transfer'
import { sendToWindow } from './window-move'

const NO_LOCK: TransferLock = { appLocked: () => false, spaceLocked: () => false }

/** Communication (a, b, c, p pinned) shown by "main" and "third", Work (w1, w2, another profile) shown by "win". a is on screen in main, c in third. */
function world() {
  const shared = new StateStore(createInitialState(liveCtx()), null)
  const comm = shared.get().activeSpaceId
  shared.dispatch({ type: 'space/create', name: 'Work', emoji: '💼', hue: 200, profileName: 'Travail' })
  const work = shared.get().spaces.find((s) => s.name === 'Work')!.id
  for (const [name, spaceId] of [['a', comm], ['b', comm], ['c', comm], ['p', comm], ['w1', work], ['w2', work]] as const) shared.dispatch({ type: 'tab/open', url: `https://${name}.fr/`, spaceId, background: true })
  const id = (n: string) => shared.get().tabs.find((tab) => tab.url === `https://${n}.fr/`)!.id
  shared.dispatch({ type: 'tab/pin', id: id('p') })
  const siblings = new Set<WindowView>()
  const main = new WindowView(shared, blankSelection(shared.get(), comm), siblings, true)
  const win = new WindowView(shared, blankSelection(shared.get(), work), siblings, false, 'window-1')
  const third = new WindowView(shared, blankSelection(shared.get(), comm), siblings, false, 'window-2')
  main.dispatch({ type: 'tab/select', id: id('a') })
  win.dispatch({ type: 'tab/select', id: id('w2') })
  third.dispatch({ type: 'tab/select', id: id('c') })
  const adopted: string[] = []
  const released: string[] = []
  const toasts: string[] = []
  const side = (view: WindowView | StateStore, key: string, over: Partial<TransferSide> = {}): TransferSide => ({
    key,
    isPrivate: false,
    state: () => view.get(),
    dispatch: (action: Action) => view.dispatch(action),
    toast: (message) => void toasts.push(message),
    history: () => undefined,
    release: (tabId) => void released.push(tabId),
    carry: () => undefined,
    // The page keeps its session (same profile): it follows the tab as it is.
    adopt: (tabId) => (adopted.push(tabId), true),
    confirmReload: () => true,
    ...over
  })
  const names = (spaceId: string) => sidebarOrder(shared.get(), spaceId).map((tab) => tab.url.split('/')[2]!.replace('.fr', ''))
  return { shared, main, win, third, comm, work, id, adopted, released, toasts, side, names }
}

describe('a tab sent to another window from its menu', () => {
  it('goes to the top of Today of the space that window shows, is shown there, and the window it left shows the next tab', () => {
    const w = world()
    const { result, ids } = sendToWindow(w.shared, NO_LOCK, w.side(w.main, 'main'), w.side(w.win, 'window-1'), w.id('a'))
    expect(result).toBe('moved')
    expect(ids).toEqual([w.id('a')])
    expect(w.names(w.work)).toEqual(['a', 'w1', 'w2'])
    expect(visibleTabIds(w.win.get())).toEqual([w.id('a')])
    expect(activeTab(w.main.get())?.id).toBe(w.id('b'))
    // Work is another profile: the page cannot leave the session it was made in, it is made again there, and the user is told.
    expect(w.adopted).toEqual([])
    expect(w.released).toEqual([w.id('a')])
    expect(w.toasts).toHaveLength(1)
  })

  it('stays in its space when the window shows the same one: its page follows it as it is, and only the window changes', () => {
    const w = world()
    expect(sendToWindow(w.shared, NO_LOCK, w.side(w.main, 'main'), w.side(w.third, 'window-2'), w.id('b')).result).toBe('moved')
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('b'))!.spaceId).toBe(w.comm)
    expect(w.names(w.comm)).toEqual(['p', 'b', 'a', 'c'])
    expect(visibleTabIds(w.third.get())).toEqual([w.id('b')])
    expect(w.adopted).toEqual([w.id('b')])
    expect(w.released).toEqual([])
  })

  it('keeps a pinned tab pinned, at its place, when the window shows its space', () => {
    const w = world()
    expect(sendToWindow(w.shared, NO_LOCK, w.side(w.main, 'main'), w.side(w.third, 'window-2'), w.id('p')).result).toBe('moved')
    expect(w.shared.get().tabs.find((tab) => tab.id === w.id('p'))).toMatchObject({ pinned: true, spaceId: w.comm })
    expect(w.names(w.comm)).toEqual(['p', 'a', 'b', 'c'])
    expect(visibleTabIds(w.third.get())).toEqual([w.id('p')])
  })

  it('takes the whole split view, which is one again in the window it goes to, on screen there, panes and sizes as they were', () => {
    const w = world()
    w.main.dispatch({ type: 'split/create', tabId: w.id('b'), withTabId: w.id('a') })
    const split = w.shared.get().splits[0]!
    w.main.dispatch({ type: 'split/ratios', id: split.id, ratios: [0.7, 0.3] })
    const { result, ids } = sendToWindow(w.shared, NO_LOCK, w.side(w.main, 'main'), w.side(w.win, 'window-1'), w.id('b'))
    expect(result).toBe('moved')
    expect(ids).toEqual([w.id('a'), w.id('b')])
    expect(w.names(w.work)).toEqual(['a', 'b', 'w1', 'w2'])
    expect(w.shared.get().splits).toEqual([{ ...split, ratios: [0.7, 0.3], spaceId: w.work }])
    expect([...visibleTabIds(w.win.get())].sort()).toEqual([w.id('a'), w.id('b')].sort())
    expect(visibleTabIds(w.main.get())).toEqual([w.id('c')])
  })

  it('keeps a split view as it is when the window shows the same space', () => {
    const w = world()
    w.main.dispatch({ type: 'split/create', tabId: w.id('a'), withTabId: w.id('b') })
    const split = w.shared.get().splits[0]!
    expect(sendToWindow(w.shared, NO_LOCK, w.side(w.main, 'main'), w.side(w.third, 'window-2'), w.id('a')).result).toBe('moved')
    expect(w.shared.get().splits).toEqual([split])
    expect([...visibleTabIds(w.third.get())].sort()).toEqual([w.id('a'), w.id('b')].sort())
  })

  it('leaves the window it came from open, on nothing, when it was its last tab', () => {
    const w = world()
    w.shared.dispatch({ type: 'tab/unpin', id: w.id('p') })
    for (const name of ['b', 'c', 'p']) w.shared.dispatch({ type: 'tab/close', id: w.id(name) })
    expect(sendToWindow(w.shared, NO_LOCK, w.side(w.main, 'main'), w.side(w.win, 'window-1'), w.id('a')).result).toBe('moved')
    expect(w.names(w.comm)).toEqual([])
    expect(activeTab(w.main.get())).toBeUndefined()
  })

  it('moves nothing between a private window and a normal one, either way', () => {
    const w = world()
    const before = w.shared.get()
    const privateStore = new StateStore(createInitialState(liveCtx()), null)
    expect(sendToWindow(w.shared, NO_LOCK, w.side(w.main, 'main'), w.side(privateStore, 'private-1', { isPrivate: true }), w.id('a'))).toEqual({ result: 'refused', ids: [] })
    expect(sendToWindow(w.shared, NO_LOCK, w.side(w.main, 'private-1', { isPrivate: true }), w.side(w.win, 'window-1'), w.id('a'))).toEqual({ result: 'refused', ids: [] })
    expect(w.shared.get()).toBe(before)
    expect(w.adopted).toEqual([])
  })

  it('moves nothing to the window the tab is in, nor out of or into a locked space (the user is told)', () => {
    const w = world()
    expect(sendToWindow(w.shared, NO_LOCK, w.side(w.main, 'main'), w.side(w.main, 'main'), w.id('a')).result).toBe('refused')
    const locked: TransferLock = { appLocked: () => false, spaceLocked: (spaceId) => spaceId === w.work }
    expect(sendToWindow(w.shared, locked, w.side(w.main, 'main'), w.side(w.win, 'window-1'), w.id('a')).result).toBe('refused')
    expect(w.names(w.work)).toEqual(['w1', 'w2'])
    expect(w.toasts).toHaveLength(1)
  })
})
