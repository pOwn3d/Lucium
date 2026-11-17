// The search suggestions of a window come from the engine of the space THAT window is on, not from the main window's.
// Each window registers its own handlers with its own view of the state (windows.ts), and `scopedIpc` runs the one of the window that sent
// the message. The real handlers are called as Electron would call them; the way out is a stand-in that records the addresses asked.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { SEARCH_ENGINES, type SidebarState } from '@shared/model'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(), netFetch: vi.fn() }))
vi.mock('electron', () => {
  const ipcMain = { on: (channel: string, handler: Handler) => void electron.handlers.set(channel, handler), handle: (channel: string, handler: Handler) => void electron.handlers.set(channel, handler) }
  const net = { fetch: (...args: unknown[]) => electron.netFetch(...args) }
  return new Proxy({ ipcMain, net, app: { getPath: () => '/nonexistent' }, clipboard: {}, dialog: {}, BrowserWindow: {}, ShareMenu: {} } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) })
})

const { registerIpc } = await import('./ipc')

const engine = (name: string) => SEARCH_ENGINES.find((e) => e.name === name)!
const DUCK = engine('DuckDuckGo')
const GOOGLE = engine('Google')
const BING = engine('Bing')

/**
 * A state with two spaces: `home` (default profile, the general engine) and `work` (a profile with an engine of its own, or none). Each space has
 * an ordinary tab and a private one; the ordinary one is on screen unless `shown` says otherwise.
 */
function stateOn(activeSpaceId: 'home' | 'work', work?: { searchUrlTemplate?: string; searchSuggestions?: boolean }, shown: 'ordinary' | 'private' | 'none' = 'ordinary'): SidebarState {
  return {
    activeSpaceId,
    spaces: [{ id: 'home' }, { id: 'work', profileId: 'pro' }],
    tabs: ['home', 'work'].flatMap((spaceId) => [
      { id: `${spaceId}-ordinary`, spaceId, url: 'https://ordinary.example/' },
      { id: `${spaceId}-private`, spaceId, url: 'about:blank', private: true }
    ]),
    activeTabBySpace: shown === 'none' ? {} : { home: `home-${shown}`, work: `work-${shown}` },
    settings: { searchUrlTemplate: DUCK.url, searchSuggestions: true, profiles: work ? { pro: work } : {} }
  } as unknown as SidebarState
}

const MAIN = 1
const OVERLAY_OF_MAIN = 2
const SECOND_WINDOW = 3
const MINI_WINDOW = 4
const PRIVATE_WINDOW = 5

/** What each window's view of the state shows now: the tests change it between calls. */
const views = { main: stateOn('home'), second: stateOn('work'), private: stateOn('home') }

beforeAll(() => {
  const browser = new Proxy({}, { get: () => () => undefined })
  const view = (read: () => SidebarState) => ({ get: read, subscribe: () => () => undefined })
  // The main window, then a second window on the same shared state with a view of its own; the mini window's page is trusted by the main window (little.ts).
  registerIpc(browser as never, view(() => views.main) as never, {} as never, new Set([MAIN, OVERLAY_OF_MAIN, MINI_WINDOW]))
  registerIpc(browser as never, view(() => views.second) as never, {} as never, new Set([SECOND_WINDOW]))
  // A private window: its tabs carry no mark of their own (every one of them is private), the window says what it is.
  const privateBrowser = new Proxy({ isPrivate: () => true } as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : () => undefined) })
  registerIpc(privateBrowser as never, view(() => views.private) as never, {} as never, new Set([PRIVATE_WINDOW]))
})

