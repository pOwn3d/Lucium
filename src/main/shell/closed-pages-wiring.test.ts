// Where the Back lists of the archived tabs are forgotten: with the history of a profile (the menu entry, the
// erasure of a profile's data), and with a site's history (the site-data panel, its shortcut, the erasure when a site's last tab closes).
// The real methods of the shell, called on stand-ins (no window); the rules themselves are in shared/closed-history-forget.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'

// Electron, as far as these need it: every name answers a stand-in that does nothing.
const electron = vi.hoisted(() => {
  const quiet = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (quiet(prop) ? undefined : stub), apply: () => stub })
  const withStub = (target: Record<string, unknown>): unknown => new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : quiet(prop) ? undefined : stub), has: (t, prop) => prop in t || !quiet(prop) })
  return { module: withStub({ app: withStub({ getPath: () => '/nonexistent' }) }) }
})
vi.mock('electron', () => electron.module as Record<string, unknown>)

const { Browser } = await import('./browser')
const { setSessionBackups } = await import('./backups')
type Method = (this: unknown, ...args: unknown[]) => unknown
const method = (name: string): Method => (Browser.prototype as unknown as Record<string, Method>)[name]!

/** A shell of which only `own` is real; whatever else a method touches does nothing. */
const inert: unknown = new Proxy(function () {}, { get: (_t, prop) => (typeof prop === 'symbol' || prop === 'then' ? undefined : inert), apply: () => inert })
function shell<T extends Record<string, unknown>>(own: T): T {
  return new Proxy(own, { get: (target, prop: string) => (prop in target ? target[prop] : inert) })
}

const forgetPages = vi.fn()
beforeEach(() => {
  forgetPages.mockReset()
  setSessionBackups({ forgetPages } as never)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  setSessionBackups(null)
  vi.restoreAllMocks()
})

describe('forgetClosedPages', () => {
  const window = (privateWindow: boolean) => {
    const dispatch = vi.fn()
    return { dispatch, self: shell({ isPrivate: () => privateWindow, dispatch }) }
  }

  it('forgets them in the archive of the state and in the copies of the session on disk, for the profile', () => {
    const { self, dispatch } = window(false)
    method('forgetClosedPages').call(self, 'work')
    expect(dispatch).toHaveBeenCalledWith({ type: 'archive/forget-pages', profileId: 'work' })
    expect(forgetPages).toHaveBeenCalledWith({ profileId: 'work' })
  })

  it('names the site, and its subdomains when asked, in both', () => {
    const { self, dispatch } = window(false)
    method('forgetClosedPages').call(self, 'default', { host: 'bank.example', subdomains: true })
    expect(dispatch).toHaveBeenCalledWith({ type: 'archive/forget-pages', profileId: 'default', site: { host: 'bank.example', subdomains: true } })
    expect(forgetPages).toHaveBeenCalledWith({ profileId: 'default', site: { host: 'bank.example', subdomains: true } })
  })

  it('forgets the lists kept in memory for the sleeping tabs too, with the same scope', () => {
    const slept = { forgetPages: vi.fn() }
    const dispatch = vi.fn()
    method('forgetClosedPages').call(shell({ isPrivate: () => false, dispatch, leader: { slept } }), 'work', { host: 'bank.example', subdomains: false })
    expect(slept.forgetPages).toHaveBeenCalledWith({ profileId: 'work', site: { host: 'bank.example', subdomains: false } })
  })

  it('touches nothing from a private window, which keeps neither an archive nor copies', () => {
    const { self, dispatch } = window(true)
    method('forgetClosedPages').call(self, 'default')
    expect(dispatch).not.toHaveBeenCalled()
    expect(forgetPages).not.toHaveBeenCalled()
  })

  it('does not throw when the copies cannot be cleaned: the state was cleaned, and the failure is logged', () => {
    forgetPages.mockImplementation(() => {
      throw new Error('disk gone')
    })
    const { self, dispatch } = window(false)
    expect(() => method('forgetClosedPages').call(self, 'default')).not.toThrow()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not be cleaned'), expect.any(Error))
  })
})

