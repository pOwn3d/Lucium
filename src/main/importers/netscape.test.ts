import { describe, expect, it } from 'vitest'
import type { Favorite, Folder, SidebarState, Space, TabItem } from '@shared/model'
import { exportBookmarksHtml } from '@shared/bookmarks-html'
import { MAX_IMPORTED_LINKS } from '@shared/import-sources'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
import type { BookmarkNode } from './bookmark-tree'
import { NETSCAPE_MAX_DEPTH, NETSCAPE_MAX_NODES, NETSCAPE_MAX_SCANNED, convertNetscapeBookmarks, decodeEntities, parseNetscapeBookmarks } from './netscape'

const link = (title: string, url: string): BookmarkNode => ({ kind: 'link', title, url })
const dir = (title: string, ...children: BookmarkNode[]): BookmarkNode => ({ kind: 'folder', title, children })
const ctx = (): Ctx => {
  let n = 0
  return { now: 5, newId: () => `n${++n}` }
}

describe('parseNetscapeBookmarks', () => {
  it('reads the file other browsers write: nested lists, folders, links, in order', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Barre</H3>
    <DL><p>
        <DT><A HREF="https://a.example/" ADD_DATE="2">A</A>
        <DT><H3>Dossier</H3>
        <DL><p>
            <DT><A HREF='https://b.example/'>B</A>
        </DL><p>
    </DL><p>
    <DT><A HREF=https://c.example/>C sans guillemets</A>
</DL><p>`
    expect(parseNetscapeBookmarks(html).nodes).toEqual([dir('Barre', link('A', 'https://a.example/'), dir('Dossier', link('B', 'https://b.example/'))), link('C sans guillemets', 'https://c.example/')])
  })

  it('reads tags in any case, decodes character references, drops markup inside a title and folds blanks', () => {
    const html = `<dl><dt><a href="https://a.example/?x=1&amp;y=2">Tom &amp; Jerry &#39;1&#x27;  <b>gras</b>\n suite &eacute;</a></dl>`
    expect(parseNetscapeBookmarks(html).nodes).toEqual([link('Tom & Jerry \'1\' gras suite &eacute;', 'https://a.example/?x=1&y=2')])
  })

  it('does not look inside a quoted attribute for the end of the tag', () => {
    const html = '<DL><DT><A TITLE="a > b" HREF="https://a.example/">ok</A></DL>'
    expect(parseNetscapeBookmarks(html).nodes).toEqual([link('ok', 'https://a.example/')])
  })

  it('ignores an anchor with no address, and a folder name with no list', () => {
    expect(parseNetscapeBookmarks('<DL><DT><A>sans adresse</A><DT><H3>orpheline</H3></DL>').nodes).toEqual([])
  })

  it('reads an empty folder as a folder', () => {
    expect(parseNetscapeBookmarks('<DL><DT><H3>Vide</H3><DL><p></DL><p></DL>').nodes).toEqual([dir('Vide')])
  })

  it('gives something for any text and nothing for no bookmarks', () => {
    for (const text of ['', 'pas du html', '<<<<>>>>', '<a', '<A HREF="', '</DL></DL></DL>', '<H3>']) expect(() => parseNetscapeBookmarks(text), text).not.toThrow()
    expect(parseNetscapeBookmarks('').nodes).toEqual([])
  })

  it('keeps going at a bounded depth: lists deeper than the limit are read as part of the level above', () => {
    const open = '<DT><H3>d</H3><DL>'.repeat(NETSCAPE_MAX_DEPTH + 10)
    const html = `<DL>${open}<DT><A HREF="https://deep.example/">profond</A>${'</DL>'.repeat(NETSCAPE_MAX_DEPTH + 10)}</DL>`
    let depth = 0
    let nodes = parseNetscapeBookmarks(html).nodes
    let found = false
    while (nodes.length > 0) {
      const first = nodes.find((n) => n.kind === 'folder') as Extract<BookmarkNode, { kind: 'folder' }> | undefined
      if (nodes.some((n) => n.kind === 'link')) found = true
      if (!first) break
      depth++
      nodes = first.children
    }
    expect(found).toBe(true)
    expect(depth).toBeLessThanOrEqual(NETSCAPE_MAX_DEPTH)
  })

  it('reads at most a bounded number of elements and says it stopped', () => {
    const many = `<DL>${'<DT><A HREF="https://a.example/">x</A>'.repeat(NETSCAPE_MAX_NODES + 50)}</DL>`
    const parsed = parseNetscapeBookmarks(many)
    expect(parsed.truncated).toBe(true)
    expect(parsed.count).toBe(NETSCAPE_MAX_NODES)
  })

  it('takes linear time on a file of tags that never close', () => {
    for (const unit of ['<a "', '<A HREF="x', '<h3>', '<a href=y>', '<']) {
      const started = performance.now()
      parseNetscapeBookmarks(unit.repeat(40_000))
      expect(performance.now() - started, unit).toBeLessThan(1500)
    }
  })

  // The import runs in the main process, so a hostile file must not freeze the application. Before: a megabyte of `<a>` took 2.8 s
  // (each anchor with no address cost a 4 Ko window and never counted towards the bound), and markup inside a title took quadratic time.
  it('counts every anchor and folder title towards the bound, an anchor with no address too', () => {
    const parsed = parseNetscapeBookmarks('<a>'.repeat(NETSCAPE_MAX_NODES + 50))
    expect(parsed.truncated).toBe(true)
    expect(parsed.count).toBe(NETSCAPE_MAX_NODES)
    expect(parsed.nodes).toEqual([])
  })

  it('stops after a bounded number of tags it does nothing with, and says it stopped', () => {
    const parsed = parseNetscapeBookmarks(`${'<p>'.repeat(NETSCAPE_MAX_SCANNED)}<DL><DT><A HREF="https://after.example/">après</A></DL>`)
    expect(parsed.truncated).toBe(true)
    expect(parsed.nodes).toEqual([])
  })

  it('reads a megabyte of anchors with no address in a moment, not in seconds', () => {
    const html = '<a>'.repeat(350_000)
    const started = performance.now()
    parseNetscapeBookmarks(html)
    expect(performance.now() - started).toBeLessThan(400)
  })

  it('takes linear time on markup that never closes inside a title, and on titles that never close', () => {
    for (const html of [`<DL>${`<DT><A HREF="https://a.example/">${'<'.repeat(4000)}</A>`.repeat(500)}</DL>`, `<DL>${`<DT><H3>${'<b'.repeat(2000)}</H3><DL></DL>`.repeat(500)}</DL>`, `<DL>${'<DT><A HREF="https://a.example/">titre sans fin '.repeat(60_000)}</DL>`]) {
      const started = performance.now()
      parseNetscapeBookmarks(html)
      expect(performance.now() - started, html.slice(0, 60)).toBeLessThan(1500)
    }
  })

  it('cuts a title at the bound instead of reading to the end of the file', () => {
    const { nodes } = parseNetscapeBookmarks(`<DL><DT><A HREF="https://a.example/">${'t'.repeat(50_000)}</A></DL>`)
    expect((nodes[0] as { title: string }).title.length).toBeLessThanOrEqual(4096)
  })
})

