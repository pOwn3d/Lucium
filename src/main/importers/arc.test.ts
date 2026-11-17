import { describe, expect, it } from 'vitest'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
import { MAX_IMPORTED_DEPTH, MAX_IMPORTED_FAVORITES, MAX_IMPORTED_FOLDERS, MAX_IMPORTED_LINKS, MAX_IMPORTED_SPACES } from '@shared/import-sources'
import { arcId, convertArcSidebar } from './arc'

// Synthetic fixture shaped like Arc 1.170.0's StorableSidebar.json (arrays interleave ids and objects).
const item = (id: string, parentID: string | null, childrenIds: string[], data: object, title: string | null = null) => [
  id,
  { id, parentID, childrenIds, data, title, createdAt: 720_000_000, originatingDevice: 'x', isUnread: false }
]

const fixture = {
  sidebar: {
    containers: [
      { global: {} },
      {
        topAppsContainerIDs: [],
        spaces: [
          'space-1',
          {
            id: 'space-1',
            title: 'Travail',
            profile: { default: true },
            customInfo: {
              iconType: { emoji_v2: '💼', emoji: 1 },
              windowTheme: { background: { single: { _0: { isVibrant: true, contentOverBackgroundAppearance: 'light', style: { color: { _0: { blendedGradient: { _0: { baseColors: [{ red: 0, green: 0.5, blue: 1 }, { red: 1, green: 0.5, blue: 0 }], overlayColors: [], translucencyStyle: 'light', wheel: { complimentary: {} }, modifiers: { overlay: 'grain', intensityFactor: 0.8, noiseFactor: 0.3 } } } } } } } } } }
            },
            containerIDs: ['pinned', 'pin-root', 'unpinned', 'today-root']
          }
        ],
        items: [
          ...item('pin-root', null, ['pinned-tab', 'folder-1'], { itemContainer: { containerType: { spaceItems: { _0: 'space-1' } } } }),
          ...item('pinned-tab', 'pin-root', [], { tab: { savedURL: 'https://pinned.example/', savedTitle: 'Pinned', timeLastActiveAt: 720_000_100 } }),
          ...item('folder-1', 'pin-root', ['in-folder', 'nested'], { list: {} }, 'Docs'),
          ...item('in-folder', 'folder-1', [], { tab: { savedURL: 'https://docs.example/', savedTitle: '', timeLastActiveAt: 720_000_200 } }, 'Titre de secours'),
          ...item('nested', 'folder-1', ['deep'], { list: {} }, 'Nested'),
          ...item('deep', 'nested', [], { tab: { savedURL: 'https://deep.example/', savedTitle: 'Deep', timeLastActiveAt: 720_000_300 } }),
          ...item('today-root', null, ['today-tab', 'ext-tab', 'split', 'missing-child'], { itemContainer: { containerType: { spaceItems: { _0: 'space-1' } } } }),
          ...item('today-tab', 'today-root', [], { tab: { savedURL: 'https://today.example/', savedTitle: 'Today', timeLastActiveAt: 720_000_400 } }),
          ...item('ext-tab', 'today-root', [], { tab: { savedURL: 'chrome-extension://abc/page.html', savedTitle: 'Ext', timeLastActiveAt: 720_000_500 } }),
          ...item('split', 'today-root', [], { splitView: { layoutOrientation: 'horizontal' } })
        ]
      }
    ]
  }
}

const ctx = (): Ctx => {
  let n = 0
  return { now: 5, newId: () => `new${++n}` }
}

