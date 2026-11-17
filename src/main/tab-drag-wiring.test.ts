// The dragging of tabs from one window to another, wired end to end: the bridge of the interface sends the channels, the IPC of a window hands them
// to its browser, and the browser keeps the drag, tells the other windows and carries out the drop. The rules are tested in src/shared/tab-transfer.test.ts,
// tab-drag.test.ts, dnd.test.ts and src/main/shell/tab-transfer.test.ts; the whole thing is to be tried with two windows.
// The browser's methods run here on stand-ins (shell/browser-fake.test-support.ts), the IPC and the bridge against an Electron that keeps what is
// registered and sent (shell/ipc-fake.test-support.ts).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Channel, type LuciumApi } from '@shared/ipc'
import { createInitialState } from '@shared/sidebar'
import { MAIN_WINDOW_KEY } from '@shared/window-tabs'
import { TabDragLedger } from '@shared/tab-drag'
import type { SidebarState } from '@shared/model'
import { fakeBrowser, methodsOf, type FakeBrowser } from './shell/browser-fake.test-support'
import { ipcHost, sendFrom } from './shell/ipc-fake.test-support'

vi.mock('electron', async () => (await import('./shell/ipc-fake.test-support')).fakeElectron())
vi.mock('electron-chrome-extensions/browser-action', () => ({ injectBrowserAction: () => {} }))
vi.mock('./blocking', () => ({ blockingService: () => ({ status: () => 'off', subscribe: () => () => {} }) }))
const transfer = vi.hoisted(() => ({ runTransfer: vi.fn((..._args: unknown[]) => 'moved') }))
vi.mock('./shell/tab-transfer', () => transfer)
const { registerIpc } = await import('./shell/ipc')
const { Browser } = await import('./shell/browser')
const shell = methodsOf(Browser.prototype)

afterEach(() => vi.clearAllMocks())

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const base = createInitialState({ now: 0, newId: () => 'x' })
const tab = (id: string) => ({ id, spaceId: base.activeSpaceId, url: `https://${id}.example/`, title: id, pinned: false, createdAt: 0, lastActiveAt: 0 })
const state: SidebarState = { ...base, tabs: [tab('a'), tab('b')] }

/** Two windows of one group: the main one (the leader, which keeps the ledger of the drags) and a second one. */
function twoWindows(options: { private?: boolean; locked?: boolean } = {}) {
  const tabDrags = new TabDragLedger()
  const group = new Set<unknown>()
  const make = (key: string, extra: Record<string, unknown> = {}): FakeBrowser & { own: Record<string, unknown>; requested: () => number } => {
    let requested = 0
    const own: Record<string, unknown> = {
      options: key === MAIN_WINDOW_KEY ? {} : { windowId: key },
      isPrivate: () => options.private === true,
      namesLockedTarget: () => options.locked === true,
      store: { get: () => state, root: () => ({ get: () => state }) },
      group,
      tabDrags,
      tabDragExpiry: null,
      carriedHistory: new Map([['a', []]]),
      publishQueue: { request: () => void requested++, cancel: () => {} },
      win: { isDestroyed: () => false, focus: vi.fn() },
      ...extra
    }
    const fake = fakeBrowser(own)
    for (const name of ['windowKey', 'publishToOthers', 'transferSide', 'foreignDragOfSnapshot']) own[name] = (...args: unknown[]) => shell[name]!.call(fake.self, ...args)
    group.add(fake.self)
    return Object.assign(fake, { own, requested: () => requested })
  }
  const main = make(MAIN_WINDOW_KEY)
  const second = make('window-2')
  for (const w of [main, second]) w.own['leader'] = main.self
  return { main, second, tabDrags, group }
}

