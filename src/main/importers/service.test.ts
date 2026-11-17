import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/model'
import { parsePlist } from '@shared/plist'
import { createInitialState, reduce, type Action, type Ctx } from '@shared/sidebar'
import { MAX_IMPORTED_LINKS, defaultCategories } from '@shared/import-sources'
import { ImportService, MAX_IMPORT_FILE_BYTES, plutilToXml, type ImportDeps } from './service'
import { TEST_BROWSERS, fakeApplications } from './app-bundles.test-support'
import { frenchSpaces } from '@shared/french-typography'
import { onWindows } from '../windows.test-support'

// A pretend home folder with the files of the browsers, shaped as they are on disk.
const root = mkdtempSync(join(tmpdir(), 'lucium-import-home-'))
afterAll(() => {
  chmodSync(join(root, 'Library/Safari/Bookmarks.plist'), 0o644)
  rmSync(root, { recursive: true, force: true })
})

const put = (relative: string, content: string | ((path: string) => void)) => {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  if (typeof content === 'string') writeFileSync(path, content)
  else content(path)
}
const sqlite = (sql: string) => (path: string) => {
  const db = new DatabaseSync(path)
  db.exec(sql)
  db.close()
}

const WHEN = Date.UTC(2026, 3, 2, 10, 0, 0)
const SUPPORT = 'Library/Application Support'
const bookmarks = (url: string) => JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Barre', children: [{ type: 'url', name: 'Signet', url }] } } })

put(`${SUPPORT}/Google/Chrome/Local State`, JSON.stringify({ profile: { info_cache: { Default: { name: 'Personnel' }, 'Profile 2': { name: 'Travail' } } } }))
put(`${SUPPORT}/Google/Chrome/Default/Bookmarks`, bookmarks('https://chrome-perso.example/'))
put(`${SUPPORT}/Google/Chrome/Default/History`, sqlite(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
  INSERT INTO urls VALUES (1, 'https://chrome-perso.example/page', 'Page', 2, 0, ${(BigInt(WHEN) + 11_644_473_600_000n) * 1000n}, 0);`))
put(`${SUPPORT}/Google/Chrome/Profile 2/Bookmarks`, bookmarks('https://chrome-travail.example/'))
put(`${SUPPORT}/Firefox/Profiles/xyz.default-release/places.sqlite`, sqlite(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER);
  CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT);
  INSERT INTO moz_places VALUES (1, 'https://fox.example/', 'Fox', 1, ${WHEN * 1000});
  INSERT INTO moz_bookmarks VALUES (3, 2, NULL, 1, 0, 'toolbar'), (10, 1, 1, 3, 0, 'Fox signet');`))
put(`${SUPPORT}/Arc/StorableSidebar.json`, JSON.stringify({ sidebar: { containers: [{ spaces: [], items: [] }] } }))
const leaf = '<dict><key>URIDictionary</key><dict><key>title</key><string>Safari signet</string></dict><key>URLString</key><string>https://safari.example/</string><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict>'
put('Library/Safari/Bookmarks.plist', `<?xml version="1.0"?><plist version="1.0"><dict><key>Children</key><array><dict><key>Children</key><array>${leaf}</array><key>Title</key><string>BookmarksBar</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict></array></dict></plist>`)
put('Library/Safari/History.db', sqlite(`CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, domain_expansion TEXT, visit_count INTEGER);
  CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);
  INSERT INTO history_items VALUES (1, 'https://safari.example/page', NULL, 5);
  INSERT INTO history_visits VALUES (1, 1, ${(WHEN - Date.UTC(2001, 0, 1)) / 1000}, 'Page Safari');`))

let actions: Action[]
let merged: HistoryEntry[]
let asked: string[]
let chosen: string | null
// The browsers' applications, as the import sheet finds them on this Mac (their bundles give the names the sentences quote).
const APPLICATIONS = fakeApplications(join(root, 'Applications'), TEST_BROWSERS)
const service = (extra: Partial<ImportDeps> = {}) => {
  let n = 0
  const ctx: Ctx = { now: WHEN, newId: () => `i${++n}` }
  return new ImportService({
    home: root,
    ctx: () => ctx,
    dispatch: (action) => actions.push(action),
    state: () => createInitialState(ctx),
    mergeHistory: (entries) => {
      merged.push(...entries)
      return entries.length
    },
    chooseFile: async (_source, expected) => {
      asked.push(expected)
      return chosen
    },
    applications: [APPLICATIONS],
    ...extra
  })
}
beforeEach(() => {
  actions = []
  merged = []
  asked = []
  chosen = null
})

