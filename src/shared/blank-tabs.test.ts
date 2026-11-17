import { describe, expect, it } from 'vitest'
import { blankTabExclusion, openedBlankTabsToClose, replacementAfterBlankClose, type BlankTabFacts } from './blank-tabs'
import type { TabItem } from './model'

const tab = (patch: Partial<TabItem> = {}): TabItem => ({
  id: 't1',
  spaceId: 's1',
  url: 'about:blank',
  title: 'about:blank',
  pinned: false,
  createdAt: 0,
  lastActiveAt: 0,
  ...patch
})

const free: BlankTabFacts = { tabCount: 3, summary: false, shared: false, displayed: false, overlayOpen: false }

/** What the shell asks before it closes an empty tab that was left (shell/blank-tab-watch.ts): no reason to keep it. */
const unused = (item: TabItem, facts: BlankTabFacts): boolean => blankTabExclusion(item, facts) === null

describe('an unused empty tab', () => {
  it('takes an empty tab that was never navigated and holds nothing', () => {
    expect(unused(tab(), free)).toBe(true)
    expect(unused(tab({ title: '' }), free)).toBe(true)
  })

  it('keeps a tab that has an address', () => {
    expect(unused(tab({ url: 'https://example.com/' }), free)).toBe(false)
  })

  it('keeps a tab that has a page title', () => {
    expect(unused(tab({ title: 'Brouillon' }), free)).toBe(false)
  })

  it('keeps the summary tab', () => {
    expect(unused(tab(), { ...free, summary: true })).toBe(false)
  })

  it('keeps a pinned tab', () => {
    expect(unused(tab({ pinned: true }), free)).toBe(false)
  })

  it('keeps a tab that holds data the user set (name, icon, folder, favourite, tree, opener)', () => {
    for (const patch of [{ customTitle: 'Notes' }, { icon: '📝' }, { folderId: 'f1' }, { favoriteId: 'fav1' }, { keepAwake: true }]) {
      expect(unused(tab(patch), free)).toBe(false)
    }
  })

  // Guard: a tab a page made carries the tree link `parentId`: it is not a field the user set, so the tab closes like the others. Without the removal
  // of `parentId` from the kept fields, every tab a page made would be kept (the journal said 'field:parentId').
  it('closes an empty tab a page made, with its tree link, when it is not pinned', () => {
    const madeByPage = tab({ parentId: 'meet-tab' })
    expect(blankTabExclusion(madeByPage, { ...free, fromPage: true })).toBeNull()
    expect(unused(madeByPage, { ...free, fromPage: true })).toBe(true)
  })

  // Guard: the same tab, pinned, is kept: a real protection (the user pinned it) stays.
  it('keeps the same tab when it is pinned', () => {
    expect(blankTabExclusion(tab({ parentId: 'meet-tab', pinned: true }), { ...free, fromPage: true })).toBe('field:pinned')
  })

  // Guard: an empty tab opened by a page (it has an opener) closes like the others: the opener is not data the user set. Without the removal of
  // `openerId` from the kept fields, such a tab would stay in the sidebar until it is closed by hand.
  it('closes an empty tab that a page opened (it has an opener), like the others', () => {
    expect(unused(tab({ openerId: 't0' }), free)).toBe(true)
    expect(blankTabExclusion(tab({ openerId: 't0' }), free)).toBeNull()
  })

  // Guard: an empty tab on screen that no sharing shows is closed (the window then shows the last tab used in its space); only a shared one is
  // kept. Without this, the active empty tab of a page would stay (the journal said 'kept: displayed', shared=false).
  it('closes an empty tab on screen that is not shared, and keeps a shared one', () => {
    expect(unused(tab(), { ...free, displayed: true, shared: false })).toBe(true)
    expect(unused(tab(), { ...free, displayed: true, shared: true })).toBe(false)
    expect(unused(tab(), { ...free, shared: true })).toBe(false)
  })

  it('keeps a tab while an overlay is open (the user may be typing)', () => {
    expect(unused(tab(), { ...free, overlayOpen: true })).toBe(false)
  })

  it('never closes the last tab of the window', () => {
    expect(unused(tab(), { ...free, tabCount: 1 })).toBe(false)
    expect(unused(tab(), { ...free, tabCount: 2 })).toBe(true)
  })
})

