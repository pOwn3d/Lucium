// The ranking of the command bar is kept per profile: what is picked in a space is counted for the profile of that space only, the bar reads the
// ranking of the profile on screen, erasing the history of a profile empties its ranking and no other, a private tab teaches
// nothing, and a file from before the ranking was kept per profile starts again from nothing without losing anything else.

import { describe, expect, it } from 'vitest'
import type { HistoryEntry, SidebarState } from './model'
import { rankCandidates, usageKey } from './command-bar'
import { USAGE_COUNT_MAX, USAGE_LIMIT, pruneUsageProfiles, usageAfterForgetting, usageAfterPick, usageCountOf, usageOfProfile, usageOnScreen, usageWithPageBack, usageWithoutPages, type CommandBarUsage } from './command-bar-usage'
import { createInitialState, normalize, parseSavedState, persistableState, reduce, type Action, type Ctx } from './sidebar'

function makeCtx(): Ctx {
  let n = 0
  return { now: 1_000_000, newId: () => `id${++n}` }
}

const run = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** A state with a space of the default profile (`home`) and a space of the profile `work`; the space on screen is `home`. */
function twoProfiles(ctx: Ctx): { state: SidebarState; home: string; work: string } {
  const base = createInitialState(ctx)
  const home = base.spaces[0]!.id
  const created = run(ctx, base, { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileId: 'work' })
  const work = created.spaces.find((s) => s.profileId === 'work')!.id
  return { state: { ...created, activeSpaceId: home }, home, work }
}

const onSpace = (state: SidebarState, spaceId: string): SidebarState => ({ ...state, activeSpaceId: spaceId })

const A = usageKey('https://a.example/')
const B = usageKey('https://b.example/')

describe('a page picked in the command bar', () => {
  it('is counted for the profile of the space on screen, and for no other', () => {
    const ctx = makeCtx()
    const { state, work } = twoProfiles(ctx)
    const atHome = run(ctx, state, { type: 'commandbar/used', key: A }, { type: 'commandbar/used', key: A })
    expect(atHome.commandBarUsage).toEqual({ default: { [A]: 2 } })
    const atWork = run(ctx, onSpace(atHome, work), { type: 'commandbar/used', key: B })
    expect(atWork.commandBarUsage).toEqual({ default: { [A]: 2 }, work: { [B]: 1 } })
    // The same address picked in both profiles is counted in each one apart.
    expect(run(ctx, atWork, { type: 'commandbar/used', key: A }).commandBarUsage).toEqual({ default: { [A]: 2 }, work: { [B]: 1, [A]: 1 } })
  })

  it('keeps the most picked pages of each profile, each within its own limit', () => {
    let all: CommandBarUsage = { work: { [A]: 5 } }
    for (let i = 0; i < USAGE_LIMIT + 20; i++) all = usageAfterPick(all, 'default', `url:https://k${i}.example/`)
    expect(Object.keys(usageOfProfile({ commandBarUsage: all }, 'default'))).toHaveLength(USAGE_LIMIT)
    expect(all['work']).toEqual({ [A]: 5 })
  })

  it('is counted nowhere for what is not a profile id', () => {
    const all: CommandBarUsage = { default: { [A]: 1 } }
    for (const profileId of ['', '__proto__', 'a/b', 'x'.repeat(33)]) expect(usageAfterPick(all, profileId, B), profileId).toBe(all)
  })

  it('is not counted over a private tab, whatever the profile of its space', () => {
    const ctx = makeCtx()
    const { state, work } = twoProfiles(ctx)
    const learned = run(ctx, onSpace(state, work), { type: 'commandbar/used', key: B })
    const overPrivate = run(ctx, learned, { type: 'tab/open', url: 'about:blank', private: true })
    const after = run(ctx, overPrivate, { type: 'commandbar/used', key: A })
    expect(after).toBe(overPrivate)
    expect(persistableState(after).commandBarUsage).toEqual({ work: { [B]: 1 } })
  })
})

