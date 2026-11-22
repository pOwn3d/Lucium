import { describe, expect, it } from 'vitest'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import { interfaceMayDispatch } from './ipc-policy'
import type { SidebarState } from './model'
import { SITE_VISITS_MAX, UNUSED_PERMISSION_DAYS, cleanSiteVisits, cleanUnusedPermissionDays, dayOf, sweepUnused, visitOrigin, withVisit } from './unused-permissions'

const A = 'https://a.example'
const B = 'https://b.example'
const answers = { [A]: { camera: 'allow', notifications: 'deny' }, [B]: { geolocation: 'allow' } } as const

describe('dayOf', () => {
  it('counts UTC days since 1970', () => {
    expect(dayOf(0)).toBe(0)
    expect(dayOf(86_400_000 - 1)).toBe(0)
    expect(dayOf(86_400_000)).toBe(1)
  })
})

describe('withVisit: one write per site per day', () => {
  it('writes the day of a site that holds an answer', () => {
    expect(withVisit({}, answers, A, 100)).toEqual({ [A]: 100 })
  })
  it('is the same table (no write) for a day already written, or an earlier one', () => {
    const visits = { [A]: 100 }
    expect(withVisit(visits, answers, A, 100)).toBe(visits)
    expect(withVisit(visits, answers, A, 99)).toBe(visits)
    expect(withVisit(visits, answers, A, 101)).toEqual({ [A]: 101 })
  })
  it('writes nothing for a site with no answer, for the answer for every site, or for a key that is not an origin', () => {
    const visits = {}
    expect(withVisit(visits, answers, 'https://none.example', 100)).toBe(visits)
    expect(withVisit(visits, { '*': { notifications: 'allow' } }, '*', 100)).toBe(visits)
    expect(withVisit(visits, answers, '__proto__', 100)).toBe(visits)
    expect(withVisit(visits, answers, A, -1)).toBe(visits)
    expect(withVisit(visits, answers, A, 1.5)).toBe(visits)
  })
})

describe('sweepUnused', () => {
  it('forgets the sites whose last visit is the delay away or older, and says which, with their permissions', () => {
    const swept = sweepUnused(answers, { [A]: 100, [B]: 11 }, 101 + 89, 90)
    // A: 90 days away → forgotten. B: 179 days away → forgotten too.
    expect(swept.forgotten).toEqual([{ origin: A, permissions: ['camera', 'notifications'] }, { origin: B, permissions: ['geolocation'] }])
    expect(swept.sitePermissions).toEqual({})
    expect(swept.siteVisits).toEqual({})
  })
  it('keeps a site visited one day inside the delay', () => {
    const swept = sweepUnused(answers, { [A]: 101, [B]: 101 }, 101 + 89, 90)
    expect(swept.forgotten).toEqual([])
    expect(swept.sitePermissions).toBe(answers)
  })
  it('does nothing while the delay is 0 (off): not even the table is touched', () => {
    const visits = { [A]: 1 }
    const swept = sweepUnused(answers, visits, 20_000, 0)
    expect(swept).toEqual({ sitePermissions: answers, siteVisits: visits, forgotten: [] })
    expect(swept.sitePermissions).toBe(answers)
  })
  it('counts a site with an answer and no visit yet as visited today: switching the setting on takes nothing at once', () => {
    const swept = sweepUnused(answers, {}, 20_000, 30)
    expect(swept.forgotten).toEqual([])
    expect(swept.siteVisits).toEqual({ [A]: 20_000, [B]: 20_000 })
    // ... and 30 days later, still unvisited, they go.
    expect(sweepUnused(answers, swept.siteVisits, 20_030, 30).forgotten.map((site) => site.origin)).toEqual([A, B])
  })
  it('never forgets the answer for every site', () => {
    const everywhere = { '*': { notifications: 'allow' }, ...answers } as const
    const swept = sweepUnused(everywhere, { [A]: 1, [B]: 1 }, 20_000, 30)
    expect(swept.sitePermissions).toEqual({ '*': { notifications: 'allow' } })
    // ... and it is no site: it gets no day of visit.
    expect(swept.siteVisits).toEqual({})
  })
  it('drops the day of a site that holds no answer any more, and returns the same objects when nothing changes', () => {
    const visits = { [A]: 20_000 }
    const same = sweepUnused({ [A]: answers[A] }, visits, 20_001, 30)
    expect(same.siteVisits).toBe(visits)
    const dropped = sweepUnused({ [A]: answers[A] }, { [A]: 20_000, [B]: 20_000 }, 20_001, 30)
    expect(dropped.siteVisits).toEqual({ [A]: 20_000 })
  })
})