describe('replacementAfterBlankClose', () => {
  const at = (id: string, spaceId: string, lastActiveAt: number) => ({ id, spaceId, lastActiveAt })
  const closed = { id: 'empty', spaceId: 's1' }
  const tabs = [at('a', 's1', 10), at('b', 's1', 50), at('c', 's1', 30), at('other', 's2', 99), at('empty', 's1', 80)]

  // Guard: the window goes back to the tab used before the empty one in its space, while that tab still exists there.
  // Without the preference, it would go to the most recent tab (here b), not to the one that was used before.
  it('goes to the tab used before the empty one in its space', () => {
    expect(replacementAfterBlankClose(tabs, closed, 'a')).toBe('a')
  })

  // Guard: a tab of another space is never chosen; without the space filter, 'other' (the most recent of all) would be picked.
  it('falls back to the most recently used tab of the same space, never another space', () => {
    expect(replacementAfterBlankClose(tabs, closed, null)).toBe('b')
    expect(replacementAfterBlankClose(tabs, closed, 'other')).toBe('b')
  })

  it('gives none when the empty tab was the only one of its space', () => {
    expect(replacementAfterBlankClose([at('empty', 's1', 1), at('x', 's2', 2)], closed, null)).toBeNull()
  })
})

describe('blankTabExclusion', () => {
  // Guard: each keeping reason has its name, so that the log says why an empty tab stays. A tab that may close has none.
  it('names the reason an empty tab is kept, and none when it may close', () => {
    expect(blankTabExclusion(tab(), free)).toBeNull()
    expect(blankTabExclusion(tab({ url: 'https://a.example/' }), free)).toBe('address')
    expect(blankTabExclusion(tab({ title: 'Notes' }), free)).toBe('title')
    expect(blankTabExclusion(tab({ folderId: 'f1' }), free)).toBe('field:folderId')
    expect(blankTabExclusion(tab(), { ...free, summary: true })).toBe('summary')
    expect(blankTabExclusion(tab(), { ...free, shared: true })).toBe('shared')
    expect(blankTabExclusion(tab(), { ...free, displayed: true })).toBeNull()
    expect(blankTabExclusion(tab(), { ...free, overlayOpen: true })).toBe('overlay')
    expect(blankTabExclusion(tab(), { ...free, tabCount: 1 })).toBe('last-tab')
  })
})

describe('openedBlankTabsToClose', () => {
  const openers = new Map([['popup', 'meet']])
  const ids = new Set(['meet', 'popup', 'other'])

  // Guard: an empty tab goes when its opener is left by the user (it was on screen, and another tab is now). Without the check on `previous`,
  // the tab would never go (the page opened it in the background: it is never on screen).
  it('goes when the tab that opened it is left', () => {
    expect(openedBlankTabsToClose(openers, ids, 'meet', 'other')).toEqual([{ id: 'popup', reason: 'parent quitté' }])
  })

  // Guard: the opener that is still shown, or a change that does not leave it, keeps the empty tab: nothing is closed at once.
  it('keeps it while the opener is not left', () => {
    expect(openedBlankTabsToClose(openers, ids, 'other', 'meet')).toEqual([])
    expect(openedBlankTabsToClose(openers, ids, 'other', 'other')).toEqual([])
    expect(openedBlankTabsToClose(openers, ids, 'meet', 'meet')).toEqual([])
  })

  // Guard: an opener that is closed takes its empty tabs with it; a tab that is gone is not in the answer.
  it('goes when the opener is closed, and not when it is already gone', () => {
    expect(openedBlankTabsToClose(openers, new Set(['popup', 'other']), null, 'other')).toEqual([{ id: 'popup', reason: 'parent fermé' }])
    expect(openedBlankTabsToClose(openers, new Set(['meet', 'other']), 'meet', 'other')).toEqual([])
  })
})

