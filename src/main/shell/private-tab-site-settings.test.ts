// The per-site settings that are saved with the state (mouse gestures left out, windows always allowed, exceptions of the blocker) never take the
// site of a private tab. The real methods of the shell run on a stand-in for the window (browser-fake.test-support.ts).

import { describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { PageEvents } from '../engine/types'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const SITE = 'https://prive.example.org/page'

function windowOn(privateTab: boolean) {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }
  const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
  let state = run(createInitialState(ctx), { type: 'settings/update', patch: { privateTabs: true, mouseGestures: true } }, { type: 'tab/open', url: SITE, ...(privateTab ? { private: true } : {}) })
  const tab = state.tabs.find((t) => t.url === SITE)!
  const toasts: Array<{ message: string; action?: { label: string; second?: { label: string; run: () => void } } }> = []
  const fake = fakeBrowser({
    store: { get: () => state },
    dispatch: (action: Action) => void (state = reduce(state, action, ctx)),
    isPrivate: () => false,
    visible: new Set([tab.id]),
    showToast: (message: string, action?: { label: string; second?: { label: string; run: () => void } }) => void toasts.push({ message, ...(action ? { action } : {}) }),
    toggleGestureSite: shell['toggleGestureSite'],
    openTabFromPage: () => undefined
  })
  return { fake, tab, toasts, settings: () => state.settings }
}

describe('the mouse gestures of a site', () => {
  it('are not offered in the menu of a private tab, and its site is never written in the list', () => {
    const w = windowOn(true)
    expect('gestures' in (shell['menuOptionsFor']!.call(w.fake.self, w.tab.id) as object)).toBe(false)
    shell['toggleGestureSite']!.call(w.fake.self, w.tab.id)
    expect(w.settings().mouseGestureExcludedHosts).toEqual([])
    expect(w.toasts).toEqual([])
  })

  it('are offered and written for an ordinary tab', () => {
    const w = windowOn(false)
    expect((shell['menuOptionsFor']!.call(w.fake.self, w.tab.id) as { gestures?: string }).gestures).toBe('on')
    shell['toggleGestureSite']!.call(w.fake.self, w.tab.id)
    expect(w.settings().mouseGestureExcludedHosts).toEqual(['prive.example.org'])
  })
})

describe('the exception of the blocker for a site', () => {
  it('is not written for a site a private tab is on, and a notice says why nothing changed', () => {
    const w = windowOn(true)
    shell['toggleBlockException']!.call(w.fake.self, SITE)
    expect(w.settings().blockExceptions ?? []).toEqual([])
    expect(w.toasts.map((toast) => toast.message)).toEqual(['Ce réglage par site n’est pas enregistré pour un onglet privé'])
  })

  it('is written for an ordinary tab', () => {
    const w = windowOn(false)
    shell['toggleBlockException']!.call(w.fake.self, SITE)
    expect(w.settings().blockExceptions).toEqual(['prive.example.org'])
    expect(w.toasts).toEqual([])
  })
})

describe('the notice of a window a page opened without a click', () => {
  const blocked = (privateTab: boolean) => {
    const w = windowOn(privateTab)
    const events = shell['pageEvents']!.call(w.fake.self, w.tab) as PageEvents & { popupBlocked: (site: string, url: string) => void }
    events.popupBlocked('prive.example.org', 'https://pub.example/fenetre')
    return w
  }

  it('offers « Toujours autoriser sur ce site » for an ordinary tab, which writes the site', () => {
    const w = blocked(false)
    expect(w.toasts[0]?.action?.second?.label).toBe('Toujours autoriser sur ce site')
    w.toasts[0]!.action!.second!.run()
    expect(w.settings().popupExceptions).toEqual(['prive.example.org'])
  })

  it('offers only to open the window for a private tab: its site is not written', () => {
    const w = blocked(true)
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]?.action?.label).toBe('Ouvrir quand même')
    expect(w.toasts[0]?.action?.second).toBeUndefined()
    expect(w.settings().popupExceptions).toEqual([])
  })
})
