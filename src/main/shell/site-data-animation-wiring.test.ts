// What Browser hands to the animation of « Effacer les données du site »: the choice of the setting (the sheet's run and the shortcut's alike), none of it
// while motion is reduced, the sheet stepping aside only when it stays open, and coming back only if it is still the one that left. The order of the steps
// is shell/site-data.test.ts; here the class runs on a stand-in (browser-fake.test-support.ts) and the real clock is wound by hand.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import type { SiteDataBatchRequest } from '@shared/site-data'
import { clearingOverlayScript, SITE_DATA_ANIMATIONS, type DrawnAnimation } from '@shared/site-data-overlay'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'
import type { SiteDataEnvironment } from './site-data'

// The system's « Réduire les animations », told by the test.
const system = vi.hoisted(() => ({ reduced: false }))
vi.mock('./motion', () => ({ prefersReducedMotion: () => system.reduced }))
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

beforeEach(() => {
  vi.useFakeTimers()
  system.reduced = false
})
afterEach(() => vi.useRealTimers())

const request = (over: Partial<SiteDataBatchRequest> = {}): SiteDataBatchRequest => ({ hosts: ['a.example'], types: ['cookies'], subdomains: false, http: true, reload: false, detached: false, ...over })

/** A window whose tab can be drawn on, with these settings: what it drew, whether the sheet stepped aside, and the run itself. */
function window(settings: Partial<Settings> = {}) {
  const drawn: string[] = []
  const aside: string[] = []
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), ...settings } }
  const env: SiteDataEnvironment = {
    clear: async (r) => r.types.map((type) => ({ type, ok: true })),
    history: { removeSite: () => 0, hosts: () => [] },
    closedPages: { removeSite: () => undefined },
    tabs: [],
    active: null
  }
  const fake = fakeBrowser({
    store: { get: () => state },
    siteDataEnvironment: () => env,
    animatedPage: () => ({ runClearOverlay: async (code: string) => (drawn.push(code), true) }),
    stepSheetAside: () => (aside.push('aside'), () => void aside.push('back'))
  })
  const run = async (asked: SiteDataBatchRequest) => {
    const done = (shell['clearSitesFor'] as (this: unknown, r: SiteDataBatchRequest, tabId?: string) => Promise<unknown>).call(fake.self, asked)
    await vi.advanceTimersByTimeAsync(10_000)
    return done
  }
  return { run, drawn, aside, fake }
}

describe('the animation of a run', () => {
  it('is the one the setting chose, for every choice, whichever way the run was started (the sheet, the shortcut and the menus all end here)', async () => {
    for (const animation of SITE_DATA_ANIMATIONS.filter((name) => name !== 'none')) {
      const w = window({ siteDataAnimation: animation })
      await w.run(request())
      expect(w.drawn[0], animation).toBe(clearingOverlayScript(animation as DrawnAnimation))
    }
  })

  it('is none with « Aucune »: nothing drawn, the sheet not moved', async () => {
    const w = window({ siteDataAnimation: 'none' })
    await w.run(request())
    expect(w.drawn).toEqual([])
    expect(w.aside).toEqual([])
  })

  it('is none while Lucium’s « Réduire les animations » is on, whatever was chosen', async () => {
    const w = window({ siteDataAnimation: 'fire', forceReduceMotion: true })
    await w.run(request())
    expect(w.drawn).toEqual([])
    expect(w.aside).toEqual([])
  })

  it('is none while the system’s « Réduire les animations » is on, whatever was chosen', async () => {
    system.reduced = true
    const w = window({ siteDataAnimation: 'fire' })
    await w.run(request())
    expect(w.drawn).toEqual([])
    expect(w.aside).toEqual([])
  })

  it('is drawn with the sheet stepping aside when the sheet stays open, and without when it closes at once (« Fermeture auto »)', async () => {
    const open = window({ siteDataAnimation: 'fire' })
    await open.run(request({ detached: false }))
    expect(open.drawn).toHaveLength(2)
    expect(open.aside).toEqual(['aside', 'back'])
    const closing = window({ siteDataAnimation: 'fire' })
    await closing.run(request({ detached: true }))
    expect(closing.drawn).toHaveLength(2)
    expect(closing.aside).toEqual([])
  })
})

describe('the sheet stepping aside', () => {
  const stepAside = shell['stepSheetAside'] as (this: unknown) => () => void
  const shown = (calls: ReadonlyArray<{ name: string; args: readonly unknown[] }>) => calls.filter((call) => call.name.startsWith('overlay.')).map((call) => `${call.name.replace('overlay.', '')}${call.args.length > 0 ? `(${call.args.join(',')})` : ''}`)

  it('hides the layer of the sheet, and brings it back with the focus, as it was', () => {
    const sheet = { panel: 'sitedata' }
    const fake = fakeBrowser({ overlayRequest: sheet })
    const back = stepAside.call(fake.self)
    expect(shown(fake.calls)).toEqual(['setVisible(false)'])
    back()
    expect(shown(fake.calls)).toEqual(['setVisible(false)', 'setVisible(true)', 'webContents.focus'])
  })

  it('leaves any other panel alone, and no panel at all', () => {
    for (const open of [{ panel: 'history' }, { panel: 'commandbar', mode: 'new', initial: '' }, null]) {
      const fake = fakeBrowser({ overlayRequest: open })
      stepAside.call(fake.self)()
      expect(shown(fake.calls), String(open?.panel)).toEqual([])
    }
  })

  it('does not bring back what is no longer there: the sheet closed, or another panel opened, while the page animated', () => {
    const fake = fakeBrowser({ overlayRequest: { panel: 'sitedata' } })
    const back = stepAside.call(fake.self)
    fake.self['overlayRequest'] = null
    back()
    expect(shown(fake.calls)).toEqual(['setVisible(false)'])
    const replaced = fakeBrowser({ overlayRequest: { panel: 'sitedata' } })
    const backReplaced = stepAside.call(replaced.self)
    replaced.self['overlayRequest'] = { panel: 'sitedata' }
    backReplaced()
    expect(shown(replaced.calls)).toEqual(['setVisible(false)'])
  })
})