describe('the history of a profile', () => {
  /** A shell whose history, dispatch and copies are recorded, with the real `eraseProfileHistory` and `forgetClosedPages` on it. */
  function profileShell(erase: () => boolean) {
    const dispatch = vi.fn()
    const state = createInitialState({ now: 1, newId: () => 'sp' })
    const self = shell({
      isPrivate: () => false,
      dispatch,
      history: { erase: vi.fn(erase) },
      store: { get: () => state, dispatch: vi.fn() },
      engine: { clearProfileData: async () => undefined, deleteProfileData: async () => undefined },
      pages: new Map(),
      // The window is alone in its group: erasing a profile reloads the tabs of every window of it.
      group: new Set(),
      eraseProfileHistory: (id: string) => method('eraseProfileHistory').call(self, id),
      eraseHistory: (id: string) => method('eraseHistory').call(self, id),
      forgetClosedPages: (id: string, site?: unknown) => method('forgetClosedPages').call(self, id, site)
    })
    return { self, dispatch }
  }
  const forgot = (dispatch: ReturnType<typeof vi.fn>, profileId: string): boolean => dispatch.mock.calls.some(([action]) => (action as { type: string; profileId?: string }).type === 'archive/forget-pages' && (action as { profileId?: string }).profileId === profileId)

  it('« Effacer l’historique de navigation » takes the Back lists of the profile with it', () => {
    const { self, dispatch } = profileShell(() => true)
    expect(method('eraseHistory').call(self, 'work')).toBe(true)
    expect(forgot(dispatch, 'work')).toBe(true)
    expect(forgetPages).toHaveBeenCalledWith({ profileId: 'work' })
  })

  it('takes them whatever became of the erasure of the visits, and still answers what the erasure answered', () => {
    const { self, dispatch } = profileShell(() => false)
    expect(method('eraseHistory').call(self, 'work')).toBe(false)
    expect(forgot(dispatch, 'work')).toBe(true)
    const thrown = profileShell(() => {
      throw new Error('history file locked')
    })
    expect(() => method('eraseHistory').call(thrown.self, 'work')).toThrow('history file locked')
    expect(forgot(thrown.dispatch, 'work')).toBe(true)
  })

  it('erasing the data of a profile, or deleting it, takes them too', async () => {
    const cleared = profileShell(() => true)
    await method('clearProfile').call(cleared.self, 'work')
    expect(forgot(cleared.dispatch, 'work')).toBe(true)
    const deleted = profileShell(() => true)
    await method('deleteProfile').call(deleted.self, 'work')
    expect(forgot(deleted.dispatch, 'work')).toBe(true)
  })
})

describe('the data of a site', () => {
  /** The environment a site-data erasure sees, built by the real method on a shell with these tabs. */
  function environmentOf(over: { current?: Record<string, unknown>; profile?: string } = {}) {
    const base: SidebarState = createInitialState({ now: 1, newId: () => 'sp' })
    const current = over.current ? { id: 't1', spaceId: 'sp', url: 'https://bank.example/', title: 't', pinned: false, createdAt: 1, lastActiveAt: 1, ...over.current } : undefined
    const state: SidebarState = { ...base, tabs: current ? [current as never] : [], activeTabBySpace: current ? { sp: 't1' } : {} }
    const forgetClosedPages = vi.fn()
    const self = shell({
      store: { get: () => state },
      group: [{ pages: new Map(), containerKeyOf: () => '' }],
      pages: new Map(),
      history: { of: () => ({ removeSite: () => 0, hosts: () => [] }) },
      containerKeyOf: (tab?: { container?: string }) => tab?.container ?? '',
      engineOf: () => ({ clearSiteData: async () => [] }),
      isPrivate: () => false,
      forgetClosedPages
    })
    const env = method('siteDataEnvironment').call(self, undefined, over.profile) as { closedPages: { removeSite(host: string, subdomains: boolean): void } }
    return { env, forgetClosedPages }
  }

  it('takes the pages of the site out of the Back lists of the profile’s closed tabs', () => {
    const { env, forgetClosedPages } = environmentOf({ current: {} })
    env.closedPages.removeSite('bank.example', true)
    expect(forgetClosedPages).toHaveBeenCalledWith('default', { host: 'bank.example', subdomains: true })
  })

  it('does it for the profile of the run when it is a run for a whole profile (at close, at quit)', () => {
    const { env, forgetClosedPages } = environmentOf({ profile: 'work' })
    env.closedPages.removeSite('bank.example', false)
    expect(forgetClosedPages).toHaveBeenCalledWith('work', { host: 'bank.example', subdomains: false })
  })

  it('leaves them alone when the data erased is a private tab’s or a container’s, as the visit history is left alone', () => {
    const isolated = environmentOf({ current: { private: true } })
    isolated.env.closedPages.removeSite('bank.example', false)
    expect(isolated.forgetClosedPages).not.toHaveBeenCalled()
    const contained = environmentOf({ current: { container: 'work-box' } })
    contained.env.closedPages.removeSite('bank.example', false)
    expect(contained.forgetClosedPages).not.toHaveBeenCalled()
  })
})

