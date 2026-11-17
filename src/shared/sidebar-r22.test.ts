// Sidebar and spaces: each defect the property test (sidebar-invariants.test.ts) or the live trials found, with the test that fails without its correction.

import { describe, expect, it } from 'vitest'
import { archiveBuckets, newlyArchived } from './archive'
import { applyLanguage } from './i18n'
import type { ArchivedTab, Favorite, SidebarState } from './model'
import { groupLabels, groupSummary, tabStop } from './selection'
import { createInitialState, normalize, reduce, type Action, type Ctx } from './sidebar'

function makeCtx(): Ctx {
  let n = 0
  return { now: 1_700_000_000_000, newId: () => `id${++n}` }
}

const play = (ctx: Ctx, state: SidebarState, ...actions: Action[]): SidebarState => actions.reduce((s, a) => reduce(s, a, ctx), state)

/** A state with one space and `tabs` tabs of Today, opened in the background. */
function withTabs(ctx: Ctx, tabs = 3): SidebarState {
  return play(ctx, createInitialState(ctx), ...Array.from({ length: tabs }, (_, i): Action => ({ type: 'tab/open', url: `https://t${i}.example/`, background: true })))
}

/** The state as text with its keys in order and without the fields that are `undefined`: two states that hold the same things give the same text. */
const text = (state: SidebarState): string => JSON.stringify(state, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v))

describe('an action that changes nothing returns the very same state (so that nothing is saved, published or drawn)', () => {
  const ctx = makeCtx()
  const base = play(ctx, withTabs(ctx, 4), { type: 'folder/create', name: 'Dossier' }, { type: 'favorite/add', url: 'https://f.example/', title: 'Fav' })
  const [t0, t1] = base.tabs
  const folder = base.folders[0]!
  const spaceId = base.spaces[0]!.id
  const fav = base.favorites[0]!
  const unchanged: Array<[string, Action]> = [
    ['toggling a folder that is gone', { type: 'folder/toggle', id: 'nope' }],
    ['unpinning a tab that is not pinned', { type: 'tab/unpin', id: t0!.id }],
    ['selecting the space that is shown', { type: 'space/select', id: spaceId }],
    ['removing a favourite that is gone', { type: 'favorite/remove', id: 'nope' }],
    ['writing a setting to the value it has', { type: 'settings/update', patch: { showToolbar: true } }],
    ['renaming a space to its own name', { type: 'space/update', id: spaceId, patch: { name: 'Perso' } }],
    ['resetting the pinned tabs when none left its page', { type: 'tabs/reset-pinned' }],
    ['giving a tab with no name a blank name', { type: 'tab/rename', id: t0!.id, title: '  ' }],
    ['renaming a folder to its own name', { type: 'folder/rename', id: folder.id, name: 'Dossier' }],
    ['renaming a folder that is gone', { type: 'folder/rename', id: 'nope', name: 'x' }],
    ['folding every folder when they all are', { type: 'folder/collapse-all' }],
    ['deleting a Tweak that is not there', { type: 'boost/delete', id: 'nope' }],
    ['moving a space to the place it has', { type: 'space/move', id: spaceId, toIndex: 0 }],
    ['clearing Today when nothing but the shown tab is left to clear', { type: 'tab/close-others', id: t0!.id }],
    ['forgetting an answer that was never given', { type: 'permission/set', origin: 'https://nobody.example', permission: 'camera', decision: null }],
    ['setting the orientation of a split view that is gone', { type: 'split/orientation', id: 'nope', orientation: 'vertical' }],
    ['giving a favourite its own title', { type: 'favorite/edit', id: fav.id, patch: {} }]
  ]
  // The first folding really changes something; the rest of the list starts from the state it leaves.
  const folded = reduce(base, { type: 'folder/collapse-all' }, ctx)
  const shown = reduce(folded, { type: 'tab/close-others', id: t0!.id }, ctx)

  for (const [name, action] of unchanged) {
    it(name, () => {
      const start = action.type === 'folder/collapse-all' ? folded : action.type === 'tab/close-others' ? shown : base
      expect(reduce(start, action, ctx)).toBe(start)
    })
  }

  it('still changes the state when something changes', () => {
    // The change asked for, and only it: a new state that holds something else would pass for a change too.
    const renamed = reduce(base, { type: 'tab/rename', id: t1!.id, title: 'Autre' }, ctx)
    expect(renamed.tabs.map((t) => t.customTitle)).toEqual([undefined, 'Autre', undefined, undefined])
    expect(renamed.tabs.map((t) => t.title)).toEqual(base.tabs.map((t) => t.title))
    expect(reduce(base, { type: 'folder/toggle', id: folder.id }, ctx).folders.map((f) => f.collapsed)).toEqual([!folder.collapsed])
  })
})

