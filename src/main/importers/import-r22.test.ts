import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { ImportRequest } from '@shared/import-sources'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Ctx } from '@shared/sidebar'
import { ImportService, type ImportDeps } from './service'
import { TEST_BROWSERS, fakeApplications } from './app-bundles.test-support'
import { frenchSpaces } from '@shared/french-typography'

// Checks of the importers on a pretend home folder with the real reducer: files that other programs wrote in other
// encodings or half wrote, profiles, and the same import run again. Every fixture here is made up.

const root = mkdtempSync(join(tmpdir(), 'lucium-import-r22-'))
afterAll(() => {
  chmodSync(root, 0o755)
  rmSync(root, { recursive: true, force: true })
})
const SUPPORT = 'Library/Application Support'
const put = (relative: string, content: string | Buffer | ((path: string) => void)) => {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  if (typeof content === 'function') content(path)
  else writeFileSync(path, content)
}
const sqlite = (sql: string) => (path: string) => {
  const db = new DatabaseSync(path)
  db.exec(sql)
  db.close()
}
const link = (name: string, url: string, guid?: string) => ({ type: 'url', name, url, ...(guid ? { guid } : {}) })
const folder = (name: string, guid: string, children: unknown[]) => ({ type: 'folder', name, guid, children })
const chromeFile = (children: unknown[]) => JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Barre', children } } })

let n = 0
let now: number
let state: SidebarState
let chosen: string | null
// The browsers' applications, as the import sheet finds them on this Mac (their bundles give the names the sentences quote).
const APPLICATIONS = fakeApplications(join(root, 'Applications'), TEST_BROWSERS)
const make = (extra: Partial<ImportDeps> = {}) => {
  const ctx = (): Ctx => ({ now, newId: () => `r22-${++n}` })
  return new ImportService({
    home: root,
    ctx,
    dispatch: (action) => {
      state = reduce(state, action, ctx())
    },
    state: () => state,
    mergeHistory: () => 0,
    chooseFile: async () => chosen,
    applications: [APPLICATIONS],
    ...extra
  })
}
beforeEach(() => {
  n = 0
  now = Date.UTC(2026, 3, 2, 10, 0, 0)
  chosen = null
  state = createInitialState({ now, newId: () => `base-${++n}` })
})
const spacesNamed = (name: string) => state.spaces.filter((s) => s.name === name)

/** The import in two steps, as the sheet does it. */
const imported = async (svc: ImportService, request: ImportRequest) => {
  const preview = await svc.preview(request)
  return { preview, done: preview.token ? svc.commit(preview.token) : null }
}

describe('files written by other programs (R22.2)', () => {
  const body = chromeFile([link('Café ☕', 'https://cafe.example/'), link('שלום', 'https://shalom.example/')])
  const cases: Array<[string, Buffer]> = [
    ['a UTF-8 byte order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)])],
    ['UTF-16 little endian', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')])],
    ['UTF-16 without a mark', Buffer.from(body, 'utf16le')]
  ]
  for (const [label, bytes] of cases) {
    it(`imports a Chromium bookmarks file saved with ${label}`, async () => {
      put(`Desktop/enc-${label.replace(/\W+/g, '-')}/Bookmarks`, bytes)
      chosen = join(root, `Desktop/enc-${label.replace(/\W+/g, '-')}/Bookmarks`)
      const report = await make().run({ source: 'other', categories: ['bookmarks'] })
      expect(report, report.message).toMatchObject({ ok: true, bookmarks: 2 })
      expect(state.tabs.map((t) => t.title)).toEqual(expect.arrayContaining(['Café ☕', 'שלום']))
    })
  }

  it('imports a bookmarks file in HTML saved in UTF-16 or in Windows-1252, accents intact', async () => {
    const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-16">\n<DL><p><DT><H3>Café</H3><DL><p><DT><A HREF="https://dossier.example/">Crème brûlée</A></DL><p></DL><p>'
    put('Desktop/utf16.html', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, 'utf16le')]))
    chosen = join(root, 'Desktop/utf16.html')
    expect((await make().run({ source: 'html', categories: ['bookmarks'] })).ok).toBe(true)
    expect(state.tabs.map((t) => t.title)).toContain('Crème brûlée')
    expect(state.folders.map((f) => f.name)).toContain('Café')

    state = createInitialState({ now, newId: () => `base-${++n}` })
    put('Desktop/latin.html', Buffer.from(html.replace('UTF-16', 'windows-1252'), 'latin1'))
    chosen = join(root, 'Desktop/latin.html')
    expect((await make().run({ source: 'html', categories: ['bookmarks'] })).ok).toBe(true)
    expect(state.tabs.map((t) => t.title)).toContain('Crème brûlée')
  })
})

