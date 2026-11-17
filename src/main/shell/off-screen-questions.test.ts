// The questions of a tab that is not on screen (a permission, a login a server asks for, a box of prompt()) wait for their tab: they are never put
// over the tab the user is on, and the tab that asks is never brought forward by its own call. The real methods of the shell run on a stand-in for
// the window (browser-fake.test-support.ts).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { OverlayRequest } from '@shared/ipc'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const REAL = ['whenOnScreen', 'waitsOffScreen', 'showWaitingQuestions', 'parkOffScreenQuestions', 'putPermission', 'putAuth', 'putDialog', 'askPermission', 'askAuth', 'authenticate', 'askPrompt', 'showDialog', 'answerPermission', 'answerAuth', 'answerDialog', 'cancelPermissionsOf', 'cancelDialogsOf', 'cancelAuthOf'] as const
const challenge = { url: 'https://intranet.example/', host: 'intranet.example', port: 443, realm: 'Session expirée, mabanque.fr', isProxy: false, scheme: 'basic' }
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A window with two tabs: the bank on screen, and a tab behind it on another site. */
function twoTabs() {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }
  const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
  const state = run(createInitialState(ctx), { type: 'tab/open', url: 'https://autre.example/page', background: true }, { type: 'tab/open', url: 'https://mabanque.example/compte' })
  const behind = state.tabs.find((tab) => tab.url.includes('autre.example'))!.id
  const front = state.tabs.find((tab) => tab.url.includes('mabanque.example'))!.id
  let visible = [front]
  const opened: OverlayRequest[] = []
  const toasts: Array<{ message: string; action?: { label: string; run: () => void } }> = []
  const dispatched: Action[] = []
  const fake = fakeBrowser({
    store: { get: () => state },
    visibleIds: () => visible,
    ownerOf: () => undefined,
    overlayRequest: null,
    offScreenQuestions: new Map(),
    permissionQueue: [],
    permissionAnswers: new Map(),
    permissionPages: new Map(),
    permissionCounter: 0,
    authQueue: [],
    authAnswers: new Map(),
    authPages: new Map(),
    authCounter: 0,
    dialogQueue: [],
    dialogAnswers: new Map(),
    dialogCounter: 0,
    openOverlay(request: OverlayRequest) {
      opened.push(request)
      fake.self['overlayRequest'] = request
    },
    closeOverlay() {
      fake.self['overlayRequest'] = null
    },
    showToast: (message: string, action?: { label: string; run: () => void }) => void toasts.push({ message, ...(action ? { action } : {}) }),
    dispatch: (action: Action) => void dispatched.push(action),
    ...Object.fromEntries(REAL.map((name) => [name, shell[name]]))
  })
  /** The user goes to a tab: the window lays itself out again. */
  const show = async (id: string): Promise<void> => {
    visible = [id]
    shell['showWaitingQuestions']!.call(fake.self)
    await settle()
  }
  const call = <T>(name: string, ...args: unknown[]): T => shell[name]!.call(fake.self, ...args) as T
  return { fake, behind, front, opened, toasts, dispatched, show, call }
}

describe('a permission a tab asks for', () => {
  it('is asked at once when the tab is on screen', () => {
    const w = twoTabs()
    void w.call<Promise<boolean>>('askPermission', 'https://mabanque.example', 'geolocation', w.front)
    expect(w.opened.map((request) => request.panel)).toEqual(['permission'])
    expect(w.toasts).toEqual([])
  })

  it('waits for its tab when it is behind another one: nothing opens over the tab on screen, and a notice names the site that waits', async () => {
    const w = twoTabs()
    const answer = w.call<Promise<boolean>>('askPermission', 'https://autre.example', 'media', w.behind)
    expect(w.opened).toEqual([])
    expect(w.toasts.map((toast) => toast.message)).toEqual(['autre.example attend une réponse dans son onglet'])
    // The button of the notice goes to the tab: the user's own gesture, never the page's.
    expect(w.dispatched).toEqual([])
    w.toasts[0]!.action!.run()
    expect(w.dispatched).toEqual([{ type: 'tab/select', id: w.behind }])
    await w.show(w.behind)
    expect(w.opened.map((request) => request.panel)).toEqual(['permission'])
    w.call('answerPermission', (w.opened[0] as { request: { id: string } }).request.id, true, false)
    expect(await answer).toBe(true)
  })

  it('goes on waiting while the window lays itself out with the tab still behind', async () => {
    const w = twoTabs()
    void w.call('askPermission', 'https://autre.example', 'media', w.behind)
    await w.show(w.front)
    await w.show(w.front)
    expect(w.opened).toEqual([])
    await w.show(w.behind)
    expect(w.opened).toHaveLength(1)
  })

  it('says once that a tab waits, however many questions it has', () => {
    const w = twoTabs()
    void w.call('askPermission', 'https://autre.example', 'media', w.behind)
    void w.call('askPermission', 'https://autre.example', 'geolocation', w.behind)
    expect(w.toasts).toHaveLength(1)
  })

  it('is not asked when its page went while it waited', async () => {
    const w = twoTabs()
    const answer = w.call<Promise<boolean>>('askPermission', 'https://autre.example', 'media', w.behind)
    w.call('cancelPermissionsOf', w.behind)
    expect(await answer).toBe(false)
    await w.show(w.behind)
    expect(w.opened).toEqual([])
  })

  it('is asked at once for a page that is not a tab (a preview, a side panel): it has no tab to wait for', () => {
    const w = twoTabs()
    void w.call('askPermission', 'https://apercu.example', 'media', 'peek-1')
    void w.call('askPermission', 'https://sans-page.example', 'media', undefined)
    expect(w.opened.map((request) => request.panel)).toEqual(['permission'])
    // The second one is in line behind the first, not parked.
    expect((w.fake.self['permissionQueue'] as unknown[]).length).toBe(1)
  })

  it('goes back to wait when its tab left the screen while it was in line behind a panel', async () => {
    const w = twoTabs()
    w.fake.self['overlayRequest'] = { panel: 'commandbar' }
    void w.call('askPermission', 'https://mabanque.example', 'geolocation', w.front)
    expect((w.fake.self['permissionQueue'] as unknown[]).length).toBe(1)
    // The user goes to the other tab, then the panel closes: the question in line is not for the tab on screen any more.
    await w.show(w.behind)
    w.call('parkOffScreenQuestions')
    expect(w.fake.self['permissionQueue']).toEqual([])
    expect([...(w.fake.self['offScreenQuestions'] as Map<string, unknown>).keys()]).toEqual([w.front])
    w.fake.self['overlayRequest'] = null
    await w.show(w.front)
    expect(w.opened.map((request) => request.panel)).toEqual(['permission'])
  })
})