beforeEach(() => {
  views.main = stateOn('home', { searchUrlTemplate: BING.url })
  views.second = stateOn('work', { searchUrlTemplate: GOOGLE.url })
  views.private = stateOn('home')
  electron.netFetch.mockReset()
  electron.netFetch.mockImplementation(async () => new Response(JSON.stringify(['arbal', ['planète']]), { status: 200 }))
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

const sender = (id: number) => ({ id, mainFrame: {}, getURL: () => 'lucium://interface/' })
const suggest = (id: number, query = 'arbal') => {
  const from = sender(id)
  return electron.handlers.get(Channel.suggest)!({ sender: from, senderFrame: from.mainFrame }, query)
}
const asked = () => electron.netFetch.mock.calls.map((call) => String(call[0]))

describe('the search suggestions of a window', () => {
  it('come from the engine of the space of the window that asks: the main window, its command bar, and a second window each use their own', async () => {
    expect(await suggest(OVERLAY_OF_MAIN)).toEqual(['planète'])
    expect(asked()).toEqual([DUCK.suggest!.replace('%s', 'arbal')])
    electron.netFetch.mockClear()
    await suggest(SECOND_WINDOW)
    expect(asked()).toEqual([GOOGLE.suggest!.replace('%s', 'arbal')])
  })

  it('follow the space a window is on when it changes: the second window back on the general space asks the general engine', async () => {
    views.second = stateOn('home', { searchUrlTemplate: GOOGLE.url })
    await suggest(SECOND_WINDOW)
    expect(asked()).toEqual([DUCK.suggest!.replace('%s', 'arbal')])
  })

  it('are off in a window whose profile switched them off, whatever the main window does', async () => {
    views.second = stateOn('work', { searchUrlTemplate: GOOGLE.url, searchSuggestions: false })
    expect(await suggest(SECOND_WINDOW)).toEqual([])
    expect(electron.netFetch).not.toHaveBeenCalled()
    expect(await suggest(MAIN)).toEqual(['planète'])
    expect(electron.netFetch).toHaveBeenCalledOnce()
  })

  it('are not served to a page nobody trusts', async () => {
    // Refused by the scoped IPC itself, before the handler: no answer, and no request to the engine.
    expect(await suggest(99)).toBeUndefined()
    expect(electron.netFetch).not.toHaveBeenCalled()
  })

  it('of a mini window use the engine of the space the main window is on, where the page it opens goes', async () => {
    views.main = stateOn('work', { searchUrlTemplate: BING.url })
    await suggest(MINI_WINDOW)
    expect(asked()).toEqual([BING.suggest!.replace('%s', 'arbal')])
  })
})

// What is typed for a private page must not leave the machine before Enter. The bar of « Nouvel onglet privé » is over a blank private tab, and
// ⌘L over a private tab is over that tab: both are "the tab on screen is private". The engine is asked nothing, whatever the setting says.
describe('the search suggestions over a private tab and in a private window', () => {
  it('are not asked of the engine while the tab on screen is private, from the window, its command bar or a second window', async () => {
    views.main = stateOn('home', undefined, 'private')
    views.second = stateOn('work', { searchUrlTemplate: GOOGLE.url, searchSuggestions: true }, 'private')
    for (const from of [MAIN, OVERLAY_OF_MAIN, SECOND_WINDOW]) expect(await suggest(from, 'symptoms of'), String(from)).toEqual([])
    expect(electron.netFetch).not.toHaveBeenCalled()
  })

  it('are asked again once an ordinary tab is on screen, and with no tab at all: only the private tab holds them back', async () => {
    views.main = stateOn('home', undefined, 'private')
    expect(await suggest(MAIN)).toEqual([])
    views.main = stateOn('home', undefined, 'ordinary')
    expect(await suggest(MAIN)).toEqual(['planète'])
    views.main = stateOn('home', undefined, 'none')
    expect(await suggest(MAIN)).toEqual(['planète'])
    expect(electron.netFetch).toHaveBeenCalledTimes(2)
  })

  it('are never asked from a private window, which follows the same rule as the private tab', async () => {
    for (const shown of ['ordinary', 'none'] as const) {
      views.private = stateOn('home', undefined, shown)
      expect(await suggest(PRIVATE_WINDOW, 'symptoms of'), shown).toEqual([])
    }
    expect(electron.netFetch).not.toHaveBeenCalled()
  })
})