describe('the names the reducer keeps are the ones a save and a reload give back', () => {
  const ctx = makeCtx()
  const long = 'A very long name '.repeat(30)

  it('a space name and emoji are cut, on one line, and never blank', () => {
    const state = play(ctx, createInitialState(ctx), { type: 'space/create', name: `${long}\nsecond line`, emoji: ' ', hue: 100 }, { type: 'space/create', name: '   ', emoji: '', hue: 10 })
    const [, created, blank] = state.spaces
    expect(created!.name.length).toBeLessThanOrEqual(200)
    expect(created!.name).not.toMatch(/[\n\r]/)
    expect(created!.emoji).toBe('✨')
    expect(blank!.name).toBe('Espace')
    expect(text(normalize(state))).toBe(text(state))
  })

  it('a folder name is cut and on one line (new, renamed, made from tabs, duplicated)', () => {
    const open = withTabs(ctx, 2)
    const ids = open.tabs.map((t) => t.id)
    const state = play(ctx, open, { type: 'folder/create', name: `${long}\nx` }, { type: 'folder/create-with', tabIds: ids, name: `${long}\ny` })
    const [first, second] = state.folders
    expect(first!.name.length).toBeLessThanOrEqual(200)
    expect(first!.name).not.toMatch(/\n/)
    expect(second!.name.length).toBeLessThanOrEqual(200)
    const renamed = reduce(state, { type: 'folder/rename', id: first!.id, name: `${long}\nz` }, ctx)
    expect(renamed.folders[0]!.name).not.toMatch(/\n/)
    const copy = reduce(renamed, { type: 'folder/duplicate', id: first!.id }, ctx)
    const copied = copy.folders.find((f) => f.id !== first!.id && f.id !== second!.id)!
    // The suffix that tells the copy from the original stays, even on a name that fills the limit.
    expect(copied.name.endsWith(' (copie)')).toBe(true)
    expect(copied.name.length).toBeLessThanOrEqual(200)
    expect(text(normalize(copy))).toBe(text(copy))
  })

  it('a tab keeps the name the user gave it only on one line, and cut at its limit before it is trimmed', () => {
    const state = withTabs(ctx, 1)
    const id = state.tabs[0]!.id
    expect(reduce(state, { type: 'tab/rename', id, title: 'line\nbreak' }, ctx).tabs[0]!.customTitle).toBe('line break')
    // 119 letters, a space, then more: cut at 120 the name ends with a space, which a reload would take off.
    const edge = reduce(state, { type: 'tab/rename', id, title: `${'a'.repeat(119)} bcd` }, ctx)
    expect(text(normalize(edge))).toBe(text(edge))
  })

  it('the title of a favourite and of an archive entry are on one line, and a favourite that cannot be loaded is not made', () => {
    const state = withTabs(ctx, 1)
    const fav = reduce(state, { type: 'favorite/add', url: 'https://f.example/', title: 'line\nbreak' }, ctx)
    expect(fav.favorites[0]!.title).toBe('line break')
    expect(reduce(state, { type: 'favorite/add', url: 'javascript:alert(1)', title: 'x' }, ctx)).toBe(state)
    expect(reduce(state, { type: 'favorite/add', url: 'not a url', title: 'x' }, ctx)).toBe(state)
    const archived = reduce(state, { type: 'archive/add', url: 'https://a.example/', title: 'a\nb', source: 'manual' }, ctx)
    expect(archived.archive[0]!.title).toBe('a b')
    // An address the file would not keep is not archived either.
    expect(reduce(state, { type: 'archive/add', url: `https://a.example/${'x'.repeat(70_000)}`, title: 'long', source: 'manual' }, ctx)).toBe(state)
    expect(text(normalize(fav))).toBe(text(fav))
    expect(text(normalize(archived))).toBe(text(archived))
  })
})