describe('listSources', () => {
  it('lists the browsers found, with their profiles named as the browser names them, Safari always', () => {
    const list = service().listSources()
    expect(list.map((s) => s.id)).toEqual(['chrome', 'safari', 'firefox', 'arc', 'html', 'other'])
    expect(list[0]!.profiles).toEqual([{ id: 'Default', name: 'Personnel' }, { id: 'Profile 2', name: 'Travail' }])
    expect(list.find((s) => s.id === 'firefox')!.profiles).toEqual([{ id: 'xyz.default-release', name: 'default-release' }])
    expect(list.find((s) => s.id === 'safari')!.profiles).toEqual([])
  })

  it('names a profile after its folder when the browser’s list of names is unreadable, and lists nothing for a browser that is not installed', () => {
    const lonely = mkdtempSync(join(tmpdir(), 'lucium-import-lonely-'))
    mkdirSync(join(lonely, `${SUPPORT}/Google/Chrome/Default`), { recursive: true })
    writeFileSync(join(lonely, `${SUPPORT}/Google/Chrome/Default/History`), '')
    const list = new ImportService({ home: lonely, ctx: () => ({ now: 1, newId: () => 'x' }), dispatch: () => undefined, state: () => createInitialState({ now: 1, newId: () => 'x' }), mergeHistory: () => 0, chooseFile: async () => null }).listSources()
    expect(list.map((s) => s.id)).toEqual(['chrome', 'safari', 'html', 'other'])
    expect(list[0]!.profiles).toEqual([{ id: 'Default', name: 'Default' }])
    rmSync(lonely, { recursive: true, force: true })
  })

  it('names each browser as its application calls itself on this Mac, and the sentence under it quotes that name', () => {
    const list = service().listSources()
    const named = (id: string) => list.find((s) => s.id === id)!
    expect(['chrome', 'safari', 'firefox', 'arc'].map((id) => named(id).name)).toEqual(['Google Chrome', 'Safari', 'Firefox', 'Arc'])
    expect(named('chrome').blurb).toBe('Nous pouvons importer vos signets et votre historique depuis Google Chrome.')
    expect(named('arc').blurb).toMatch(/^Nous pouvons importer vos espaces, .* depuis Arc\.$/)
    expect([named('html').name, named('other').name]).toEqual(['Fichier de signets (HTML)', 'Autre navigateur'])
  })

  it('gives a browser whose application is not on this Mac its generic label, and numbers two labels that are the same', () => {
    put(`${SUPPORT}/BraveSoftware/Brave-Browser/Default/Bookmarks`, bookmarks('https://lion.example/'))
    try {
      // No folder of applications: no browser is named by the code, each one has the label of its format.
      const bare = service({ applications: [] }).listSources()
      expect(bare.map((s) => s.name)).toEqual(['Navigateur basé sur Chromium', 'Navigateur de macOS', 'Navigateur basé sur Gecko', 'Navigateur à barre latérale', 'Navigateur basé sur Chromium (2)', 'Fichier de signets (HTML)', 'Autre navigateur'])
      expect(bare[0]!.blurb).toBe('Nous pouvons importer vos signets et votre historique depuis Navigateur basé sur Chromium.')
      // With the applications, only the one that is not installed keeps the label.
      expect(service().listSources().find((s) => s.id === 'brave')!.name).toBe('Navigateur basé sur Chromium')
    } finally {
      rmSync(join(root, `${SUPPORT}/BraveSoftware`), { recursive: true, force: true })
    }
  })

  it('says, in the sentences of an import, the name the sheet showed', async () => {
    const svc = service()
    svc.listSources()
    chosen = null
    const report = await svc.run({ source: 'chrome', profile: 'Default', categories: ['bookmarks'] })
    expect(report.message).toMatch(/^Importé depuis Google Chrome\u00a0: /)
    // The space takes the short name of the application.
    expect((actions[0] as Extract<Action, { type: 'import/merge' }>).spaces[0]?.name).toBe('Chrome (Personnel)')
    // Without the applications, the same import speaks of the generic label.
    actions = []
    const bare = await service({ applications: [] }).run({ source: 'chrome', profile: 'Profile 2', categories: ['bookmarks'] })
    expect(bare.message).toMatch(/^Importé depuis Navigateur basé sur Chromium\u00a0: /)
  })
})