describe('the bar', () => {
  const history: HistoryEntry[] = [
    { url: 'https://docs.example/one', title: 'Projet un', lastVisitAt: 20, visitCount: 1 },
    { url: 'https://docs.example/two', title: 'Projet deux', lastVisitAt: 10, visitCount: 1 }
  ]
  const order = (state: SidebarState): string[] => rankCandidates('projet', state, history).filter((c) => c.kind === 'history').map((c) => c.label)

  it('reads the ranking of the profile of the space on screen: what was picked in another profile moves no line', () => {
    const ctx = makeCtx()
    const { state, work } = twoProfiles(ctx)
    const plain = order(state)
    expect(plain).toHaveLength(2)
    const last = history.find((h) => h.title === plain.at(-1))!
    const learnedAtWork: SidebarState = { ...state, commandBarUsage: { work: { [usageKey(last.url)]: 3 } } }
    expect(usageOnScreen(learnedAtWork)).toEqual({})
    expect(order(learnedAtWork)).toEqual(plain)
    // In a space of that profile the same ranking puts the page first.
    expect(order(onSpace(learnedAtWork, work))[0]).toBe(last.title)
  })
})

describe('erasing the history of a profile', () => {
  it('empties the ranking of that profile and leaves the ranking of the others', () => {
    const ctx = makeCtx()
    const { state } = twoProfiles(ctx)
    const used: SidebarState = { ...state, commandBarUsage: { default: { [A]: 2 }, work: { [A]: 1, [B]: 4 } } }
    const erased = run(ctx, used, { type: 'archive/forget-pages', profileId: 'work' })
    expect(erased.commandBarUsage).toEqual({ default: { [A]: 2 } })
    expect(run(ctx, used, { type: 'archive/forget-pages', profileId: 'default' }).commandBarUsage).toEqual({ work: { [A]: 1, [B]: 4 } })
    // A profile that has no ranking: nothing to forget is no new state.
    expect(run(ctx, erased, { type: 'archive/forget-pages', profileId: 'work' })).toBe(erased)
  })

  it('takes the addresses of one site out of the ranking of that profile only', () => {
    const all: CommandBarUsage = { default: { [A]: 2, [B]: 1 }, work: { [A]: 1, [B]: 4 } }
    expect(usageAfterForgetting(all, 'work', { host: 'a.example', subdomains: false })).toEqual({ default: { [A]: 2, [B]: 1 }, work: { [B]: 4 } })
    // The last address of a profile gone, the profile has no entry left.
    expect(usageAfterForgetting({ default: { [A]: 2 }, work: { [A]: 1 } }, 'work', { host: 'a.example', subdomains: false })).toEqual({ default: { [A]: 2 } })
    expect(usageAfterForgetting(all, 'work', { host: 'other.example', subdomains: true })).toBe(all)
  })
})