describe('the history panel names the profile it lists', () => {
  // Two spaces, the second of the profile « work »; the space on screen is the second one, as after a change of space under the open panel.
  const state = (): SidebarState => {
    const base = createInitialState({ now: 0, newId: (() => { let n = 0; return () => `id${++n}` })() })
    const other = { ...base.spaces[0]!, id: 'space-work', profileId: 'work' }
    return { ...base, spaces: [...base.spaces, other], activeSpaceId: other.id }
  }
  const window = () => {
    const log = (pages: number, page: string) => ({ remove: vi.fn(), removeKept: vi.fn(), putBack: vi.fn(() => true), removeBetween: vi.fn(() => pages), between: vi.fn((): Array<{ url: string }> => []), search: vi.fn(() => [page]) })
    const logs = { default: log(3, 'default page'), work: log(5, 'work page') }
    const self = shell({ store: { get: state }, history: { of: (id: 'default' | 'work') => logs[id] }, activeHistory: method('activeHistory') })
    return { logs, self }
  }

  it('forgets the page in the history it was listed from, not in the one of the space now on screen', () => {
    const { logs, self } = window()
    method('forgetHistory').call(self, 'https://a.example/', 'default')
    expect(logs.default.remove).toHaveBeenCalledWith('https://a.example/')
    expect(logs.work.remove).not.toHaveBeenCalled()
  })

  it('forgets in the history of the space on screen when no profile is named (the command bar)', () => {
    const { logs, self } = window()
    method('forgetHistory').call(self, 'https://a.example/')
    expect(logs.work.remove).toHaveBeenCalledWith('https://a.example/')
    expect(logs.default.remove).not.toHaveBeenCalled()
  })

  it('forgets for good unless a way back is asked for; with one, the history of the profile keeps the page aside', () => {
    const { logs, self } = window()
    method('forgetHistory').call(self, 'https://a.example/', 'default', true)
    expect(logs.default.removeKept).toHaveBeenCalledWith('https://a.example/')
    expect(logs.default.remove).not.toHaveBeenCalled()
    expect(logs.work.removeKept).not.toHaveBeenCalled()
    method('forgetHistory').call(self, 'https://b.example/', 'default')
    expect(logs.default.remove).toHaveBeenCalledWith('https://b.example/')
    expect(logs.default.removeKept).toHaveBeenCalledTimes(1)
  })

  it('puts a page back in the history of the profile that is named, not in the one of the space now on screen, and says whether it is back', () => {
    const { logs, self } = window()
    expect(method('putBackHistory').call(self, 'https://a.example/', 'default')).toBe(true)
    expect(logs.default.putBack).toHaveBeenCalledWith('https://a.example/')
    expect(logs.work.putBack).not.toHaveBeenCalled()
    logs.default.putBack.mockReturnValue(false)
    expect(method('putBackHistory').call(self, 'https://a.example/', 'default')).toBe(false)
  })

  describe('and the ranking of the command bar follows', () => {
    const A = 'https://a.example/'
    /** The same window, with a ranking: the page A was picked 4 times in the default profile and twice in « work » (the profile on screen). */
    const ranked = (kept = true) => {
      const { logs } = window()
      logs.default.removeKept.mockReturnValue(kept as never)
      const dispatch = vi.fn()
      const store = { get: () => ({ ...state(), commandBarUsage: { default: { [`url:${A}`]: 4 }, work: { [`url:${A}`]: 2 } } }) }
      const self = shell({ store, history: { of: (id: 'default' | 'work') => logs[id] }, activeHistory: method('activeHistory'), dispatch })
      return { logs, self, dispatch }
    }

    it('a page forgotten for good leaves the ranking of the profile it was listed from', () => {
      const { self, dispatch } = ranked()
      method('forgetHistory').call(self, A, 'default')
      expect(dispatch.mock.calls).toEqual([[{ type: 'commandbar/forget', profileId: 'default', urls: [A] }]])
    })

    it('without a profile, it leaves the ranking of the profile on screen', () => {
      const { self, dispatch } = ranked()
      method('forgetHistory').call(self, A)
      expect(dispatch.mock.calls).toEqual([[{ type: 'commandbar/forget', profileId: 'work', urls: [A] }]])
    })

    it('a page that is not ranked sends nothing to the state', () => {
      const { self, dispatch } = ranked()
      method('forgetHistory').call(self, 'https://never.example/', 'default')
      expect(dispatch).not.toHaveBeenCalled()
    })

    it('forgotten with a way back, it leaves the ranking at once and comes back with its count when the history gives the page back', () => {
      const { self, dispatch } = ranked()
      method('forgetHistory').call(self, A, 'default', true)
      expect(dispatch.mock.calls).toEqual([[{ type: 'commandbar/forget', profileId: 'default', urls: [A] }]])
      dispatch.mockClear()
      expect(method('putBackHistory').call(self, A, 'default')).toBe(true)
      expect(dispatch.mock.calls).toEqual([[{ type: 'commandbar/put-back', profileId: 'default', url: A, count: 4 }]])
      // Once: a second request finds nothing kept.
      dispatch.mockClear()
      method('putBackHistory').call(self, A, 'default')
      expect(dispatch).not.toHaveBeenCalled()
    })

    it('does not come back in the ranking when the history no longer gives the page back, then or later', () => {
      const { logs, self, dispatch } = ranked()
      method('forgetHistory').call(self, A, 'default', true)
      dispatch.mockClear()
      logs.default.putBack.mockReturnValue(false)
      expect(method('putBackHistory').call(self, A, 'default')).toBe(false)
      logs.default.putBack.mockReturnValue(true)
      method('putBackHistory').call(self, A, 'default')
      expect(dispatch).not.toHaveBeenCalled()
    })

    it('does not come back in another profile, nor after it was forgotten for good', () => {
      const { self, dispatch } = ranked()
      method('forgetHistory').call(self, A, 'default', true)
      dispatch.mockClear()
      method('putBackHistory').call(self, A, 'work')
      expect(dispatch).not.toHaveBeenCalled()
      method('forgetHistory').call(self, A, 'default', true)
      method('forgetHistory').call(self, A, 'default')
      dispatch.mockClear()
      method('putBackHistory').call(self, A, 'default')
      expect(dispatch).not.toHaveBeenCalled()
    })

    it('keeps no count aside for a page the history did not hold: nothing could bring it back', () => {
      const { self, dispatch } = ranked(false)
      method('forgetHistory').call(self, A, 'default', true)
      dispatch.mockClear()
      method('putBackHistory').call(self, A, 'default')
      expect(dispatch).not.toHaveBeenCalled()
    })

    it('a whole day forgotten takes its pages out of the ranking of the profile the panel lists', () => {
      const { logs, self, dispatch } = ranked()
      const between = vi.fn(() => [{ url: A }, { url: 'https://b.example/' }])
      Object.assign(logs.default, { between })
      expect(method('forgetHistoryDay').call(self, 100, 200, 'default')).toBe(3)
      expect(between).toHaveBeenCalledWith(100, 200)
      expect(between.mock.invocationCallOrder[0]!).toBeLessThan(logs.default.removeBetween.mock.invocationCallOrder[0]!)
      expect(dispatch.mock.calls).toEqual([[{ type: 'commandbar/forget', profileId: 'default', urls: [A, 'https://b.example/'] }]])
    })
  })

  it('puts nothing back, and says so, for a profile that does not exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { logs, self } = window()
    expect(method('putBackHistory').call(self, 'https://a.example/', 'gone')).toBe(false)
    expect(logs.default.putBack).not.toHaveBeenCalled()
    expect(logs.work.putBack).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('which does not exist: nothing is put back'))
    warn.mockRestore()
  })

  it('forgets a whole day in the history the panel lists, not in the one of the space now on screen, and says how many pages went', () => {
    const { logs, self } = window()
    expect(method('forgetHistoryDay').call(self, 100, 200, 'default')).toBe(3)
    expect(logs.default.removeBetween).toHaveBeenCalledWith(100, 200)
    expect(logs.work.removeBetween).not.toHaveBeenCalled()
  })

  it('forgets no day, and says so, for a profile that does not exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { logs, self } = window()
    expect(method('forgetHistoryDay').call(self, 100, 200, 'gone')).toBe(0)
    expect(logs.default.removeBetween).not.toHaveBeenCalled()
    expect(logs.work.removeBetween).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('which does not exist: nothing is forgotten'))
    warn.mockRestore()
  })

  it('forgets nothing, and says so, for a profile that does not exist', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { logs, self } = window()
    method('forgetHistory').call(self, 'https://a.example/', 'gone')
    expect(logs.default.remove).not.toHaveBeenCalled()
    expect(logs.work.remove).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('which does not exist: nothing is forgotten'))
  })

  it('gives no page to a panel that lists another profile than the one on screen, and the pages of the one on screen otherwise', () => {
    const { logs, self } = window()
    expect(method('searchHistory').call(self, '', 10, 'default')).toEqual([])
    expect(logs.default.search).not.toHaveBeenCalled()
    expect(method('searchHistory').call(self, '', 10, 'work')).toEqual(['work page'])
    expect(method('searchHistory').call(self, '', 10)).toEqual(['work page'])
  })
})