describe('convertArcSidebar', () => {
  const result = convertArcSidebar(fixture, ctx())

  it('maps spaces with their name and emoji', () => {
    expect(result.spaces).toMatchObject([{ name: 'Travail', emoji: '💼', profileId: 'default' }])
  })

  it('imports the real theme of a space: colours, harmony, intensity, texture and appearance', () => {
    expect(result.spaces[0]!.theme).toMatchObject({ baseColors: ['#0080ff', expect.any(String)], harmony: 'complementary', intensity: 0.8, noise: 0.3, overlay: 'grain', appearance: 'light' })
  })

  it('falls back to a theme built from a hue when the space has no blended gradient', () => {
    const bare = structuredClone(fixture) as unknown as { sidebar: { containers: Array<{ spaces?: Array<Record<string, any>> }> } }
    delete bare.sidebar.containers[1]!.spaces![1]!.customInfo.windowTheme
    const theme = convertArcSidebar(bare, ctx()).spaces[0]!.theme
    expect(theme.baseColors.length).toBeGreaterThan(0)
    expect(theme.harmony).toBe('complementary')
  })

  it('separates pinned from Today tabs and keeps the pinned URL as anchor', () => {
    const pinned = result.tabs.filter((t) => t.pinned).map((t) => t.url)
    expect(pinned).toEqual(['https://pinned.example/', 'https://docs.example/', 'https://deep.example/'])
    expect(result.tabs.find((t) => t.url === 'https://pinned.example/')?.anchorUrl).toBe('https://pinned.example/')
    expect(result.tabs.filter((t) => !t.pinned).map((t) => t.url)).toEqual(['https://today.example/'])
  })

  it('turns lists into folders and keeps a list inside a list nested', () => {
    expect(result.folders.map((f) => f.name)).toEqual(['Docs', 'Nested'])
    const [top, nested] = result.folders
    expect(top!.parentId).toBeUndefined()
    expect(nested!.parentId).toBe(top!.id)
    expect(result.tabs.find((t) => t.url === 'https://deep.example/')?.folderId).toBe(nested!.id)
    expect(result.tabs.find((t) => t.url === 'https://docs.example/')?.folderId).toBe(top!.id)
  })

  it('merges into a sidebar whose folders are still a tree (nothing deeper than the sidebar allows is lost)', () => {
    const merged = reduce(createInitialState(ctx()), { type: 'import/merge', spaces: result.spaces, tabs: result.tabs, folders: result.folders, favorites: [] }, ctx())
    const nested = merged.folders.find((f) => f.name === 'Nested')!
    expect(merged.folders.find((f) => f.id === nested.parentId)?.name).toBe('Docs')
    expect(merged.tabs.find((t) => t.url === 'https://deep.example/')?.folderId).toBe(nested.id)
  })

  it('falls back to the item title when the saved title is empty', () => {
    expect(result.tabs.find((t) => t.url === 'https://docs.example/')?.title).toBe('Titre de secours')
  })

  it('converts Apple-epoch seconds to milliseconds', () => {
    const tab = result.tabs.find((t) => t.url === 'https://pinned.example/')!
    expect(tab.lastActiveAt).toBe(Date.UTC(2001, 0, 1) + 720_000_100 * 1000)
  })

  it('brings a Today tab in as used now, so that the first sweep of the auto-archive does not send it to the archive', () => {
    const now = Date.UTC(2026, 3, 2, 10, 0, 0)
    const arrived = convertArcSidebar(fixture, { now, newId: () => 'n' })
    const today = arrived.tabs.find((t) => t.url === 'https://today.example/')!
    expect(today.lastActiveAt).toBe(now)
    // The file dated it in 2023: with that date the sweep (12 hours by default) archives it at once.
    const imported = { ...createInitialState({ now, newId: () => 'x' }), spaces: arrived.spaces, tabs: arrived.tabs, folders: arrived.folders }
    const swept = reduce(imported, { type: 'archive/sweep' }, { now: now + 3_600_000, newId: () => 'y' })
    expect(swept.tabs.some((t) => t.url === 'https://today.example/')).toBe(true)
    expect(swept.archive).toEqual([])
  })

  it('counts what it cannot import instead of failing', () => {
    // chrome-extension tab, split view, dangling child id
    expect(result.report.skipped).toBe(3)
    expect(result.report).toMatchObject({ spaces: 1, tabs: 4, folders: 2 })
  })

  it('returns an empty import on unrecognised input', () => {
    for (const bad of [null, {}, { sidebar: {} }, { sidebar: { containers: [1, 'x'] } }, 'text']) {
      expect(convertArcSidebar(bad, ctx()).spaces).toEqual([])
    }
  })
})