describe('a state file', () => {
  it('written before the ranking was kept per profile starts again without a ranking, and keeps everything else', () => {
    const ctx = makeCtx()
    const before = run(ctx, createInitialState(ctx), { type: 'tab/open', url: 'https://kept.example/' })
    const old = JSON.parse(JSON.stringify(persistableState(before))) as Record<string, unknown>
    // The single list of an older file: addresses, with how often each was picked, for every profile at once.
    old['commandBarUsage'] = { [A]: 7, [B]: 2 }
    const read = parseSavedState(JSON.stringify(old))
    expect(read.commandBarUsage).toEqual({})
    expect(read.tabs.map((t) => t.url)).toEqual(['https://kept.example/'])
    expect(read.spaces).toEqual(before.spaces)
    // And it learns again, per profile, from there.
    expect(run(ctx, read, { type: 'commandbar/used', key: A }).commandBarUsage).toEqual({ default: { [A]: 1 } })
  })

  it('keeps the ranking of each profile that exists, as it was', () => {
    const ctx = makeCtx()
    const { state } = twoProfiles(ctx)
    const saved: SidebarState = { ...state, commandBarUsage: { default: { [A]: 2 }, work: { [B]: 4 } } }
    const read = parseSavedState(JSON.stringify(persistableState(saved)))
    expect(read.commandBarUsage).toEqual({ default: { [A]: 2 }, work: { [B]: 4 } })
    expect(normalize(read).commandBarUsage).toEqual(read.commandBarUsage)
  })

  it('drops the ranking of a profile that no longer exists and of what is not a profile id', () => {
    const ctx = makeCtx()
    const { state } = twoProfiles(ctx)
    const file = JSON.parse(JSON.stringify(persistableState(state))) as Record<string, unknown>
    file['commandBarUsage'] = { default: { [A]: 2 }, gone: { [A]: 9 }, 'not a profile': { [A]: 9 }, work: { [B]: 1 }, empty: {} }
    expect(parseSavedState(JSON.stringify(file)).commandBarUsage).toEqual({ default: { [A]: 2 }, work: { [B]: 1 } })
    const orphan: SidebarState = { ...state, commandBarUsage: { default: { [A]: 2 }, gone: { [A]: 9 } } }
    expect(pruneUsageProfiles(orphan).commandBarUsage).toEqual({ default: { [A]: 2 } })
    const whole: SidebarState = { ...state, commandBarUsage: { default: { [A]: 2 } } }
    expect(pruneUsageProfiles(whole)).toBe(whole)
  })
})

