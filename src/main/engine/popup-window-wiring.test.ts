// The window of the popup of an extension icon, with several windows on one profile. The rules themselves (which tab a click is for, which window the library is
// told the user is in) are tested without a window in ece-router.test.ts, ece-active-tabs.test.ts and action-window.test.ts; here the engine's side runs on a
// stand-in of the engine (the class reaches Electron only when a method runs): the rules it gives the library (`libraryRules`), the window it follows
// (`followFocusedWindow`) and the page it makes (`createPage`), and the engine constructed, and a profile it makes, over the real library. What is left (a real
// window taking the focus, a real popup) is checked by hand with three windows.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import type { LibraryGuard } from './ece-router'
import { engineForPages, FakeWindow, madeViews } from './electron-page.test-support'
import { constructEngine, emitApp } from './engine-constructed.test-support'
import { inertEngine, LibraryTab, LibraryWindow, libraryContents, madeSessions } from '../profile-made.test-support'
import { fakeBrowser, methodsOf } from '../shell/browser-fake.test-support'

vi.mock('electron', async () => (await import('./engine-constructed.test-support')).engineElectron())
vi.mock('electron-chrome-extensions', async () => ({ ElectronChromeExtensions: (await import('../profile-made.test-support')).realLibrary() }))
vi.mock('electron-chrome-web-store', () => ({}))
// `Browser.start` runs on a stand-in (browser-start.test.ts): the blocking service and the shims of the extensions are inert, as their own tests run them.
vi.mock('../blocking', () => ({ blockingService: () => ({ subscribe: () => () => {} }) }))
vi.mock('../shell/extension-shims', () => ({ ExtensionShims: class {} }))
// The library's own bookkeeping of a moved tab is tested on the real library (ece-active-tabs.test.ts); here, only that the engine asks for it.
vi.mock('./ece-router', async (importOriginal) => ({ ...(await importOriginal<typeof import('./ece-router')>()), tabMovedTo: vi.fn() }))

const { ElectronEngine } = await import('./electron-engine')
const { tabMovedTo } = await import('./ece-router')
const { Browser } = await import('../shell/browser')
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

/** The rules the engine gives the library of profile `p`, where tab 7 is in window 1 and tab 8 in window 2 (both of `p`), and tab 9 is of profile `q`. */
function rulesOf(over: Record<string, unknown> = {}): LibraryGuard {
  const tabs: Record<number, { profile: string; window: number }> = { 7: { profile: 'p', window: 1 }, 8: { profile: 'p', window: 2 }, 9: { profile: 'q', window: 1 } }
  const engine = { profileOfTab: (tab: number) => tabs[tab]?.profile, windowOfTab: (tab: number) => tabs[tab]?.window, ...over }
  return engineMethods['libraryRules']!.call(engine, 'p') as LibraryGuard
}

/** The page of an extension (its popup) shown in `win`. */
const senderIn = (win: FakeWindow | null, destroyed = false) => ({ window: win, isDestroyed: () => destroyed })

beforeEach(() => {
  madeViews.length = 0
  vi.mocked(tabMovedTo).mockClear()
})

