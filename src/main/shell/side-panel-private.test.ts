import { describe, expect, it, vi } from 'vitest'
import { PRIVATE_PANEL_REFUSAL } from '@shared/sidepanel'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The side panel of an extension is never docked beside a private tab, whoever asks for it: the extension (`chrome.sidePanel.open`), a click on
// its icon, a menu. The methods of the window run on a stand-in (browser-fake.test-support.ts): no Electron, no window.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const EXTENSION = 'a'.repeat(32)

/** A window on a space of the profile "work", with an ordinary tab and a private one; `shown` is the tab on screen. */
function windowOn(shown: 'plain' | 'secret', options: { privateWindow?: boolean; docked?: string } = {}) {
  const initial = createInitialState({ now: 0, newId: () => 'x' })
  const space = { ...initial.spaces[0]!, id: 'sp', profileId: 'work' }
  const tab = (id: string, more: Record<string, unknown> = {}) => ({ ...initial.tabs[0]!, id, spaceId: 'sp', url: 'https://a.example/', ...more })
  const state = { ...initial, spaces: [space], activeSpaceId: 'sp', tabs: [tab('plain'), tab('secret', { private: true })], activeTabBySpace: { sp: shown } }
  const page = { loadURL: vi.fn(), destroy: vi.fn() }
  const createPage = vi.fn(() => page)
  const docked = options.docked === undefined ? null : { extensionId: EXTENSION, name: 'Ext', path: options.docked, page: { destroy: vi.fn() }, profileId: 'work' }
  const fake = fakeBrowser({
    store: { get: () => state },
    options: { windowId: 3 },
    sidePanel: docked,
    isPrivate: () => options.privateWindow === true,
    resolveSidePanel: () => ({ enabled: true, path: 'panel.html' }),
    profileForPanel(this: unknown, tabKey: string | undefined) {
      return shell['profileForPanel']!.call(this, tabKey)
    },
    openSidePanel(this: unknown, extensionId: string, tabKey: string | undefined) {
      return shell['openSidePanel']!.call(this, extensionId, tabKey)
    },
    engine: { createPage, listExtensions: () => [], emitShimEvent: vi.fn(), tabNumberOf: () => 12 }
  })
  return { fake, createPage, page }
}

describe('the profile a side panel opens in', () => {
  it('is the profile of the space of the tab, the tab on screen when none is named', () => {
    const { fake } = windowOn('plain')
    expect(shell['profileForPanel']!.call(fake.self, undefined)).toBe('work')
    expect(shell['profileForPanel']!.call(fake.self, 'plain')).toBe('work')
  })

  it('is none for a private tab, named or on screen, and for any tab of a private window', () => {
    expect(shell['profileForPanel']!.call(windowOn('plain').fake.self, 'secret')).toBeNull()
    expect(shell['profileForPanel']!.call(windowOn('secret').fake.self, undefined)).toBeNull()
    expect(shell['profileForPanel']!.call(windowOn('plain', { privateWindow: true }).fake.self, 'plain')).toBeNull()
  })
})

describe('docking the side panel of an extension', () => {
  it('makes the page of the panel in the profile of the tab, beside an ordinary tab', () => {
    const { fake, createPage, page } = windowOn('plain')
    shell['openSidePanel']!.call(fake.self, EXTENSION, undefined)
    expect(createPage).toHaveBeenCalledTimes(1)
    expect((createPage.mock.calls[0] as unknown[])[0]).toMatchObject({ profileId: 'work', extensionPanel: true, windowId: 3 })
    expect(page.loadURL).toHaveBeenCalledWith(`chrome-extension://${EXTENSION}/panel.html`)
    expect((fake.self['sidePanel'] as { profileId: string }).profileId).toBe('work')
  })

  it.each([
    ['the tab on screen is private', 'secret', undefined, {}],
    ['the tab it is asked for is private', 'plain', 'secret', {}],
    ['an ordinary tab is named while a private one is on screen', 'secret', 'plain', {}],
    ['the window is private', 'plain', undefined, { privateWindow: true }]
  ] as const)('is refused when %s: no page is made, nothing is told to the extension, nothing is docked', (_what, shown, asked, options) => {
    const { fake, createPage } = windowOn(shown, options)
    expect(() => shell['openSidePanel']!.call(fake.self, EXTENSION, asked)).toThrow(PRIVATE_PANEL_REFUSAL)
    expect(createPage).not.toHaveBeenCalled()
    expect(fake.self['sidePanel']).toBeNull()
    expect(fake.names()).toEqual([])
  })

  it('leaves the panel that is docked as it is when the user goes to a private tab whose options name another page', () => {
    const { fake, createPage } = windowOn('secret', { docked: 'other.html' })
    expect(() => shell['reconcileSidePanel']!.call(fake.self)).not.toThrow()
    expect(createPage).not.toHaveBeenCalled()
    expect((fake.self['sidePanel'] as { path: string }).path).toBe('other.html')
    // On an ordinary tab the same change of page is followed.
    const plain = windowOn('plain', { docked: 'other.html' })
    shell['reconcileSidePanel']!.call(plain.fake.self)
    expect(plain.createPage).toHaveBeenCalledTimes(1)
    expect((plain.fake.self['sidePanel'] as { path: string }).path).toBe('panel.html')
  })
})