describe('a login a server asks a tab for', () => {
  it('waits for its tab when it is behind another one, whatever its realm says', async () => {
    const w = twoTabs()
    const answer = w.call<Promise<unknown>>('authenticate', w.behind, challenge)
    await settle()
    expect(w.opened).toEqual([])
    expect(w.toasts).toHaveLength(1)
    await w.show(w.behind)
    expect(w.opened.map((request) => request.panel)).toEqual(['auth'])
    w.call('answerAuth', (w.opened[0] as { request: { id: string } }).request.id, null)
    expect(await answer).toBeNull()
  })

  it('is asked at once when the tab is on screen', async () => {
    const w = twoTabs()
    void w.call('authenticate', w.front, challenge)
    await settle()
    expect(w.opened.map((request) => request.panel)).toEqual(['auth'])
  })

  it('is not put in line behind a panel when its page went while it waited', async () => {
    const w = twoTabs()
    const answer = w.call<Promise<unknown>>('authenticate', w.behind, challenge)
    await settle()
    w.call('cancelAuthOf', w.behind)
    expect(await answer).toBeNull()
    w.fake.self['overlayRequest'] = { panel: 'commandbar' }
    await w.show(w.behind)
    expect(w.fake.self['authQueue']).toEqual([])
  })

  it('goes back to wait, like a box of prompt(), when its tab left the screen while it was in line behind a panel', async () => {
    const w = twoTabs()
    w.fake.self['overlayRequest'] = { panel: 'commandbar' }
    void w.call('authenticate', w.front, challenge)
    await settle()
    void w.call('askPrompt', w.front, { origin: 'https://mabanque.example', message: '?', value: '' }, new AbortController().signal)
    expect((w.fake.self['authQueue'] as unknown[]).length).toBe(1)
    expect((w.fake.self['dialogQueue'] as unknown[]).length).toBe(1)
    await w.show(w.behind)
    w.call('parkOffScreenQuestions')
    expect(w.fake.self['authQueue']).toEqual([])
    expect(w.fake.self['dialogQueue']).toEqual([])
    w.fake.self['overlayRequest'] = null
    await w.show(w.front)
    // The login is shown; the box is in line behind it.
    expect(w.opened.map((request) => request.panel)).toEqual(['auth'])
    expect((w.fake.self['dialogQueue'] as unknown[]).length).toBe(1)
  })
})

