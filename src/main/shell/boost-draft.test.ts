// The saves of a Tweak editor that is still open on a script (browser-site.ts, `boostsChanged`), run on a stand-in for the window: a draft is
// shown but reloads no page, and the save the editor sends as it closes makes the reloads the drafts owed.

import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Boost, type SidebarState } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { cleanBoost } from '@shared/sidebar-state'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The shell reaches Electron only when a method runs.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('../userscripts', () => ({ userScripts: () => ({ matching: () => [], recordFailure: () => undefined }) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const tweak = (over: Partial<Boost> = {}): Boost => ({ ...cleanBoost({ id: 'b1', host: 'site.example', css: 'p { color: red }', js: 'window.__tweak = 1' }, () => 'b1'), ...over })

function windowWith(boost: Boost) {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  let state: SidebarState = { ...base, tabs: [{ id: 't1', url: 'https://site.example/page', title: 'T' }] as SidebarState['tabs'], boosts: [boost], settings: { ...defaultSettings(), boostsEnabled: true } }
  const page = { applyCss: vi.fn(), setZoom: vi.fn(), runScript: vi.fn(), evaluate: vi.fn(async () => undefined), reload: vi.fn() }
  const fake: ReturnType<typeof fakeBrowser> = fakeBrowser({
    store: { get: () => state },
    pages: new Map([['t1', page]]),
    volatileZoom: new Map(),
    stoppedByDrafts: [],
    isPrivate: () => false,
    boostsFor: (tab: unknown) => shell.boostsFor!.call(fake.self, tab),
    applyBoost: (id: unknown, run: unknown) => shell.applyBoost!.call(fake.self, id, run),
    refreshBoosts: (stopped: unknown) => shell.refreshBoosts!.call(fake.self, stopped),
    refreshBoostsHere: (stopped: unknown, reload: unknown) => shell.refreshBoostsHere!.call(fake.self, stopped, reload)
  })
  fake.self['group'] = new Set([fake.self])
  /** The store takes the Tweak, then the shell is told, as `dispatch` does. */
  const save = (next: Boost, draft: boolean): void => {
    const before = state
    state = { ...state, boosts: [next] }
    shell.boostsChanged!.call(fake.self, draft ? { type: 'boost/save', boost: next, draft: true } : { type: 'boost/save', boost: next }, before)
  }
  return { page, save }
}

describe('a Tweak saved while its editor is open on a script', () => {
  it('shows the stylesheet of a draft without reloading the page, and reloads it at the save that is not a draft', () => {
    const { page, save } = windowWith(tweak())
    save(tweak({ css: 'p { color: blue }' }), true)
    expect(page.applyCss).toHaveBeenLastCalledWith(expect.stringContaining('color: blue'))
    expect(page.reload).not.toHaveBeenCalled()

    save(tweak({ css: 'p { color: blue }' }), false)
    expect(page.reload).toHaveBeenCalledOnce()
  })

  it('remembers a script a draft switched off: the page that still runs it is reloaded when the editor closes', () => {
    const { page, save } = windowWith(tweak())
    save(tweak({ jsEnabled: false }), true)
    expect(page.reload).not.toHaveBeenCalled()
    // By now the stored Tweak runs no script: only what the draft left owed asks for the reload.
    save(tweak({ jsEnabled: false }), false)
    expect(page.reload).toHaveBeenCalledOnce()
    // What was owed is paid once.
    save(tweak({ jsEnabled: false, css: '' }), false)
    expect(page.reload).toHaveBeenCalledOnce()
  })
})