describe('a page forgotten in the history of a profile', () => {
  const PAGE_A = 'https://a.example/'
  const PAGE_B = 'https://b.example/'

  it('leaves the ranking of that profile, and of no other; the other pages of the profile stay', () => {
    const all: CommandBarUsage = { default: { [A]: 4, [B]: 1 }, work: { [A]: 2 } }
    expect(usageWithoutPages(all, 'default', [PAGE_A])).toEqual({ default: { [B]: 1 }, work: { [A]: 2 } })
    // The last page of a ranking takes the entry of the profile with it.
    expect(usageWithoutPages(all, 'work', [PAGE_A])).toEqual({ default: { [A]: 4, [B]: 1 } })
    expect(usageWithoutPages(all, 'default', [PAGE_A, PAGE_B, 'https://never.example/'])).toEqual({ work: { [A]: 2 } })
  })

  it('changes nothing, and gives the same object back, for a page that is not ranked or a profile without a ranking', () => {
    const all: CommandBarUsage = { default: { [A]: 4 } }
    expect(usageWithoutPages(all, 'default', ['https://never.example/'])).toBe(all)
    expect(usageWithoutPages(all, 'work', [PAGE_A])).toBe(all)
    expect(usageWithoutPages(all, '__proto__', [PAGE_A])).toBe(all)
  })

  it('is read with the count it had (0 when it is not ranked), without reading a name every object has', () => {
    const all: CommandBarUsage = { default: { [A]: 4 } }
    expect(usageCountOf(all, 'default', PAGE_A)).toBe(4)
    expect(usageCountOf(all, 'default', PAGE_B)).toBe(0)
    expect(usageCountOf(all, 'work', PAGE_A)).toBe(0)
    expect(usageCountOf(all, 'constructor', PAGE_A)).toBe(0)
  })

  it('comes back with its count, added to what it was picked since, in its profile only', () => {
    const all: CommandBarUsage = { default: { [B]: 1 }, work: { [A]: 2 } }
    expect(usageWithPageBack(all, 'default', PAGE_A, 4)).toEqual({ default: { [B]: 1, [A]: 4 }, work: { [A]: 2 } })
    expect(usageWithPageBack(all, 'work', PAGE_A, 4)).toEqual({ default: { [B]: 1 }, work: { [A]: 6 } })
    expect(usageWithPageBack({}, 'default', PAGE_A, 4)).toEqual({ default: { [A]: 4 } })
  })

  it('does not come back with a count that is not one, an address too long for a key, or under what is not a profile id', () => {
    const all: CommandBarUsage = { default: { [B]: 1 } }
    for (const count of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) expect(usageWithPageBack(all, 'default', PAGE_A, count), String(count)).toBe(all)
    expect(usageWithPageBack(all, 'default', `https://a.example/${'x'.repeat(400)}`, 2)).toBe(all)
    expect(usageWithPageBack(all, '__proto__', PAGE_A, 2)).toBe(all)
    expect(usageWithPageBack(all, 'default', PAGE_B, USAGE_COUNT_MAX)).toEqual({ default: { [B]: USAGE_COUNT_MAX } })
  })

  it('comes back in a full ranking only when it is picked more than the least picked page', () => {
    const full: CommandBarUsage = { default: Object.fromEntries(Array.from({ length: USAGE_LIMIT }, (_, i) => [usageKey(`https://p${i}.example/`), 5])) }
    const back = usageWithPageBack(full, 'default', PAGE_A, 9)
    expect(Object.keys(back['default']!)).toHaveLength(USAGE_LIMIT)
    expect(back['default']![A]).toBe(9)
    expect(usageWithPageBack(full, 'default', PAGE_A, 1)['default']![A]).toBeUndefined()
  })

  it('the reducer takes it out of the ranking of the profile that is named, whatever space is on screen, and puts it back there', () => {
    const ctx = makeCtx()
    const { state, work } = twoProfiles(ctx)
    const ranked: SidebarState = { ...state, commandBarUsage: { default: { [A]: 4, [B]: 1 }, work: { [A]: 2 } } }
    const forgotten = run(ctx, onSpace(ranked, work), { type: 'commandbar/forget', profileId: 'default', urls: [PAGE_A] })
    expect(forgotten.commandBarUsage).toEqual({ default: { [B]: 1 }, work: { [A]: 2 } })
    const picked = run(ctx, onSpace(forgotten, state.spaces[0]!.id), { type: 'commandbar/used', key: A })
    expect(run(ctx, onSpace(picked, work), { type: 'commandbar/put-back', profileId: 'default', url: PAGE_A, count: 4 }).commandBarUsage).toEqual({ default: { [B]: 1, [A]: 5 }, work: { [A]: 2 } })
  })

  it('the reducer changes nothing for a page that is not ranked, and for what is not a list of addresses', () => {
    const ctx = makeCtx()
    const { state } = twoProfiles(ctx)
    const ranked: SidebarState = { ...state, commandBarUsage: { default: { [A]: 4 } } }
    expect(run(ctx, ranked, { type: 'commandbar/forget', profileId: 'default', urls: ['https://never.example/'] })).toBe(ranked)
    expect(run(ctx, ranked, { type: 'commandbar/forget', profileId: 'default', urls: PAGE_A as unknown as string[] })).toBe(ranked)
    expect(run(ctx, ranked, { type: 'commandbar/forget', profileId: 'default', urls: [7, PAGE_A] as unknown as string[] }).commandBarUsage).toEqual({})
  })

  it('the reducer puts nothing back under a profile that does not exist, nor while the history of the profile is not recorded', () => {
    const ctx = makeCtx()
    const { state } = twoProfiles(ctx)
    expect(run(ctx, state, { type: 'commandbar/put-back', profileId: 'gone', url: PAGE_A, count: 4 })).toBe(state)
    expect(run(ctx, state, { type: 'commandbar/put-back', profileId: 'work', url: PAGE_A, count: '4' as unknown as number })).toBe(state)
    const off = run(ctx, state, { type: 'settings/update', patch: { historyOff: true } })
    expect(run(ctx, off, { type: 'commandbar/put-back', profileId: 'work', url: PAGE_A, count: 4 })).toBe(off)
    expect(run(ctx, state, { type: 'commandbar/put-back', profileId: 'work', url: PAGE_A, count: 4 }).commandBarUsage).toEqual({ work: { [A]: 4 } })
  })
})
