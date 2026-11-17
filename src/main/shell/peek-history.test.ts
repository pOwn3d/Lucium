// Glance: the pages of a preview join the history like a tab's, and « Vue scindée » says when the split view is full. The real methods of the
// shell run on a stand-in for the window (browser-fake.test-support.ts), with an engine that gives the preview a page and keeps its events.

import { describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { createInitialState, reduce, splitIsFull, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import type { PageEvents } from '../engine/types'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The shell reaches Electron only when a method runs.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** A window whose tab on screen is on `https://a.test/`, in a space of the profile `travail`. */
function stateWith(...actions: Action[]): SidebarState {
  const base = run(createInitialState(ctx), { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'travail' })
  return run(base, { type: 'tab/open', url: 'https://a.test/' }, ...actions)
}

describe('the history of the pages of a preview (Glance)', () => {
  function previewing(state: SidebarState, own: Record<string, unknown> = {}) {
    const visits: Array<{ kind: 'record' | 'retitle'; profileId: string; spaceId: string | undefined; url: string; title: string }> = []
    const history = {
      of: (profileId: string, spaceId?: string) => ({
        record: (url: string, title: string) => void visits.push({ kind: 'record', profileId, spaceId, url, title }),
        retitle: (url: string, title: string) => (visits.push({ kind: 'retitle', profileId, spaceId, url, title }), true)
      })
    }
    let events: PageEvents | null = null
    let error = false
    const page = { id: 'peek-1', loadURL: () => {}, destroy: () => {}, showsError: () => error }
    const given = { createPage: (_options: unknown, handlers: PageEvents) => ((events = handlers), page) }
    const fake = fakeBrowser({
      blockerCss: { fresh: () => {}, apply: () => {}, forget: () => {} },
      history,
      peek: null,
      peekCounter: 0,
      options: {},
      store: { get: () => state },
      pageId: (id: string) => id,
      containerKeyOf: () => '',
      isPrivate: () => false,
      engine: given,
      privateContext: () => given,
      containerContext: () => given,
      ...own
    })
    shell['openPeek']!.call(fake.self, 'https://news.test/x')
    return { fake, visits, events: () => events!, showError: (on: boolean) => void (error = on) }
  }

  const recorded = (visits: ReturnType<typeof previewing>['visits']) => visits.filter((visit) => visit.kind === 'record')

  it('records a page once it has loaded, like a tab: in the history of the profile of the space on screen, tagged with that space', () => {
    const state = stateWith()
    const p = previewing(state)
    p.events().update({ url: 'https://news.test/x/article', title: 'Les nouvelles' })
    // Still loading: not a visit yet.
    expect(recorded(p.visits)).toEqual([])
    p.events().update({ loading: false })
    expect(recorded(p.visits)).toEqual([{ kind: 'record', profileId: 'travail', spaceId: state.activeSpaceId, url: 'https://news.test/x/article', title: 'Les nouvelles' }])
  })

  it('shows the icon the page tells, and drops it when the page tells an empty one: the icon of the page before does not stay over another site', () => {
    const p = previewing(stateWith())
    const icon = (): string | undefined => (p.fake.self as unknown as { peek: { faviconUrl?: string } }).peek.faviconUrl
    p.events().update({ url: 'https://news.test/x', faviconUrl: 'https://news.test/favicon.ico' })
    expect(icon()).toBe('https://news.test/favicon.ico')
    // A patch that says nothing of the icon keeps it.
    p.events().update({ title: 'Les nouvelles' })
    expect(icon()).toBe('https://news.test/favicon.ico')
    p.events().update({ url: 'https://autre.test/', faviconUrl: '' })
    expect(icon()).toBeUndefined()
  })

  it('records nothing for a load that came to no page: a frame that loaded in the page, a download, one of our error pages', () => {
    const p = previewing(stateWith())
    p.events().update({ url: 'https://news.test/x', title: 'Les nouvelles' })
    p.events().update({ loading: false, visit: false })
    p.showError(true)
    p.events().update({ loading: false })
    expect(recorded(p.visits)).toEqual([])
    // Nor does the title such a load brings name the page of the history.
    p.showError(false)
    const before = p.visits.length
    p.events().update({ title: 'Cadre', loading: false, visit: false })
    expect(p.visits).toHaveLength(before)
  })

  it('gives the page the title it ended with, once it has loaded, and not the title of an error page', () => {
    const p = previewing(stateWith())
    p.events().update({ url: 'https://news.test/x', title: 'Les nouvelles' })
    p.events().update({ loading: false })
    p.events().update({ title: 'Les nouvelles (3)' })
    expect(p.visits.at(-1)).toMatchObject({ kind: 'retitle', url: 'https://news.test/x', title: 'Les nouvelles (3)' })
    p.showError(true)
    const before = p.visits.length
    p.events().update({ title: 'Erreur' })
    expect(p.visits).toHaveLength(before)
  })

  it('leaves the preview of a link of a private tab, and of a tab in a container, out of the history of the profile', () => {
    const privateTab = previewing(stateWith({ type: 'tab/open', url: 'https://secret.test/', private: true }))
    privateTab.events().update({ url: 'https://news.test/x', title: 'Les nouvelles' })
    privateTab.events().update({ loading: false })
    expect(privateTab.visits).toEqual([])
    const container = previewing(stateWith(), { containerKeyOf: () => 'work' })
    container.events().update({ url: 'https://news.test/x', title: 'Les nouvelles' })
    container.events().update({ loading: false })
    expect(container.visits).toEqual([])
  })
})

describe('« Vue scindée » of a preview', () => {
  /** Four tabs of a space in one split view, the first on screen. */
  function fourPanes(): SidebarState {
    const opened = run(createInitialState(ctx), ...['a', 'b', 'c', 'd'].map((host): Action => ({ type: 'tab/open', url: `https://${host}.test/` })))
    const [a, b, c, d] = opened.tabs.map((tab) => tab.id)
    return run(opened, { type: 'split/create', tabId: a!, withTabId: b! }, { type: 'split/create', tabId: a!, withTabId: c! }, { type: 'split/create', tabId: a!, withTabId: d! }, { type: 'tab/select', id: a! })
  }

  const toasts = (state: SidebarState): string[] => {
    const fake = fakeBrowser({ peek: { page: {}, url: 'https://news.test/x' }, store: { get: () => state } })
    shell['peekAction']!.call(fake.self, 'open-in-split')
    return fake.calls.filter((call) => call.name === 'showToast').map((call) => String(call.args[0]))
  }

  it('says that the split view has its four panes when the page cannot join it', () => {
    const state = fourPanes()
    expect(splitIsFull(state)).toBe(true)
    expect(toasts(state)).toEqual([t('peek.vue-scindee-pleine-la-page-est-ouverte-dans-un-onglet')])
  })

  it('says nothing when the split view takes the page, or when there is none', () => {
    const state = fourPanes()
    const three = run(state, { type: 'split/remove', tabId: state.tabs[3]!.id })
    expect(splitIsFull(three)).toBe(false)
    expect(toasts(three)).toEqual([])
    expect(toasts(run(createInitialState(ctx), { type: 'tab/open', url: 'https://a.test/' }))).toEqual([])
  })
})