describe('files that cannot be read tell why (R22.1)', () => {
  it('says a half-written bookmarks file is cut short, and writes nothing', async () => {
    const whole = chromeFile([link('Un', 'https://un.example/'), link('Deux', 'https://deux.example/')])
    put('Desktop/cut/Bookmarks', whole.slice(0, whole.length - 40))
    chosen = join(root, 'Desktop/cut/Bookmarks')
    const report = await make().run({ source: 'other', categories: ['bookmarks'] })
    expect(report.ok).toBe(false)
    expect(report.message).toMatch(/^Bookmarks est tronqué ou abîmé .*réessayez/)
    expect(report.message).not.toMatch(/JSON|position/)
    expect(state.tabs).toEqual([])
  })

  it('says a database that is not one is not readable, and which file', async () => {
    put('Desktop/notdb/places.sqlite', 'ceci n’est pas une base SQLite. '.repeat(100))
    chosen = join(root, 'Desktop/notdb/places.sqlite')
    const report = await make().run({ source: 'other', categories: ['bookmarks'] })
    expect(report.ok).toBe(false)
    expect(report.message).toMatch(/^places\.sqlite n’est pas une base de données lisible/)
    expect(report.message).not.toMatch(/not a database/)
  })

  it('says a file that parses but is not a Chrome bookmarks file is not one, instead of "no web bookmark"', async () => {
    put('Desktop/other/Bookmarks', JSON.stringify({ hello: 'monde' }))
    chosen = join(root, 'Desktop/other/Bookmarks')
    const named = await make().run({ source: 'chrome', categories: ['bookmarks'], pick: true, profile: undefined })
    expect(named).toMatchObject({ ok: false })
    expect(named.message).toBe('Bookmarks n’est pas un fichier de signets de Google Chrome (format inattendu).')
    // A Chrome profile whose bookmark bar is simply empty is another answer.
    put('Desktop/empty/Bookmarks', chromeFile([]))
    chosen = join(root, 'Desktop/empty/Bookmarks')
    expect((await make().run({ source: 'chrome', categories: ['bookmarks'], pick: true })).message).toContain('Aucun signet web')
  })

  it('says a Firefox file without a single bookmark row is not a Firefox bookmarks file', async () => {
    put('Desktop/fox/places.sqlite', sqlite('CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER); CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT);'))
    chosen = join(root, 'Desktop/fox/places.sqlite')
    const report = await make().run({ source: 'other', categories: ['bookmarks'] })
    expect(report.ok).toBe(false)
    expect(report.message).toBe('places.sqlite n’est pas un fichier de signets reconnu (format inattendu).')
  })
})