describe('the channels', () => {
  it('exist, are bound by the preload script, and are handled by the browser of the window that sent them', async () => {
    expect(Channel.tabDrag).toBe('lucium:tab-drag')
    expect(Channel.dropWindowTabs).toBe('lucium:drop-window-tabs')
    vi.stubGlobal('location', { search: '' })
    await import('../preload/index')
    vi.unstubAllGlobals()
    const api = ipcHost.exposed.get('lucium') as LuciumApi
    ipcHost.sent.length = 0
    api.tabDrag('start', ['a'])
    api.tabDrag('end')
    api.dropWindowTabs({ kind: 'today' })
    expect(ipcHost.sent).toEqual([
      { kind: 'send', channel: Channel.tabDrag, args: ['start', ['a']] },
      { kind: 'send', channel: Channel.tabDrag, args: ['end', undefined] },
      { kind: 'send', channel: Channel.dropWindowTabs, args: [{ kind: 'today' }] }
    ])
    const browser = fakeBrowser()
    registerIpc(browser.self as never, { get: () => state, subscribe: () => () => {} } as never, {} as never, new Set([1]))
    browser.calls.length = 0
    sendFrom(1, Channel.tabDrag, 'start', ['a'])
    sendFrom(1, Channel.tabDrag, 'end')
    sendFrom(1, Channel.tabDrag, 'other', ['a'])
    sendFrom(1, Channel.dropWindowTabs, { kind: 'today' })
    expect(browser.calls).toEqual([
      { name: 'beginTabDrag', args: [['a']] },
      { name: 'endTabDrag', args: [] },
      { name: 'dropForeignTabs', args: [{ kind: 'today' }] }
    ])
  })
})

describe('the browser of a window', () => {
  it('tells the other windows of a drag only from a normal window that has a sibling, and never of what a lock hides', () => {
    vi.useFakeTimers()
    const w = twoWindows()
    shell['beginTabDrag']!.call(w.main.self, ['a', 'nope'])
    expect(w.tabDrags.live()).toMatchObject({ sourceKey: MAIN_WINDOW_KEY, tabs: [{ id: 'a' }] })
    expect(w.second.requested()).toBe(1)
    expect(w.main.requested()).toBe(0)
    vi.useRealTimers()
    for (const options of [{ private: true }, { locked: true }]) {
      const other = twoWindows(options)
      shell['beginTabDrag']!.call(other.main.self, ['a'])
      expect(other.tabDrags.live(), JSON.stringify(options)).toBeNull()
    }
    const alone = twoWindows()
    alone.group.delete(alone.second.self)
    shell['beginTabDrag']!.call(alone.main.self, ['a'])
    expect(alone.tabDrags.live()).toBeNull()
  })

  it('takes a drop from the drag it was told of and a place in the list, never from tabs named by the message', () => {
    const w = twoWindows()
    w.tabDrags.begin('window-2', [{ id: 'b' }])
    // A target that is none, or a private window, takes nothing.
    shell['dropForeignTabs']!.call(w.main.self, { kind: 'nowhere', tabs: ['a'] })
    expect(transfer.runTransfer).not.toHaveBeenCalled()
    shell['dropForeignTabs']!.call(w.main.self, { kind: 'today' })
    expect(transfer.runTransfer).toHaveBeenCalledTimes(1)
    const [, , from, to, ids, target] = transfer.runTransfer.mock.calls[0]!
    // The window the tabs come from is another one of the group, found by the key the drag recorded.
    expect((from as { key: string }).key).toBe('window-2')
    expect((to as { key: string }).key).toBe(MAIN_WINDOW_KEY)
    expect(ids).toEqual(['b'])
    expect(target).toEqual({ kind: 'today' })
    // The drag is claimed: a second drop takes nothing.
    shell['dropForeignTabs']!.call(w.main.self, { kind: 'today' })
    expect(transfer.runTransfer).toHaveBeenCalledTimes(1)
    // The window the tabs landed in comes to the front (a drop does not do it, and the keys go to the window in front).
    expect((w.main.own['win'] as { focus: ReturnType<typeof vi.fn> }).focus).toHaveBeenCalledTimes(1)
    const privateWindows = twoWindows({ private: true })
    privateWindows.tabDrags.begin('window-2', [{ id: 'b' }])
    shell['dropForeignTabs']!.call(privateWindows.main.self, { kind: 'today' })
    expect(transfer.runTransfer).toHaveBeenCalledTimes(1)
  })

  it('lets go of the pages it carried history for, once a drop is done', () => {
    const w = twoWindows()
    w.tabDrags.begin('window-2', [{ id: 'a' }])
    shell['dropForeignTabs']!.call(w.main.self, { kind: 'today' })
    expect((w.main.own['carriedHistory'] as Map<string, unknown>).has('a')).toBe(false)
  })

  it('shows the interface the drag of another window only, in the snapshot', () => {
    const w = twoWindows()
    expect(shell['foreignDragOfSnapshot']!.call(w.main.self)).toEqual({})
    const drag = w.tabDrags.begin('window-2', [{ id: 'b' }])
    expect(shell['foreignDragOfSnapshot']!.call(w.main.self)).toEqual({ foreignDrag: { token: drag.token, tabs: [{ id: 'b' }] } })
    // The window the drag comes from is not shown its own drag.
    expect(shell['foreignDragOfSnapshot']!.call(w.second.self)).toEqual({})
    // Nor is a private window, nor a window alone.
    expect(shell['foreignDragOfSnapshot']!.call(twoWindows({ private: true }).main.self)).toEqual({})
    // The snapshot carries it.
    Object.assign(w.main.own, { mediaPlayers: [], peek: null, sidePanel: null, webPanel: null, toast: null, floatVisible: false, overlayRequest: null, find: null, windowNamesOfSnapshot: () => ({}) })
    expect(shell['snapshot']!.call(w.main.self)).toMatchObject({ foreignDrag: { token: drag.token, tabs: [{ id: 'b' }] } })
  })

  it('forgets the drag of a window that closes, and leaves the group', () => {
    const w = twoWindows()
    w.tabDrags.begin('window-2', [{ id: 'b' }])
    const maps = ['scopeGuards', 'pages', 'privatePages', 'pageContainer', 'permissionAnswers', 'permissionPages', 'authAnswers', 'reviewAnswers', 'dialogAnswers', 'leaveAnswers', 'passphraseAnswers']
    Object.assign(w.second.own, { ...Object.fromEntries(maps.map((name) => [name, new Map()])), passwordView: null, floatTimer: null, splitDrag: null, dialogQueue: [] })
    w.second.own['forgetTabDrag'] = () => shell['forgetTabDrag']!.call(w.second.self)
    shell['stop']!.call(w.second.self)
    expect(w.tabDrags.live()).toBeNull()
    expect(w.main.requested()).toBe(1)
    expect(w.group.has(w.second.self)).toBe(false)
  })

  it('reads the pages of a tab from the window that holds its page and lets that page go there', () => {
    const w = twoWindows()
    const entries = [{ url: 'https://a.example/', title: 'a' }]
    const owner = { pages: new Map([['a', { navigationEntries: () => entries }]]), destroyPage: vi.fn() }
    w.main.own['ownerOf'] = (id: string) => (id === 'a' ? owner : undefined)
    const side = shell['transferSide']!.call(w.main.self) as { history: (id: string) => unknown; release: (id: string) => void }
    expect(side.history('a')).toBe(entries)
    expect(side.history('b')).toBeUndefined()
    side.release('a')
    expect(owner.destroyPage).toHaveBeenCalledWith('a')
  })
})