// A sidebar built from plain objects: one space whose pinned container is `pinned`.
type ArcObject = { id: string; childrenIds: string[]; data: object; title?: string; createdAt?: number }
const sidebarOf = (items: ArcObject[]) => ({
  sidebar: { containers: [{ spaces: [{ id: 's', title: 'S', containerIDs: ['pinned', 'p'] }], items }] }
})
const tabItem = (id: string, url: unknown, extra: Partial<ArcObject> = {}): ArcObject => ({ id, childrenIds: [], data: { tab: { savedURL: url, savedTitle: id } }, ...extra })

describe('convertArcSidebar on damaged or hostile files', () => {
  it('imports an item shared by several parents once: 19 items cannot become 131 072 tabs', () => {
    // Each list holds the next one twice: followed naively, the leaf is reached 2^16 times.
    const depth = 16
    const items: ArcObject[] = [{ id: 'p', childrenIds: ['L0', 'L0'], data: {} }]
    for (let i = 0; i < depth; i++) items.push({ id: `L${i}`, childrenIds: [`L${i + 1}`, `L${i + 1}`], title: 'f', data: { list: {} } })
    items.push({ id: `L${depth}`, childrenIds: ['T', 'T'], title: 'f', data: { list: {} } }, tabItem('T', 'https://a.example/'))
    const started = performance.now()
    const result = convertArcSidebar(sidebarOf(items), ctx())
    expect(performance.now() - started).toBeLessThan(1000)
    expect(result.tabs).toHaveLength(1)
    expect(result.folders).toHaveLength(depth + 1)
    // Every repeated reference is counted as left out, not silently dropped.
    expect(result.report.skipped).toBeGreaterThan(0)
  })

  it('stops following lists inside lists past a bounded depth, without overflowing the stack', () => {
    // 20 000 lists, each in the one before: followed to the end this is a RangeError, and a real file never holds more than a few levels.
    const length = 20_000
    const items: ArcObject[] = [{ id: 'p', childrenIds: ['L0'], data: {} }]
    for (let i = 0; i < length; i++) items.push({ id: `L${i}`, childrenIds: [`L${i + 1}`], title: 'f', data: { list: {} } })
    items.push(tabItem(`L${length}`, 'https://deep.example/'))
    const result = convertArcSidebar(sidebarOf(items), ctx())
    expect(result.folders).toHaveLength(MAX_IMPORTED_DEPTH + 1)
    expect(result.tabs).toEqual([])
    expect(result.report.overLimit).toBeGreaterThan(0)
  })

  it('brings in at most MAX_IMPORTED_SPACES spaces and counts the others as over the limit', () => {
    const extra = 25
    const spaces = Array.from({ length: MAX_IMPORTED_SPACES + extra }, (_, i) => ({ id: `s${i}`, title: `Espace ${i}`, containerIDs: [] as string[] }))
    const result = convertArcSidebar({ sidebar: { containers: [{ spaces, items: [] }] } }, ctx())
    expect(result.spaces).toHaveLength(MAX_IMPORTED_SPACES)
    expect(result.report.overLimit).toBe(extra)
  })

  it('does not loop on a list that holds itself, or on a container that a list points back to', () => {
    const items: ArcObject[] = [
      { id: 'p', childrenIds: ['L', 'T'], data: {} },
      { id: 'L', childrenIds: ['L', 'p', 'T2'], title: 'boucle', data: { list: {} } },
      tabItem('T', 'https://a.example/'),
      tabItem('T2', 'https://b.example/')
    ]
    const result = convertArcSidebar(sidebarOf(items), ctx())
    expect(result.tabs.map((t) => t.url).sort()).toEqual(['https://a.example/', 'https://b.example/'])
    expect(result.report.skipped).toBe(2)
  })

  it('imports a container once even when two spaces (or its pinned and unpinned side) point at it', () => {
    const items: ArcObject[] = [{ id: 'p', childrenIds: ['T'], data: {} }, tabItem('T', 'https://a.example/')]
    const raw = {
      sidebar: {
        containers: [
          {
            spaces: [
              { id: 's1', title: 'Un', containerIDs: ['pinned', 'p', 'unpinned', 'p'] },
              { id: 's2', title: 'Deux', containerIDs: ['pinned', 'p'] }
            ],
            items
          }
        ]
      }
    }
    const result = convertArcSidebar(raw, ctx())
    expect(result.spaces).toHaveLength(2)
    expect(result.tabs).toHaveLength(1)
    expect(result.report.skipped).toBe(2)
  })

  it('stops at the tab limit, imports what is below it, and counts the rest as over the limit (not as ignored)', () => {
    const total = MAX_IMPORTED_LINKS + 7
    const items: ArcObject[] = [{ id: 'p', childrenIds: Array.from({ length: total }, (_, i) => `T${i}`).concat('X'), data: {} }, tabItem('X', 'chrome://settings')]
    for (let i = 0; i < total; i++) items.push(tabItem(`T${i}`, `https://a.example/${i}`))
    const result = convertArcSidebar(sidebarOf(items), ctx())
    expect(result.tabs).toHaveLength(MAX_IMPORTED_LINKS)
    expect(result.report).toMatchObject({ tabs: MAX_IMPORTED_LINKS, skipped: 1, overLimit: 7 })
  })

  it('counts what is inside a folder the folder limit kept out, and imports none of it', () => {
    // MAX + 1 lists side by side; the last holds two tabs and a list of its own with one more.
    const items: ArcObject[] = [{ id: 'p', childrenIds: Array.from({ length: MAX_IMPORTED_FOLDERS + 1 }, (_, i) => `L${i}`), data: {} }]
    for (let i = 0; i < MAX_IMPORTED_FOLDERS; i++) items.push({ id: `L${i}`, childrenIds: [], title: `f${i}`, data: { list: {} } })
    const last = `L${MAX_IMPORTED_FOLDERS}`
    items.push({ id: last, childrenIds: ['a', 'b', 'inner'], title: 'trop', data: { list: {} } }, tabItem('a', 'https://a.example/'), tabItem('b', 'https://b.example/'))
    items.push({ id: 'inner', childrenIds: ['c'], title: 'inner', data: { list: {} } }, tabItem('c', 'https://c.example/'))
    const result = convertArcSidebar(sidebarOf(items), ctx())
    expect(result.folders).toHaveLength(MAX_IMPORTED_FOLDERS)
    expect(result.tabs).toEqual([])
    // The list itself, its two tabs, its inner list and the tab in it.
    expect(result.report.overLimit).toBe(5)
  })

  it('keeps a date that cannot be a moment (1e308 seconds is Infinity in milliseconds) out of the tab', () => {
    const items: ArcObject[] = [
      { id: 'p', childrenIds: ['T', 'U', 'V'], data: {} },
      { id: 'T', childrenIds: [], createdAt: 1e308, data: { tab: { savedURL: 'https://a.example/', timeLastActiveAt: -1e300 } } },
      { id: 'U', childrenIds: [], createdAt: -5, data: { tab: { savedURL: 'https://b.example/', timeLastActiveAt: 1e12 } } },
      { id: 'V', childrenIds: [], createdAt: 720_000_000, data: { tab: { savedURL: 'https://c.example/', timeLastActiveAt: 'soon' } } }
    ]
    const [a, b, c] = convertArcSidebar(sidebarOf(items), ctx()).tabs
    // Out of range: the moment of the import; a last activity that is out of range is the creation.
    expect([a!.createdAt, a!.lastActiveAt]).toEqual([5, 5])
    expect([b!.createdAt, b!.lastActiveAt]).toEqual([5, 5])
    expect([c!.createdAt, c!.lastActiveAt]).toEqual([Date.UTC(2001, 0, 1) + 720_000_000 * 1000, Date.UTC(2001, 0, 1) + 720_000_000 * 1000])
    for (const tab of [a!, b!, c!]) expect(JSON.parse(JSON.stringify(tab)).createdAt).toBe(tab.createdAt)
  })

  it('refuses a tab whose address only has the prefix of a web page, and cuts a title that is far too long', () => {
    const items: ArcObject[] = [
      { id: 'p', childrenIds: ['a', 'b', 'c'], data: {} },
      tabItem('a', 'https://'),
      tabItem('b', 'http://exa mple/'),
      { id: 'c', childrenIds: [], data: { tab: { savedURL: 'https://ok.example/', savedTitle: 't'.repeat(5000) } } }
    ]
    const result = convertArcSidebar(sidebarOf(items), ctx())
    expect(result.tabs.map((t) => t.url)).toEqual(['https://ok.example/'])
    expect(result.tabs[0]!.title).toHaveLength(1000)
    expect(result.report.skipped).toBe(2)
  })
})