describe('what a file may hold', () => {
  it('the setting is one of the delays or 0', () => {
    for (const days of UNUSED_PERMISSION_DAYS) expect(cleanUnusedPermissionDays(days)).toBe(days)
    for (const bad of [-1, 1, 45, NaN, '90', null, undefined]) expect(cleanUnusedPermissionDays(bad)).toBe(0)
  })
  it('the table keeps sites that hold an answer with a real day, and stays within its ceiling', () => {
    expect(cleanSiteVisits({ [A]: 10, [B]: 'x', 'https://c.example': 5, '*': 3, [`https://o.example`]: -4 }, answers)).toEqual({ [A]: 10 })
    expect(cleanSiteVisits([1, 2], answers)).toEqual({})
    expect(cleanSiteVisits(null, answers)).toEqual({})
    const many = Object.fromEntries(Array.from({ length: SITE_VISITS_MAX + 50 }, (_, i) => [`https://s${i}.example`, 5]))
    const wide = Object.fromEntries(Object.keys(many).map((origin) => [origin, { camera: 'allow' }])) as Record<string, Record<string, 'allow'>>
    expect(Object.keys(cleanSiteVisits(many, wide))).toHaveLength(SITE_VISITS_MAX)
  })
})

describe('visitOrigin', () => {
  it('is the origin of a web page, and nothing for another scheme or a text that is no address', () => {
    expect(visitOrigin('https://a.example:8443/x?y#z')).toBe('https://a.example:8443')
    expect(visitOrigin('http://a.example/')).toBe('http://a.example')
    expect(visitOrigin('file:///etc/hosts')).toBeNull()
    expect(visitOrigin('lucium://settings')).toBeNull()
    expect(visitOrigin('not an address')).toBeNull()
  })
})

describe('the reducer', () => {
  const ctx: Ctx = { now: 1_790_000_000_000, newId: (() => { let n = 0; return () => `id-${++n}` })() }
  const play = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, action) => reduce(s, action, ctx), state)
  const given = (days: number): SidebarState => {
    const state = createInitialState(ctx)
    return play({ ...state, settings: { ...state.settings, forgetUnusedPermissionsDays: days } }, { type: 'permission/set', origin: A, permission: 'camera', decision: 'allow' })
  }

  it('writes a visit once a day: the same state comes back for a second visit the same day', () => {
    const first = play(given(90), { type: 'permission/visit', origin: A, day: 100 })
    expect(first.siteVisits).toEqual({ [A]: 100 })
    expect(reduce(first, { type: 'permission/visit', origin: A, day: 100 }, ctx)).toBe(first)
  })
  it('writes no visit for a site with no answer', () => {
    const state = given(90)
    expect(reduce(state, { type: 'permission/visit', origin: B, day: 100 }, ctx)).toBe(state)
  })
  it('sweeps only while the setting is on: off, the answers stay whatever the day', () => {
    const off = play(given(0), { type: 'permission/visit', origin: A, day: 1 })
    expect(reduce(off, { type: 'permission/sweep', day: 50_000 }, ctx)).toBe(off)
    const on = play(given(30), { type: 'permission/visit', origin: A, day: 1 })
    const swept = reduce(on, { type: 'permission/sweep', day: 31 }, ctx)
    expect(swept.sitePermissions).toEqual({})
    expect(swept.siteVisits).toEqual({})
  })
  it('keeps the answers of a site visited inside the delay', () => {
    const on = play(given(30), { type: 'permission/visit', origin: A, day: 2 })
    expect(reduce(on, { type: 'permission/sweep', day: 31 }, ctx).sitePermissions).toEqual({ [A]: { camera: 'allow' } })
  })
  it('forgetting the last answer of a site forgets its visit too', () => {
    const visited = play(given(90), { type: 'permission/visit', origin: A, day: 100 })
    expect(play(visited, { type: 'permission/set', origin: A, permission: 'camera', decision: null }).siteVisits).toEqual({})
  })
  it('the interface cannot send a visit or a sweep: they are the main process’', () => {
    const known: string[] = []
    expect(interfaceMayDispatch({ type: 'permission/visit', origin: A, day: 1 }, known)).toBe(false)
    expect(interfaceMayDispatch({ type: 'permission/sweep', day: 1 }, known)).toBe(false)
  })
})
