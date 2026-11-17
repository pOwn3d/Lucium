// "Effacer à la fermeture": which closed tabs empty a site, what is asked of the engine, and what a private window refuses.

import { describe, expect, it } from 'vitest'
import { defaultSettings, type SidebarState, type TabItem } from './model'
import { privateAction } from './private-window'
import { createInitialState, reduce, type Action } from './sidebar'
import {
  SITE_CLEAR_MAX,
  WHOLE_STATE_ACTIONS,
  cleanClearOnClose,
  clearHostOfUrl,
  describeClearFailure,
  isClearedOnClose,
  setClearedOnClose,
  sitesToClearOnClose,
  sitesToClearOnQuit
} from './site-clear'
import { SITE_DATA_HOSTS_MAX } from './site-data'
import { frenchSpaces } from './french-typography'

let counter = 0
const home = 'space-a'
const ctx = { now: 1, newId: () => `id${++counter}` }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

const tab = (id: string, spaceId: string, url: string): TabItem => ({ id, spaceId, url, title: id, pinned: false, createdAt: 1, lastActiveAt: 1 })

/** Two spaces on the default profile and one on a profile of its own, with the given tabs and list. */
function world(tabs: TabItem[], settings: Partial<SidebarState['settings']> = {}): SidebarState {
  const start = createInitialState(ctx)
  const first = start.spaces[0]!
  const spaces = [
    { ...first, id: home },
    { ...first, id: 'space-b', name: 'B' },
    { ...first, id: 'space-w', name: 'W', profileId: 'work' }
  ]
  return { ...start, spaces, activeSpaceId: home, activeTabBySpace: { [home]: null }, tabs, settings: { ...start.settings, siteDataClearOnCloseEnabled: true, siteDataClearOnClose: ['shop.example', 'localhost:3000'], ...settings } }
}
const without = (state: SidebarState, ...ids: string[]): SidebarState => ({ ...state, tabs: state.tabs.filter((t) => !ids.includes(t.id)) })

describe('the list', () => {
  it('keeps valid hosts as the URL parser prints them, each once, and nothing else', () => {
    expect(cleanClearOnClose(['Shop.Example', 'https://pas-un-hote.example/x', 42, null, 'shop.example', 'localhost:3000', 'a b', 'example.com:99999', '__proto__'])).toEqual(['shop.example', 'localhost:3000'])
    expect(cleanClearOnClose('shop.example')).toEqual([])
  })

  it('is bounded: a hand-edited file cannot grow it without end', () => {
    const many = Array.from({ length: SITE_CLEAR_MAX + 20 }, (_, i) => `site${i}.example`)
    expect(cleanClearOnClose(many)).toHaveLength(SITE_CLEAR_MAX)
  })

  it('adds and removes a site given as an address or as a host, and ignores what is not a web host', () => {
    const on = setClearedOnClose([], 'https://Shop.Example/panier?x=1', true)
    expect(on).toEqual(['shop.example'])
    expect(setClearedOnClose(on, 'shop.example', true)).toEqual(on)
    expect(setClearedOnClose(on, 'localhost:3000', true)).toEqual(['shop.example', 'localhost:3000'])
    expect(setClearedOnClose(on, 'pas un hôte', true)).toEqual(on)
    expect(setClearedOnClose(on, 42, true)).toEqual(on)
    expect(setClearedOnClose(on, 'file:///tmp/a.html', true)).toEqual(on)
    expect(setClearedOnClose(on, 'shop.example', false)).toEqual([])
    expect(setClearedOnClose(on, 'autre.example', false)).toEqual(on)
  })

  it('refuses one site more than it holds', () => {
    const full = Array.from({ length: SITE_CLEAR_MAX }, (_, i) => `site${i}.example`)
    expect(setClearedOnClose(full, 'nouveau.example', true)).toEqual(full)
    expect(setClearedOnClose(full, 'site3.example', false)).toHaveLength(SITE_CLEAR_MAX - 1)
  })

  it('reads the host of a web page only', () => {
    expect(clearHostOfUrl('https://Shop.Example:8443/x')).toBe('shop.example:8443')
    for (const url of ['about:blank', 'file:///tmp/a', 'chrome-extension://abc/page.html', 'view-source:https://a.example/', 'pas une adresse']) expect(clearHostOfUrl(url), url).toBeNull()
    expect(isClearedOnClose(['shop.example'], 'https://shop.example/a')).toBe(true)
    expect(isClearedOnClose(['shop.example'], 'https://www.shop.example/a')).toBe(false)
    expect(isClearedOnClose(['shop.example'], 'about:blank')).toBe(false)
  })
})