describe('decodeEntities', () => {
  it('decodes the usual references and leaves an unknown or impossible one as it is', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;&nbsp;&#65;&#x1F600;')).toBe('&<>"\' A😀')
    expect(decodeEntities('&bogus; &#0; &#xD800; &#99999999; & seul')).toBe('&bogus; &#0; &#xD800; &#99999999; & seul')
  })
})

describe('convertNetscapeBookmarks', () => {
  it('makes a space of pinned tabs and folders, by the rules of every importer: web pages only, nested folders kept', () => {
    const html = '<DL><DT><H3>Dossier</H3><DL><DT><A HREF="https://a.example/">A</A><DT><H3>Sous</H3><DL><DT><A HREF="https://b.example/">B</A></DL></DL><DT><A HREF="javascript:alert(1)">piège</A><DT><A HREF="file:///tmp/x.html">fichier</A></DL>'
    const imported = convertNetscapeBookmarks(html, ctx())
    expect(imported.spaces).toHaveLength(1)
    expect(imported.tabs.map((t) => [t.url, t.pinned])).toEqual([['https://a.example/', true], ['https://b.example/', true]])
    expect(imported.folders.map((f) => f.name)).toEqual(['Dossier', 'Sous'])
    expect(imported.folders[1]!.parentId).toBe(imported.folders[0]!.id)
    // The script address and the file are not web pages.
    expect(imported.report.skipped).toBe(2)
  })

  it('imports nothing from a file without bookmarks, and no more than the limit from a big one', () => {
    expect(convertNetscapeBookmarks('<html>rien</html>', ctx()).spaces).toEqual([])
    const big = `<DL>${Array.from({ length: MAX_IMPORTED_LINKS + 5 }, (_, i) => `<DT><A HREF="https://a.example/${i}">x</A>`).join('')}</DL>`
    const imported = convertNetscapeBookmarks(big, ctx())
    expect(imported.tabs).toHaveLength(MAX_IMPORTED_LINKS)
    expect(imported.report.overLimit).toBe(5)
  })
})