describe('favorites (the top apps of the file)', () => {
  /** A sidebar with one space and a top-apps container (markers and ids interleave) holding the given tabs. */
  const withTopApps = (tabs: Array<{ id: string; url: string; title?: string }>) => ({
    sidebar: {
      containers: [
        { global: {} },
        {
          topAppsContainerIDs: [{ default: true }, 'top-root'],
          spaces: ['s1', { id: 's1', title: 'Espace', customInfo: {}, containerIDs: ['pinned', 'pin-root'] }],
          items: [
            ...item('pin-root', null, [], { itemContainer: {} }),
            ...item('top-root', null, tabs.map((t) => t.id), { itemContainer: {} }),
            ...tabs.flatMap((t) => item(t.id, 'top-root', [], { tab: { savedURL: t.url, savedTitle: t.title ?? '', timeLastActiveAt: 720_000_100 } }, t.title ?? null))
          ]
        }
      ]
    }
  })

  it('imports the favorites in their order, with their title', () => {
    const imported = convertArcSidebar(withTopApps([{ id: 'a', url: 'https://one.example/', title: 'Un' }, { id: 'b', url: 'https://two.example/', title: 'Deux' }]), ctx())
    expect(imported.favorites.map((f) => [f.url, f.title])).toEqual([['https://one.example/', 'Un'], ['https://two.example/', 'Deux']])
    expect(imported.report.favorites).toBe(2)
  })

  it('keeps one favorite per address', () => {
    const imported = convertArcSidebar(withTopApps([{ id: 'a', url: 'https://one.example/' }, { id: 'b', url: 'https://one.example/' }]), ctx())
    expect(imported.favorites).toHaveLength(1)
  })

  it('leaves out what is not a web page, and counts it', () => {
    const imported = convertArcSidebar(withTopApps([{ id: 'a', url: 'https://one.example/' }, { id: 'b', url: 'chrome-extension://abc/page.html' }, { id: 'c', url: 'javascript:alert(1)' }]), ctx())
    expect(imported.favorites.map((f) => f.url)).toEqual(['https://one.example/'])
    expect(imported.report.skipped).toBe(2)
  })

  it('brings in at most MAX_IMPORTED_FAVORITES, and says how many it left out', () => {
    const tabs = Array.from({ length: MAX_IMPORTED_FAVORITES + 3 }, (_, i) => ({ id: `t${i}`, url: `https://site${i}.example/` }))
    const imported = convertArcSidebar(withTopApps(tabs), ctx())
    expect(imported.favorites).toHaveLength(MAX_IMPORTED_FAVORITES)
    expect(imported.report.overLimit).toBe(3)
  })

  it('merges into a sidebar without duplicating a favorite it already has', () => {
    const c = ctx()
    const base = reduce(createInitialState(c), { type: 'favorite/add', url: 'https://one.example/', title: 'Déjà là' }, c)
    const imported = convertArcSidebar(withTopApps([{ id: 'a', url: 'https://one.example/' }, { id: 'b', url: 'https://two.example/' }]), c)
    const merged = reduce(base, { type: 'import/merge', spaces: imported.spaces, tabs: imported.tabs, folders: imported.folders, favorites: imported.favorites }, c)
    expect(merged.favorites.map((f) => f.url)).toEqual(['https://one.example/', 'https://two.example/'])
  })
})

