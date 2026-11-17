// What a private tab leaves in the saved state: not its site, through a favorite, the developer mode or the sleep exceptions.

import { describe, expect, it } from 'vitest'
import type { SidebarState } from './model'
import { createInitialState, reduce, type Action } from './sidebar'

const ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

const SITE_URL = 'https://prive.example.org/page'
const withTabs = (...tabs: Array<{ url: string; private: boolean }>): SidebarState =>
  run(
    createInitialState(ctx),
    { type: 'settings/update', patch: { privateTabs: true } },
    ...tabs.map((tab): Action => ({ type: 'tab/open', url: tab.url, ...(tab.private ? { private: true } : {}) }))
  )

describe('a favorite (favorite/add)', () => {
  const add: Action = { type: 'favorite/add', url: SITE_URL, title: 'Page' }

  it('is not made from the address of a private tab', () => {
    const state = withTabs({ url: SITE_URL, private: true })
    expect(state.tabs.some((t) => t.private === true)).toBe(true)
    expect(run(state, add).favorites).toEqual([])
  })

  it('is made from the address of a regular tab, or of an address no tab shows', () => {
    expect(run(withTabs({ url: SITE_URL, private: false }), add).favorites).toHaveLength(1)
    expect(run(withTabs(), add).favorites).toHaveLength(1)
  })

  it('is made when a regular tab is on the same address as a private one', () => {
    expect(run(withTabs({ url: SITE_URL, private: true }, { url: SITE_URL, private: false }), add).favorites).toHaveLength(1)
  })
})

describe('the developer mode of a site (developer/site)', () => {
  it('is not turned on for the host of a private tab, however the site is written', () => {
    const state = withTabs({ url: SITE_URL, private: true })
    expect(run(state, { type: 'developer/site', site: 'prive.example.org', enabled: true }).settings.developerHosts).toEqual([])
    expect(run(state, { type: 'developer/site', site: SITE_URL, enabled: true }).settings.developerHosts).toEqual([])
    expect(run(state, { type: 'developer/site', site: 'https://www.prive.example.org/', enabled: true }).settings.developerHosts).toEqual([])
  })

  it('is turned on for a regular tab, and turned off for the host of a private one (that writes nothing)', () => {
    const on = run(withTabs({ url: SITE_URL, private: false }), { type: 'developer/site', site: 'prive.example.org', enabled: true })
    expect(on.settings.developerHosts).toEqual(['prive.example.org'])
    const privateToo = run(on, { type: 'tab/open', url: SITE_URL, private: true })
    expect(run(privateToo, { type: 'developer/site', site: 'prive.example.org', enabled: false }).settings.developerHosts).toEqual([])
  })
})

describe('the sleep exceptions (sleep/exclude-site)', () => {
  it('do not take the host of a private tab', () => {
    const state = withTabs({ url: SITE_URL, private: true })
    expect(run(state, { type: 'sleep/exclude-site', site: SITE_URL, excluded: true }).settings.sleepExcludedHosts).toEqual([])
    expect(run(state, { type: 'sleep/exclude-site', site: 'prive.example.org', excluded: true }).settings.sleepExcludedHosts).toEqual([])
  })

  it('take the host of a regular tab, and a host no tab shows', () => {
    const regular = run(withTabs({ url: SITE_URL, private: false }), { type: 'sleep/exclude-site', site: SITE_URL, excluded: true })
    expect(regular.settings.sleepExcludedHosts).toEqual(['prive.example.org'])
    expect(run(withTabs(), { type: 'sleep/exclude-site', site: 'autre.example.net', excluded: true }).settings.sleepExcludedHosts).toEqual(['autre.example.net'])
  })
})
