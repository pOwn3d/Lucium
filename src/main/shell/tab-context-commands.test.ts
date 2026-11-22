// Three commands that act on the context of a tab, not on the one of the window: the preview of a link (the context of the tab the link is in), the
// cache that is emptied before a reload (the one the page is served from), and the tabs reloaded after a profile is erased (in every window). The
// real methods of the shell run on a stand-in for the window (browser-fake.test-support.ts).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { activeTab, createInitialState, reduce, type Action } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

let n = 0
const ctx = { now: 1, newId: () => `id${++n}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** A window with a private tab behind the ordinary tab that is selected. */
function privateBehind() {
  const state = run(createInitialState(ctx), { type: 'settings/update', patch: { privateTabs: true } }, { type: 'tab/open', url: 'https://prive.example/', private: true }, { type: 'tab/open', url: 'https://devant.example/' })
  const behind = state.tabs.find((tab) => tab.private === true)!
  expect(activeTab(state)!.private).toBeUndefined()
  return { state, behind }
}

/** An engine (or a private context) that records the pages it is asked for and the caches it empties. */
const context = (name: string, log: string[]) => ({
  createPage: () => (log.push(`page:${name}`), { id: 'peek', loadURL: () => undefined, destroy: () => undefined, showsError: () => false }),
  clearCache: async (profileId: string) => void log.push(`cache:${name}:${profileId}`)
})

describe('the preview of a link (Glance)', () => {
  function previewing(fromTab: (w: ReturnType<typeof privateBehind>) => string | undefined) {
    const w = privateBehind()
    const log: string[] = []
    const fake = fakeBrowser({
      store: { get: () => w.state },
      peek: null,
      peekCounter: 0,
      options: {},
      pageId: (id: string) => id,
      containerKeyOf: () => '',
      isPrivate: () => false,
      history: { of: () => ({ record: () => undefined, retitle: () => true }) },
      blockerCss: { fresh: () => undefined, apply: () => undefined, forget: () => undefined },
      engine: context('profile', log),
      privateContext: () => context('private', log),
      containerContext: () => context('container', log)
    })
    shell['openPeek']!.call(fake.self, 'https://lien.example/', fromTab(w))
    return log
  }

  it('is made in the private context when the link is in a private tab, although an ordinary tab is the selected one', () => {
    expect(previewing((w) => w.behind.id)).toEqual(['page:private'])
  })

  // The listener of a link is made with the page, which only Electron does: its contract is read in the source.
  it('is asked for with the tab the link was clicked in', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'browser-pages.ts'), 'utf8')
    expect(source).toContain("else if (where === 'peek') this.openPeek(url, tab.id)")
  })

  it('is made in the context of the tab on screen when no tab is named, or one that is gone', () => {
    expect(previewing(() => undefined)).toEqual(['page:profile'])
    expect(previewing(() => 'gone')).toEqual(['page:profile'])
  })
})

describe('« Vider le cache et recharger »', () => {
  async function emptied(privateTab: boolean) {
    const state = run(createInitialState(ctx), { type: 'settings/update', patch: { privateTabs: true } }, { type: 'tab/open', url: 'https://page.example/', ...(privateTab ? { private: true } : {}) })
    const log: string[] = []
    const fake = fakeBrowser({
      store: { get: () => state },
      isPrivate: () => false,
      engineOf: shell['engineOf'],
      engine: context('profile', log),
      privateContext: () => context('private', log),
      containerContext: () => context('container', log),
      activePage: () => ({ reloadIgnoringCache: () => void log.push('reload') })
    })
    await shell['clearCacheAndReload']!.call(fake.self)
    return log
  }

  it('empties the cache of the private context for a private tab, then reloads', async () => {
    expect(await emptied(true)).toEqual(['cache:private:default', 'reload'])
  })

  it('empties the cache of the profile for an ordinary tab, then reloads', async () => {
    expect(await emptied(false)).toEqual(['cache:profile:default', 'reload'])
  })
})

describe('the tabs reloaded after a profile is erased', () => {
  it('are those of every window of the group that holds a page of the profile', async () => {
    const state = run(createInitialState(ctx), { type: 'tab/open', url: 'https://page.example/' })
    const tab = activeTab(state)!
    const reloaded: string[] = []
    const windowWith = (name: string) => ({ store: { get: () => state }, pages: new Map([[tab.id, { reload: () => void reloaded.push(name) }]]) })
    const other = windowWith('other window')
    const own = windowWith('this window')
    const fake = fakeBrowser({ ...own, engine: { clearProfileData: async () => undefined }, eraseProfileHistory: () => true, eraseHistory: () => true })
    fake.self['group'] = new Set([fake.self, other])
    await shell['clearProfile']!.call(fake.self, 'default')
    expect(reloaded.sort()).toEqual(['other window', 'this window'])
  })
})