describe('the action behind the entry of the tab menu and of the site panel', () => {
  it('adds and removes the site of a page in the shared list, and changes nothing for what is not a site', () => {
    const start = createInitialState(ctx)
    const on = run(start, { type: 'siteclear/site', site: 'https://shop.example/panier', on: true })
    expect(on.settings.siteDataClearOnClose).toEqual(['shop.example'])
    expect(run(on, { type: 'siteclear/site', site: 'shop.example', on: true })).toBe(on)
    expect(run(on, { type: 'siteclear/site', site: 'shop.example', on: false }).settings.siteDataClearOnClose).toEqual([])
    expect(run(start, { type: 'siteclear/site', site: 'pas un hôte', on: true })).toBe(start)
    expect(run(start, { type: 'siteclear/site', site: 'shop.example', on: false })).toBe(start)
  })

  it('treats anything but a real true as "off" (the interface is not trusted)', () => {
    const on = run(createInitialState(ctx), { type: 'siteclear/site', site: 'shop.example', on: true })
    const forged = { type: 'siteclear/site', site: 'autre.example', on: 'yes' } as unknown as Action
    expect(run(on, forged)).toBe(on)
  })

  it('is off by default: the switch is off, the list is empty and nothing is erased at quit', () => {
    expect(defaultSettings()).toMatchObject({ siteDataClearOnCloseEnabled: false, siteDataClearOnClose: [], siteDataClearOnQuit: false })
  })

  it('switches the function on with the first site that is asked for, and not when a site is taken out', () => {
    const start = createInitialState(ctx)
    expect(start.settings.siteDataClearOnCloseEnabled).toBe(false)
    const on = run(start, { type: 'siteclear/site', site: 'https://shop.example/x', on: true })
    expect(on.settings).toMatchObject({ siteDataClearOnCloseEnabled: true, siteDataClearOnClose: ['shop.example'] })
    // Switched off in the settings, the site stays listed; asking for it again is asking for the function.
    const off = run(on, { type: 'settings/update', patch: { siteDataClearOnCloseEnabled: false } })
    expect(off.settings.siteDataClearOnClose).toEqual(['shop.example'])
    expect(run(off, { type: 'siteclear/site', site: 'shop.example', on: true }).settings.siteDataClearOnCloseEnabled).toBe(true)
    expect(run(off, { type: 'siteclear/site', site: 'shop.example', on: false }).settings).toMatchObject({ siteDataClearOnCloseEnabled: false, siteDataClearOnClose: [] })
    // Something that is not a site does not switch anything on.
    expect(run(start, { type: 'siteclear/site', site: 'pas un hôte', on: true })).toBe(start)
  })

  it('is refused by a private window, which has nothing to erase (its session is thrown away whole)', () => {
    expect(privateAction({ type: 'siteclear/site', site: 'shop.example', on: true })).toBeNull()
    expect(privateAction({ type: 'settings/update', patch: { siteDataClearOnClose: ['shop.example'], siteDataClearOnQuit: true } })).toBeNull()
  })
})