describe('what an action names must exist', () => {
  const ctx = makeCtx()

  it('a folder asked for in a space that does not exist is made in the space on screen, not in a space nothing lists', () => {
    const state = createInitialState(ctx)
    const made = reduce(state, { type: 'folder/create', name: 'Ailleurs', spaceId: 'no-such-space' }, ctx)
    expect(made.folders).toHaveLength(1)
    expect(made.folders[0]!.spaceId).toBe(state.activeSpaceId)
  })

  it('a web panel id that the space already has is refused: opening and removing go by that id', () => {
    const on = play(ctx, createInitialState(ctx), { type: 'settings/update', patch: { webPanels: true } })
    const id = on.activeSpaceId
    const one = reduce(on, { type: 'space/panel-add', id, panelId: 'p1', url: 'https://a.example/' }, ctx)
    expect(one.spaces[0]!.webPanels).toHaveLength(1)
    expect(reduce(one, { type: 'space/panel-add', id, panelId: 'p1', url: 'https://b.example/' }, ctx)).toBe(one)
    expect(reduce(one, { type: 'space/panel-add', id, panelId: 'p2', url: 'https://b.example/' }, ctx).spaces[0]!.webPanels).toHaveLength(2)
  })

  it('an archive keeps an id once: a tab whose id is already archived (a copy restored meanwhile) replaces that entry', () => {
    const state = withTabs(ctx, 2)
    const tab = state.tabs[0]!
    const stale: ArchivedTab = { id: tab.id, spaceId: tab.spaceId, url: 'https://old.example/', title: 'Old', archivedAt: 1 }
    const archived = reduce({ ...state, archive: [stale] }, { type: 'tab/archive', id: tab.id }, ctx)
    expect(archived.archive.filter((a) => a.id === tab.id)).toHaveLength(1)
    expect(archived.archive[0]!.url).toBe(tab.url)
  })

  it('a Today tab that names a folder (an import, a hand-edited file) is outside it', () => {
    const state = withTabs(ctx, 1)
    const folder = { id: 'f1', spaceId: state.activeSpaceId, name: 'F', collapsed: false }
    const raw = { ...state, folders: [folder], tabs: [{ ...state.tabs[0]!, folderId: 'f1', pinned: false }, { ...state.tabs[0]!, id: 'pinned-one', pinned: true, folderId: 'f1' }] }
    const loaded = normalize(raw)
    expect(loaded.tabs.find((t) => t.id === state.tabs[0]!.id)!.folderId).toBeUndefined()
    expect(loaded.tabs.find((t) => t.id === 'pinned-one')!.folderId).toBe('f1')
  })
})

describe('the pane sizes of a split view', () => {
  const ctx = makeCtx()
  const open = withTabs(ctx, 3)
  const [a, b, c] = open.tabs.map((t) => t.id) as [string, string, string]
  const three = play(ctx, open, { type: 'split/create', tabId: a, withTabId: b }, { type: 'split/create', tabId: a, withTabId: c })
  const split = three.splits[0]!

  it('are measured by the share each pane ends up with, not by the numbers sent', () => {
    // These add up to 2.15: the middle pane is 0.157 as sent and 0.073 of the stage, under the minimum.
    expect(reduce(three, { type: 'split/ratios', id: split.id, ratios: [0.9386, 0.1575, 1.0618] }, ctx)).toBe(three)
    // …while sizes that add up to 4 but stay in proportion are fine, and are scaled to 1.
    const scaled = reduce(three, { type: 'split/ratios', id: split.id, ratios: [2, 1, 1] }, ctx)
    expect(scaled.splits[0]!.ratios).toEqual([0.5, 0.25, 0.25])
  })

  it('refuse a size that is zero, negative or not a number', () => {
    expect(reduce(three, { type: 'split/ratios', id: split.id, ratios: [0, 0.5, 0.5] }, ctx)).toBe(three)
    expect(reduce(three, { type: 'split/ratios', id: split.id, ratios: [0.5, Number.NaN, 0.5] }, ctx)).toBe(three)
    expect(reduce(three, { type: 'split/ratios', id: split.id, ratios: 'x' as unknown as number[] }, ctx)).toBe(three)
  })
})