describe('openedBlankTabsToClose: the opener has finished loading', () => {
  const openers = new Map([['popup', 'meet']])
  const ids = new Set(['meet', 'popup', 'other'])

  // Guard: once the page that opened the empty tab has finished loading, the tab goes (its popup is not coming any more). Without this branch,
  // the tab would wait for the user to leave Meet, which is what the journal of the test showed.
  it('goes when the opener has finished loading', () => {
    expect(openedBlankTabsToClose(openers, ids, null, null, 'meet')).toEqual([{ id: 'popup', reason: 'parent chargé' }])
  })

  // Guard: before the opener has loaded, the empty tab is kept: nothing is closed at its creation (a popup that is still loading would be cut).
  it('keeps it before the opener has loaded, and when another page loads', () => {
    expect(openedBlankTabsToClose(openers, ids, null, null, null)).toEqual([])
    expect(openedBlankTabsToClose(openers, ids, null, null, 'other')).toEqual([])
  })
})

describe('a tab a page made, during a sharing', () => {
  // Guard: the tab a page made is empty when the page only wrote its title into it: the title is not a use by the user. Without the exemption, a
  // Meet popup whose script set a title would be kept for ever ('title').
  it('stays empty when the page wrote a title, and closes', () => {
    expect(blankTabExclusion(tab({ title: 'Meet' }), { ...free, fromPage: true })).toBeNull()
    expect(blankTabExclusion(tab({ title: 'Meet' }), free)).toBe('title')
  })

  // Guard: the active empty tab a page made (on screen, not shared) closes; the same tab, shared, is kept. Without the change, the 'displayed'
  // exclusion kept it (the journal said displayed=true, shared=false, 'kept: displayed').
  it('closes the empty tab on screen that a page made when no sharing shows it, and keeps it when shared', () => {
    expect(blankTabExclusion(tab(), { ...free, fromPage: true, displayed: true, shared: false })).toBeNull()
    expect(blankTabExclusion(tab(), { ...free, fromPage: true, displayed: true, shared: true })).toBe('shared')
  })

  // Guard: an address committed by the page (the popup loaded) is a use: the tab is kept, whoever made it.
  it('keeps the tab once it has an address, even made by a page', () => {
    expect(blankTabExclusion(tab({ url: 'https://meet.google.com/abc' }), { ...free, fromPage: true })).toBe('address')
  })

  // Guard: during a sharing, only the tab on screen is kept: a tab made in the background, not on screen, closes even while the window shares.
  it('closes when the sharing does not show it (it is not on screen)', () => {
    expect(blankTabExclusion(tab(), { ...free, fromPage: true, displayed: false, shared: false })).toBeNull()
    // Both on screen and shared: the sharing is the reason (it is checked first).
    expect(blankTabExclusion(tab(), { ...free, fromPage: true, displayed: true, shared: true })).toBe('shared')
  })
})

describe('replacementAfterBlankClose: the window of another tab', () => {
  const at = (id: string, spaceId: string, lastActiveAt: number) => ({ id, spaceId, lastActiveAt })
  const closed = { id: 'empty', spaceId: 's1' }
  const tabs = [at('mine', 's1', 10), at('elsewhere', 's1', 90), at('other-space', 's2', 99), at('empty', 's1', 80)]

  // Guard: when the empty tab of the third window closes, the window takes a tab of its own, not the tab the
  // second window shows (the most recent of the space). Without the exclusion, 'elsewhere' would be chosen and the popup would open in the second window.
  it('never takes a tab that another window shows', () => {
    expect(replacementAfterBlankClose(tabs, closed, null, new Set(['elsewhere']))).toBe('mine')
    expect(replacementAfterBlankClose(tabs, closed, null)).toBe('elsewhere')
  })

  // Guard: the tab used before, when another window shows it now, is not the replacement either: the tab of this window is.
  it('does not take the tab used before when another window shows it', () => {
    expect(replacementAfterBlankClose(tabs, closed, 'elsewhere', new Set(['elsewhere']))).toBe('mine')
  })

  it('gives none when every other tab of the space is shown by another window', () => {
    expect(replacementAfterBlankClose(tabs, closed, null, new Set(['mine', 'elsewhere']))).toBeNull()
  })
})