describe('what closing a tab erases', () => {
  const a = tab('a', home, 'https://shop.example/panier')

  it('erases the site when its last tab closes, in the profile of that tab, with the types the panel remembered, under both schemes', () => {
    const before = world([a, tab('x', home, 'https://autre.example/')], { siteDataTypes: ['cookies', 'localStorage'], siteDataSubdomains: false, siteDataHttp: false })
    const jobs = sitesToClearOnClose(before, without(before, 'a'), { private: false })
    // A site on the list is forgotten whole: its http origins go too, whatever the sheet's « Inclure HTTP » was.
    expect(jobs).toEqual([{ profileId: 'default', request: { hosts: ['shop.example'], types: ['cookies', 'localStorage'], subdomains: false, http: true, reload: false, detached: true } }])
  })

  it('spares a site that is not on the list', () => {
    const before = world([tab('x', home, 'https://autre.example/')])
    expect(sitesToClearOnClose(before, without(before, 'x'), { private: false })).toEqual([])
  })

  it('waits for the last tab of the site: another tab on it, in this window or another space of the profile, keeps the data', () => {
    const before = world([a, tab('b', home, 'https://shop.example/compte'), tab('c', 'space-b', 'https://shop.example/aide')])
    const one = without(before, 'a')
    expect(sitesToClearOnClose(before, one, { private: false })).toEqual([])
    const two = without(before, 'a', 'b')
    expect(sitesToClearOnClose(before, two, { private: false })).toEqual([])
    expect(sitesToClearOnClose(before, without(before, 'a', 'b', 'c'), { private: false })).toHaveLength(1)
  })

  it('counts the tabs of one profile only: the same site open in another profile has other cookies and does not hold this one back', () => {
    const before = world([a, tab('w', 'space-w', 'https://shop.example/')])
    const jobs = sitesToClearOnClose(before, without(before, 'a'), { private: false })
    expect(jobs.map((j) => j.profileId)).toEqual(['default'])
    const other = sitesToClearOnClose(before, without(before, 'w'), { private: false })
    expect(other.map((j) => j.profileId)).toEqual(['work'])
  })

  it('erases nothing when a tab only navigates away: a sign-in goes through other hosts and must not be logged out halfway', () => {
    const before = world([a])
    const after = { ...before, tabs: [{ ...a, url: 'https://sso.identite.example/login' }] }
    expect(sitesToClearOnClose(before, after, { private: false })).toEqual([])
  })

  it('erases nothing when a tab moves to another space: it is still open', () => {
    const before = world([a])
    const after = { ...before, tabs: [{ ...a, spaceId: 'space-w' }] }
    expect(sitesToClearOnClose(before, after, { private: false })).toEqual([])
  })

  it('names a site once when several of its tabs close together, and each site that was emptied', () => {
    const before = world([a, tab('b', home, 'https://shop.example/x'), tab('l', home, 'http://localhost:3000/'), tab('k', home, 'https://autre.example/')])
    const jobs = sitesToClearOnClose(before, { ...before, tabs: before.tabs.filter((t) => t.id === 'k') }, { private: false })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.request.hosts.sort()).toEqual(['localhost:3000', 'shop.example'])
  })

  it('erases every site a single change emptied, in as many runs as one run can name', () => {
    const sites = Array.from({ length: SITE_DATA_HOSTS_MAX + 3 }, (_, i) => `site${i}.example`)
    const before = world(sites.map((site, i) => tab(`s${i}`, home, `https://${site}/`)), { siteDataClearOnClose: sites })
    const jobs = sitesToClearOnClose(before, { ...before, tabs: [] }, { private: false })
    expect(jobs.every((job) => job.request.hosts.length <= SITE_DATA_HOSTS_MAX)).toBe(true)
    expect(jobs.flatMap((job) => job.request.hosts).sort()).toEqual([...sites].sort())
  })

  it('erases nothing in a private window, with an empty list, or while the function is switched off', () => {
    const before = world([a])
    expect(sitesToClearOnClose(before, without(before, 'a'), { private: true })).toEqual([])
    const empty = world([a], { siteDataClearOnClose: [] })
    expect(sitesToClearOnClose(empty, without(empty, 'a'), { private: false })).toEqual([])
    const off = world([a], { siteDataClearOnCloseEnabled: false })
    expect(sitesToClearOnClose(off, without(off, 'a'), { private: false })).toEqual([])
  })

  it('does not count a private tab of a normal window: closing it erases nothing, and it does not keep the profile\'s data from being erased', () => {
    const secret = { ...tab('p', home, 'https://shop.example/cadeau'), private: true }
    // Its closing: its context is thrown away whole, the profile holds nothing of the site on its account.
    const alone = world([secret])
    expect(sitesToClearOnClose(alone, without(alone, 'p'), { private: false })).toEqual([])
    // Another tab of the profile closes while a private one is open on the same site: the profile's data goes all the same.
    const both = world([a, secret])
    expect(sitesToClearOnClose(both, without(both, 'a'), { private: false }).map((j) => j.request.hosts)).toEqual([['shop.example']])
    // Both close together: only the profile's tab counts.
    expect(sitesToClearOnClose(both, without(both, 'a', 'p'), { private: false }).map((j) => j.request.hosts)).toEqual([['shop.example']])
  })

  it('goes by the subdomains option: a tab on a subdomain keeps the site open only when the erasure would reach it', () => {
    const sub = tab('s', home, 'https://pay.shop.example/')
    const exact = world([a, sub], { siteDataSubdomains: false })
    expect(sitesToClearOnClose(exact, without(exact, 'a'), { private: false })).toHaveLength(1)
    const wide = world([a, sub], { siteDataSubdomains: true })
    expect(sitesToClearOnClose(wide, without(wide, 'a'), { private: false })).toEqual([])
    const closing = sitesToClearOnClose(wide, without(wide, 'a', 's'), { private: false })
    expect(closing[0]!.request.subdomains).toBe(true)
  })

  it('treats the tab of a closed Today list as closed: the real reducer drops it', () => {
    const before = world([a, tab('k', home, 'https://autre.example/')])
    const after = run(before, { type: 'tab/close', id: 'a' })
    expect(after.tabs.some((t) => t.id === 'a')).toBe(false)
    expect(sitesToClearOnClose(before, after, { private: false }).map((j) => j.request.hosts)).toEqual([['shop.example']])
  })

  it('does not count a pinned tab put to sleep as closed: it is still in the sidebar', () => {
    const pinned = { ...a, pinned: true, anchorUrl: a.url }
    const before = world([pinned])
    const after = run(before, { type: 'tab/close', id: 'a' })
    expect(sitesToClearOnClose(before, after, { private: false })).toEqual([])
  })

  it('knows the actions that replace the whole state, which close nobody', () => {
    expect([...WHOLE_STATE_ACTIONS].sort()).toEqual(['import/merge', 'import/revert', 'state/restore'])
  })
})

