// The mark of a tab that does not go through the proxy of its profile (proxy-mark.ts): a container and a private context get the general proxy, never a profile's.

import { describe, expect, it } from 'vitest'
import { defaultSettings, type Settings, type SidebarState, type TabItem } from './model'
import { createInitialState, reduce, type Action } from './sidebar'
import { appliedProxy, planProxies, appliedFor, type ProxySetting } from './proxy'
import { browsingContextOf, proxyMarkOf, proxyMarkedTabs, type ProxyMarkInput } from './proxy-mark'

const manual = (address: string): ProxySetting => ({ mode: 'manual', address, bypass: '' })
const WORK = manual('http://work.example:3128')
const GENERAL = manual('http://general.example:8080')

const input = (over: Partial<ProxyMarkInput> = {}): ProxyMarkInput => ({ enabled: true, general: GENERAL, profile: WORK, context: 'container', ...over })

describe('the reason a tab leaves without the proxy of its profile', () => {
  // Guard: a container and a private context go out through the general proxy while the profile has one of its own. Without the context check, a tab
  // browsed in the session of its profile (which has the proxy) would wear the mark too.
  it('is its container or its private context, when its profile has a proxy of its own that differs from the general one', () => {
    expect(proxyMarkOf(input({ context: 'container' }))).toBe('container')
    expect(proxyMarkOf(input({ context: 'private' }))).toBe('private')
    expect(proxyMarkOf(input({ context: 'profile' }))).toBeNull()
  })

  // Guard: with the option off nothing is configured: no profile has a proxy in use. Without the `enabled` check the mark would say something false.
  it('is nothing while the option is off', () => {
    expect(proxyMarkOf(input({ enabled: false }))).toBeNull()
    expect(proxyMarkOf(input({ enabled: false, context: 'private' }))).toBeNull()
  })

  // Guard: a profile that has no proxy of its own follows the general one, as its container and private tabs do: nothing is lost.
  it('is nothing for a profile that has no proxy of its own', () => {
    expect(proxyMarkOf(input({ profile: undefined }))).toBeNull()
    expect(proxyMarkOf(input({ profile: undefined, context: 'private' }))).toBeNull()
  })

  // Guard: the traffic goes the same way, so the tab loses nothing. Without the comparison, a profile whose own proxy is the general one would mark every container.
  it('is nothing when the proxy of the profile sends the traffic the way the general one does', () => {
    expect(proxyMarkOf(input({ profile: manual('http://general.example:8080') }))).toBeNull()
    expect(proxyMarkOf(input({ profile: { ...GENERAL, bypass: '' } }))).toBeNull()
    expect(proxyMarkOf(input({ profile: { mode: 'system', address: '', bypass: '' }, general: { mode: 'system', address: 'ignored', bypass: 'ignored' } }))).toBeNull()
    // A different bypass list is a different route.
    expect(proxyMarkOf(input({ profile: { ...GENERAL, bypass: '*.example.org' } }))).toBe('container')
  })

  // « Direct » and « system » are choices too: a profile that ignores a general proxy loses that when its container goes through it.
  it('is there for a profile that chose « Aucun proxy » or the proxy of the system against a general proxy', () => {
    expect(proxyMarkOf(input({ profile: { mode: 'direct', address: '', bypass: '' } }))).toBe('container')
    expect(proxyMarkOf(input({ profile: { mode: 'system', address: '', bypass: '' } }))).toBe('container')
    expect(proxyMarkOf(input({ profile: WORK, general: { mode: 'system', address: '', bypass: '' } }))).toBe('container')
  })

  // The rule is the engine's own: the proxy the mark says a container goes through is what the plan gives it.
  it('agrees with what the engine applies: the plan gives a container and a private context the general proxy, a profile its own', () => {
    const settings = { ...defaultSettings(), proxyEnabled: true, proxy: GENERAL, profiles: { work: { proxy: WORK } } }
    const plan = planProxies(settings)!
    expect(appliedFor(plan, 'work')).toEqual(appliedProxy(WORK))
    expect(plan.global).toEqual(appliedProxy(GENERAL))
    expect(proxyMarkOf({ enabled: settings.proxyEnabled, general: settings.proxy, profile: settings.profiles.work?.proxy, context: 'container' })).toBe('container')
  })
})