describe('permissions that are forgotten leave nothing behind', () => {
  it('forgetting the only answer of an origin removes the origin, as a file would not hold an empty one', () => {
    const ctx = makeCtx()
    const given = play(ctx, createInitialState(ctx), { type: 'permission/set', origin: 'https://a.example', permission: 'camera', decision: 'allow' })
    expect(Object.keys(given.sitePermissions)).toEqual(['https://a.example'])
    const forgotten = reduce(given, { type: 'permission/set', origin: 'https://a.example', permission: 'camera', decision: null }, ctx)
    expect(forgotten.sitePermissions).toEqual({})
    expect(text(normalize(forgotten))).toBe(text(forgotten))
  })
})

describe('the favourites of a profile that is gone', () => {
  const fav = (id: string, profileId: string): Favorite => ({ id, url: `https://${id}.example/`, title: id, profileId })

  /** Two spaces on two profiles (the second one is named), a favourite for each, and one for a profile nothing knows. */
  function twoProfiles(): { ctx: Ctx; state: SidebarState } {
    const ctx = makeCtx()
    const state = play(ctx, createInitialState(ctx), { type: 'space/create', name: 'Travail', emoji: '💼', hue: 200, profileName: 'Travail' })
    const work = state.spaces[1]!.profileId
    return { ctx, state: { ...state, favorites: [fav('main', 'default'), fav('work', work), fav('stray', 'ghost')] } }
  }

  it('go when the profile is removed (its name and settings deleted, no space left on it)', () => {
    const { ctx, state } = twoProfiles()
    const work = state.spaces[1]!.profileId
    // The space leaves the profile, then the profile is removed from the settings (Réglages › Profils › Supprimer).
    const empty = play(ctx, state, { type: 'space/update', id: state.spaces[1]!.id, patch: { profileId: 'default' } })
    // The profile still has its name: it exists, its favourites stay for when a space takes it again.
    expect(empty.favorites.map((f) => f.id)).toContain('work')
    const { [work]: _name, ...names } = empty.settings.profileNames
    const removed = reduce(empty, { type: 'settings/update', patch: { profileNames: names } }, ctx)
    expect(removed.favorites.map((f) => f.id)).toEqual(['main'])
  })

  it('go with the page they had open in a space (the page stays as an ordinary tab)', () => {
    const { ctx, state } = twoProfiles()
    const work = state.spaces[1]!
    const opened = play(ctx, state, { type: 'favorite/open', id: 'work', spaceId: work.id })
    expect(opened.tabs.some((t) => t.favoriteId === 'work')).toBe(true)
    const moved = play(ctx, opened, { type: 'space/update', id: work.id, patch: { profileId: 'default' } })
    const { [work.profileId]: _name, ...names } = moved.settings.profileNames
    const removed = reduce(moved, { type: 'settings/update', patch: { profileNames: names } }, ctx)
    expect(removed.favorites.map((f) => f.id)).toEqual(['main'])
    expect(removed.tabs.every((t) => t.favoriteId === undefined)).toBe(true)
  })

  it('are not kept by a file that holds them for a profile that does not exist, and the default profile never loses its own', () => {
    const { state } = twoProfiles()
    const loaded = normalize(state)
    expect(loaded.favorites.map((f) => f.id)).toEqual(['main', 'work'])
    const bare = normalize({ ...state, favorites: [fav('main', 'default')] })
    expect(bare.favorites.map((f) => f.id)).toEqual(['main'])
  })

  it('stay while a space put aside uses the profile', () => {
    const { ctx, state } = twoProfiles()
    const aside = play(ctx, state, { type: 'space/aside', id: state.spaces[1]!.id })
    const { [state.spaces[1]!.profileId]: _name, ...names } = aside.settings.profileNames
    // The profile has no name left, but the space that comes back needs it.
    const again = reduce(aside, { type: 'settings/update', patch: { profileNames: names } }, ctx)
    expect(again.favorites.map((f) => f.id)).toContain('work')
  })
})

describe('the age groups of the archive are in the language of the interface', () => {
  const DAY = 86_400_000
  const now = new Date(2026, 9, 23, 15, 0, 0).getTime()
  const entry = (id: string, at: number): ArchivedTab => ({ id, spaceId: 's', url: `https://${id}.fr/`, title: id, archivedAt: at })
  const labels = () => archiveBuckets([entry('a', now - 1000), entry('b', now - DAY), entry('c', now - 5 * DAY), entry('d', now - 20 * DAY), entry('e', now - 90 * DAY)], now).map((b) => b.label)

  it('French by default, English when the interface is translated (no group is left in French)', () => {
    try {
      applyLanguage({ interfaceTranslated: false, language: 'auto' }, 'fr')
      expect(labels()).toEqual(['Aujourd’hui', 'Hier', '7 derniers jours', '30 derniers jours', 'Plus ancien'])
      applyLanguage({ interfaceTranslated: true, language: 'en' }, 'en')
      expect(labels()).toEqual(['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Older'])
    } finally {
      applyLanguage({ interfaceTranslated: false, language: 'auto' }, 'fr')
    }
  })
})