describe('a box of prompt() a tab opens', () => {
  it('waits for its tab when it is behind another one: the tab is not selected by its own call, and nothing takes the keyboard', async () => {
    const w = twoTabs()
    const answer = w.call<Promise<unknown>>('askPrompt', w.behind, { origin: 'https://autre.example', message: 'Mot de passe ?', value: '' }, new AbortController().signal)
    expect(w.opened).toEqual([])
    expect(w.dispatched).toEqual([])
    expect(w.toasts).toHaveLength(1)
    await w.show(w.behind)
    expect(w.opened.map((request) => request.panel)).toEqual(['dialog'])
    w.call('answerDialog', (w.opened[0] as { request: { id: string } }).request.id, { value: 'ok' })
    expect(await answer).toEqual({ value: 'ok' })
  })

  it('waits again when its tab left the screen before its turn came', async () => {
    const w = twoTabs()
    w.fake.self['overlayRequest'] = { panel: 'commandbar' }
    void w.call('askPrompt', w.front, { origin: 'https://mabanque.example', message: '?', value: '' }, new AbortController().signal)
    const [queued] = w.fake.self['dialogQueue'] as unknown[]
    await w.show(w.behind)
    w.fake.self['overlayRequest'] = null
    ;(w.fake.self['dialogQueue'] as unknown[]).length = 0
    w.call('showDialog', queued)
    expect(w.opened).toEqual([])
    expect(w.dispatched).toEqual([])
    await w.show(w.front)
    expect(w.opened.map((request) => request.panel)).toEqual(['dialog'])
  })

  it('waits for its tab at once, and is not put in line, when a panel is open over the tab on screen', () => {
    const w = twoTabs()
    w.fake.self['overlayRequest'] = { panel: 'commandbar' }
    void w.call('askPrompt', w.behind, { origin: 'https://autre.example', message: '?', value: '' }, new AbortController().signal)
    expect(w.fake.self['dialogQueue']).toEqual([])
    expect(w.toasts).toHaveLength(1)
  })

  it('is not put in line behind a panel when the page gave up while it waited', async () => {
    const w = twoTabs()
    const gone = new AbortController()
    const answer = w.call<Promise<unknown>>('askPrompt', w.behind, { origin: 'https://autre.example', message: '?', value: '' }, gone.signal)
    gone.abort()
    await answer
    w.fake.self['overlayRequest'] = { panel: 'commandbar' }
    await w.show(w.behind)
    expect(w.fake.self['dialogQueue']).toEqual([])
  })

  it('is not shown when the page gave up while it waited', async () => {
    const w = twoTabs()
    const gone = new AbortController()
    const answer = w.call<Promise<unknown>>('askPrompt', w.behind, { origin: 'https://autre.example', message: '?', value: '' }, gone.signal)
    gone.abort()
    await answer
    await w.show(w.behind)
    expect(w.opened).toEqual([])
  })
})

describe('a box of alert() or confirm() a tab opens', () => {
  it('waits for its tab like the box of prompt(), and keeps its kind: the panel shows the box of that function', async () => {
    const w = twoTabs()
    const confirm = { kind: 'confirm', host: 'autre.example', message: 'Supprimer ?', defaultValue: '', offerSuppress: false }
    const answer = w.call<Promise<unknown>>('askPrompt', w.behind, confirm, new AbortController().signal)
    expect(w.opened).toEqual([])
    expect(w.dispatched).toEqual([])
    expect(w.toasts).toHaveLength(1)
    await w.show(w.behind)
    expect(w.opened).toEqual([{ panel: 'dialog', request: { id: expect.any(String), ...confirm } }])
    w.call('answerDialog', (w.opened[0] as { request: { id: string } }).request.id, { value: '', suppress: false })
    expect(await answer).toEqual({ value: '', suppress: false })
  })

  it('is cancelled, never shown, when the page gave up while it waited for its tab', async () => {
    const w = twoTabs()
    const gone = new AbortController()
    const answer = w.call<Promise<unknown>>('askPrompt', w.behind, { kind: 'alert', host: 'autre.example', message: '!', defaultValue: '', offerSuppress: false }, gone.signal)
    gone.abort()
    expect(await answer).toEqual({ value: null, suppress: false })
    await w.show(w.behind)
    expect(w.opened).toEqual([])
  })
})

// Only a real window lays itself out; the call is read in the source, as for the rest of the wiring of the layout.
describe('the layout of the window', () => {
  it('puts the questions that waited once the tabs on screen are known', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'browser-layout.ts'), 'utf8')
    const sync = source.slice(source.indexOf('this.shownTabId = active?.id ?? null'))
    expect(sync.slice(0, 400)).toContain('this.showWaitingQuestions()')
  })
})

describe('the questions in line when a panel closes', () => {
  /** A window whose command bar closes with a box of prompt() of the tab on screen and a passphrase in line behind it. */
  it('keep the passphrase in line while a box goes first: it is asked after it, not lost', async () => {
    const w = twoTabs()
    const passphrase = { id: 'pass-1', title: 'Phrase', message: 'Laquelle ?' }
    const dialog = { id: 'dialog-9', kind: 'prompt', origin: 'https://mabanque.example', message: '?', value: '' }
    ;(w.fake.self['dialogAnswers'] as Map<string, unknown>).set('dialog-9', { pageId: w.front, resolve: () => undefined })
    Object.assign(w.fake.self, { overlayRequest: { panel: 'commandbar' }, dialogQueue: [dialog], reviewQueue: [], passphraseQueue: [passphrase], zapping: null, pendingSplit: null, openArcGuideAfterImport: () => false })
    delete w.fake.self['closeOverlay']
    shell['closeOverlay']!.call(w.fake.self)
    await settle()
    expect(w.opened.map((request) => request.panel)).toEqual(['dialog'])
    expect(w.fake.self['passphraseQueue']).toEqual([passphrase])
  })
})