// Contract: the sidebar is a React tree wired to the drag events of a real window (no DOM runs in the unit tests); these lines are where it tells
// the main process of a drag of its rows and where it takes the drop of another window's tabs.
describe('the sidebar', () => {
  const sidebar = read('../renderer/Sidebar.tsx')

  it('tells the main process when it starts and ends dragging tab rows, on every way a drag ends', () => {
    expect(sidebar).toMatch(/toldWindows\.current = true\s*act\.tabDrag\('start', ids\)/)
    expect(sidebar).toMatch(/const releaseWindows = \(\) => \{[^}]*act\.tabDrag\('end'\)/s)
    // The end of the drag in the row, the drop, and the press or key that ends a drag whose row was replaced.
    expect(sidebar).toMatch(/const endDrag = \(\) => \{[^}]*releaseWindows\(\)/s)
    expect(sidebar).toMatch(/const stop = \(\) => \{[^}]*releaseWindows\(\)/s)
  })

  it('takes a drop of the tabs another window drags as a place of its list, and asks the main process to carry it out', () => {
    expect(sidebar).toMatch(/snapshot\.foreignDrag/)
    expect(sidebar).toMatch(/\{ kind: 'window-tabs', tabs: foreign\.tabs, spaceId: space\.id \}/)
    expect(sidebar).toMatch(/const plan = active && found \? planDrop\(state, active, found\.target\) : NO_DROP/)
    expect(sidebar).toMatch(/if \(plan\.fromWindow\) act\.dropWindowTabs\(plan\.fromWindow\)/)
  })

  it('does not keep the marks of a drag that nobody ended', () => {
    expect(sidebar).toMatch(/dismiss = \(\) => setDismissedDrag\(foreignToken\)/)
    expect(sidebar).toMatch(/snapshot\.foreignDrag\.token !== dismissedDrag/)
  })
})