describe('profiles (R22.3)', () => {
  const fox = (urls: string[]) =>
    sqlite(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER);
      CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT);
      INSERT INTO moz_bookmarks VALUES (3, 2, NULL, 1, 0, 'toolbar');
      ${urls.map((u, i) => `INSERT INTO moz_places VALUES (${i + 1}, '${u}', 'T', 1, 0); INSERT INTO moz_bookmarks VALUES (${10 + i}, 1, ${i + 1}, 3, ${i}, 'B${i}');`).join('\n')}`)
  put(`${SUPPORT}/Firefox/Profiles/aaa111.default/places.sqlite`, fox(['https://ancien.example/']))
  put(`${SUPPORT}/Firefox/Profiles/mmm222.dev-edition/places.sqlite`, fox(['https://dev.example/']))
  put(`${SUPPORT}/Firefox/Profiles/zzz333.default-release/places.sqlite`, fox(['https://actuel.example/']))
  put(`${SUPPORT}/Google/Chrome/Local State`, JSON.stringify({ profile: { info_cache: { Default: { name: 'Perso' }, 'Profile 1': { name: 'Travail' } } } }))
  put(`${SUPPORT}/Google/Chrome/Default/Bookmarks`, chromeFile([link('Perso', 'https://perso.example/')]))
  put(`${SUPPORT}/Google/Chrome/Profile 1/Bookmarks`, chromeFile([link('Travail', 'https://travail.example/')]))
  put(`${SUPPORT}/zen/Profiles/qqq.default-release/places.sqlite`, fox(['https://zen.example/']))

  it('lists the profile Firefox itself uses first, whatever the order of the random folder names', () => {
    const firefox = make().listSources().find((s) => s.id === 'firefox')!
    expect(firefox.profiles.map((p) => p.id)).toEqual(['zzz333.default-release', 'aaa111.default', 'mmm222.dev-edition'])
  })

  it('imports the profile in use when the request names none, not the first folder by name', async () => {
    const report = await make().run({ source: 'firefox', categories: ['bookmarks'] })
    expect(report.ok).toBe(true)
    expect(state.tabs.map((t) => t.url)).toEqual(['https://actuel.example/'])
  })

  it('names the space after the profile when the browser has several, so that two imports leave two spaces that can be told apart', async () => {
    const svc = make()
    await svc.run({ source: 'chrome', profile: 'Default', categories: ['bookmarks'] })
    await svc.run({ source: 'chrome', profile: 'Profile 1', categories: ['bookmarks'] })
    expect(state.spaces.map((s) => s.name)).toEqual(expect.arrayContaining(['Chrome (Perso)', 'Chrome (Travail)']))
    expect(spacesNamed('Chrome')).toEqual([])
    expect(state.tabs.map((t) => t.url).sort()).toEqual(['https://perso.example/', 'https://travail.example/'])
  })

  it('lists a profile name as one short line, whatever Local State holds', () => {
    put(`${SUPPORT}/BraveSoftware/Brave-Browser/Local State`, JSON.stringify({ profile: { info_cache: { Default: { name: `Brave\n${'x'.repeat(100_000)}` }, 'Profile 1': { name: 42 } } } }))
    put(`${SUPPORT}/BraveSoftware/Brave-Browser/Default/Bookmarks`, chromeFile([link('A', 'https://a.example/')]))
    put(`${SUPPORT}/BraveSoftware/Brave-Browser/Profile 1/Bookmarks`, chromeFile([link('B', 'https://b.example/')]))
    const brave = make().listSources().find((s) => s.id === 'brave')!
    expect(brave.profiles[0]!.name).toHaveLength(80)
    expect(brave.profiles[0]!.name).not.toContain('\n')
    expect(brave.profiles[1]).toEqual({ id: 'Profile 1', name: 'Profile 1' })
  })

  it('keeps the name of the browser alone when it has one profile, and names a fork after itself, not after Firefox', async () => {
    await make().run({ source: 'zen', categories: ['bookmarks'] })
    expect(state.spaces.map((s) => s.name)).toContain('Zen')
    expect(state.spaces.map((s) => s.name)).not.toContain('Firefox')
  })
})

describe('the same import, run again (R22.6)', () => {
  const chromeRequest: ImportRequest = { source: 'chrome', profile: 'Default', categories: ['bookmarks'] }
  const setChrome = (children: unknown[]) => {
    put(`${SUPPORT}/Google/Chrome/Local State`, JSON.stringify({ profile: { info_cache: { Default: { name: 'Perso' } } } }))
    put(`${SUPPORT}/Google/Chrome/Default/Bookmarks`, chromeFile(children))
    rmSync(join(root, `${SUPPORT}/Google/Chrome/Profile 1`), { recursive: true, force: true })
  }
  const first = [link('Un', 'https://un.example/'), folder('Docs', 'guid-docs', [link('Deux', 'https://deux.example/'), folder('Sous', 'guid-sous', [link('Trois', 'https://trois.example/')])])]

  it('brings nothing the second time, says so, and offers nothing to confirm', async () => {
    setChrome(first)
    const svc = make()
    const one = await imported(svc, chromeRequest)
    expect(one.done).toMatchObject({ ok: true, bookmarks: 3, folders: 2 })
    const before = structuredClone(state)

    const two = await imported(svc, chromeRequest)
    expect(two.preview).toMatchObject({ ok: true, message: frenchSpaces('Rien de nouveau depuis Google Chrome : ces signets sont déjà importés.') })
    expect(two.preview.token).toBeUndefined()
    expect(two.preview.details).toEqual([frenchSpaces('3 signets déjà importés auparavant : laissés tels quels, sans doublon.')])
    expect(state).toEqual(before)
    expect(state.spaces.filter((s) => s.name === 'Chrome')).toHaveLength(1)
  })

  it('brings only the new bookmarks the third time, into the same space and the same folders, and takes only those back', async () => {
    setChrome(first)
    const svc = make()
    await imported(svc, chromeRequest)
    const space = state.spaces.find((s) => s.name === 'Chrome')!
    // Something new in Chrome: a link at the root and one in the folder that was imported.
    setChrome([...first.slice(0, 1), folder('Docs', 'guid-docs', [link('Deux', 'https://deux.example/'), link('Quatre', 'https://quatre.example/'), folder('Sous', 'guid-sous', [link('Trois', 'https://trois.example/')])]), link('Cinq', 'https://cinq.example/')])
    const three = await imported(svc, chromeRequest)
    expect(three.preview.message).toContain('2 signets')
    expect(three.preview.details?.join('\n')).toContain(frenchSpaces('Les nouveaux signets rejoignent l’espace « Chrome »'))
    expect(three.preview.details?.join('\n')).toContain('3 signets déjà importés')
    expect(three.done).toMatchObject({ ok: true, bookmarks: 2, folders: 0 })
    expect(state.spaces.filter((s) => s.name === 'Chrome')).toHaveLength(1)
    expect(state.tabs.filter((t) => t.spaceId === space.id).map((t) => t.url).sort()).toEqual(['https://cinq.example/', 'https://deux.example/', 'https://quatre.example/', 'https://trois.example/', 'https://un.example/'])
    const quatre = state.tabs.find((t) => t.url === 'https://quatre.example/')!
    expect(state.folders.find((f) => f.id === quatre.folderId)?.name).toBe('Docs')

    // Taking the third import back leaves the first one, and the space, in place.
    const undone = svc.undo(three.done!.undoToken!)
    expect(undone.ok).toBe(true)
    expect(state.tabs.filter((t) => t.spaceId === space.id).map((t) => t.url).sort()).toEqual(['https://deux.example/', 'https://trois.example/', 'https://un.example/'])
    expect(state.spaces.some((s) => s.id === space.id)).toBe(true)
  })

  it('keeps the identity of a folder that was renamed in the browser (its own identifier), and of a link that moved to the root only as a new one', async () => {
    setChrome(first)
    const svc = make()
    await imported(svc, chromeRequest)
    setChrome([first[0]!, folder('Documents renommés', 'guid-docs', [link('Deux', 'https://deux.example/'), folder('Sous', 'guid-sous', [link('Trois', 'https://trois.example/')])])])
    const again = await imported(svc, chromeRequest)
    expect(again.preview.token).toBeUndefined()
    expect(state.tabs).toHaveLength(3)
    expect(state.folders).toHaveLength(2)
  })

  it('takes a link that moved to another folder for a new bookmark: its identity is its folder and its address (a link in two folders is two bookmarks), so the copy already imported stays where it was', async () => {
    setChrome(first)
    const svc = make()
    await imported(svc, chromeRequest)
    const deux = state.tabs.find((t) => t.url === 'https://deux.example/')!
    // « Deux » leaves « Docs » for the root of the bar in Chrome.
    setChrome([first[0]!, link('Deux', 'https://deux.example/'), folder('Docs', 'guid-docs', [folder('Sous', 'guid-sous', [link('Trois', 'https://trois.example/')])])])
    const again = await imported(svc, chromeRequest)
    expect(again.done).toMatchObject({ ok: true, bookmarks: 1 })
    const copies = state.tabs.filter((t) => t.url === 'https://deux.example/')
    expect(copies).toHaveLength(2)
    expect(copies.find((t) => t.id === deux.id)?.folderId).toBe(deux.folderId)
    expect(copies.find((t) => t.id !== deux.id)?.folderId).toBeUndefined()
  })

  it('does not call two folders of one name, or one link in two folders, the same thing', async () => {
    setChrome([folder('Divers', 'g1', [link('Même', 'https://meme.example/')]), folder('Divers', 'g2', [link('Même', 'https://meme.example/')]), link('Même', 'https://meme.example/')])
    const svc = make()
    expect((await imported(svc, chromeRequest)).done).toMatchObject({ bookmarks: 3, folders: 2 })
    expect(new Set(state.tabs.map((t) => t.id)).size).toBe(3)
    expect((await imported(svc, chromeRequest)).preview.token).toBeUndefined()
  })

  it('gives a second folder of the same name its own identity when the file has no identifiers (Firefox, a bookmarks file)', async () => {
    put('Desktop/twins.html', '<DL><p><DT><H3>Divers</H3><DL><p><DT><A HREF="https://meme.example/">Même</A></DL><p><DT><H3>Divers</H3><DL><p><DT><A HREF="https://meme.example/">Même</A></DL><p></DL><p>')
    chosen = join(root, 'Desktop/twins.html')
    const svc = make()
    expect((await imported(svc, { source: 'html', categories: ['bookmarks'] })).done).toMatchObject({ bookmarks: 2, folders: 2 })
    const again = await imported(svc, { source: 'html', categories: ['bookmarks'] })
    expect(again.preview.token).toBeUndefined()
    expect(state.tabs).toHaveLength(2)
  })

  it('is the same for Firefox, Safari and a bookmarks file', async () => {
    const leaf = '<dict><key>URIDictionary</key><dict><key>title</key><string>Safari</string></dict><key>URLString</key><string>https://safari-r22.example/</string><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string></dict>'
    put('Library/Safari/Bookmarks.plist', `<?xml version="1.0"?><plist version="1.0"><dict><key>Children</key><array><dict><key>Children</key><array><dict><key>Children</key><array>${leaf}</array><key>Title</key><string>Dossier</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string><key>WebBookmarkUUID</key><string>UUID-1</string></dict></array><key>Title</key><string>BookmarksBar</string><key>WebBookmarkType</key><string>WebBookmarkTypeList</string></dict></array></dict></plist>`)
    put('Desktop/signets.html', '<DL><p><DT><H3>Dossier</H3><DL><p><DT><A HREF="https://html-r22.example/">H</A></DL><p></DL><p>')
    for (const request of [{ source: 'firefox', categories: ['bookmarks'] }, { source: 'safari', categories: ['bookmarks'] }, { source: 'html', categories: ['bookmarks'] }] as ImportRequest[]) {
      chosen = join(root, 'Desktop/signets.html')
      const svc = make()
      const one = await imported(svc, request)
      expect(one.done, request.source).toMatchObject({ ok: true })
      const spaces = state.spaces.length
      const tabs = state.tabs.length
      const two = await imported(svc, request)
      expect(two.preview, request.source).toMatchObject({ ok: true })
      expect(two.preview.token, request.source).toBeUndefined()
      expect(state.spaces).toHaveLength(spaces)
      expect(state.tabs).toHaveLength(tabs)
    }
  })

  it('brings the space back when the person deleted it', async () => {
    setChrome(first)
    const svc = make()
    await imported(svc, chromeRequest)
    const space = state.spaces.find((s) => s.name === 'Chrome')!
    state = reduce(state, { type: 'import/revert', spaces: [space.id], tabs: [], folders: [], favorites: [], splits: [], boosts: [] }, { now, newId: () => 'z' })
    expect(state.tabs.filter((t) => t.spaceId === space.id)).toEqual([])
    expect((await imported(svc, chromeRequest)).done).toMatchObject({ ok: true, bookmarks: 3 })
  })

  it('treats a new export of the same bookmarks, under another file name, as the same bookmarks: the dated names browsers give their exports must not make a second space', async () => {
    put('Desktop/bookmarks_10_26_26.html', '<DL><p><DT><A HREF="https://a.example/">A</A></DL><p>')
    put('Desktop/bookmarks_10_27_26.html', '<DL><p><DT><A HREF="https://a.example/">A</A><DT><A HREF="https://b.example/">B</A></DL><p>')
    const svc = make()
    chosen = join(root, 'Desktop/bookmarks_10_26_26.html')
    await imported(svc, { source: 'html', categories: ['bookmarks'] })
    chosen = join(root, 'Desktop/bookmarks_10_27_26.html')
    const later = await imported(svc, { source: 'html', categories: ['bookmarks'] })
    expect(later.done).toMatchObject({ ok: true, bookmarks: 1 })
    expect(state.spaces.filter((s) => s.name === 'Signets importés')).toHaveLength(1)
    expect(state.tabs.map((t) => t.url).sort()).toEqual(['https://a.example/', 'https://b.example/'])
  })

  it('does not take a file the person picked for the profile of that name: a copy of Chrome’s bookmarks is its own space, not the real profile’s', async () => {
    setChrome(first)
    put('Desktop/copie/Bookmarks', chromeFile([link('Copie', 'https://copie.example/')]))
    const svc = make()
    await imported(svc, chromeRequest)
    chosen = join(root, 'Desktop/copie/Bookmarks')
    // The macOS refusal sends the person to the chooser with the browser still named Chrome.
    const picked = await imported(svc, { source: 'chrome', categories: ['bookmarks'], pick: true })
    expect(picked.done).toMatchObject({ ok: true, bookmarks: 1 })
    // Two spaces, not the copy's link added to the profile's space: the real profile's three links are still in the first.
    const chromes = state.spaces.filter((s) => s.name === 'Chrome')
    expect(chromes).toHaveLength(2)
    expect(chromes.map((c) => state.tabs.filter((t) => t.spaceId === c.id).length).sort()).toEqual([1, 3])
    expect((await imported(svc, { source: 'chrome', categories: ['bookmarks'], pick: true })).preview.token).toBeUndefined()
  })

  it('keeps the files of an unlisted browser apart by their place: two of its profiles are two spaces', async () => {
    for (const profile of ['un', 'deux']) put(`Desktop/opera-${profile}/Bookmarks`, chromeFile([link('Page', `https://${profile}.example/`)]))
    const svc = make()
    for (const profile of ['un', 'deux']) {
      chosen = join(root, `Desktop/opera-${profile}/Bookmarks`)
      await imported(svc, { source: 'other', categories: ['bookmarks'] })
    }
    expect(state.spaces.filter((s) => s.name === 'Autre navigateur')).toHaveLength(2)
    chosen = join(root, 'Desktop/opera-un/Bookmarks')
    expect((await imported(svc, { source: 'other', categories: ['bookmarks'] })).preview.token).toBeUndefined()
  })

  it('still brings in a bookmark the person pinned themselves, and says so (a pin of their own is not an earlier import)', async () => {
    setChrome([link('Un', 'https://un.example/')])
    state = reduce(state, { type: 'tab/open', url: 'https://un.example/' }, { now, newId: () => 'mine' })
    state = reduce(state, { type: 'tab/pin', id: state.tabs[0]!.id }, { now, newId: () => 'mine2' })
    const preview = await make().preview(chromeRequest)
    expect(preview.bookmarks).toBe(1)
    expect(preview.details?.join('\n')).toContain('1 signet est déjà épinglé dans vos espaces')
  })
})

describe('the history files of several Arc profiles (R22.4)', () => {
  it('names the profile of the file it could not read, so that two failures are not the same sentence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lucium-import-r22-arc-'))
    try {
      for (const profile of ['Default', 'Profile 1', 'Profile 2']) {
        mkdirSync(join(home, `${SUPPORT}/Arc/User Data/${profile}`), { recursive: true })
        writeFileSync(join(home, `${SUPPORT}/Arc/User Data/${profile}/History`), 'ceci n’est pas une base SQLite. '.repeat(100))
      }
      writeFileSync(join(home, `${SUPPORT}/Arc/StorableSidebar.json`), '{}')
      const report = await make({ home }).run({ source: 'arc', categories: ['history'] })
      expect(report.ok).toBe(false)
      for (const profile of ['Default', 'Profile 1', 'Profile 2']) expect(report.message).toContain(`${profile}/History n’est pas une base de données lisible`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
