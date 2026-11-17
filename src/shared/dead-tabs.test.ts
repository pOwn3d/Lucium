// Which tabs are offered as tabs whose site no longer answers (dead-tabs.ts): the failures that say the site is gone, never a certificate, nothing
// while the network is down or when no site answered, never a pinned tab or the page of a favourite, never a tab kept for its address lately; and
// what the rows of the sheet say. The run that collects the loads: main/shell/reload-all-run.test.ts; the sheet: renderer/dead-tabs-sheet.test.ts.

import { beforeEach, describe, expect, it } from 'vitest'
import { setLanguage } from './i18n'
import type { SidebarState, TabItem } from './model'
import { createInitialState, reduce } from './sidebar'
import { DEAD_KEPT_MS, deadReasonLabel, deadReasonOf, deadTabGroups, deadTabRows, deadTabsToOffer, isKeptDead, stillOffered, withLaterEntries, type LoadFailure } from './dead-tabs'

const tab = (id: string, over: Partial<TabItem> = {}): TabItem => ({ id, spaceId: 'sp', url: `https://${id}.example/`, title: `Titre ${id}`, pinned: false, createdAt: 1, lastActiveAt: 1, ...over })
const network = (name: string): LoadFailure => ({ kind: 'network', name })
const NOW = 1_000_000_000_000
const facts = { online: true, now: NOW }

beforeEach(() => setLanguage('fr'))

