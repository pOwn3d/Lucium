// Forgetting the pages of closed tabs: "Effacer l'historique de navigation" takes the Back lists of the archive
// with it, and "Effacer les données du site…" takes the site's pages out of them. The archived tabs themselves stay.

import { describe, expect, it } from 'vitest'
import { closedHistoryAfter } from './closed-history'
import { interfaceMayDispatch } from './ipc-policy'
import type { ArchivedTab, ClosedHistory, SidebarState } from './model'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'

const at = (host: string, n: number) => ({ url: `https://${host}/p${n}`, title: `${host} ${n}` })

describe('closedHistoryAfter (the Back list of one tab)', () => {
  const list: ClosedHistory = { entries: [at('bank.example', 1), at('news.example', 2), at('mail.example', 3), at('bank.example', 4), at('news.example', 5)], index: 4 }

  it('drops the whole list when no site is named (clearing the history)', () => {
    expect(closedHistoryAfter(list, 'https://news.example/p5', undefined)).toBeUndefined()
  })

  it('takes the pages of the site out and moves the index with them (this fails if the pages stay or the index is not moved)', () => {
    const after = closedHistoryAfter(list, 'https://news.example/p5', { host: 'bank.example', subdomains: false })
    expect(after).toEqual({ entries: [at('news.example', 2), at('mail.example', 3), at('news.example', 5)], index: 2 })
    expect(after!.entries[after!.index]!.url).toBe('https://news.example/p5')
    expect(JSON.stringify(after)).not.toContain('bank.example')
  })

  it('keeps the pages after the current one in step too (a tab that had gone back)', () => {
    const back: ClosedHistory = { entries: [at('bank.example', 1), at('news.example', 2), at('bank.example', 3), at('mail.example', 4)], index: 1 }
    expect(closedHistoryAfter(back, 'https://news.example/p2', { host: 'bank.example', subdomains: false })).toEqual({ entries: [at('news.example', 2), at('mail.example', 4)], index: 0 })
  })

  it('leaves the list as it is, the very same object, when none of its pages is on the site', () => {
    expect(closedHistoryAfter(list, 'https://news.example/p5', { host: 'other.example', subdomains: false })).toBe(list)
  })

  it('takes the subdomains only when asked', () => {
    const withSub: ClosedHistory = { entries: [at('www.bank.example', 1), at('news.example', 2), at('news.example', 3)], index: 2 }
    expect(closedHistoryAfter(withSub, 'https://news.example/p3', { host: 'bank.example', subdomains: false })).toBe(withSub)
    expect(closedHistoryAfter(withSub, 'https://news.example/p3', { host: 'bank.example', subdomains: true })).toEqual({ entries: [at('news.example', 2), at('news.example', 3)], index: 1 })
  })

  it('goes with its whole list when the tab itself is on the site: the list ends on the tab’s own page, which cannot stay (this fails if the tab’s own page is kept)', () => {
    expect(closedHistoryAfter(list, 'https://news.example/p5', { host: 'news.example', subdomains: false })).toBeUndefined()
  })

  it('is undefined when fewer than two pages would be left (a list of one page brings nothing back)', () => {
    const two: ClosedHistory = { entries: [at('bank.example', 1), at('news.example', 2)], index: 1 }
    expect(closedHistoryAfter(two, 'https://news.example/p2', { host: 'bank.example', subdomains: false })).toBeUndefined()
  })

  it('matches a host with its port as the history does, and not another port', () => {
    const local: ClosedHistory = { entries: [{ url: 'http://localhost:3000/a', title: '' }, { url: 'http://localhost:4000/b', title: '' }, { url: 'https://news.example/c', title: '' }], index: 2 }
    expect(closedHistoryAfter(local, 'https://news.example/c', { host: 'localhost:3000', subdomains: false })).toEqual({ entries: [local.entries[1], local.entries[2]], index: 1 })
  })
})