describe('run', () => {
  it('imports the bookmarks of the chosen Chrome profile into a new space, and its history into the history', async () => {
    const report = await service().run({ source: 'chrome', profile: 'Default', categories: ['bookmarks', 'history'] })
    expect(report).toMatchObject({ ok: true, bookmarks: 1, history: 1 })
    expect(report.message).toContain('Importé depuis Google Chrome')
    const merge = actions[0] as Extract<Action, { type: 'import/merge' }>
    expect(merge.type).toBe('import/merge')
    // Chrome has two profiles here: the space says which one it holds, so that importing both does not leave two spaces of one name.
    expect(merge.spaces[0]?.name).toBe('Chrome (Personnel)')
    expect(merge.tabs.map((t) => t.url)).toEqual(['https://chrome-perso.example/'])
    expect(merged).toEqual([{ url: 'https://chrome-perso.example/page', title: 'Page', visitCount: 2, lastVisitAt: WHEN }])
  })

  it('takes the profile the user chose, not the first one', async () => {
    await service().run({ source: 'chrome', profile: 'Profile 2', categories: ['bookmarks'] })
    expect((actions[0] as Extract<Action, { type: 'import/merge' }>).tabs[0]?.url).toBe('https://chrome-travail.example/')
  })

  it('never builds a path from a profile name that is not one of the browser’s own', async () => {
    for (const profile of ['../../../Safari', 'Profile 9', '/etc']) {
      const report = await service().run({ source: 'chrome', profile, categories: ['bookmarks'] })
      expect(report.ok, profile).toBe(false)
      expect(report.message).toContain('Aucun profil')
    }
    expect(actions).toEqual([])
  })

  it('refuses a browser it does not know and a request that asks for nothing it can give', async () => {
    expect((await service().run({ source: '../etc', categories: ['bookmarks'] })).ok).toBe(false)
    expect((await service().run({ source: 'safari', categories: [] })).message).toBe('Choisissez ce qu’il faut importer.')
    // The sidebar is not a category of the Safari import.
    expect((await service().run({ source: 'safari', categories: ['sidebar'] })).message).toBe('Choisissez ce qu’il faut importer.')
    expect(actions).toEqual([])
  })

  it('imports Safari bookmarks (through plutil’s XML) and history', async () => {
    const report = await service().run({ source: 'safari', categories: ['bookmarks', 'history'] })
    expect(report).toMatchObject({ ok: true, bookmarks: 1, history: 1 })
    expect(merged[0]).toEqual({ url: 'https://safari.example/page', title: 'Page Safari', visitCount: 5, lastVisitAt: WHEN })
  })

  it('imports Firefox bookmarks and history from its profile', async () => {
    const report = await service().run({ source: 'firefox', categories: ['bookmarks', 'history'] })
    expect(report).toMatchObject({ ok: true, bookmarks: 1, history: 1 })
    expect((actions[0] as Extract<Action, { type: 'import/merge' }>).spaces[0]?.name).toBe('Firefox')
  })

  // Windows: `chmod 000` does not make a file unreadable there (it only sets the read-only flag), so the refusal macOS gives cannot be provoked.
  it.skipIf(onWindows)('tells the user how to give access when macOS refuses to open the data, instead of saying there is nothing', async () => {
    chmodSync(join(root, 'Library/Safari/Bookmarks.plist'), 0o000)
    chmodSync(join(root, 'Library/Safari/History.db'), 0o000)
    const report = await service().run({ source: 'safari', categories: ['bookmarks', 'history'] })
    chmodSync(join(root, 'Library/Safari/Bookmarks.plist'), 0o644)
    chmodSync(join(root, 'Library/Safari/History.db'), 0o644)
    expect(report).toMatchObject({ ok: false, needsDiskAccess: true })
    expect(report.message).toContain('Accès complet au disque')
    expect(actions).toEqual([])
  })

  // Windows: `chmod 000` does not make a file unreadable there (it only sets the read-only flag), so the refusal macOS gives cannot be provoked.
  it.skipIf(onWindows)('imports what it can and says so when only one category is protected', async () => {
    chmodSync(join(root, 'Library/Safari/History.db'), 0o000)
    const report = await service().run({ source: 'safari', categories: ['bookmarks', 'history'] })
    chmodSync(join(root, 'Library/Safari/History.db'), 0o644)
    expect(report).toMatchObject({ ok: true, bookmarks: 1, history: 0 })
    expect(report.message).toContain('protégée par macOS')
  })

  it('lets the user pick the file, and uses it for the one category it holds', async () => {
    chosen = join(root, 'Library/Safari/History.db')
    const report = await service().run({ source: 'safari', categories: ['bookmarks', 'history'], pick: true })
    expect(asked).toEqual(['Bookmarks.plist ou History.db'])
    expect(report).toMatchObject({ ok: true, bookmarks: 0, history: 1 })
    expect(actions).toEqual([])
  })

  it('does nothing when the user cancels the file chooser', async () => {
    expect(await service().run({ source: 'safari', categories: ['history'], pick: true })).toMatchObject({ ok: false, message: 'Import annulé.' })
  })

  it('says a missing file is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'lucium-import-empty-'))
    const bare = new ImportService({ home: empty, ctx: () => ({ now: 1, newId: () => 'x' }), dispatch: () => undefined, state: () => createInitialState({ now: 1, newId: () => 'x' }), mergeHistory: () => 0, chooseFile: async () => null })
    const report = await bare.run({ source: 'safari', categories: ['history'] })
    expect(report.ok).toBe(false)
    expect(report.message).toContain('History.db est introuvable')
    rmSync(empty, { recursive: true, force: true })
  })

  it('reports a browser whose bookmarks hold no web page', async () => {
    put(`${SUPPORT}/Vivaldi/Default/Bookmarks`, JSON.stringify({ roots: { bookmark_bar: { children: [{ type: 'url', name: 'x', url: 'javascript:1' }] } } }))
    const report = await service().run({ source: 'vivaldi', profile: 'Default', categories: ['bookmarks'] })
    expect(report).toMatchObject({ ok: false, skipped: 1 })
    expect(report.message).toContain('Aucun signet web')
  })
})