describe('the window of the popup of an extension icon, with several windows on one profile', () => {
  it('lets the router know whether a tab is in the window of the icon, from the window the engine gave the tab to the library', () => {
    const inWindow = rulesOf().tabInWindowOfSender!
    const popup = senderIn(new FakeWindow(1))
    expect(inWindow(popup, 7)).toBe(true)
    expect(inWindow(popup, 8)).toBe(false)
    // A tab of another profile is not in the window of this profile's icon.
    expect(inWindow(popup, 9)).toBe(false)
    // A sender whose window cannot be told is not refused: the check only says no for a tab it knows to be elsewhere.
    expect(inWindow(senderIn(null), 8)).toBe(true)
    expect(inWindow(senderIn(new FakeWindow(1), true), 8)).toBe(true)
  })

  it('tells the extension runtime of every profile which window the user is in, when a window of the application takes the focus', () => {
    const profiles = new Map([
      ['p', { followWindow: vi.fn() }],
      ['q', { followWindow: vi.fn() }]
    ])
    const engine: Record<string, unknown> = { profiles, currentWindowId: undefined, hooks: { hasWindow: (id: number) => id === 1 || id === 2 } }
    // Only the windows that show tabs count (not the popup of an icon, Settings, a mini window).
    engineMethods['followFocusedWindow']!.call(engine, 5)
    expect(engine['currentWindowId']).toBeUndefined()
    engineMethods['followFocusedWindow']!.call(engine, 2)
    expect(engine['currentWindowId']).toBe(2)
    for (const profile of profiles.values()) expect(profile.followWindow).toHaveBeenCalledWith(2)
    // No shell yet: no window is one of its windows.
    engine['hooks'] = null
    engineMethods['followFocusedWindow']!.call(engine, 1)
    expect(engine['currentWindowId']).toBe(2)
  })

  it('listens to the focus of the windows of the application: the one that shows tabs is the one the user is in', async () => {
    const engine = await constructEngine()
    const followed = vi.fn()
    Object.assign(engine, { profiles: new Map([['p', { followWindow: followed }]]) })
    engine.setExtensionTabHooks({ hasWindow: (id: number) => id === 2 } as never)
    emitApp('browser-window-focus', { id: 5 })
    expect(followed).not.toHaveBeenCalled()
    emitApp('browser-window-focus', { id: 2 })
    expect(followed).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('has the shell say which windows show tabs: the windows of its group that are not destroyed', () => {
    const windows = [{ win: { id: 1, isDestroyed: () => false } }, { win: { id: 2, isDestroyed: () => true } }]
    const fake = fakeBrowser({ isPrivate: () => false, isSecondary: () => false, gates: { gate: () => undefined }, store: { get: () => ({ settings: {} }), subscribe: () => () => {} }, group: new Set(windows) })
    methodsOf(Browser.prototype)['start']!.call(fake.self)
    const hooks = fake.calls.find((call) => call.name === 'engine.setExtensionTabHooks')!.args[0] as { hasWindow(windowId: number): boolean }
    expect(hooks.hasWindow(1)).toBe(true)
    // A window being closed, a window of the application that shows no tab (Settings, a mini window, the popup of an icon): none counts.
    expect(hooks.hasWindow(2)).toBe(false)
    expect(hooks.hasWindow(9)).toBe(false)
  })

  it('tells it again when a window the user is in gets its first page of a profile, the moment the library learns of the window', async () => {
    const focused = await engineForPages({ ready: null, currentWindowId: 1 })
    const { view } = focused.create('t')
    expect(focused.library.addTab).toHaveBeenCalledWith(view.webContents, focused.windows.get('main'))
    expect(focused.library.followWindow).toHaveBeenCalledWith(1)
    expect(focused.library.addTab.mock.invocationCallOrder[0]).toBeLessThan(focused.library.followWindow.mock.invocationCallOrder[0]!)
    // A page in a window the user is not in.
    const behind = await engineForPages({ ready: null, currentWindowId: 1 })
    behind.create('u', 'other')
    expect(behind.library.addTab).toHaveBeenCalled()
    expect(behind.library.followWindow).not.toHaveBeenCalled()
  })

  it('tells the library of the profile the window a tab was dropped on, with the window the engine keeps for it', async () => {
    const world = await engineForPages({ ready: null })
    const { page, view } = world.create('t')
    expect(page.moveToWindow('other')).toBe(true)
    expect(tabMovedTo).toHaveBeenCalledWith(world.library, view.webContents, world.windows.get('other'))
    expect(world.engine.tabMeta.get(view.webContents.id)?.win).toBe(world.windows.get('other'))
    // A page of a private context is no tab of the library: nothing to tell.
    const hidden = await engineForPages()
    hidden.create('u').page.moveToWindow('other')
    expect(tabMovedTo).toHaveBeenCalledTimes(1)
  })

  it('tells the user when a click could not give its window a tab to act on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const notice = vi.fn()
    const createTab = vi.fn(async () => {
      throw new Error('the window is closing')
    })
    const rules = rulesOf({ hooks: { activeTabOf: () => undefined, createTab }, notice, tabNumberOf: () => 1 })
    expect(await rules.activeTabOfSender!(senderIn(new FakeWindow(1)))).toBeUndefined()
    expect(createTab).toHaveBeenCalledWith(undefined, true, 1, 'p')
    expect(notice).toHaveBeenCalledWith(t('engine.impossible-d-ouvrir-un-onglet-dans-cette-fenetre-pour'))
    expect(warn).toHaveBeenCalledWith('[extensions] cannot open a tab in the window of the icon that was clicked:', 'the window is closing')
    warn.mockRestore()
  })
})

// The pages of every profile are in one table. What the library of a profile is given as "the tab just created" becomes a tab of that profile's
// extensions (they can read it, navigate it, close it): only a page that is a tab of that same profile may be given.
describe('the page the library of a profile is given for a tab one of its extensions asked for', () => {
  const win = new FakeWindow(1)
  const page = (contentsId: number) => ({ webContents: { id: contentsId }, window: win })
  const engine = {
    pages: new Map([['mine', page(7)], ['theirs', page(9)], ['private', page(11)]]),
    // Tab 7 is of profile `p`, tab 9 of profile `q`; a private page (11) is no tab of any profile.
    profileOfTab: (tab: number) => ({ 7: 'p', 9: 'q' } as Record<number, string>)[tab]
  }
  const give = (id: string) => engineMethods['pageOfExtensionTab']!.call(engine, id, 'p')

  it('is the page of the tab, with its window, when the tab is of that profile', () => {
    expect(give('mine')).toEqual([{ id: 7 }, win])
  })

  it('is refused when the tab is of another profile, or of none', () => {
    expect(() => give('theirs')).toThrow('is not a tab of the profile of the extension')
    expect(() => give('private')).toThrow('is not a tab of the profile of the extension')
    expect(() => give('gone')).toThrow('has no page')
  })

  it('is what the library is answered with when it asks for a tab: the shell opens it in the profile of the extension, and the page is the one the library is given', async () => {
    const hooks = { createTab: vi.fn(async () => 'tab-9'), selectTab: vi.fn() }
    const contents = new LibraryTab(77, 'https://a.example/', {})
    libraryContents.set(77, contents)
    const engine = Object.assign(Object.create(ElectronEngine.prototype) as object, inertEngine({ pages: new Map([['tab-9', { webContents: contents, window: new LibraryWindow(5) }]]), profileOfTab: () => 'p', requireHooks: () => hooks }))
    const made = engineMethods['ensureProfile']!.call(engine, 'p') as { extensions: { ctx: { store: { createTab(details: Record<string, unknown>): Promise<unknown> } } } }
    expect(await made.extensions.ctx.store.createTab({ url: 'https://a.example/', active: false, windowId: 5 })).toBe(contents)
    expect(hooks.createTab).toHaveBeenCalledExactlyOnceWith('https://a.example/', false, 5, 'p')
    // A page of another profile is no tab of this one: the library is refused it.
    madeSessions.clear()
    const other = Object.assign(Object.create(ElectronEngine.prototype) as object, inertEngine({ pages: new Map([['tab-9', { webContents: contents, window: new LibraryWindow(5) }]]), profileOfTab: () => 'q', requireHooks: () => hooks }))
    const madeOther = engineMethods['ensureProfile']!.call(other, 'p') as typeof made
    await expect(madeOther.extensions.ctx.store.createTab({ url: 'https://a.example/', windowId: 5 })).rejects.toThrow('is not a tab of the profile of the extension')
  })
})
