// Where the full-text index of the pages (page-index.ts) is fed and asked: the real methods of the shell, called on stand-ins (no window).
// The rules of the index itself are in shared/page-index.test.ts and main/page-index.test.ts.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAGE_INDEX_SCRIPT, PAGE_INDEX_SETTLE_MS } from '@shared/page-index'
import { PageIndexBook, setPageIndex } from '../page-index'

const electron = vi.hoisted(() => {
  const quiet = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (quiet(prop) ? undefined : stub), apply: () => stub })
  const withStub = (target: Record<string, unknown>): unknown => new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : quiet(prop) ? undefined : stub), has: (t, prop) => prop in t || !quiet(prop) })
  return { module: withStub({ app: withStub({ getPath: () => '/nonexistent' }) }) }
})
vi.mock('electron', () => electron.module as Record<string, unknown>)

const { Browser } = await import('./browser')
const { BrowserPages } = await import('./browser-pages')
const { BrowserSite } = await import('./browser-site')
type Method = (this: unknown, ...args: unknown[]) => unknown
const method = (name: string): Method => ((Browser.prototype as unknown as Record<string, Method>)[name] ?? (BrowserPages.prototype as unknown as Record<string, Method>)[name] ?? (BrowserSite.prototype as unknown as Record<string, Method>)[name])!

const inert: unknown = new Proxy(function () {}, { get: (_t, prop) => (typeof prop === 'symbol' || prop === 'then' ? undefined : inert), apply: () => inert })
function shell<T extends Record<string, unknown>>(own: T): T {
  return new Proxy(own, { get: (target, prop: string) => (prop in target ? target[prop] : inert) })
}

const BODY = 'La tarte Tatin se fait avec des pommes caramélisées et une pâte brisée.'
const URL_A = 'https://recettes.example/tatin'

let book: PageIndexBook
beforeEach(() => {
  book = new PageIndexBook(mkdtempSync(join(tmpdir(), 'lucium-page-index-wiring-')))
  setPageIndex(book)
  vi.useFakeTimers()
})
afterEach(() => {
  setPageIndex(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scheduleIndexing', () => {
  const tab = (patch: Record<string, unknown> = {}) => ({ id: 't1', url: URL_A, title: 'Tatin', spaceId: 's1', ...patch })
  function window(options: { on?: boolean; tab?: Record<string, unknown> | null; answer?: unknown; showsError?: boolean; canRun?: boolean } = {}) {
    const state = { settings: { pageContentIndex: options.on ?? true }, tabs: options.tab === null ? [] : [tab(options.tab ?? {})], spaces: [{ id: 's1', profileId: 'default' }] }
    const runPageIndex = vi.fn(async () => ('answer' in options ? options.answer : BODY))
    const page = { runPageIndex: options.canRun === false ? undefined : runPageIndex, showsError: () => options.showsError === true }
    const self = shell({ store: { get: () => state }, pages: new Map([['t1', page]]) })
    return { self, state, runPageIndex }
  }
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(PAGE_INDEX_SETTLE_MS + 10)
  }

  it('reads the page after its scripts had time to draw it, in the profile of its space, and the page can then be found by its text', async () => {
    const { self, runPageIndex } = window()
    method('scheduleIndexing').call(self, 't1', tab())
    expect(runPageIndex).not.toHaveBeenCalled()
    await settle()
    expect(runPageIndex).toHaveBeenCalledWith(PAGE_INDEX_SCRIPT)
    expect(book.of('default').search('pommes caramelisees').map((m) => m.url)).toEqual([URL_A])
  })

  it('reads nothing when the setting went off during the wait', async () => {
    const { self, state, runPageIndex } = window()
    method('scheduleIndexing').call(self, 't1', tab())
    state.settings.pageContentIndex = false
    await settle()
    expect(runPageIndex).not.toHaveBeenCalled()
    expect(book.of('default').size()).toBe(0)
  })

  it('keeps nothing when the setting goes off while the script runs', async () => {
    const { self, state } = window()
    const page = (self.pages as Map<string, { runPageIndex: () => Promise<unknown> }>).get('t1')!
    page.runPageIndex = async () => {
      state.settings.pageContentIndex = false
      return BODY
    }
    method('scheduleIndexing').call(self, 't1', tab())
    await settle()
    expect(book.of('default').size()).toBe(0)
  })

  it('reads nothing for a tab that went to another page, a private tab, a tab that is gone, or an error page', async () => {
    for (const options of [{ tab: { url: 'https://autre.example/' } }, { tab: { private: true } }, { tab: null }, { showsError: true }]) {
      const { self, runPageIndex } = window(options)
      method('scheduleIndexing').call(self, 't1', tab())
      await settle()
      expect(runPageIndex, JSON.stringify(options)).not.toHaveBeenCalled()
    }
    expect(book.of('default').size()).toBe(0)
  })

  it('schedules nothing for an address that is not a web page without a login', async () => {
    for (const url of ['file:///etc/hosts', 'lucium://settings', 'https://user:secret@example.org/']) {
      const { self, runPageIndex } = window({ tab: { url } })
      method('scheduleIndexing').call(self, 't1', tab({ url }))
      await settle()
      expect(runPageIndex, url).not.toHaveBeenCalled()
    }
  })

  it('keeps nothing of a page the script refuses (a password field answers null)', async () => {
    const { self, runPageIndex } = window({ answer: null as unknown as string })
    method('scheduleIndexing').call(self, 't1', tab())
    await settle()
    expect(runPageIndex).toHaveBeenCalled()
    expect(book.of('default').size()).toBe(0)
  })

  it('says, with the host only, that a page could not be read, and keeps nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { self } = window()
    const page = (self.pages as Map<string, { runPageIndex: () => Promise<unknown> }>).get('t1')!
    page.runPageIndex = () => Promise.reject(new Error('the page is gone'))
    const secret = 'https://recettes.example/secret-path?token=abc'
    ;(self.store.get().tabs[0] as { url: string }).url = secret
    method('scheduleIndexing').call(self, 't1', tab({ url: secret }))
    await settle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recettes.example'), expect.anything())
    expect(String(warn.mock.calls[0]![0])).not.toContain('token')
    expect(book.of('default').size()).toBe(0)
  })
})