describe('"Vider Aujourd’hui" archives the tabs it closes', () => {
  const ctx = makeCtx()
  const open = withTabs(ctx, 5)
  const [a, , c] = open.tabs.map((t) => t.id) as [string, string, string, string, string]

  it('puts the Today tabs in the archive (kept: the pinned ones and the tab on screen), so that nothing is lost for good', () => {
    const state = play(ctx, open, { type: 'tab/pin', id: a }, { type: 'tab/select', id: c })
    const cleared = reduce(state, { type: 'today/clear' }, ctx)
    expect(cleared.tabs.map((t) => t.id)).toEqual([a, c])
    expect(cleared.archive.map((x) => x.url)).toEqual(['https://t4.example/', 'https://t3.example/', 'https://t1.example/'])
    expect(cleared.archive.every((x) => x.source === 'manual' && x.spaceId === state.activeSpaceId)).toBe(true)
  })

  it('brings them back, in their order, with the "Annuler" of the notice (restore the last N)', () => {
    const state = play(ctx, open, { type: 'tab/select', id: a })
    const cleared = reduce(state, { type: 'today/clear' }, ctx)
    const n = newlyArchived(state.archive, cleared.archive)
    expect(n).toBe(4)
    const back = reduce(cleared, { type: 'archive/restore-last', count: n }, ctx)
    expect(back.tabs.map((t) => t.url)).toEqual(['https://t0.example/', 'https://t1.example/', 'https://t2.example/', 'https://t3.example/', 'https://t4.example/'])
    expect(back.archive).toHaveLength(0)
  })

  it('does not touch another space, a private tab (the archive never hears of it) or the page of a favourite', () => {
    const state = play(ctx, open, { type: 'tab/open', url: 'https://private.example/', private: true, background: true }, { type: 'favorite/add', url: 'https://fav.example/', title: 'F' })
    const withFav = play(ctx, state, { type: 'favorite/open', id: state.favorites[0]!.id })
    const cleared = reduce(withFav, { type: 'today/clear' }, ctx)
    expect(cleared.tabs.some((t) => t.private === true)).toBe(false)
    expect(cleared.archive.some((x) => x.url.includes('private.example'))).toBe(false)
    expect(cleared.tabs.some((t) => t.favoriteId !== undefined)).toBe(true)
  })

  it('says nothing and changes nothing when there is nothing to clear', () => {
    const one = withTabs(ctx, 1)
    const lone = reduce(one, { type: 'tab/select', id: one.tabs[0]!.id }, ctx)
    expect(reduce(lone, { type: 'today/clear' }, ctx)).toBe(lone)
  })

  it('newlyArchived counts the new entries, also when the archive is full and the oldest ones went out', () => {
    const entry = (id: string): ArchivedTab => ({ id, spaceId: 's', url: `https://${id}.example/`, title: id, archivedAt: 1 })
    const before = ['a', 'b', 'c'].map(entry)
    expect(newlyArchived(before, before)).toBe(0)
    expect(newlyArchived(before, [entry('x'), entry('y'), ...before])).toBe(2)
    // Same length, but two went out and two came in.
    expect(newlyArchived(before, [entry('x'), entry('y'), entry('a')])).toBe(2)
  })
})