describe('split views', () => {
  /** A split view `sv` of the given tabs, in a pinned folder `f` (as the files of version 1.170 keep them) or at the root of Today. */
  const withSplit = (view: object, urls: string[], inside: 'folder' | 'pinned' | 'today' = 'folder') => {
    const ids = urls.map((_, i) => `t${i}`)
    const tabs = urls.map((url, i) => ({ id: ids[i]!, childrenIds: [], data: { tab: { savedURL: url, savedTitle: `Titre ${i}` } } }))
    const split: ArcObject = { id: 'sv', childrenIds: ids, data: { splitView: view } }
    const list: ArcObject = { id: 'f', childrenIds: ['sv'], title: 'Dossier', data: { list: {} } }
    const root: ArcObject = { id: 'p', childrenIds: [inside === 'folder' ? 'f' : 'sv'], data: {} }
    const raw = {
      sidebar: { containers: [{ spaces: [{ id: 's', title: 'S', containerIDs: [inside === 'today' ? 'unpinned' : 'pinned', 'p'] }], items: [root, ...(inside === 'folder' ? [list] : []), split, ...tabs] }] }
    }
    return convertArcSidebar(raw, ctx())
  }
  const URLS = ['https://a.example/', 'https://b.example/']

  it('brings the tabs of a split view in, side by side as the file had them, in the folder it sat in', () => {
    const result = withSplit({ layoutOrientation: 'horizontal', itemWidthFactors: ['t1', 0.7, 't0', 0.3], focusItemID: 't0', customInfo: null }, URLS)
    expect(result.splits).toHaveLength(1)
    const split = result.splits[0]!
    const [a, b] = result.tabs
    expect(split).toMatchObject({ spaceId: result.spaces[0]!.id, orientation: 'horizontal', tabIds: [a!.id, b!.id] })
    // The factors are told apart by tab id: the pairs come in another order than the panes.
    expect(split.ratios[0]).toBeCloseTo(0.3)
    expect(split.ratios[1]).toBeCloseTo(0.7)
    expect([a!.pinned, a!.folderId]).toEqual([true, result.folders[0]!.id])
    expect(b!.folderId).toBe(result.folders[0]!.id)
    expect(result.report).toMatchObject({ splits: 1, tabs: 2, skipped: 0 })
  })

  it('keeps a vertical split vertical whatever the case, and anything unknown horizontal', () => {
    expect(withSplit({ layoutOrientation: 'vertical' }, URLS).splits[0]!.orientation).toBe('vertical')
    expect(withSplit({ layoutOrientation: 'Vertical' }, URLS).splits[0]!.orientation).toBe('vertical')
    expect(withSplit({ layoutOrientation: 'diagonal' }, URLS).splits[0]!.orientation).toBe('horizontal')
    expect(withSplit({}, URLS).splits[0]!.orientation).toBe('horizontal')
  })

  it('reads a single listed factor as the share of that pane, the other pane taking the rest', () => {
    expect(withSplit({ itemWidthFactors: ['t0', 0.5] }, URLS).splits[0]!.ratios).toEqual([0.5, 0.5])
    const [x, y] = withSplit({ itemWidthFactors: ['t1', 0.7] }, URLS).splits[0]!.ratios
    expect(x).toBeCloseTo(0.3)
    expect(y).toBeCloseTo(0.7)
  })

  it('shares the panes equally when the factors make no sense (wrong sum, negative, not a number, a pane squeezed to nothing, unknown ids)', () => {
    for (const factors of [['t0', 0.9, 't1', 0.9], ['t0', -1, 't1', 2], ['t0', 'x', 't1', null], ['t0', 0.01, 't1', 0.99], ['nope', 0.4], 'oops', undefined, ['t0', 1]]) {
      expect(withSplit({ itemWidthFactors: factors }, URLS).splits[0]!.ratios, JSON.stringify(factors)).toEqual([0.5, 0.5])
    }
  })

  it('produces a split that the state accepts as it is (ratios that sum to 1, panes of one space)', () => {
    const result = withSplit({ itemWidthFactors: ['t1', 0.6, 't0', 0.4] }, URLS)
    const c = ctx()
    const merged = reduce(createInitialState(c), { type: 'import/merge', spaces: result.spaces, tabs: result.tabs, folders: result.folders, favorites: [], splits: result.splits }, c)
    expect(merged.splits).toEqual(result.splits)
  })

  it('works in the Today part and at the root of the pinned part too', () => {
    expect(withSplit({}, URLS, 'today').splits[0]).toMatchObject({ tabIds: expect.any(Array) })
    expect(withSplit({}, URLS, 'today').tabs.map((t) => t.pinned)).toEqual([false, false])
    const pinned = withSplit({}, URLS, 'pinned')
    expect(pinned.tabs.map((t) => [t.pinned, t.folderId])).toEqual([[true, undefined], [true, undefined]])
    expect(pinned.splits).toHaveLength(1)
  })

  it('keeps the tabs but not the split when fewer than two panes are web pages, and says so', () => {
    const lone = withSplit({}, ['https://a.example/', 'chrome-extension://abc/page.html'])
    expect(lone.splits).toEqual([])
    expect(lone.tabs.map((t) => t.url)).toEqual(['https://a.example/'])
    // The split itself and the page that is not a web page.
    expect(lone.report.skipped).toBe(2)
    const empty = withSplit({}, [])
    expect(empty.splits).toEqual([])
    expect(empty.report.skipped).toBe(1)
  })

  it('puts four panes in a split at most and keeps the other tabs as tabs', () => {
    const six = withSplit({}, Array.from({ length: 6 }, (_, i) => `https://p${i}.example/`))
    expect(six.splits[0]!.tabIds).toHaveLength(4)
    expect(six.tabs).toHaveLength(6)
  })

  it('counts the tabs of a split inside a folder the limit kept out, and imports none of them', () => {
    const items: ArcObject[] = [{ id: 'p', childrenIds: Array.from({ length: MAX_IMPORTED_FOLDERS + 1 }, (_, i) => `L${i}`), data: {} }]
    for (let i = 0; i < MAX_IMPORTED_FOLDERS; i++) items.push({ id: `L${i}`, childrenIds: [], title: `f${i}`, data: { list: {} } })
    const last = `L${MAX_IMPORTED_FOLDERS}`
    items.push({ id: last, childrenIds: ['sv'], title: 'trop', data: { list: {} } }, { id: 'sv', childrenIds: ['a', 'b'], data: { splitView: {} } }, tabItem('a', 'https://a.example/'), tabItem('b', 'https://b.example/'))
    const result = convertArcSidebar(sidebarOf(items), ctx())
    expect(result.tabs).toEqual([])
    expect(result.splits).toEqual([])
    // The folder itself and its two tabs.
    expect(result.report.overLimit).toBe(3)
  })

  it('counts the tabs a full import leaves out of a split as over the limit, and no split is made of one', () => {
    const items: ArcObject[] = [{ id: 'p', childrenIds: [...Array.from({ length: MAX_IMPORTED_LINKS - 1 }, (_, i) => `T${i}`), 'sv'], data: {} }, { id: 'sv', childrenIds: ['a', 'b'], data: { splitView: {} } }, tabItem('a', 'https://a.example/'), tabItem('b', 'https://b.example/')]
    for (let i = 0; i < MAX_IMPORTED_LINKS - 1; i++) items.push(tabItem(`T${i}`, `https://t${i}.example/`))
    const result = convertArcSidebar(sidebarOf(items), ctx())
    expect(result.tabs).toHaveLength(MAX_IMPORTED_LINKS)
    expect(result.splits).toEqual([])
    expect(result.report).toMatchObject({ overLimit: 1, skipped: 1 })
  })
})