describe('importing a bookmarks file (HTML)', () => {
  const file = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Dossier</H3><DL><p><DT><A HREF="https://html-un.example/">Un</A></DL><p><DT><A HREF="https://html-deux.example/">Deux</A><DT><A HREF="javascript:alert(1)">piège</A></DL><p>`

  it('always asks for the file, whatever the request says, and brings it in as a new space', async () => {
    put('Desktop/signets.html', file)
    chosen = join(root, 'Desktop/signets.html')
    const report = await service().run({ source: 'html', categories: ['bookmarks'] })
    expect(asked).toEqual(['un fichier de signets .html'])
    expect(report).toMatchObject({ ok: true, bookmarks: 2, folders: 1, skipped: 1 })
    const merge = actions[0] as Extract<Action, { type: 'import/merge' }>
    expect(merge.tabs.map((t) => t.url)).toEqual(['https://html-un.example/', 'https://html-deux.example/'])
    expect(merge.folders.map((f) => f.name)).toEqual(['Dossier'])
  })

  it('does nothing when the user cancels, and nothing with a file that is not a bookmarks file', async () => {
    expect(await service().run({ source: 'html', categories: ['bookmarks'] })).toMatchObject({ ok: false, message: 'Import annulé.' })
    put('Desktop/notes.txt', file)
    chosen = join(root, 'Desktop/notes.txt')
    expect((await service().run({ source: 'html', categories: ['bookmarks'] })).ok).toBe(false)
    expect(actions).toEqual([])
  })

  it('says a file that holds no bookmark list is not a bookmarks file, and one that holds an empty list has no bookmark', async () => {
    put('Desktop/vide.html', '<html><body>rien</body></html>')
    chosen = join(root, 'Desktop/vide.html')
    const other = await service().run({ source: 'html', categories: ['bookmarks'] })
    expect(other.ok).toBe(false)
    expect(other.message).toBe('vide.html n’est pas un fichier de signets reconnu (format inattendu).')
    put('Desktop/export-vide.html', '<!DOCTYPE NETSCAPE-Bookmark-file-1><TITLE>Signets</TITLE><H1>Signets</H1><DL><p></DL><p>')
    chosen = join(root, 'Desktop/export-vide.html')
    const empty = await service().run({ source: 'html', categories: ['bookmarks'] })
    expect(empty.ok).toBe(false)
    expect(empty.message).toContain('Aucun signet web')
    expect(actions).toEqual([])
  })
})

describe('ImportService with files that are too big or too long', () => {
  it('says that a bookmarks file bigger than the limit is too big, without reading it', async () => {
    put(`${SUPPORT}/BraveSoftware/Brave-Browser/Default/Bookmarks`, (path) => {
      writeFileSync(path, '{}')
      // A sparse file: it claims the size without using the disk.
      truncateSync(path, MAX_IMPORT_FILE_BYTES + 1)
    })
    const report = await service().run({ source: 'brave', profile: 'Default', categories: ['bookmarks'] })
    expect(report.ok).toBe(false)
    expect(report.message).toContain(frenchSpaces('Bookmarks : le fichier est trop volumineux'))
    expect(actions).toEqual([])
  })

  it('tells the user how many links the limit kept out, in the sentence of the sheet', async () => {
    const children = Array.from({ length: MAX_IMPORTED_LINKS + 3 }, (_, i) => ({ type: 'url', name: `n${i}`, url: `https://many.example/${i}` }))
    put(`${SUPPORT}/Vivaldi/Default/Bookmarks`, JSON.stringify({ roots: { bookmark_bar: { children } } }))
    const report = await service().run({ source: 'vivaldi', profile: 'Default', categories: ['bookmarks'] })
    expect(report).toMatchObject({ ok: true, bookmarks: MAX_IMPORTED_LINKS, overLimit: 3, skipped: 0 })
    expect(report.message).toMatch(/3 éléments non importés\u00a0: limite de 2\s000 atteinte\./)
    expect(report.message).not.toContain('ignoré')
  })
})

