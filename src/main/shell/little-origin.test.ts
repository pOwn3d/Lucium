// A mini window opens on the screen of the window the link comes from: every way to ask for one from a window of the browser says where that window
// is (`from`). The real methods of the class Browser on a stand-in; where the window ends up: shared/little-window.test.ts and little.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import { createInitialState, reduce } from '@shared/sidebar'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

/** A window on a second screen. */
const FROM = { x: 2000, y: 100, width: 800, height: 600 }

function windowOnASecondScreen() {
  const ctx = { now: 1, newId: () => 'tab-1' }
  const state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)
  const littleOpener = vi.fn()
  const littleBarOpener = vi.fn()
  const fake = fakeBrowser({
    store: { get: () => state },
    pages: new Map(),
    activePage: () => undefined,
    littleOpener,
    littleBarOpener,
    zapping: false,
    overlayRequest: null,
    dispatch: vi.fn(),
    isPrivate: () => false,
    windowBounds: () => FROM,
    searchTemplateFor: shell['searchTemplateFor'],
    submitUrl: shell['submitUrl'],
    pageEvents: shell['pageEvents'],
    setTabAddress: shell['setTabAddress']
  })
  return { call: (name: string, ...args: unknown[]) => shell[name]!.call(fake.self, ...args), littleOpener, littleBarOpener, spaceId: state.activeSpaceId }
}

describe('the screen a mini window is opened from', () => {
  it('is the screen of this window for a link of a tab that asks for one', () => {
    const w = windowOnASecondScreen()
    const tab = { id: 'tab-9', spaceId: 'elsewhere', url: 'https://a.example/', title: 'A', pinned: false, createdAt: 1, lastActiveAt: 1 }
    const events = w.call('pageEvents', tab, () => true) as { openWindow: (url: string, disposition: string) => void }
    events.openWindow('https://other.example/', 'little')
    expect(w.littleOpener).toHaveBeenCalledWith('https://other.example/', { spaceId: 'elsewhere', from: FROM })
  })

  it('is the screen of this window for the command bar in the mode of a mini window', () => {
    const w = windowOnASecondScreen()
    w.call('submitUrl', 'https://b.example/', 'little')
    expect(w.littleOpener).toHaveBeenCalledWith('https://b.example/', { spaceId: w.spaceId, from: FROM })
  })

  it('is the screen of this window for "Open in a mini window" of a favorite or of an error page', () => {
    const w = windowOnASecondScreen()
    w.call('openLittle', 'https://c.example/')
    expect(w.littleOpener).toHaveBeenCalledWith('https://c.example/', { from: FROM })
  })

  it('is the screen of this window for "New Mini Window": the command bar alone', () => {
    const w = windowOnASecondScreen()
    w.call('openOverlay', { panel: 'commandbar', mode: 'little' })
    expect(w.littleBarOpener).toHaveBeenCalledWith(FROM)
  })
})