describe('the failures that make a dead tab', () => {
  it('are the network errors of a site that is gone, each with its reason', () => {
    expect(deadReasonOf(network('ERR_NAME_NOT_RESOLVED'))).toBe('not-found')
    expect(deadReasonOf(network('ERR_CONNECTION_REFUSED'))).toBe('refused')
    expect(deadReasonOf(network('ERR_CONNECTION_RESET'))).toBe('reset')
    expect(deadReasonOf(network('ERR_CONNECTION_CLOSED'))).toBe('reset')
    expect(deadReasonOf(network('ERR_CONNECTION_TIMED_OUT'))).toBe('timed-out')
    expect(deadReasonOf(network('ERR_TIMED_OUT'))).toBe('timed-out')
    expect(deadReasonOf(network('ERR_ADDRESS_UNREACHABLE'))).toBe('unreachable')
  })

  it('are not the errors of this Mac being offline, nor an error the site may recover from', () => {
    for (const name of ['ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED', 'ERR_NAME_RESOLUTION_FAILED', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_EMPTY_RESPONSE', 'ERR_BLOCKED_BY_CLIENT']) expect(deadReasonOf(network(name)), name).toBeNull()
  })

  it('never are a certificate that is refused: a test server often has one of its own', () => {
    expect(deadReasonOf({ kind: 'certificate', name: 'ERR_CERT_AUTHORITY_INVALID' })).toBeNull()
    expect(deadReasonOf({ kind: 'certificate', name: 'ERR_CERT_DATE_INVALID' })).toBeNull()
  })

  it('are a page removed (410) or not found (404), not a server in trouble', () => {
    expect(deadReasonOf({ kind: 'status', status: 404 })).toBe('missing')
    expect(deadReasonOf({ kind: 'status', status: 410 })).toBe('removed')
    for (const status of [401, 403, 500, 502, 503]) expect(deadReasonOf({ kind: 'status', status }), String(status)).toBeNull()
    expect(deadReasonOf(null)).toBeNull()
  })

  it('are said in plain words', () => {
    expect(['not-found', 'refused', 'reset', 'timed-out', 'unreachable', 'missing', 'removed'].map((reason) => deadReasonLabel(reason as never))).toEqual([
      'Adresse introuvable', 'Connexion refusée', 'Connexion réinitialisée', 'Délai dépassé', 'Adresse injoignable', 'Page introuvable (404)', 'Page supprimée (410)'
    ])
    setLanguage('en')
    expect(deadReasonLabel('not-found')).toBe('Address not found')
  })
})

describe('the tabs offered', () => {
  const tabs = [tab('a'), tab('dead'), tab('cert'), tab('gone404'), tab('slow')]
  const outcomes = new Map<string, LoadFailure | null>([
    ['a', null],
    ['dead', network('ERR_NAME_NOT_RESOLVED')],
    ['cert', { kind: 'certificate', name: 'ERR_CERT_AUTHORITY_INVALID' }],
    ['gone404', { kind: 'status', status: 404 }]
  ])

  it('are the dead ones among the loads looked at, in the order of the sidebar, a tab not looked at being left out', () => {
    const reversed = new Map([...outcomes].reverse())
    expect(deadTabsToOffer(reversed, tabs, facts)).toEqual([{ id: 'dead', reason: 'not-found' }, { id: 'gone404', reason: 'missing' }])
  })

  it('are none while the network is down', () => {
    expect(deadTabsToOffer(outcomes, tabs, { ...facts, online: false })).toEqual([])
  })

  it('are none when no site answered at all: the trouble is more likely on this side', () => {
    const allFailed = new Map<string, LoadFailure | null>([['dead', network('ERR_NAME_NOT_RESOLVED')], ['slow', network('ERR_CONNECTION_TIMED_OUT')]])
    expect(deadTabsToOffer(allFailed, tabs, facts)).toEqual([])
    // A certificate refused or a status is a server that answered: the network works.
    expect(deadTabsToOffer(new Map([...allFailed, ['cert', { kind: 'certificate', name: 'ERR_CERT_AUTHORITY_INVALID' }]]), tabs, facts)).toHaveLength(2)
    expect(deadTabsToOffer(new Map([...allFailed, ['gone404', { kind: 'status', status: 500 }]]), tabs, facts)).toHaveLength(2)
  })

  it('are a pinned tab too (a test server gone is often pinned), but never the page of a favourite nor a tab of a locked space', () => {
    const marked = [tab('a'), tab('dead', { pinned: true }), tab('gone404', { favoriteId: 'fav' }), tab('favPinned', { pinned: true, favoriteId: 'fav2' }), tab('slow', { spaceId: 'locked' })]
    const failed = new Map<string, LoadFailure | null>([['a', null], ['dead', network('ERR_NAME_NOT_RESOLVED')], ['gone404', { kind: 'status', status: 404 }], ['favPinned', network('ERR_NAME_NOT_RESOLVED')], ['slow', network('ERR_CONNECTION_REFUSED')]])
    expect(deadTabsToOffer(failed, marked, { ...facts, hidden: (t) => t.spaceId === 'locked' })).toEqual([{ id: 'dead', reason: 'not-found' }])
    expect(deadTabsToOffer(failed, marked, facts)).toEqual([{ id: 'dead', reason: 'not-found' }, { id: 'slow', reason: 'refused' }])
  })

  it('offer the pinned preproduction servers that no longer resolve, and leave their refused certificates alone', () => {
    // What the maintainer saw: pinned tabs on ppd-… and .local hosts that no longer resolve, beside test servers whose certificate is refused.
    const tabs = [tab('ppd', { pinned: true, url: 'https://ppd-app.example/' }), tab('local', { pinned: true, url: 'http://intranet.local/' }), tab('cert', { pinned: true }), tab('ok')]
    const failed = new Map<string, LoadFailure | null>([['ppd', network('ERR_NAME_NOT_RESOLVED')], ['local', network('ERR_NAME_NOT_RESOLVED')], ['cert', { kind: 'certificate', name: 'ERR_CERT_AUTHORITY_INVALID' }], ['ok', null]])
    expect(deadTabsToOffer(failed, tabs, facts)).toEqual([{ id: 'ppd', reason: 'not-found' }, { id: 'local', reason: 'not-found' }])
  })

  it('leave out a tab the user kept for the address it still has, for thirty days', () => {
    const kept = (url: string, at: number) => [tab('a'), tab('dead', { deadKept: { url, at } })]
    const failed = new Map<string, LoadFailure | null>([['a', null], ['dead', network('ERR_NAME_NOT_RESOLVED')]])
    expect(deadTabsToOffer(failed, kept('https://dead.example/', NOW - 1000), facts)).toEqual([])
    expect(deadTabsToOffer(failed, kept('https://dead.example/', NOW - DEAD_KEPT_MS + 1), facts)).toEqual([])
    // Kept long ago, or for another address it has left since: offered again.
    expect(deadTabsToOffer(failed, kept('https://dead.example/', NOW - DEAD_KEPT_MS), facts)).toEqual([{ id: 'dead', reason: 'not-found' }])
    expect(deadTabsToOffer(failed, kept('https://dead.example/old', NOW - 1000), facts)).toEqual([{ id: 'dead', reason: 'not-found' }])
  })

  it('reads a mark from the future (a clock put back) as no mark', () => {
    expect(isKeptDead(tab('x', { deadKept: { url: 'https://x.example/', at: NOW + 60_000 } }), NOW)).toBe(false)
    expect(isKeptDead(tab('x', { deadKept: { url: 'https://x.example/', at: NOW } }), NOW)).toBe(true)
  })

  it('are shown when the sheet opens only while still open and not the page of a favourite (pinned since, a tab is still shown)', () => {
    const entries = [{ id: 'a', reason: 'not-found' as const }, { id: 'b', reason: 'refused' as const }, { id: 'c', reason: 'reset' as const }, { id: 'd', reason: 'reset' as const }]
    expect(stillOffered(entries, [tab('b', { pinned: true }), tab('c'), tab('d', { favoriteId: 'fav' })])).toEqual([{ id: 'b', reason: 'refused' }, { id: 'c', reason: 'reset' }])
  })

  it('are no longer shown by an open sheet once kept for their address (a run that goes on brings them again)', () => {
    const entries = [{ id: 'kept', reason: 'not-found' as const }, { id: 'c', reason: 'reset' as const }]
    const tabs = [tab('kept', { deadKept: { url: 'https://kept.example/', at: NOW - 1000 } }), tab('c')]
    expect(stillOffered(entries, tabs, NOW)).toEqual([{ id: 'c', reason: 'reset' }])
    // Without the time (the notice, which was computed before), only the tabs closed since are left out.
    expect(stillOffered(entries, tabs)).toEqual(entries)
  })
})

describe('« Tout garder »', () => {
  it('marks each tab with the address it has and the time of the reducer, and only tabs that exist', () => {
    let n = 0
    const ctx = { now: NOW, newId: () => `id${++n}` }
    let state: SidebarState = createInitialState(ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://dead.example/page', background: true }, ctx)
    const id = state.tabs[0]!.id
    const kept = reduce(state, { type: 'tabs/keep-dead', ids: [id, 'nobody'] }, ctx)
    expect(kept.tabs[0]!.deadKept).toEqual({ url: 'https://dead.example/page', at: NOW })
    expect(reduce(state, { type: 'tabs/keep-dead', ids: ['nobody'] }, ctx)).toBe(state)
    expect(reduce(state, { type: 'tabs/keep-dead', ids: 'all' as never }, ctx)).toBe(state)
  })
})

describe('« Fermer les onglets cochés » with pinned tabs among them', () => {
  /** A Today tab, a pinned tab, and the page of a favourite that is pinned. */
  function threeTabs() {
    let n = 0
    const ctx = { now: NOW, newId: () => `id${++n}` }
    let state: SidebarState = createInitialState(ctx)
    for (const url of ['https://today.example/', 'https://ppd-app.example/', 'https://fav.example/']) state = reduce(state, { type: 'tab/open', url, background: true }, ctx)
    const [today, pinned, fav] = state.tabs.map((t) => t.id) as [string, string, string]
    state = reduce(state, { type: 'tab/pin', id: pinned }, ctx)
    state = { ...state, tabs: state.tabs.map((t) => (t.id === fav ? { ...t, pinned: true, favoriteId: 'f1' } : t)) }
    return { state, ctx, today, pinned, fav }
  }

  it('sends them all to the archive in one go, the pinned one out of the pinned tabs, and « Annuler » brings it back pinned', () => {
    const { state, ctx, today, pinned } = threeTabs()
    const closed = reduce(state, { type: 'tabs/archive-many', ids: [today, pinned], pinned: true }, ctx)
    expect(closed.tabs.map((t) => t.id)).not.toContain(pinned)
    expect(closed.tabs.map((t) => t.id)).not.toContain(today)
    expect(closed.archive.slice(0, 2).map((entry) => [entry.url, entry.pinned === true])).toEqual(expect.arrayContaining([['https://ppd-app.example/', true], ['https://today.example/', false]]))
    const back = reduce(closed, { type: 'archive/restore-last', count: 2 }, ctx)
    expect(back.tabs.find((t) => t.url === 'https://ppd-app.example/')?.pinned).toBe(true)
    expect(back.tabs.find((t) => t.url === 'https://today.example/')?.pinned).toBe(false)
  })

  it('leaves a pinned tab alone without a real `true`, and the page of a favourite in any case', () => {
    const { state, ctx, pinned, fav } = threeTabs()
    expect(reduce(state, { type: 'tabs/archive-many', ids: [pinned] }, ctx)).toBe(state)
    expect(reduce(state, { type: 'tabs/archive-many', ids: [pinned], pinned: 'yes' as never }, ctx)).toBe(state)
    expect(reduce(state, { type: 'tabs/archive-many', ids: [fav], pinned: true }, ctx)).toBe(state)
  })
})

describe('the groups of the sheet', () => {
  it('put the pinned tabs first, then those of the day, each in the order of its rows, and leave out an empty group', () => {
    const row = (id: string, pinned: boolean) => ({ tab: tab(id, { pinned }), name: id, address: id, reason: 'x' })
    const rows = [row('t1', false), row('p1', true), row('t2', false), row('p2', true)]
    expect(deadTabGroups(rows).map((group) => [group.kind, group.rows.map((r) => r.tab.id)])).toEqual([['pinned', ['p1', 'p2']], ['today', ['t1', 't2']]])
    expect(deadTabGroups([row('t1', false)]).map((group) => group.kind)).toEqual(['today'])
    expect(deadTabGroups([])).toEqual([])
  })

  it('add the tabs a run finds while the sheet is open after those it opened with, each tab once', () => {
    const first = [{ id: 'a', reason: 'not-found' as const }]
    expect(withLaterEntries(first, [{ id: 'b', reason: 'refused' as const }, { id: 'a', reason: 'not-found' as const }])).toEqual([{ id: 'a', reason: 'not-found' }, { id: 'b', reason: 'refused' }])
    expect(withLaterEntries(first, undefined)).toEqual(first)
  })
})

describe('the rows of the sheet', () => {
  function stateWith(spaces: number): SidebarState {
    let n = 0
    const ctx = { now: 1, newId: () => `id${++n}` }
    let state = createInitialState(ctx)
    if (spaces > 1) state = reduce(state, { type: 'space/create', name: 'Perso', emoji: '🏡', hue: 100 }, ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://preprod.example/app/login?next=1', background: true, spaceId: state.spaces.at(-1)!.id }, ctx)
    return { ...state, tabs: state.tabs.map((t) => ({ ...t, title: 'Ancienne préproduction' })) }
  }

  it('say the name, the address without its scheme and the reason, and the space when the window has several', () => {
    const one = stateWith(1)
    const [row] = deadTabRows([{ id: one.tabs[0]!.id, reason: 'not-found' }], one)
    expect(row).toMatchObject({ name: 'Ancienne préproduction', address: 'preprod.example/app/login?next=1', reason: 'Adresse introuvable' })
    expect(row!.space).toBeUndefined()
    const two = stateWith(2)
    expect(deadTabRows([{ id: two.tabs[0]!.id, reason: 'timed-out' }], two)[0]).toMatchObject({ reason: 'Délai dépassé', space: '🏡 Perso' })
  })

  it('leave out a tab closed since the notice', () => {
    expect(deadTabRows([{ id: 'gone', reason: 'refused' }], stateWith(1))).toEqual([])
  })
})