describe.runIf(process.platform === 'darwin')('plutilToXml', () => {
  it('converts a binary property list with the system’s own tool, so that the parser reads what Safari writes', async () => {
    const xmlPath = join(root, 'xml.plist')
    const binPath = join(root, 'bin.plist')
    writeFileSync(xmlPath, `<?xml version="1.0"?><plist version="1.0"><dict><key>Title</key><string>BookmarksBar</string><key>Date</key><date>2024-01-02T03:04:05Z</date></dict></plist>`)
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', binPath, xmlPath])
    const bytes = (await import('node:fs')).readFileSync(binPath)
    expect(bytes.subarray(0, 6).toString()).toBe('bplist')
    const parsed = parsePlist(await plutilToXml(bytes)) as { Title: string; Date: Date }
    expect(parsed.Title).toBe('BookmarksBar')
    expect(parsed.Date.toISOString()).toBe('2024-01-02T03:04:05.000Z')
  })

  it('stops a conversion whose output grows past the bound, and keeps none of it', async () => {
    const xmlPath = join(root, 'xml-big.plist')
    const binPath = join(root, 'bin-big.plist')
    writeFileSync(xmlPath, `<?xml version="1.0"?><plist version="1.0"><dict><key>Title</key><string>${'x'.repeat(5000)}</string></dict></plist>`)
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', binPath, xmlPath])
    const bytes = (await import('node:fs')).readFileSync(binPath)
    await expect(plutilToXml(bytes, 1000)).rejects.toThrow(/more than 1000 bytes/)
    expect(await plutilToXml(bytes)).toContain('Title')
  })

  it('refuses bytes that are not a property list', async () => {
    await expect(plutilToXml(Buffer.from('this is not a plist at all'))).rejects.toThrow(/plutil/)
  })
})

// ---------- Arc: sidebar, history, Tweaks ----------