describe('the menu of a selection of tabs is in the language of the interface', () => {
  const summary = (pinned: number, total: number) => groupSummary(Array.from({ length: total }, (_, i) => ({ pinned: i < pinned })))

  it('French by default, with the plural of the count', () => {
    applyLanguage({ interfaceTranslated: false, language: 'auto' }, 'fr')
    expect(groupLabels(summary(0, 3))).toMatchObject({ archive: 'Archiver 3 onglets', pin: 'Épingler 3 onglets', close: 'Fermer 3 onglets' })
    expect(groupLabels(summary(0, 1))).toMatchObject({ archive: 'Archiver 1 onglet', pin: 'Épingler 1 onglet', close: 'Fermer 1 onglet' })
    // All pinned: the entry unpins, and counts what it unpins.
    expect(groupLabels(summary(2, 2)).pin).toBe('Désépingler 2 onglets')
  })

  it('English when the interface is translated: no entry is left in French', () => {
    try {
      applyLanguage({ interfaceTranslated: true, language: 'en' }, 'en')
      expect(groupLabels(summary(1, 3))).toMatchObject({ archive: 'Archive 2 tabs', pin: 'Pin 2 tabs', close: 'Close 3 tabs', copyLinks: 'Copy Links as Markdown' })
      expect(groupLabels(summary(2, 2)).pin).toBe('Unpin 2 tabs')
      expect(groupLabels(summary(0, 1)).close).toBe('Close 1 tab')
    } finally {
      applyLanguage({ interfaceTranslated: false, language: 'auto' }, 'fr')
    }
  })

  it('a duplicated folder is told from its original in the language of the interface', () => {
    const ctx = makeCtx()
    const state = play(ctx, createInitialState(ctx), { type: 'folder/create', name: 'Projet' })
    try {
      applyLanguage({ interfaceTranslated: true, language: 'en' }, 'en')
      expect(reduce(state, { type: 'folder/duplicate', id: state.folders[0]!.id }, ctx).folders.map((f) => f.name)).toEqual(['Projet', 'Projet (copy)'])
      applyLanguage({ interfaceTranslated: false, language: 'auto' }, 'fr')
      expect(reduce(state, { type: 'folder/duplicate', id: state.folders[0]!.id }, ctx).folders.map((f) => f.name)).toEqual(['Projet', 'Projet (copie)'])
    } finally {
      applyLanguage({ interfaceTranslated: false, language: 'auto' }, 'fr')
    }
  })
})

describe('the Tab key in the list of tabs', () => {
  const order = ['a', 'b', 'c', 'd']

  it('stops on the tab that is on screen', () => {
    expect(tabStop(order, 'c')).toBe('c')
  })

  it('stops on the first row, and only on it, when the tab on screen has no row (none, a closed folder, a folded branch)', () => {
    expect(tabStop(order, null)).toBe('a')
    expect(tabStop(order, undefined)).toBe('a')
    expect(tabStop(order, 'hidden-in-a-folder')).toBe('a')
  })

  it('has no stop in an empty list', () => {
    expect(tabStop([], null)).toBeNull()
  })
})

describe('the panes of a split view on screen are not idle, and are not cleared', () => {
  const HOUR = 3_600_000

  function splitState() {
    const ctx = makeCtx()
    const open = withTabs(ctx, 3)
    const [a, b, c] = open.tabs.map((t) => t.id) as [string, string, string]
    const state = play(ctx, open, { type: 'split/create', tabId: a, withTabId: b }, { type: 'tab/select', id: a })
    return { ctx, state, a, b, c }
  }

  it('the auto-archive sweep keeps the other pane of the split view that is on screen, and archives the idle tab outside it', () => {
    const { ctx, state, a, b, c } = splitState()
    ctx.now += 13 * HOUR
    const swept = reduce(state, { type: 'archive/sweep' }, ctx)
    expect(swept.tabs.map((t) => t.id)).toEqual([a, b])
    expect(swept.splits).toHaveLength(1)
    expect(swept.archive.map((x) => x.url)).toEqual([state.tabs.find((t) => t.id === c)!.url])
  })

  it('a split view that is not on screen is idle like the rest (both panes go together)', () => {
    const { ctx, state, a, c } = splitState()
    const elsewhere = reduce(state, { type: 'tab/select', id: c }, ctx)
    ctx.now += 13 * HOUR
    const swept = reduce(elsewhere, { type: 'archive/sweep' }, ctx)
    expect(swept.tabs.map((t) => t.id)).toEqual([c])
    expect(swept.splits).toHaveLength(0)
    expect(swept.archive).toHaveLength(2)
    void a
  })

  it('"Vider Aujourd’hui" keeps the whole split view on screen', () => {
    const { ctx, state, a, b } = splitState()
    const cleared = reduce(state, { type: 'today/clear' }, ctx)
    expect(cleared.tabs.map((t) => t.id)).toEqual([a, b])
    expect(cleared.splits).toHaveLength(1)
  })
})