describe('searchPageContent', () => {
  function window(options: { on?: boolean; privateWindow?: boolean; held?: string[] } = {}) {
    const state = { settings: { pageContentIndex: options.on ?? true, profiles: [] }, spaces: [{ id: 's1', profileId: 'default' }], sessions: [], activeSpaceId: 's1' }
    const held = new Set(options.held ?? [URL_A])
    const get = vi.fn((url: string) => (held.has(url) ? { url } : undefined))
    return shell({ store: { get: () => state }, isPrivate: () => options.privateWindow === true, activeHistory: () => ({ get }) })
  }
  beforeEach(() => {
    book.of('default').add({ url: URL_A, title: 'Tatin', text: BODY, at: 1 })
    book.of('default').add({ url: 'https://oubliee.example/', title: 'Oubliée', text: BODY, at: 2 })
  })

  it('gives the pages whose text holds the words, only those the history still holds', () => {
    expect(method('searchPageContent').call(window(), 'tarte tatin')).toEqual([expect.objectContaining({ url: URL_A })])
  })

  it('gives nothing while the setting is off, in a private window, or for a panel that lists another profile', () => {
    expect(method('searchPageContent').call(window({ on: false }), 'tatin')).toEqual([])
    expect(method('searchPageContent').call(window({ privateWindow: true }), 'tatin')).toEqual([])
    expect(method('searchPageContent').call(window(), 'tatin', 'other-profile')).toEqual([])
    expect(method('searchPageContent').call(window(), 'tatin', 'default')).toHaveLength(1)
  })

  it('gives nothing without an index', () => {
    setPageIndex(null)
    expect(method('searchPageContent').call(window(), 'tatin')).toEqual([])
  })
})

describe('forgetting', () => {
  it('« Effacer l’index » empties every profile', () => {
    book.of('default').add({ url: URL_A, title: 'Tatin', text: BODY, at: 1 })
    book.of('work').add({ url: 'https://w.example/', title: 'W', text: BODY, at: 2 })
    book.flush()
    expect(method('clearPageIndex').call(shell({}))).toBe(true)
    expect(book.of('default').size()).toBe(0)
    expect(book.of('work').size()).toBe(0)
  })

  it('erasing the history of a profile erases its index, and only its index', () => {
    book.of('default').add({ url: URL_A, title: 'Tatin', text: BODY, at: 1 })
    book.of('work').add({ url: 'https://w.example/', title: 'W', text: BODY, at: 2 })
    const self = shell({ history: { erase: () => true }, forgetClosedPages: () => undefined })
    method('eraseProfileHistory').call(self, 'work')
    expect(book.of('work').size()).toBe(0)
    expect(book.of('default').size()).toBe(1)
  })

  it('erasing a history under a name that is no profile id leaves the default index alone', () => {
    book.of('default').add({ url: URL_A, title: 'Tatin', text: BODY, at: 1 })
    const self = shell({
      history: {
        erase: () => {
          throw new Error('Invalid profile id')
        }
      },
      forgetClosedPages: () => undefined
    })
    expect(() => method('eraseProfileHistory').call(self, '../x')).toThrow()
    expect(book.of('default').size()).toBe(1)
  })

  it('forgetting a page, or a day, takes its text out of the index', () => {
    book.of('default').add({ url: URL_A, title: 'Tatin', text: BODY, at: 1 })
    book.of('default').add({ url: 'https://b.example/', title: 'B', text: BODY, at: 2 })
    book.of('default').add({ url: 'https://c.example/', title: 'C', text: BODY, at: 3 })
    const log = { remove: vi.fn(), removeKept: vi.fn(() => false), between: () => [{ url: 'https://b.example/' }, { url: 'https://c.example/' }], removeBetween: () => 2 }
    const self = shell({ store: { get: () => ({ settings: { profiles: {}, profileNames: {} }, spaces: [{ id: 's1', profileId: 'default' }], sessions: [], activeSpaceId: 's1', commandBarUsage: {} }) }, history: { of: () => log } })
    method('forgetHistory').call(self, URL_A, 'default')
    expect(book.of('default').size()).toBe(2)
    method('forgetHistoryDay').call(self, 0, 10, 'default')
    expect(book.of('default').size()).toBe(0)
  })
})

describe('the data of a site', () => {
  it('« Effacer les données du site » with the history takes the text of the site out of the index too, subdomains when asked', () => {
    book.of('default').add({ url: 'https://bank.example/a', title: 'A', text: BODY, at: 1 })
    book.of('default').add({ url: 'https://www.bank.example/b', title: 'B', text: BODY, at: 2 })
    book.of('default').add({ url: 'https://other.example/c', title: 'C', text: BODY, at: 3 })
    const log = { hosts: () => [], removeSite: vi.fn(() => 2) }
    const self = shell({ history: { of: () => log } })
    const env = method('historyWithIndex').call(self, 'default') as { removeSite(host: string, subdomains: boolean): number }
    expect(env.removeSite('bank.example', false)).toBe(2)
    expect(book.of('default').search('tatin').map((m) => m.url).sort()).toEqual(['https://other.example/c', 'https://www.bank.example/b'])
    env.removeSite('bank.example', true)
    expect(book.of('default').search('tatin').map((m) => m.url)).toEqual(['https://other.example/c'])
  })
})