describe('tab groups', () => {
  it('brings the tabs of a group in, in place and in order, and counts the groups', () => {
    const items: ArcObject[] = [
      { id: 'p', childrenIds: ['a', 'g', 'd'], data: {} },
      tabItem('a', 'https://a.example/'),
      { id: 'g', childrenIds: ['b', 'c'], title: 'Groupe', data: { tabGroup: { title: 'Groupe' } } },
      tabItem('b', 'https://b.example/'),
      tabItem('c', 'https://c.example/'),
      tabItem('d', 'https://d.example/')
    ]
    const result = convertArcSidebar(sidebarOf(items), ctx())
    expect(result.tabs.map((t) => t.url)).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'])
    expect(result.report).toMatchObject({ tabs: 4, tabGroups: 1, skipped: 0 })
  })
})

describe('the ids of what is imported', () => {
  const fixtureResult = () => convertArcSidebar(fixture, ctx())

  it('come from the file’s own ids, so the same file always gives the same ones (and another id gives another)', () => {
    const first = fixtureResult()
    const second = convertArcSidebar(fixture, { now: 99, newId: () => 'other' })
    expect(second.spaces.map((s) => s.id)).toEqual(first.spaces.map((s) => s.id))
    expect(second.tabs.map((t) => t.id)).toEqual(first.tabs.map((t) => t.id))
    expect(second.folders.map((f) => f.id)).toEqual(first.folders.map((f) => f.id))
    const all = [...first.spaces, ...first.tabs, ...first.folders].map((e) => e.id)
    expect(new Set(all).size).toBe(all.length)
    for (const id of all) expect(id).toMatch(/^arc-[0-9a-f]{24}$/)
    expect(arcId('space', 'x')).not.toBe(arcId('item', 'x'))
  })

  it('make a second merge of the same import change nothing, and let the user’s own changes stand', () => {
    const c = ctx()
    const imported = fixtureResult()
    const merge = (state: ReturnType<typeof createInitialState>) =>
      reduce(state, { type: 'import/merge', spaces: imported.spaces, tabs: imported.tabs, folders: imported.folders, favorites: imported.favorites, splits: imported.splits }, c)
    const once = merge(createInitialState(c))
    expect(merge(once)).toEqual(once)
    // The user renamed a space, picked a tab in it and moved a tab to Today: a second import touches none of it.
    const space = once.spaces.find((s) => s.name === 'Travail')!
    const tab = once.tabs.find((t) => t.url === 'https://pinned.example/')!
    const edited = reduce(reduce(reduce(once, { type: 'space/update', id: space.id, patch: { name: 'Boulot' } }, c), { type: 'tab/select', id: tab.id }, c), { type: 'tab/move', id: tab.id, toIndex: 0, pinned: false }, c)
    const again = merge(edited)
    expect(edited.spaces.map((s) => s.name)).toContain('Boulot')
    expect(edited.tabs.find((t) => t.id === tab.id)?.pinned).toBe(false)
    expect(edited.activeTabBySpace[space.id]).toBe(tab.id)
    expect(again.spaces.map((s) => s.name)).toEqual(edited.spaces.map((s) => s.name))
    expect(again.activeTabBySpace).toEqual(edited.activeTabBySpace)
    expect(again.tabs).toEqual(edited.tabs)
  })
})
