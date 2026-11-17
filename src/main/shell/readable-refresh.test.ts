// The readable mode is live: a mode chosen for a site, or the default changed, makes the open pages be looked at again (`refreshDark`), and a change of the
// appearance of the interface does so only while the default follows it ("Automatique"). The real `dispatch` and `setSystemDark` of the shell, on a stand-in.

import { describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const ctx = { now: 1, newId: () => 'id' }

/** A window on one page of `example.org`, whose store applies the actions of the reducer; `refreshDark` and `refreshDarkHere` are what the tests watch. */
function window(settings: Partial<SidebarState['settings']> = {}) {
  let state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://example.org/' }, ctx)
  state = { ...state, settings: { ...state.settings, ...settings } }
  const refreshed = { all: 0, here: 0 }
  const fake = fakeBrowser({
    isPrivate: () => false,
    store: { get: () => state, root: () => ({ get: () => state }), dispatch: (action: Action) => void (state = reduce(state, action, ctx)) },
    closedHistoryCtx: () => ctx,
    refreshDark: () => void refreshed.all++,
    refreshDarkHere: () => void refreshed.here++,
    toolbarLine: () => '',
    systemDark: false
  })
  return { fake, refreshed, state: () => state, tabId: () => state.tabs[0]!.id }
}
const dispatch = (w: ReturnType<typeof window>, action: Action) => shell.dispatch!.call(w.fake.self, action)

describe('the pages follow the readable mode as soon as it changes', () => {
  it('looks at the pages again when a site gets a mode, changes it, or gives it back', () => {
    const w = window()
    dispatch(w, { type: 'readable/site', site: 'example.org', mode: 'dark', tabId: w.tabId() })
    expect([w.state().settings.siteReadableMode, w.refreshed.all]).toEqual([{ 'example.org': 'dark' }, 1])
    dispatch(w, { type: 'readable/site', site: 'example.org', mode: 'light', tabId: w.tabId() })
    dispatch(w, { type: 'readable/site', site: 'example.org', mode: null, tabId: w.tabId() })
    expect(w.refreshed.all).toBe(3)
  })

  it('does nothing for a choice that changes nothing, and for one a private tab asked for', () => {
    const w = window({ siteReadableMode: { 'example.org': 'dark' } })
    dispatch(w, { type: 'readable/site', site: 'example.org', mode: 'dark', tabId: w.tabId() })
    dispatch(w, { type: 'readable/site', site: 'pas un hôte', mode: 'dark' })
    expect(w.refreshed.all).toBe(0)
    const priv = window()
    dispatch(priv, { type: 'tab/open', url: 'https://secret.example/', private: true })
    dispatch(priv, { type: 'readable/site', site: 'secret.example', mode: 'dark', tabId: priv.state().tabs.at(-1)!.id })
    expect(priv.state().settings.siteReadableMode).toEqual({})
    expect(priv.refreshed.all).toBe(0)
  })

  it('looks at the pages again when the default or the sites are written through the settings, and not for any other setting', () => {
    const w = window()
    dispatch(w, { type: 'settings/update', patch: { readableMode: 'dark' } })
    dispatch(w, { type: 'settings/update', patch: { siteReadableMode: { 'example.org': 'original' } } })
    expect(w.refreshed.all).toBe(2)
    dispatch(w, { type: 'settings/update', patch: { uiScale: 110 } })
    expect(w.refreshed.all).toBe(2)
  })

  it('is refused in a private window, which follows the main window and has no choice of its own', () => {
    const w = window()
    ;(w.fake.self as Record<string, unknown>)['isPrivate'] = () => true
    dispatch(w, { type: 'readable/site', site: 'example.org', mode: 'dark', tabId: w.tabId() })
    dispatch(w, { type: 'settings/update', patch: { readableMode: 'dark' } })
    expect(w.state().settings.siteReadableMode).toEqual({})
    expect(w.state().settings.readableMode).toBe('original')
    expect(w.refreshed.all).toBe(0)
  })

  it('looks at the pages again when the main window changes the mode and a private window follows it', () => {
    const w = window()
    shell.inheritSettings!.call(w.fake.self, { ...w.state().settings, readableMode: 'dark', siteReadableMode: { 'example.org': 'light' } })
    expect([w.state().settings.readableMode, w.state().settings.siteReadableMode, w.refreshed.here]).toEqual(['dark', { 'example.org': 'light' }, 1])
    shell.inheritSettings!.call(w.fake.self, { ...w.state().settings, uiScale: 110 })
    expect(w.refreshed.here).toBe(1)
  })
})

describe('the pages follow the appearance of the interface only while the default is Automatique', () => {
  it('looks at the pages again when the appearance changes under Automatique', () => {
    const w = window({ readableMode: 'auto' })
    shell.setSystemDark!.call(w.fake.self, true)
    expect(w.refreshed.here).toBe(1)
  })

  it('does not, under any other default: Original, Sombre and Clair do not depend on the appearance', () => {
    for (const readableMode of ['original', 'dark', 'light'] as const) {
      const w = window({ readableMode })
      shell.setSystemDark!.call(w.fake.self, true)
      expect(w.refreshed.here, readableMode).toBe(0)
    }
  })
})
