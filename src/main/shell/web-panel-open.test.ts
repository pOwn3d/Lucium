// The web panel that is open beside the page: it goes when its space is given another profile, and the name over it says which site it shows once
// it has left the one it was opened for. The real methods of the shell run on a stand-in for the window (browser-fake.test-support.ts).

import { describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { PageEvents } from '../engine/types'
import { t } from '@shared/i18n'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import { CERTIFICATE_NOTICE_MS, clientCertificateNotice } from './certificates'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

function windowWithPanel() {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }
  const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
  let state = createInitialState(ctx)
  state = run(state, { type: 'settings/update', patch: { webPanels: true } }, { type: 'space/panel-add', id: state.spaces[0]!.id, panelId: 'wa', url: 'https://web.whatsapp.com/', title: 'WhatsApp' })
  const space = state.spaces[0]!
  let events: PageEvents | undefined
  const page = { loadURL: () => undefined, destroy: vi.fn() }
  const fake = fakeBrowser({
    store: { get: () => state },
    isPrivate: () => false,
    isTabLocked: () => false,
    webPanel: null,
    sidePanel: null,
    webPanelCounter: 0,
    options: { windowId: 1 },
    pageId: (id: string) => id,
    engine: {
      createPage: (_options: unknown, given: PageEvents) => {
        events = given
        return page
      }
    },
    ...Object.fromEntries(['openWebPanel', 'closeWebPanel', 'destroyWebPanel', 'reconcileWebPanel', 'webPanelOfSnapshot'].map((name) => [name, shell[name]]))
  })
  shell['openWebPanel']!.call(fake.self, 'wa')
  const heading = (): string | undefined => (shell['webPanelOfSnapshot']!.call(fake.self) as { webPanel?: { title: string } }).webPanel?.title
  const published = (): number => fake.names().filter((name) => name === 'publish').length
  return { fake, space, page, events: events!, heading, published, set: (next: SidebarState) => (state = next), state: () => state, reconcile: () => shell['reconcileWebPanel']!.call(fake.self) }
}

describe('the web panel open beside the page', () => {
  it('stays while its space, its profile and its place in the list are what they were', () => {
    const w = windowWithPanel()
    w.reconcile()
    expect(w.fake.self['webPanel']).not.toBeNull()
    expect(w.page.destroy).not.toHaveBeenCalled()
  })

  it('goes when its space is given another profile: its page holds the session of the profile before', () => {
    const w = windowWithPanel()
    w.set({ ...w.state(), spaces: w.state().spaces.map((space) => (space.id === w.space.id ? { ...space, profileId: 'travail' } : space)) })
    w.reconcile()
    expect(w.fake.self['webPanel']).toBeNull()
    expect(w.page.destroy).toHaveBeenCalledTimes(1)
  })

  it('is named by its title alone while it shows its own site, and with the site it shows once it went elsewhere', () => {
    const w = windowWithPanel()
    expect(w.heading()).toBe('WhatsApp')
    w.events.update({ url: 'https://web.whatsapp.com/send' })
    expect(w.heading()).toBe('WhatsApp')
    const before = w.published()
    w.events.update({ url: 'https://connexion.ailleurs.example/login' })
    expect(w.heading()).toBe('WhatsApp · connexion.ailleurs.example')
    // The interface is told when the address changes, and only then.
    expect(w.published()).toBe(before + 1)
    w.events.update({ title: 'Nouveau titre' })
    w.events.update({ url: 'https://connexion.ailleurs.example/login' })
    expect(w.published()).toBe(before + 1)
  })

  it('a page that is no longer the panel changes nothing', () => {
    const w = windowWithPanel()
    shell['closeWebPanel']!.call(w.fake.self)
    w.events.update({ url: 'https://ailleurs.example/' })
    expect(w.heading()).toBeUndefined()
  })
})

describe('« Ajouter la page en volet web » from a private tab', () => {
  const ctx = { now: 1, newId: (() => { let n = 0; return () => `p${++n}` })() }
  const add = (privateTab: boolean) => {
    let state = reduce(createInitialState(ctx), { type: 'settings/update', patch: { webPanels: true, privateTabs: true } }, ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://clinic.example/results', ...(privateTab ? { private: true } : {}) }, ctx)
    const dispatched: Action[] = []
    const toasts: string[] = []
    const fake = fakeBrowser({ store: { get: () => state }, isPrivate: () => false, isTabLocked: () => false, dispatch: (action: Action) => void dispatched.push(action), showToast: (text: string) => void toasts.push(text) })
    shell['addWebPanelFromPage']!.call(fake.self)
    return { dispatched, toasts }
  }

  it('adds nothing and says why: the panels are saved with the space', () => {
    const { dispatched, toasts } = add(true)
    expect(dispatched).toEqual([])
    expect(toasts).toEqual([t('browser.la-page-d-un-onglet-prive-ne-devient-pas-un-volet')])
  })

  it('adds the page of an ordinary tab', () => {
    const { dispatched } = add(false)
    expect(dispatched.map((action) => action.type)).toEqual(['space/panel-add'])
  })
})

// A server asked the page of the panel for a client certificate and got none (certificates.ts): the window says so, with the site.
describe('a client certificate asked of the page of a web panel', () => {
  it('is said in a notice of the window that names the site, and stays long enough to be read', () => {
    const w = windowWithPanel()
    w.events.clientCertificateRefused!('intranet.example:8443')
    const notices = w.fake.calls.filter((call) => call.name === 'showToast')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.args).toEqual([clientCertificateNotice('intranet.example:8443'), undefined, CERTIFICATE_NOTICE_MS])
    expect(String(notices[0]!.args[0])).toContain('intranet.example:8443')
  })
})