describe('the reducer (archive/forget-pages)', () => {
  const entry = (id: string, spaceId: string, url: string, history?: ClosedHistory): ArchivedTab => ({ id, spaceId, url, title: id, archivedAt: 1, ...(history ? { history } : {}) })
  const ctx: Ctx = { now: 5, newId: () => 'n' }
  const longList = (): ClosedHistory => ({ entries: [at('bank.example', 1), at('news.example', 2), at('mail.example', 3)], index: 2 })
  const state = (): SidebarState => {
    const base = createInitialState({ now: 1, newId: () => 'sp' })
    const work = { ...base.spaces[0]!, id: 'work-space', profileId: 'work' }
    return {
      ...base,
      spaces: [base.spaces[0]!, work],
      archive: [
        entry('home-1', 'sp', 'https://mail.example/p3', longList()),
        entry('work-1', 'work-space', 'https://mail.example/p3', longList()),
        entry('home-bare', 'sp', 'https://news.example/x'),
        entry('home-bank', 'sp', 'https://bank.example/p2', { entries: [at('news.example', 1), at('bank.example', 2)], index: 1 })
      ]
    }
  }

  it('forgets the lists of the spaces of the profile and keeps every archived tab, its address and its title', () => {
    const after = reduce(state(), { type: 'archive/forget-pages', profileId: 'default' }, ctx)
    expect(after.archive.map((e) => [e.id, e.url, e.title])).toEqual(state().archive.map((e) => [e.id, e.url, e.title]))
    expect(after.archive.filter((e) => e.history).map((e) => e.id)).toEqual(['work-1'])
  })

  it('forgets nothing of another profile (this fails if the profile is not looked at)', () => {
    const after = reduce(state(), { type: 'archive/forget-pages', profileId: 'default' }, ctx)
    expect(after.archive.find((e) => e.id === 'work-1')!.history).toEqual(longList())
    const other = reduce(state(), { type: 'archive/forget-pages', profileId: 'work' }, ctx)
    expect(other.archive.find((e) => e.id === 'home-1')!.history).toEqual(longList())
    expect(other.archive.find((e) => e.id === 'work-1')).not.toHaveProperty('history')
  })

  it('takes the pages of a site out of the lists of the profile; the tab that is on that site loses its list and stays', () => {
    const after = reduce(state(), { type: 'archive/forget-pages', profileId: 'default', site: { host: 'bank.example', subdomains: false } }, ctx)
    const byId = Object.fromEntries(after.archive.map((e) => [e.id, e]))
    expect(byId['home-1']!.history).toEqual({ entries: [at('news.example', 2), at('mail.example', 3)], index: 1 })
    expect(byId['home-bank']).toBeDefined()
    expect(byId['home-bank']).not.toHaveProperty('history')
    expect(byId['home-bank']!.url).toBe('https://bank.example/p2')
    // The other profile's list still holds the site’s page.
    expect(byId['work-1']!.history).toEqual(longList())
    expect(after.archive).toHaveLength(4)
  })

  it('never turns a site that is not a host into "forget everything"', () => {
    const before = state()
    for (const host of ['', 'not a host!', 'a/b', 42 as unknown as string]) {
      expect(reduce(before, { type: 'archive/forget-pages', profileId: 'default', site: { host, subdomains: false } }, ctx), String(host)).toBe(before)
    }
  })

  it('returns the same state when there was nothing to forget', () => {
    const before = state()
    expect(reduce(before, { type: 'archive/forget-pages', profileId: 'nobody' }, ctx)).toBe(before)
    expect(reduce(before, { type: 'archive/forget-pages', profileId: 'default', site: { host: 'unrelated.example', subdomains: false } }, ctx)).toBe(before)
  })

  describe('a space put aside (its archive is kept in its session, in the state file)', () => {
    const aside = (): SidebarState => {
      const withWork = reduce(state(), { type: 'space/aside', id: 'work-space' }, ctx)
      // The space took its archived tab, and the list of that tab, into the session.
      expect(withWork.archive.map((e) => e.id)).not.toContain('work-1')
      expect(withWork.sessions[0]!.space!.archive[0]!.history).toEqual(longList())
      return withWork
    }

    it('loses its lists with the history of its profile, and keeps its archived tabs (this fails if only the archive on screen is cleaned)', () => {
      const after = reduce(aside(), { type: 'archive/forget-pages', profileId: 'work' }, ctx)
      const kept = after.sessions[0]!.space!.archive
      expect(kept.map((e) => [e.id, e.url])).toEqual([['work-1', 'https://mail.example/p3']])
      expect(kept[0]).not.toHaveProperty('history')
      expect(JSON.stringify(after.sessions)).not.toContain('bank.example')
    })

    it('loses only the pages of a site when a site is named', () => {
      const after = reduce(aside(), { type: 'archive/forget-pages', profileId: 'work', site: { host: 'bank.example', subdomains: false } }, ctx)
      expect(after.sessions[0]!.space!.archive[0]!.history).toEqual({ entries: [at('news.example', 2), at('mail.example', 3)], index: 1 })
    })

    it('keeps its lists when the history of another profile is erased, in the very same sessions', () => {
      const before = aside()
      const after = reduce(before, { type: 'archive/forget-pages', profileId: 'default' }, ctx)
      expect(after.sessions).toBe(before.sessions)
      expect(after.sessions[0]!.space!.archive[0]!.history).toEqual(longList())
    })
  })

  describe('a private tab', () => {
    const pages = [at('secret.example', 1), at('secret.example', 2)]

    it('is never asked for its pages, and leaves no list in the archive, with the setting on (this fails if a private tab reaches the archive)', () => {
      const base = reduce(reduce(createInitialState({ now: 1, newId: () => 'sp' }), { type: 'settings/update', patch: { reopenHistory: true } }, ctx), { type: 'tab/open', url: 'https://secret.example/p2', private: true }, { now: 2, newId: () => 'secret' })
      const asked: string[] = []
      const reading: Ctx = { ...ctx, closedHistory: (tabId) => (asked.push(tabId), { entries: pages, index: 1 }) }
      const leaving: Action[] = [{ type: 'tab/archive', id: 'secret' }, { type: 'tab/close', id: 'secret' }, { type: 'tabs/archive-many', ids: ['secret'] }]
      for (const action of leaving) {
        const after = reduce(base, action, reading)
        expect(after.tabs.some((t) => t.id === 'secret'), action.type).toBe(false)
        expect(after.archive, action.type).toEqual([])
      }
      expect(asked).toEqual([])
      // The same reader does give its list to a tab that is not private: the check above is not passing for want of a reader.
      const open = reduce(base, { type: 'tab/open', url: 'https://secret.example/p2' }, { now: 3, newId: () => 'plain' })
      expect(reduce(open, { type: 'tab/archive', id: 'plain' }, reading).archive[0]!.history).toEqual({ entries: pages, index: 1 })
      expect(asked).toEqual(['plain'])
    })
  })

  it('is not an action the interface may send', () => {
    expect(interfaceMayDispatch({ type: 'archive/forget-pages', profileId: 'default' }, [])).toBe(false)
  })
})
