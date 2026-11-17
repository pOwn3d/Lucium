// The preview of an address in the command bar used to show the generic globe while the site was open in
// a tab whose icon was known. The icon is chosen from what the application already holds (tabs, then bookmarks, then pages to read later): no request.

import { describe, expect, it } from 'vitest'
import { candidatePreview, pageFavicon, type Candidate } from './command-bar'
import { createInitialState, reduce, type Action, type Ctx } from './sidebar'
import type { SidebarState } from './model'

const ctx: Ctx = { now: 1_000_000, newId: () => 'id' }
const run = (state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)
const ICON = 'https://learn.datascientest.com/favicon.ico'
const ADDRESS = 'https://learn.datascientest.com/'

/** The bar opened on an address: one tab (on the address, with or without a known icon), plus the given library entries. */
function world(tabIcon: string | undefined, extra: Partial<SidebarState> = {}): SidebarState {
  let s = run(createInitialState(ctx), { type: 'tab/open', url: ADDRESS })
  s = { ...s, tabs: s.tabs.map((tab) => ({ ...tab, title: 'Liora Learn', faviconUrl: tabIcon })), ...extra }
  return s
}
const openLine: Candidate = { kind: 'open', id: 'open', label: 'learn.datascientest.com', detail: '', url: ADDRESS }
const preview = (state: SidebarState, candidate: Candidate = openLine) => candidatePreview(candidate, { state, now: ctx.now, mode: 'current', platform: 'darwin' })

describe('the icon of the preview for an address', () => {
  it('is the icon of the tab open on that address, first', () => {
    expect(preview(world(ICON)).faviconUrl).toBe(ICON)
  })

  it('falls back to the icon of a bookmark, then of a page to read later, kept for that address', () => {
    const bookmark = { id: 'b1', url: ADDRESS, title: 'Liora', tags: [], addedAt: 1, faviconUrl: 'https://learn.datascientest.com/signet.png' }
    const later = { id: 'r1', url: ADDRESS, title: 'Liora', savedAt: 1, faviconUrl: 'https://learn.datascientest.com/plus-tard.png' }
    expect(pageFavicon(ADDRESS, world(undefined, { bookmarks: [bookmark] as never }))).toBe(bookmark.faviconUrl)
    expect(pageFavicon(ADDRESS, world(undefined, { readLater: [later] as never }))).toBe(later.faviconUrl)
  })

  it('is none when no icon is known, so the line keeps its globe (no request is made)', () => {
    expect(preview(world(undefined)).faviconUrl).toBeUndefined()
    expect(preview(world('not-an-address')).faviconUrl).toBeUndefined()
    expect(pageFavicon('https://autre.example/', world(ICON))).toBeUndefined()
  })

  it('is given to a history line too, and is not set for a search', () => {
    const history: Candidate = { kind: 'history', id: `history:${ADDRESS}`, label: 'Liora Learn', detail: '', url: ADDRESS }
    expect(preview(world(ICON), history).faviconUrl).toBe(ICON)
    const search: Candidate = { kind: 'open', id: 'open', label: 'liora', detail: '', url: 'https://www.google.com/search?q=liora', search: true }
    expect(preview(world(ICON), search).faviconUrl).toBeUndefined()
  })
})