describe('importing from Arc', () => {
  const home = mkdtempSync(join(tmpdir(), 'lucium-import-arc-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))
  const ARC = 'Library/Application Support/Arc'
  const at = (relative: string) => join(home, relative)
  const write = (relative: string, content: string | ((path: string) => void)) => {
    const path = at(relative)
    mkdirSync(dirname(path), { recursive: true })
    if (typeof content === 'string') writeFileSync(path, content)
    else content(path)
  }
  const history = (rows: Array<[string, string, number]>) =>
    sqlite(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      ${rows.map(([url, title, visits], i) => `INSERT INTO urls VALUES (${i + 1}, '${url}', '${title}', ${visits}, 0, ${(BigInt(WHEN) + 11_644_473_600_000n) * 1000n}, 0);`).join('\n')}`)

  // The sidebar file interleaves ids and objects.
  const item = (id: string, parentID: string | null, childrenIds: string[], data: object, title: string | null = null) => [id, { id, parentID, childrenIds, data, title, createdAt: 720_000_000 }]
  const tab = (url: string) => ({ tab: { savedURL: url, savedTitle: url, timeLastActiveAt: 720_000_100 } })
  const sidebar = {
    sidebar: {
      containers: [
        { global: {} },
        {
          topAppsContainerIDs: [{ default: true }, 'top'],
          spaces: ['s1', { id: 's1', title: 'Travail', customInfo: { iconType: { emoji_v2: '💼' } }, containerIDs: ['pinned', 'pin', 'unpinned', 'today'] }],
          items: [
            ...item('top', null, ['fav'], { itemContainer: {} }),
            ...item('fav', 'top', [], tab('https://favori.example/')),
            ...item('pin', null, ['dossier'], { itemContainer: {} }),
            ...item('dossier', 'pin', ['sv'], { list: {} }, 'Dossier'),
            ...item('sv', 'dossier', ['a', 'b'], { splitView: { layoutOrientation: 'horizontal', itemWidthFactors: ['a', 0.5] } }),
            ...item('a', 'sv', [], tab('https://a.example/')),
            ...item('b', 'sv', [], tab('https://b.example/')),
            ...item('today', null, ['grp', 'ext'], { itemContainer: {} }),
            ...item('grp', 'today', ['c'], { tabGroup: { title: 'Groupe' } }),
            ...item('c', 'grp', [], tab('https://c.example/')),
            ...item('ext', 'today', [], tab('chrome-extension://abc/page.html'))
          ]
        }
      ]
    }
  }
  write(`${ARC}/StorableSidebar.json`, JSON.stringify(sidebar))
  write(`${ARC}/User Data/Default/History`, history([['https://hist-un.example/', 'Un', 3], ['https://hist-deux.example/', 'Deux', 1], ['chrome://settings/', 'Réglages', 9]]))
  write(`${ARC}/User Data/Profile 1/History`, history([['https://hist-trois.example/', 'Trois', 2]]))
  // What Arc's own Tweaks would look like if they were in a file: the import of Arc has no such part, and the file is refused.
  write('Desktop/boosts.json', JSON.stringify([{ host: 'exemple.fr', name: 'Sobre', css: 'body { color: #333 }' }]))

  /** A live sidebar: what the service dispatches is applied, and what it asks about the state is answered from it. */
  const live = (extra: Partial<ImportDeps> = {}) => {
    let n = 0
    const ctx: Ctx = { now: WHEN, newId: () => `n${++n}` }
    const box = { state: createInitialState(ctx), merged: [] as HistoryEntry[], known: new Map<string, HistoryEntry>(), dispatched: [] as Action[] }
    const svc = new ImportService({
      home,
      ctx: () => ctx,
      dispatch: (action) => {
        box.dispatched.push(action)
        box.state = reduce(box.state, action, ctx)
      },
      state: () => box.state,
      // Like the history store: a page already there keeps the larger count, and only what changed is counted.
      mergeHistory: (entries) => {
        let touched = 0
        for (const e of entries) {
          const old = box.known.get(e.url)
          if (old && old.visitCount >= e.visitCount && old.lastVisitAt >= e.lastVisitAt) continue
          box.known.set(e.url, e)
          touched++
        }
        return touched
      },
      chooseFile: async (_source, expected) => {
        asked.push(expected)
        return chosen
      },
      applications: [APPLICATIONS],
      ...extra
    })
    return { svc, box }
  }

  // Arc does not keep its Tweaks on the Mac: there is no such part to offer, and nothing to point at.
  it('lists Arc with its sidebar and its history, both found and ticked', () => {
    const arc = live().svc.listSources().find((s) => s.id === 'arc')!
    expect(arc.categories).toEqual(['sidebar', 'history'])
    expect(arc.missing).toBeUndefined()
    expect(defaultCategories(arc)).toEqual(['sidebar', 'history'])
  })

  it('brings the sidebar, the favourites, the split view and the history of every profile, and reports each', async () => {
    const { svc, box } = live()
    const report = await svc.run({ source: 'arc', categories: ['sidebar', 'history'] })
    expect(report).toMatchObject({ ok: true, spaces: 1, bookmarks: 3, folders: 1, favorites: 1, splits: 1, history: 3 })
    expect(report.message).toMatch(/^Importé depuis Arc\u00a0: 1 espace, 3 onglets, 1 dossier, 1 favori, 1 vue scindée, 3 pages d’historique\./)
    expect(box.state.spaces.map((s) => s.name)).toContain('Travail')
    expect(box.state.splits).toHaveLength(1)
    expect(box.state.splits[0]!.tabIds.map((id) => box.state.tabs.find((t) => t.id === id)?.url)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(box.state.favorites.map((f) => f.url)).toEqual(['https://favori.example/'])
    expect([...box.known.keys()].sort()).toEqual(['https://hist-deux.example/', 'https://hist-trois.example/', 'https://hist-un.example/'])
    expect(report.details?.join(' ')).toMatch(/1 groupe d’onglets/)
    expect(report.details?.join(' ')).toMatch(/1 élément ignoré/)
    expect(report.details?.join(' ')).toMatch(/Historique\u00a0: 4 pages lues, 3 ajoutées/)
  })

  it('imports nothing more the second time, and says so instead of failing', async () => {
    const { svc, box } = live()
    await svc.run({ source: 'arc', categories: ['sidebar', 'history'] })
    const before = structuredClone(box.state)
    const dispatchedBefore = box.dispatched.length
    const second = await svc.run({ source: 'arc', categories: ['sidebar', 'history'] })
    expect(box.state).toEqual(before)
    expect(box.dispatched).toHaveLength(dispatchedBefore)
    expect(second).toMatchObject({ ok: true, spaces: 0, bookmarks: 0, folders: 0, favorites: 0, splits: 0, history: 0 })
    expect(second.message).toBe(frenchSpaces('Rien de nouveau depuis Arc : tout ce que ce fichier contient est déjà là.'))
    expect(second.details?.join(' ')).toMatch(/7 éléments déjà importés auparavant/)
  })

  it('brings only what is new when the sidebar file has changed since the last import', async () => {
    const { svc, box } = live()
    await svc.run({ source: 'arc', categories: ['sidebar'] })
    const grown = structuredClone(sidebar)
    const main = grown.sidebar.containers[1] as { items: unknown[] }
    main.items.push(...item('d', 'today', [], tab('https://d.example/')))
    ;(main.items.find((o) => (o as { id?: string }).id === 'today') as { childrenIds: string[] }).childrenIds.push('d')
    write(`${ARC}/StorableSidebar.json`, JSON.stringify(grown))
    const report = await svc.run({ source: 'arc', categories: ['sidebar'] })
    write(`${ARC}/StorableSidebar.json`, JSON.stringify(sidebar))
    expect(report).toMatchObject({ ok: true, spaces: 0, bookmarks: 1 })
    expect(box.state.spaces.filter((s) => s.name === 'Travail')).toHaveLength(1)
    expect(box.state.tabs.filter((t) => t.url === 'https://d.example/')).toHaveLength(1)
  })

  it('writes nothing when the sidebar file is not JSON, is not an Arc file, or holds no space, and says why', async () => {
    const original = JSON.stringify(sidebar)
    try {
      for (const [content, expected] of [['{ pas du json', /^StorableSidebar\.json est tronqué ou abîmé/], [JSON.stringify({ hello: 1 }), /aucun espace/], [JSON.stringify({ sidebar: { containers: [{ spaces: [], items: [] }] } }), /aucun espace/]] as const) {
        write(`${ARC}/StorableSidebar.json`, content)
        const { svc, box } = live()
        const report = await svc.run({ source: 'arc', categories: ['sidebar'] })
        expect(report.ok, content).toBe(false)
        expect(report.message, content).toMatch(expected)
        expect(box.dispatched, content).toEqual([])
      }
    } finally {
      write(`${ARC}/StorableSidebar.json`, original)
    }
  })

  it('merges nothing from a history file that cannot be read, tells which, and still brings the other profiles', async () => {
    write(`${ARC}/User Data/Profile 2/History`, 'ceci n’est pas une base SQLite')
    try {
      const { svc, box } = live()
      const report = await svc.run({ source: 'arc', categories: ['history'] })
      expect(report.ok).toBe(true)
      // The file is named with its profile: every profile's history file is called "History".
      expect(report.message).toMatch(/Profile 2\/History n’est pas une base de données lisible/)
      expect(box.known.size).toBe(3)
    } finally {
      rmSync(at(`${ARC}/User Data/Profile 2`), { recursive: true, force: true })
    }
  })

  it('fails, and says which file, when the only history file cannot be read', async () => {
    const alone = mkdtempSync(join(tmpdir(), 'lucium-import-arc-alone-'))
    mkdirSync(join(alone, `${ARC}/User Data/Default`), { recursive: true })
    writeFileSync(join(alone, `${ARC}/User Data/Default/History`), 'ceci n’est pas une base SQLite')
    try {
      const { svc, box } = live({ home: alone })
      const report = await svc.run({ source: 'arc', categories: ['history'] })
      expect(report.ok).toBe(false)
      expect(report.message).toMatch(/^Default\/History n’est pas une base de données lisible/)
      expect(box.known.size).toBe(0)
    } finally {
      rmSync(alone, { recursive: true, force: true })
    }
  })

  it('takes a file of Tweaks the user picks for none of its parts, and brings nothing of it', async () => {
    chosen = at('Desktop/boosts.json')
    const { svc, box } = live()
    const report = await svc.run({ source: 'arc', categories: ['sidebar', 'history'], pick: true })
    expect(asked).toEqual(['StorableSidebar.json ou History'])
    expect(report.ok).toBe(false)
    expect(report.message).toBe(frenchSpaces('boosts.json n’est pas un fichier que cet import sait lire (StorableSidebar.json ou History).'))
    expect(box.dispatched).toEqual([])
    expect(box.state.boosts).toEqual([])
  })

  it('reads no file of Tweaks kept next to the sidebar file', async () => {
    write(`${ARC}/StorableBoosts.json`, JSON.stringify([{ host: 'exemple.fr', name: 'Sobre', css: 'body { color: #333 }' }]))
    try {
      const { svc, box } = live()
      expect(svc.listSources().find((s) => s.id === 'arc')!.categories).toEqual(['sidebar', 'history'])
      await svc.run({ source: 'arc', categories: ['sidebar', 'history'] })
      expect(box.state.boosts).toEqual([])
    } finally {
      rmSync(at(`${ARC}/StorableBoosts.json`))
    }
  })

  it('tells the user when the file they picked is not one it reads, and does nothing', async () => {
    write('Desktop/notes.txt', 'rien')
    chosen = at('Desktop/notes.txt')
    const { svc, box } = live()
    const report = await svc.run({ source: 'arc', categories: ['sidebar', 'history'], pick: true })
    expect(report.ok).toBe(false)
    expect(report.message).toContain('notes.txt n’est pas un fichier que cet import sait lire')
    expect(box.dispatched).toEqual([])
  })

  it('uses a picked History file for the history alone', async () => {
    chosen = at(`${ARC}/User Data/Profile 1/History`)
    const { svc, box } = live()
    const report = await svc.run({ source: 'arc', categories: ['sidebar', 'history'], pick: true })
    expect(report).toMatchObject({ ok: true, history: 1, spaces: 0 })
    expect(report.message).toMatch(/^Importé depuis Arc\u00a0: 1 page d’historique\.$/)
    expect([...box.known.keys()]).toEqual(['https://hist-trois.example/'])
    expect(box.dispatched).toEqual([])
  })

  // Windows: `chmod 000` does not make a file unreadable there (it only sets the read-only flag), so the refusal macOS gives cannot be provoked.
  it.skipIf(onWindows)('explains full disk access when macOS refuses the sidebar, and writes nothing', async () => {
    chmodSync(at(`${ARC}/StorableSidebar.json`), 0o000)
    try {
      const { svc, box } = live()
      const report = await svc.run({ source: 'arc', categories: ['sidebar'] })
      expect(report).toMatchObject({ ok: false, needsDiskAccess: true })
      expect(box.dispatched).toEqual([])
    } finally {
      chmodSync(at(`${ARC}/StorableSidebar.json`), 0o644)
    }
  })
})
