// What counts as a visit when a page stops loading (a frame inside the page that loads is not one), and where the engine and the browser apply it.
// The tracker is pure; the page of the engine is run over a fake web contents (electron-page.test-support.ts), and so is the history the shell
// picks for a tab (`Browser.historyOf`, called on a stand-in: the class reaches Electron only when a method runs).

import { describe, expect, it, vi } from 'vitest'
import { VisitTracker } from './visit-tracker'
import { fakeBrowser } from '../shell/browser-fake.test-support'
import { makePage } from './electron-page.test-support'
import { defaultSettings, type TabItem } from '@shared/model'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))

const { Browser } = await import('../shell/browser')
const shellMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

describe('VisitTracker', () => {
  it('counts a load that ended after the page navigated', () => {
    const visits = new VisitTracker()
    visits.loadStarted()
    visits.navigationCommitted()
    expect(visits.loadStopped()).toBe(true)
  })

  it('counts a route of a single-page site (the main frame navigated inside its document)', () => {
    const visits = new VisitTracker()
    visits.loadStarted()
    visits.navigationCommitted()
    visits.loadStopped()
    visits.loadStarted()
    visits.navigationCommitted()
    expect(visits.loadStopped()).toBe(true)
  })

  it('does not count a frame that loads inside a page already there: an advertisement that refreshes would visit the page again and again', () => {
    const visits = new VisitTracker()
    visits.loadStarted()
    visits.navigationCommitted()
    expect(visits.loadStopped()).toBe(true)
    for (let refresh = 0; refresh < 5; refresh++) {
      visits.loadStarted()
      expect(visits.loadStopped()).toBe(false)
    }
  })

  it('does not count a load that never committed (a download, an aborted navigation)', () => {
    const visits = new VisitTracker()
    visits.loadStarted()
    expect(visits.loadStopped()).toBe(false)
  })
})

describe('where the rule is applied', () => {
  /** What the page told the shell when its loading stopped, for each stop. */
  const visitsOf = (update: { mock: { calls: unknown[][] } }): unknown[] =>
    update.mock.calls.map(([patch]) => patch as { loading?: boolean; visit?: boolean }).filter((patch) => patch.loading === false).map((patch) => patch.visit)

  it('the engine feeds the tracker with the navigations of the main frame and reports `visit` when the loading stops', async () => {
    const { wc, events } = await makePage()
    // A document of the page.
    wc.emit('did-start-loading')
    wc.emit('did-navigate', {}, 'https://site.example/a')
    wc.emit('did-stop-loading')
    // A frame inside it that loads (an advertisement that refreshes).
    wc.emit('did-start-loading')
    wc.emit('did-navigate-in-page', {}, 'https://ads.example/frame', false)
    wc.emit('did-stop-loading')
    // A route of a single-page site: the main frame navigates inside its document.
    wc.emit('did-start-loading')
    wc.emit('did-navigate-in-page', {}, 'https://site.example/b', true)
    wc.emit('did-stop-loading')
    expect(visitsOf(events.update)).toEqual([true, false, true])
  })

  const TAB: TabItem = { id: 't1', spaceId: 's', url: 'https://site.example/a', title: 'Site', pinned: false, createdAt: 1, lastActiveAt: 1 }

  /** `Browser.handlePageUpdate` on a stand-in of the window, with a page that shows its document or one of our error pages. */
  function updatedWith(patch: Record<string, unknown>, showsError = false) {
    const record = vi.fn()
    const retitle = vi.fn()
    const fake = fakeBrowser({
      store: { get: () => ({ tabs: [TAB], settings: defaultSettings() }), dispatch: vi.fn() },
      runtime: { tabs: {}, canGoBack: false, canGoForward: false },
      pages: new Map([[TAB.id, { showsError: () => showsError }]]),
      committed: new Set(),
      visible: new Set(),
      colorUnread: new Set(),
      frozen: new Set(),
      historyOf: () => ({ record, retitle })
    })
    shellMethods['handlePageUpdate']!.call(fake.self, TAB.id, patch)
    return { record, retitle }
  }

  it('the browser records a visit only for a load that came to a page that is not one of our error pages', () => {
    expect(updatedWith({ loading: false, visit: true }).record).toHaveBeenCalledExactlyOnceWith(TAB.url, TAB.title)
    // A frame that loaded inside the page is no visit; neither is one of our error pages (the site does not answer); a patch that says nothing of a visit counts.
    expect(updatedWith({ loading: false, visit: false }).record).not.toHaveBeenCalled()
    expect(updatedWith({ loading: false, visit: true }, true).record).not.toHaveBeenCalled()
    expect(updatedWith({ loading: false }).record).toHaveBeenCalledTimes(1)
  })

  it('the browser keeps the history title up to date with the title of the page, never from an error page', () => {
    expect(updatedWith({ title: 'Nouveau', loading: true }).retitle).toHaveBeenCalledExactlyOnceWith(TAB.url, TAB.title)
    expect(updatedWith({ title: 'Nouveau', loading: true }, true).retitle).not.toHaveBeenCalled()
    // A page that has finished loading is not retitled by its last title: the load that ended is a visit.
    expect(updatedWith({ title: 'Nouveau', loading: false }).retitle).not.toHaveBeenCalled()
  })

  it('a private tab and a tab in a container have no history at all', () => {
    const of = vi.fn((_profile: string, _space: string) => 'the history of the profile')
    const shell = {
      history: { of },
      store: { get: () => ({ spaces: [{ id: 's', profileId: 'p' }], profiles: [] }) },
      containerKeyOf: (tab: { container?: string }) => (tab.container ? `container:${tab.container}` : '')
    }
    const historyOf = (tab: object): unknown => shellMethods['historyOf']!.call(shell, { id: 't', spaceId: 's', url: 'https://a.example/', title: 'A', ...tab })
    expect(historyOf({ private: true })).toBeNull()
    expect(historyOf({ container: 'travail' })).toBeNull()
    expect(of).not.toHaveBeenCalled()
    expect(historyOf({})).toBe('the history of the profile')
    expect(of).toHaveBeenCalledWith('p', 's')
  })
})
