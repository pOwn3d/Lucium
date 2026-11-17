import { describe, expect, it } from 'vitest'
import type { Bookmark, Favorite, Folder, SidebarState, Space, TabItem } from './model'
import { bookmarksExportSummary, escapeHtml, exportBookmarksHtml, exportLibraryHtml, exportableUrl, libraryExportSummary, parseBookmarksExportRequest } from './bookmarks-html'
import { createInitialState } from './sidebar'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

const ctx = { now: 1_700_000_000_000, newId: () => 'x' }
const space = (id: string, name: string): Space => ({ ...createInitialState(ctx).spaces[0]!, id, name })
const tab = (id: string, spaceId: string, url: string, extra: Partial<TabItem> = {}): TabItem => ({ id, spaceId, url, title: id, pinned: true, createdAt: 1_700_000_000_000, lastActiveAt: 1_700_000_100_000, ...extra })
const folder = (id: string, spaceId: string, name: string, parentId?: string): Folder => ({ id, spaceId, name, collapsed: false, ...(parentId ? { parentId } : {}) })
const stateOf = (parts: Partial<SidebarState>): SidebarState => ({ ...createInitialState(ctx), spaces: [], ...parts })
const off = { includeToday: false }
const on = { includeToday: true }

describe('exportBookmarksHtml', () => {
  const state = stateOf({
    spaces: [space('s1', 'Travail'), space('s2', 'Perso')],
    folders: [folder('f1', 's1', 'Docs'), folder('f2', 's1', 'Sous-dossier', 'f1'), folder('f3', 's2', 'Loisirs')],
    tabs: [
      tab('a', 's1', 'https://a.example/'),
      tab('b', 's1', 'https://b.example/page', { folderId: 'f1' }),
      tab('c', 's1', 'https://c.example/', { folderId: 'f2', title: 'Titre de C', customTitle: 'Nom perso' }),
      tab('d', 's1', 'https://aujourdhui.example/', { pinned: false }),
      tab('e', 's2', 'file:///Users/moi/doc.pdf', { folderId: 'f3' })
    ],
    favorites: [{ id: 'fav', url: 'https://favori.example/', title: 'Mon favori' } as Favorite]
  })

  it('writes the Netscape bookmarks file: favourites, then each space with its loose pins, its folders (nested) and their pins', () => {
    const { html, counts } = exportBookmarksHtml(state, off)
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n')).toBe(true)
    expect(html).toContain('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">')
    const order = ['<H3>Favoris</H3>', 'https://favori.example/', '<H3>Travail</H3>', 'https://a.example/', '<H3>Docs</H3>', 'https://b.example/page', '<H3>Sous-dossier</H3>', 'https://c.example/', '<H3>Perso</H3>', '<H3>Loisirs</H3>', 'file:///Users/moi/doc.pdf']
    const at = order.map((needle) => html.indexOf(needle))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(html).toContain('>Nom perso</A>')
    expect(counts).toEqual({ spaces: 2, links: 4, folders: 3, favorites: 1, today: 0, skipped: 0 })
  })

  it('leaves the Today tabs out unless asked, and then puts them in a folder of their own in their space', () => {
    expect(exportBookmarksHtml(state, off).html).not.toContain('aujourdhui.example')
    const { html, counts } = exportBookmarksHtml(state, on)
    expect(html).toMatch(/<DT><H3>Aujourd’hui<\/H3>\n\s+<DL><p>\n\s+<DT><A HREF="https:\/\/aujourdhui\.example\/"/)
    expect(counts.today).toBe(1)
    expect(counts.links).toBe(4)
  })

  it('writes the dates of a tab, in seconds', () => {
    expect(exportBookmarksHtml(state, off).html).toContain('<A HREF="https://a.example/" ADD_DATE="1700000000" LAST_MODIFIED="1700000100">')
  })

  it('escapes every title and name: no markup, no attribute, no control character gets through', () => {
    const hostile = stateOf({
      spaces: [space('s1', '</H3><script>alert(1)</script>')],
      folders: [folder('f', 's1', '"><img src=x onerror=alert(1)>')],
      tabs: [tab('t', 's1', 'https://ok.example/?a=1&b="2"', { title: `<b>gras</b> & 'guillemets' "doubles"\u0000\n`, folderId: 'f' })],
      favorites: [{ id: 'v', url: 'https://fav.example/', title: '<img src=x onerror=alert(1)>' } as Favorite]
    })
    const { html } = exportBookmarksHtml(hostile, off)
    expect(html).not.toMatch(/<script|<img|<b>|onerror=alert\(1\)>/i)
    expect(html).toContain('&lt;/H3&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('HREF="https://ok.example/?a=1&amp;b=%222%22"')
    expect(html).toContain('&lt;b&gt;gras&lt;/b&gt; &amp; &#39;guillemets&#39; &quot;doubles&quot;')
    expect(html).not.toMatch(/\u0000/)
    // The title ran on after a newline: it is one line.
    expect(html.split('\n').filter((l) => l.includes('gras')).length).toBe(1)
  })

  it('writes only web pages and files: internal pages, extensions, scripts and data addresses are left out, and counted', () => {
    const bad = stateOf({
      spaces: [space('s1', 'S')],
      tabs: [
        tab('1', 's1', 'about:blank'),
        tab('2', 's1', 'chrome-extension://abc/page.html'),
        tab('3', 's1', 'javascript:alert(1)'),
        tab('4', 's1', 'data:text/html,<b>x</b>'),
        tab('5', 's1', 'view-source:https://x.example/'),
        tab('6', 's1', 'https://ok.example/'),
        tab('7', 's1', 'http://ok.example/')
      ],
      favorites: [{ id: 'v', url: 'about:blank', title: 'x' } as Favorite]
    })
    const { html, counts } = exportBookmarksHtml(bad, off)
    expect(html.match(/<A HREF="([^"]*)"/g)).toEqual(['<A HREF="https://ok.example/"', '<A HREF="http://ok.example/"'])
    expect(counts).toMatchObject({ links: 2, favorites: 0, skipped: 6 })
  })

  it('writes an address as the parser reads it, so a space or a quote in it cannot leave the attribute', () => {
    const odd = stateOf({ spaces: [space('s1', 'S')], tabs: [tab('1', 's1', 'https://x.example/a b"c\'d')] })
    expect(exportBookmarksHtml(odd, off).html).toContain('HREF="https://x.example/a%20b%22c&#39;d"')
  })

  it('names an empty title after its address and an empty name "Dossier"', () => {
    const bare = stateOf({ spaces: [space('s1', 'S')], folders: [folder('f', 's1', '  ')], tabs: [tab('1', 's1', 'https://x.example/', { title: '', folderId: 'f' })] })
    const { html } = exportBookmarksHtml(bare, off)
    expect(html).toContain('<H3>Dossier</H3>')
    expect(html).toContain('>https://x.example/</A>')
  })

  it('names the file, the favourites and a folder without a name in the language of the interface, as it names the Today folder', () => {
    const bare = stateOf({
      spaces: [space('s1', 'S')],
      folders: [folder('f', 's1', '  ')],
      tabs: [tab('1', 's1', 'https://x.example/', { folderId: 'f' })],
      favorites: [{ id: 'fav', url: 'https://favori.example/', title: 'F' } as Favorite]
    })
    setLanguage('en')
    try {
      const { html } = exportBookmarksHtml(bare, off)
      expect(html).toContain('<TITLE>Lucium Bookmarks</TITLE>\n<H1>Lucium Bookmarks</H1>')
      expect(html).toContain('<H3>Favorites</H3>')
      expect(html).toContain('<H3>Folder</H3>')
      expect(exportLibraryHtml([]).html).toContain('<H1>Lucium Bookmarks</H1>')
      // The counts are written with the digits of English.
      expect(libraryExportSummary(12_000, 0)).toBe('12,000 bookmarks.')
    } finally {
      setLanguage('fr')
    }
    expect(exportBookmarksHtml(bare, off).html).toContain('<TITLE>Signets de Lucium</TITLE>\n<H1>Signets de Lucium</H1>')
  })

  it('writes a folder that holds nothing, and a tab whose folder is gone as a loose one', () => {
    const odd = stateOf({ spaces: [space('s1', 'S')], folders: [folder('f', 's1', 'Vide')], tabs: [tab('1', 's1', 'https://x.example/', { folderId: 'absent' })] })
    const { html, counts } = exportBookmarksHtml(odd, off)
    expect(html).toMatch(/<H3>Vide<\/H3>\n\s+<DL><p>\n\s+<\/DL><p>/)
    expect(counts).toMatchObject({ links: 1, folders: 1 })
  })

  it('does not loop on folders that hold each other, and still writes them and their tabs', () => {
    const loop = stateOf({
      spaces: [space('s1', 'S')],
      folders: [folder('a', 's1', 'A', 'b'), folder('b', 's1', 'B', 'a')],
      tabs: [tab('1', 's1', 'https://x.example/', { folderId: 'a' }), tab('2', 's1', 'https://y.example/', { folderId: 'b' })]
    })
    const { html, counts } = exportBookmarksHtml(loop, off)
    expect(counts).toMatchObject({ folders: 2, links: 2 })
    expect(html).toContain('https://x.example/')
    expect(html).toContain('https://y.example/')
  })

  it('writes a file with no folder at all for an empty browser, rather than failing', () => {
    const { html, counts } = exportBookmarksHtml(stateOf({}), off)
    expect(html).toContain('<DL><p>')
    expect(counts).toEqual({ spaces: 0, links: 0, folders: 0, favorites: 0, today: 0, skipped: 0 })
  })
})

describe('a chain of folders deeper than any the sidebar makes', () => {
  it('is written whole, without running out of stack: past the bound, the folders below come one level up', async () => {
    const { BOOKMARKS_EXPORT_DEPTH_MAX } = await import('./bookmarks-html')
    const length = 3000
    const folders = Array.from({ length }, (_, i) => folder(`f${i}`, 's1', `Dossier ${i}`, i > 0 ? `f${i - 1}` : undefined))
    const tabs = Array.from({ length }, (_, i) => tab(`t${i}`, 's1', `https://t${i}.example/`, { folderId: `f${i}` }))
    const deep = stateOf({ spaces: [space('s1', 'Travail')], folders, tabs })
    const { html, counts } = exportBookmarksHtml(deep, off)
    expect(counts).toMatchObject({ folders: length, links: length })
    const indents = html.split('\n').filter((line) => line.includes('<DT><H3>')).map((line) => line.length - line.trimStart().length)
    expect(Math.max(...indents)).toBeLessThanOrEqual((BOOKMARKS_EXPORT_DEPTH_MAX + 1) * 4)
  })
})

describe('exportableUrl', () => {
  it('lets http, https and file through, in the form the URL parser gives', () => {
    expect(exportableUrl('https://a.example')).toBe('https://a.example/')
    expect(exportableUrl('http://a.example/x')).toBe('http://a.example/x')
    expect(exportableUrl('file:///tmp/a.html')).toBe('file:///tmp/a.html')
  })

  it('refuses anything else, an address with a control character, one too long, and what is not a string', () => {
    for (const bad of ['about:blank', 'javascript:1', 'data:text/plain,x', 'ftp://a.example/', 'chrome://settings', 'blob:https://a.example/id', 'https://a.example/\u0007', `https://a.example/${'x'.repeat(9000)}`, 'pas une adresse', '', null, 3]) {
      expect(exportableUrl(bad), String(bad)).toBeNull()
    }
  })
})

describe('escapeHtml', () => {
  it('replaces the five characters HTML reads, and control characters by spaces', () => {
    expect(escapeHtml(`<a href="x">'&'</a>\t\u0000`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;  ')
  })
})

describe('parseBookmarksExportRequest', () => {
  it('asks for the Today tabs only with a flag that is exactly true', () => {
    expect(parseBookmarksExportRequest({ includeToday: true })).toEqual({ includeToday: true })
    for (const loose of ['true', 1, 'yes', null, undefined, {}]) expect(parseBookmarksExportRequest({ includeToday: loose })).toEqual({ includeToday: false })
    expect(parseBookmarksExportRequest({})).toEqual({ includeToday: false })
  })

  it('refuses a request that is not an object', () => {
    for (const bad of [null, undefined, 'x', 3, true, ['includeToday']]) expect(parseBookmarksExportRequest(bad), String(bad)).toBeNull()
  })
})

describe('bookmarksExportSummary', () => {
  it('counts what the file holds, with the Today tabs only when asked for, and what was left aside', () => {
    const counts = { spaces: 2, links: 12, folders: 3, favorites: 1, today: 5, skipped: 0 }
    expect(bookmarksExportSummary(counts, false)).toBe('12 onglets épinglés, 3 dossiers, 1 favori dans 2 espaces.')
    expect(bookmarksExportSummary(counts, true)).toBe('12 onglets épinglés, 3 dossiers, 1 favori, 5 onglets du jour dans 2 espaces.')
    expect(bookmarksExportSummary({ ...counts, skipped: 2 }, false)).toContain(frenchSpaces('2 éléments laissés de côté : ce n’est ni une page web ni un fichier.'))
  })
})

describe('exportLibraryHtml', () => {
  const bm = (n: number, over: Partial<Bookmark> = {}): Bookmark => ({ id: `b${n}`, url: `https://site${n}.example/page`, title: `Page ${n}`, tags: [], addedAt: 1_600_000_000_000 + n * 1000, ...over })

  it('writes a flat Netscape file with the date, the tags and the note of each bookmark', () => {
    const { html, count, skipped } = exportLibraryHtml([bm(1, { tags: ['à voir', 'dev'], note: 'Une note' }), bm(2)])
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n')).toBe(true)
    expect(html).toContain('<DT><A HREF="https://site1.example/page" ADD_DATE="1600000001" TAGS="à voir,dev">Page 1</A>\n    <DD>Une note')
    expect(html).toContain('<DT><A HREF="https://site2.example/page" ADD_DATE="1600000002">Page 2</A>')
    expect(html.indexOf('site1.example')).toBeLessThan(html.indexOf('site2.example'))
    expect({ count, skipped }).toEqual({ count: 2, skipped: 0 })
  })

  it('escapes titles, notes and tags, and writes only web addresses even for a library that was not cleaned', () => {
    const hostile = [
      bm(1, { title: '"><script>alert(1)</script>', note: '<img src=x onerror=alert(1)>', tags: ['a"b', "c'd", 'x,y', 'ctrl\u0000'] }),
      bm(2, { url: 'javascript:alert(1)' }),
      bm(3, { url: 'data:text/html,<script>1</script>' }),
      bm(4, { url: `https://long.example/${'x'.repeat(9000)}` }),
      bm(5, { title: '\u0000\u0001' })
    ]
    const { html, count, skipped } = exportLibraryHtml(hostile)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('data:text')
    expect(html).toContain('TAGS="a&quot;b,c&#39;d"')
    expect(html.replace(/\n/g, '')).not.toMatch(/\p{Cc}/u)
    expect({ count, skipped }).toEqual({ count: 2, skipped: 3 })
    expect(html).toContain('>https://site5.example/page</A>')
  })

  it('writes a file with no link for an empty library, rather than failing', () => {
    expect(exportLibraryHtml([])).toMatchObject({ count: 0, skipped: 0 })
  })

  it('tells what the file holds and what it left out', () => {
    expect(libraryExportSummary(3, 0)).toBe('3 signets.')
    expect(libraryExportSummary(1, 2)).toBe(frenchSpaces('1 signet. 2 signets laissés de côté : ce n’est ni une page web ni un fichier.'))
  })
})

describe('the private tabs of a normal window', () => {
  it('are in no export, with or without the Today tabs: neither their address nor their title', () => {
    const state = stateOf({
      spaces: [space('s1', 'Travail')],
      tabs: [
        tab('a', 's1', 'https://a.example/'),
        tab('jour', 's1', 'https://aujourdhui.example/', { pinned: false }),
        tab('secret', 's1', 'https://prive.example/compte', { pinned: false, private: true, title: 'Titre privé' }),
        tab('epingle-prive', 's1', 'https://prive-epingle.example/', { private: true, title: 'Autre titre privé' })
      ]
    })
    for (const options of [on, off]) {
      const { html, counts } = exportBookmarksHtml(state, options)
      expect(html).not.toMatch(/prive|privé/)
      expect(counts.links).toBe(1)
      expect(counts.today).toBe(options.includeToday ? 1 : 0)
    }
    expect(exportBookmarksHtml(state, on).html).toContain('https://aujourdhui.example/')
  })
})