describe('what quitting erases', () => {
  it('is nothing unless the setting asks for it, the function is on and the list is not empty', () => {
    const state = world([])
    expect(sitesToClearOnQuit(state, { private: false })).toEqual([])
    expect(sitesToClearOnQuit({ ...state, settings: { ...state.settings, siteDataClearOnQuit: true, siteDataClearOnClose: [] } }, { private: false })).toEqual([])
    expect(sitesToClearOnQuit({ ...state, settings: { ...state.settings, siteDataClearOnQuit: true, siteDataClearOnCloseEnabled: false } }, { private: false })).toEqual([])
    expect(sitesToClearOnQuit({ ...state, settings: { ...state.settings, siteDataClearOnQuit: true } }, { private: false })).toHaveLength(2)
  })

  it('is the whole list in every profile the spaces use, in runs of at most the size one run may name', () => {
    const many = Array.from({ length: SITE_DATA_HOSTS_MAX + 3 }, (_, i) => `site${i}.example`)
    const state = world([], { siteDataClearOnQuit: true, siteDataClearOnClose: many, siteDataTypes: ['cookies'] })
    const jobs = sitesToClearOnQuit(state, { private: false })
    expect(jobs.map((j) => [j.profileId, j.request.hosts.length])).toEqual([['default', SITE_DATA_HOSTS_MAX], ['default', 3], ['work', SITE_DATA_HOSTS_MAX], ['work', 3]])
    expect(jobs.every((j) => j.request.types.join() === 'cookies' && !j.request.reload)).toBe(true)
  })

  it('is nothing in a private window', () => {
    const state = world([], { siteDataClearOnQuit: true })
    expect(sitesToClearOnQuit(state, { private: true })).toEqual([])
  })
})

describe('the notice of a failure', () => {
  it('names the first few sites and counts the rest', () => {
    expect(describeClearFailure(['a.example'])).toBe(frenchSpaces('Effacement à la fermeture incomplet : a.example'))
    expect(describeClearFailure(['a.example', 'b.example', 'c.example', 'd.example', 'e.example'])).toBe(frenchSpaces('Effacement à la fermeture incomplet : a.example, b.example, c.example et 2 autres'))
    expect(describeClearFailure(['a.example', 'b.example', 'c.example', 'd.example'])).toBe(frenchSpaces('Effacement à la fermeture incomplet : a.example, b.example, c.example et 1 autre'))
  })
})
