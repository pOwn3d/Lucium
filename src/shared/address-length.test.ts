// A page can write any address it likes into its own history (history.replaceState takes up to 2 Mo): what the state keeps of an address has a ceiling,
// so that one page cannot make the saved state (or the history) too big to be read again, nor weigh down every message to the interface.

import { describe, expect, it } from 'vitest'
import { createInitialState, parseSavedState, reduce, type Ctx } from './sidebar'
import { HISTORY_URL_MAX, TAB_URL_MAX, TITLE_MAX, cleanHistory, cleanArchive, cleanFavorites, cleanTabs, isLoadableUrl } from './state-clean'
import { connectionState, hostOf } from './url'

const ctx: Ctx = { now: 1_000_000, newId: (() => { let n = 0; return () => `id${++n}` })() }
const addressOf = (length: number): string => `https://a.example/#${'x'.repeat(length - 'https://a.example/#'.length)}`

describe('the address a tab keeps', () => {
  it('is cut at the ceiling when a page writes a longer one into its own history: the state never keeps more', () => {
    const opened = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)
    const id = opened.tabs[0]!.id
    const huge = addressOf(1_500_000)
    const titled = reduce(opened, { type: 'tab/update', id, patch: { url: huge, title: 'Page' } }, ctx)
    expect(titled.tabs[0]).toMatchObject({ url: huge.slice(0, TAB_URL_MAX), title: 'Page' })
  })

  it('follows a long address up to the ceiling, and not one character further', () => {
    const opened = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)
    const id = opened.tabs[0]!.id
    expect(reduce(opened, { type: 'tab/update', id, patch: { url: addressOf(TAB_URL_MAX) } }, ctx).tabs[0]!.url).toBe(addressOf(TAB_URL_MAX))
    expect(reduce(opened, { type: 'tab/update', id, patch: { url: addressOf(TAB_URL_MAX + 1) } }, ctx).tabs[0]!.url).toBe(addressOf(TAB_URL_MAX))
  })

  // The host, the padlock and the site panel are all read from the address of the tab: a page that went to another site by an address too long to keep
  // (a redirect is enough) must not be shown under the name of the site the tab was on.
  it('names the site the page really is on, however long the address: the tab never stays at the site it left', () => {
    const opened = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://bank.example/account' }, ctx)
    const id = opened.tabs[0]!.id
    const lure = `https://evil.example/login#${'x'.repeat(70_000)}`
    const after = reduce(opened, { type: 'tab/update', id, patch: { url: lure, title: 'Bank' } }, ctx).tabs[0]!
    expect(new URL(after.url).origin).toBe('https://evil.example')
    expect(hostOf(after.url)).toBe('evil.example')
    expect(after.url).toBe(lure.slice(0, TAB_URL_MAX))
    // An http page that took the place of an https one is not called secure either.
    const plain = reduce(opened, { type: 'tab/update', id, patch: { url: `http://evil.example/?${'q'.repeat(70_000)}` } }, ctx).tabs[0]!
    expect(connectionState(plain.url)).toBe('insecure')
  })

  it('is cut after the site, never inside it: a name and a password written before the host do not pass for the site', () => {
    const opened = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://bank.example/' }, ctx)
    const id = opened.tabs[0]!.id
    // Cut blindly at the ceiling, this address would end inside its user name and read as `https://bank.example`.
    const disguised = `https://bank.example:${'9'.repeat(70_000)}@evil.example/login`
    const after = reduce(opened, { type: 'tab/update', id, patch: { url: disguised } }, ctx).tabs[0]!
    expect(after.url).toBe('https://evil.example/login')
    const long = `https://user:${'p'.repeat(10)}@evil.example/${'a'.repeat(70_000)}?q=1#end`
    const cut = reduce(opened, { type: 'tab/update', id, patch: { url: long } }, ctx).tabs[0]!
    expect(cut.url).toHaveLength(TAB_URL_MAX)
    expect(cut.url.startsWith('https://evil.example/aaa')).toBe(true)
  })

  it('is cut the same way under the source view of a page', () => {
    const opened = reduce(createInitialState(ctx), { type: 'tab/open', url: 'view-source:https://a.example/' }, ctx)
    const id = opened.tabs[0]!.id
    const after = reduce(opened, { type: 'tab/update', id, patch: { url: `view-source:https://evil.example/#${'x'.repeat(70_000)}` } }, ctx).tabs[0]!
    expect(after.url).toHaveLength(TAB_URL_MAX)
    expect(after.url.startsWith('view-source:https://evil.example/#xxx')).toBe(true)
  })

  it('is still refused when it is not an address a tab may hold, long or not', () => {
    const opened = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)
    const id = opened.tabs[0]!.id
    expect(reduce(opened, { type: 'tab/update', id, patch: { url: `javascript:${'x'.repeat(70_000)}` } }, ctx)).toBe(opened)
    expect(reduce(opened, { type: 'tab/update', id, patch: { url: 'x'.repeat(70_000) } }, ctx)).toBe(opened)
  })

  it('is not opened in a tab either', () => {
    const base = createInitialState(ctx)
    expect(reduce(base, { type: 'tab/open', url: addressOf(TAB_URL_MAX + 1) }, ctx).tabs).toHaveLength(0)
    expect(reduce(base, { type: 'tab/open', url: addressOf(TAB_URL_MAX) }, ctx).tabs).toHaveLength(1)
  })

  it('is not read from a file either: a tab, a favourite or an archive entry with a longer address is left out, the others stay', () => {
    expect(isLoadableUrl(addressOf(TAB_URL_MAX))).toBe(true)
    expect(isLoadableUrl(addressOf(TAB_URL_MAX + 1))).toBe(false)
    const spaces = new Set(['s'])
    const tab = (id: string, url: string) => ({ id, spaceId: 's', url, title: id, pinned: false, createdAt: 1, lastActiveAt: 1 })
    expect(cleanTabs([tab('ok', 'https://a.example/'), tab('huge', addressOf(TAB_URL_MAX + 1))], spaces, new Map()).map((t) => t.id)).toEqual(['ok'])
    expect(cleanFavorites([{ id: 'ok', url: 'https://a.example/', title: 'A' }, { id: 'huge', url: addressOf(TAB_URL_MAX + 1), title: 'B' }]).map((f) => f.id)).toEqual(['ok'])
    expect(cleanArchive([{ id: 'ok', spaceId: 's', url: 'https://a.example/', title: 'A', archivedAt: 1 }, { id: 'huge', spaceId: 's', url: addressOf(TAB_URL_MAX + 1), title: 'B', archivedAt: 1 }], spaces).map((a) => a.id)).toEqual(['ok'])
  })

  it('does not become a title as long as itself: an entry without a title and without a host is named by the start of its address', () => {
    const local = `file:///Users/me/${'x'.repeat(TAB_URL_MAX - 'file:///Users/me/'.length)}`
    expect(isLoadableUrl(local)).toBe(true)
    const spaces = new Set(['s'])
    const titles = [
      cleanTabs([{ id: 't', spaceId: 's', url: local, pinned: false, createdAt: 1, lastActiveAt: 1 }], spaces, new Map())[0]!.title,
      cleanFavorites([{ id: 'f', url: local }])[0]!.title,
      cleanArchive([{ id: 'a', spaceId: 's', url: local, archivedAt: 1 }], spaces)[0]!.title
    ]
    for (const title of titles) expect(title).toBe(local.slice(0, TITLE_MAX))
    // An address with a host is still named by its host.
    expect(cleanFavorites([{ id: 'f', url: 'https://www.a.example/page' }])[0]!.title).toBe('a.example')
  })

  it('does not stop a whole saved state from being read: only the tab with the huge address goes', () => {
    const base = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://a.example/' }, ctx)
    const file = JSON.parse(JSON.stringify(base)) as { tabs: Array<{ id: string; url: string }> }
    file.tabs.push({ ...file.tabs[0]!, id: 'huge', url: addressOf(TAB_URL_MAX + 1) })
    expect(parseSavedState(JSON.stringify(file)).tabs.map((t) => t.url)).toEqual(['https://a.example/'])
  })
})

describe('the address the history keeps', () => {
  it('is read from a file up to the ceiling', () => {
    const entry = (url: string) => ({ url, title: 't', visitCount: 1, lastVisitAt: 1 })
    expect(cleanHistory([entry(addressOf(HISTORY_URL_MAX)), entry(addressOf(HISTORY_URL_MAX + 1)), entry('https://b.example/')]).map((e) => e.url.length)).toEqual([HISTORY_URL_MAX, 'https://b.example/'.length])
  })
})