describe('where the page of a tab is browsed', () => {
  const settings: Pick<Settings, 'containers'> = { containers: [{ id: 'bank', name: 'Banque', color: 'blue' }] }
  const tab = (over: Partial<TabItem> = {}): Pick<TabItem, 'container' | 'private'> => over

  it('is the session of its profile for an ordinary tab, a container for a tab of one that exists, a private context for a private tab', () => {
    expect(browsingContextOf(settings, tab(), false)).toBe('profile')
    expect(browsingContextOf(settings, tab({ container: 'bank' }), false)).toBe('container')
    expect(browsingContextOf(settings, tab({ private: true }), false)).toBe('private')
  })

  it('is a private context for every tab of a private window, and the profile again for a tab of a container that was deleted', () => {
    expect(browsingContextOf(settings, tab(), true)).toBe('private')
    expect(browsingContextOf(settings, tab({ container: 'bank' }), true)).toBe('private')
    expect(browsingContextOf(settings, tab({ container: 'gone' }), false)).toBe('profile')
  })
})

describe('the tabs of a window that wear the mark', () => {
  let n = 0
  const ctx = { now: 1, newId: () => `id${++n}` }
  const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

  /** A space of the profile « work » with an ordinary tab, a container tab and a private tab; the default space with an ordinary tab and a private one. */
  function world(settings: Partial<Settings>): { state: SidebarState; ids: Record<'workOrdinary' | 'workContainer' | 'workPrivate' | 'homeOrdinary' | 'homePrivate', string> } {
    let state = createInitialState(ctx)
    const home = state.spaces[0]!.id
    state = run(state, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 20, profileId: 'work' })
    const work = state.spaces[1]!.id
    for (const [space, url] of [[work, 'https://w1.example/'], [work, 'https://w2.example/'], [work, 'https://w3.example/'], [home, 'https://h1.example/'], [home, 'https://h2.example/']] as const) state = run(state, { type: 'tab/open', url, spaceId: space, background: true })
    const byUrl = (url: string) => state.tabs.find((tab) => tab.url === url)!.id
    const ids = { workOrdinary: byUrl('https://w1.example/'), workContainer: byUrl('https://w2.example/'), workPrivate: byUrl('https://w3.example/'), homeOrdinary: byUrl('https://h1.example/'), homePrivate: byUrl('https://h2.example/') }
    state = {
      ...state,
      tabs: state.tabs.map((tab) => (tab.id === ids.workContainer ? { ...tab, container: 'bank' } : tab.id === ids.workPrivate || tab.id === ids.homePrivate ? { ...tab, private: true } : tab)),
      settings: { ...state.settings, containers: [{ id: 'bank', name: 'Banque', color: 'blue' }], proxyEnabled: true, proxy: GENERAL, profiles: { work: { proxy: WORK } }, ...settings }
    }
    return { state, ids }
  }

  it('are the container and private tabs of the profile that has a proxy, with why, and no other', () => {
    const { state, ids } = world({})
    expect([...proxyMarkedTabs(state, false)]).toEqual([[ids.workContainer, 'container'], [ids.workPrivate, 'private']])
  })

  // Guard: the profile of the tab is the profile of its space. Without it the default profile, which has no proxy of its own, would mark nothing and `work` everything.
  it('goes by the profile of the space of each tab: the private tab of a profile without a proxy of its own has no mark', () => {
    const { state, ids } = world({})
    expect(proxyMarkedTabs(state, false).has(ids.homePrivate)).toBe(false)
    expect(proxyMarkedTabs(state, false).has(ids.workOrdinary)).toBe(false)
  })

  it('has none while the option is off, or while no profile has a proxy of its own (nothing is computed per tab)', () => {
    expect(proxyMarkedTabs(world({ proxyEnabled: false }).state, false).size).toBe(0)
    expect(proxyMarkedTabs(world({ profiles: {} }).state, false).size).toBe(0)
    expect(proxyMarkedTabs(world({ profiles: { work: {} } }).state, false).size).toBe(0)
  })

  // A private window belongs to no profile of the user (its only space has the id of the private profile, which can hold no proxy): no tab of it has one to lose.
  it('has none in a private window, whose tabs have no profile of their own', () => {
    const { state } = world({})
    const privateSpace = state.spaces[0]!.id
    const alone = { ...state, spaces: [{ ...state.spaces[0]!, profileId: 'private' }], tabs: state.tabs.filter((tab) => tab.spaceId === privateSpace), settings: { ...state.settings, profiles: {} } }
    expect(proxyMarkedTabs(alone, true).size).toBe(0)
  })
})
