// The sleep of a tab whose page asks to confirm leaving it: the real methods of the class Browser on a stand-in, with pages whose
// `release` answers as the engine's does (electron-page.ts; its own test: engine/page-release.test.ts). Such a page is not freed: it stays awake,
// the sweep leaves it out of the cap a while, and a sleep the user asked for says why.

import { describe, expect, it, vi } from 'vitest'
import { t } from '@shared/i18n'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
import { defaultSettings } from '@shared/model'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})
vi.mock('./sleep-pressure', () => ({ memoryPressure: () => Promise.resolve('normal') }))
vi.mock('./battery-saver', () => ({ batterySaver: () => ({ active: () => false }) }))

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

/** A window with one tab behind, `draft`, whose page answers the close of a sleep with `answer`. */
function windowWith(answer: boolean | 'none', frozen = false) {
  let n = 0
  const ctx: Ctx = { now: 1, newId: () => `t${++n}` }
  let state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://docs.example/edit' }, ctx)
  state = { ...state, settings: { ...defaultSettings(), sleepMode: 'discard' } }
  const id = state.tabs[0]!.id
  const page = { release: answer === 'none' ? undefined : vi.fn(async () => answer), thaw: vi.fn(async () => undefined) }
  const pages = new Map([[id, page]])
  const destroyed: string[] = []
  const toasts: string[] = []
  const kept = new Map<string, number>()
  const own: Record<string, unknown> = {
    store: { get: () => state },
    pages,
    frozen: new Set(frozen ? [id] : []),
    autoFrozen: new Set<string>(),
    fullscreenTab: null,
    visible: new Set<string>(),
    sleepKept: kept,
    destroyPage: (tabId: string) => (destroyed.push(tabId), pages.delete(tabId)),
    showToast: (message: string) => void toasts.push(message),
    isShown: () => false,
    setAwake: () => {},
    releasePage: shell['releasePage'],
    thawPage: shell['thawPage'],
    sleepNow: shell['sleepNow'],
    sleepFacts: () => ({ awake: true, selected: false, visiblePane: false, loading: false, audible: false, downloading: false, idleMs: 3_600_000 }),
    autoReloader: null
  }
  const fake = fakeBrowser(own)
  own['leader'] = fake.self
  return { id, page, destroyed, toasts, kept, call: (name: string, ...args: unknown[]) => shell[name]!.call(fake.self, ...args) as Promise<boolean> }
}

describe('the page of a tab freed by a sleep', () => {
  it('stays awake when it asks to confirm leaving: not destroyed, and left out of the cap of the sweep a while', async () => {
    const w = windowWith(false)
    expect(await w.call('releasePage', w.id)).toBe(false)
    expect(w.destroyed).toEqual([])
    expect(w.kept.has(w.id)).toBe(true)
  })

  it('goes when it lets itself go', async () => {
    const w = windowWith(true)
    expect(await w.call('releasePage', w.id)).toBe(true)
    expect(w.destroyed).toEqual([w.id])
  })

  it('runs again first when it was frozen, so that it can be asked', async () => {
    const w = windowWith(false, true)
    expect(await w.call('releasePage', w.id)).toBe(false)
    expect(w.page.thaw).toHaveBeenCalledTimes(1)
    expect(w.page.release).toHaveBeenCalledTimes(1)
  })

  it('is destroyed as before by an engine that cannot ask', async () => {
    const w = windowWith('none')
    expect(await w.call('releasePage', w.id)).toBe(true)
    expect(w.destroyed).toEqual([w.id])
  })

  it('says why when the user put the tab to sleep and the page kept itself awake', async () => {
    const w = windowWith(false)
    expect(await w.call('sleepNow', w.id, 'discard')).toBe(false)
    expect(w.toasts).toEqual([t('sleep.site-demande-une-confirmation-reste-eveille', { site: 'docs.example' })])
  })
})