// ---------- the round trip: what Lucium writes, Lucium reads back, with nothing lost ----------

describe('export, then import', () => {
  const NOW = 1_700_000_000_000
  const c: Ctx = { now: NOW, newId: () => 'x' }
  const space = (id: string, name: string): Space => ({ ...createInitialState(c).spaces[0]!, id, name })
  const tab = (id: string, spaceId: string, url: string, extra: Partial<TabItem> = {}): TabItem => ({ id, spaceId, url, title: id, pinned: true, createdAt: NOW, lastActiveAt: NOW, ...extra })
  const folder = (id: string, spaceId: string, name: string, parentId?: string): Folder => ({ id, spaceId, name, collapsed: false, ...(parentId ? { parentId } : {}) })
  const state: SidebarState = {
    ...createInitialState(c),
    spaces: [space('s1', 'Travail & « études »'), space('s2', 'Perso <3 😀')],
    folders: [folder('f1', 's1', 'Docs "importants"'), folder('f2', 's1', 'Niveau 2', 'f1'), folder('f3', 's1', 'Niveau 3', 'f2'), folder('f4', 's2', "L'été")],
    tabs: [
      tab('1', 's1', 'https://a.example/?q=1&r=2', { title: 'A & B <i>x</i>' }),
      tab('2', 's1', 'https://b.example/page#frag', { folderId: 'f1', title: 'Titre "guillemets" et \'apostrophes\'' }),
      tab('3', 's1', 'https://c.example/', { folderId: 'f2', customTitle: 'Nom perso' }),
      tab('4', 's1', 'https://d.example/', { folderId: 'f3', title: 'Très profond — éàü' }),
      tab('5', 's2', 'http://e.example:8080/x', { folderId: 'f4' }),
      tab('6', 's2', 'https://f.example/', { title: 'Emoji 😀🚀' }),
      tab('7', 's1', 'https://aujourdhui.example/', { pinned: false, title: 'Du jour' }),
      tab('8', 's1', 'about:blank'),
      tab('9', 's1', 'chrome-extension://abc/p.html')
    ],
    favorites: [{ id: 'v1', url: 'https://favori.example/', title: 'Favori <un>' } as Favorite]
  }

  /** What the file must hold, written by hand: the tree of each space, as the sidebar shows it. */
  const expected = (today: boolean): BookmarkNode[] => [
    dir('Favoris', link('Favori <un>', 'https://favori.example/')),
    dir(
      'Travail & « études »',
      link('A & B <i>x</i>', 'https://a.example/?q=1&r=2'),
      dir('Docs "importants"', link('Titre "guillemets" et \'apostrophes\'', 'https://b.example/page#frag'), dir('Niveau 2', link('Nom perso', 'https://c.example/'), dir('Niveau 3', link('Très profond — éàü', 'https://d.example/')))),
      ...(today ? [dir('Aujourd’hui', link('Du jour', 'https://aujourdhui.example/'))] : [])
    ),
    dir('Perso <3 😀', link('Emoji 😀🚀', 'https://f.example/'), dir("L'été", link('5', 'http://e.example:8080/x')))
  ]

  it('reads back every folder, nested as it was, and every link with its title, without the Today tabs by default', () => {
    const { html } = exportBookmarksHtml(state, { includeToday: false })
    expect(parseNetscapeBookmarks(html).nodes).toEqual(withEveryTitle(expected(false)))
  })

  it('reads back the Today tabs when they were asked for', () => {
    const { html } = exportBookmarksHtml(state, { includeToday: true })
    expect(parseNetscapeBookmarks(html).nodes).toEqual(withEveryTitle(expected(true)))
  })

  it('comes back through the import as the same pinned tabs and folders of a new space (what is not a web page is not a bookmark)', () => {
    const { html } = exportBookmarksHtml(state, { includeToday: false })
    const imported = convertNetscapeBookmarks(html, ctx())
    const merged = reduce(createInitialState(c), { type: 'import/merge', spaces: imported.spaces, tabs: imported.tabs, folders: imported.folders, favorites: [] }, ctx())
    const urls = merged.tabs.map((t) => t.url).sort()
    const written = state.tabs.filter((t) => t.pinned && /^https?:/.test(t.url)).map((t) => t.url)
    // The favourite comes back as a pinned tab of the imported space, in its "Favoris" folder.
    expect(urls).toEqual([...written, 'https://favori.example/'].map((u) => new URL(u).href).sort())
    expect(merged.folders.map((f) => f.name).sort()).toEqual(['Docs "importants"', 'Favoris', 'Niveau 2', 'Niveau 3', "L'été", 'Perso <3 😀', 'Travail & « études »'].sort())
    const niveau3 = merged.folders.find((f) => f.name === 'Niveau 3')!
    expect(merged.tabs.find((t) => t.folderId === niveau3.id)?.title).toBe('Très profond — éàü')
    const chain: string[] = []
    for (let f: Folder | undefined = niveau3; f; f = merged.folders.find((p) => p.id === f!.parentId)) chain.unshift(f.name)
    expect(chain).toEqual(['Travail & « études »', 'Docs "importants"', 'Niveau 2', 'Niveau 3'])
  })

  it('survives a second trip: what is read back writes the same file', () => {
    const first = exportBookmarksHtml(state, { includeToday: false }).html
    const imported = convertNetscapeBookmarks(first, ctx())
    const back: SidebarState = { ...createInitialState(c), spaces: imported.spaces, tabs: imported.tabs, folders: imported.folders, activeSpaceId: imported.spaces[0]!.id }
    const second = exportBookmarksHtml(back, { includeToday: false }).html
    const names = (html: string) => parseNetscapeBookmarks(html).nodes
    // One more level now (the imported space), holding the first file's tree.
    expect(names(second)).toEqual([dir(imported.spaces[0]!.name, ...names(first))])
  })
})

/** The links as the file gives them: the address as the URL parser spells it. */
function withEveryTitle(nodes: BookmarkNode[]): BookmarkNode[] {
  return nodes.map((n) => (n.kind === 'folder' ? { ...n, children: withEveryTitle(n.children) } : { ...n, url: new URL(n.url).href }))
}

describe('parseNetscapeBookmarks with details (the bookmark library)', () => {
  const html = `<DL><p>
    <DT><H3>Dossier</H3>
    <DD>Description du dossier
    <DL><p>
      <DT><A HREF="https://a.example/" ADD_DATE="1600000000" TAGS="x, y">A</A>
      <DD>Note de A &amp; plus
      <DT><A HREF="https://b.example/" ADD_DATE="pas un nombre">B</A>
    </DL><p>
    <DT><A HREF="https://c.example/">C</A>
    <DD>
</DL>`

  it('reads the tags, the date and the note of a link, and only those of the link they belong to', () => {
    const { nodes } = parseNetscapeBookmarks(html, { details: true })
    expect(nodes).toEqual([
      dir('Dossier', { kind: 'link', title: 'A', url: 'https://a.example/', tags: 'x, y', addedAt: 1_600_000_000, note: 'Note de A & plus' }, link('B', 'https://b.example/')),
      link('C', 'https://c.example/')
    ])
  })

  it('leaves all of that out by default, so that the import into the sidebar is what it was', () => {
    const { nodes } = parseNetscapeBookmarks(html)
    expect(nodes).toEqual([dir('Dossier', link('A', 'https://a.example/'), link('B', 'https://b.example/')), link('C', 'https://c.example/')])
  })

  it('cuts a long note and a long list of tags', () => {
    const long = `<DL><DT><A HREF="https://a.example/" TAGS="${'t,'.repeat(1500)}">A</A><DD>${'n'.repeat(5000)}</DL>`
    const [only] = parseNetscapeBookmarks(long, { details: true }).nodes
    expect(only?.kind === 'link' && (only.tags?.length ?? 0)).toBeLessThanOrEqual(2000)
    expect(only?.kind === 'link' && (only.note?.length ?? 0)).toBeLessThanOrEqual(1200)
  })
})
