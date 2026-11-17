import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportRequest } from '@shared/import-sources'
import type { SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action, type Ctx } from '@shared/sidebar'
import { HistoryStore } from '../history'
import { ImportService, MAX_LOCAL_STATE_BYTES, PREVIEW_VALID_MS, UNDO_WINDOW_MS, type ImportDeps } from './service'
import { TEST_BROWSERS, fakeApplications } from './app-bundles.test-support'
import { frenchSpaces } from '@shared/french-typography'

// The preview, the confirmation and the undo of an import, on a pretend home folder, with the real reducer and the real history store.

const root = mkdtempSync(join(tmpdir(), 'lucium-import-flow-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
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
const micros = (ms: number) => (BigInt(ms) + 11_644_473_600_000n) * 1000n
const chromeHistory = (rows: Array<[string, string, number]>) =>
  sqlite(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
    ${rows.map(([url, title, visits], i) => `INSERT INTO urls VALUES (${i + 1}, '${url}', '${title}', ${visits}, 0, ${micros(WHEN - i * 1000)}, 0);`).join('\n')}`)
const link = (name: string, url: string) => ({ type: 'url', name, url })

put(`${SUPPORT}/Google/Chrome/Local State`, JSON.stringify({ profile: { info_cache: { Default: { name: 'Perso' } } } }))
put(
  `${SUPPORT}/Google/Chrome/Default/Bookmarks`,
  JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'Barre', children: [link('Un', 'https://flow-un.example/'), link('Un encore', 'https://flow-un.example/'), { type: 'folder', name: 'Dossier', children: [link('Deux', 'https://flow-deux.example/')] }, link('Piège', 'javascript:alert(1)')] } } })
)
put(`${SUPPORT}/Google/Chrome/Default/History`, chromeHistory([['https://flow-hist-un.example/', 'Histoire un', 3], ['https://flow-hist-deux.example/', 'Histoire deux', 1], ['chrome://settings/', 'Réglages', 9]]))

// The sidebar file interleaves ids and objects.
const item = (id: string, parentID: string | null, childrenIds: string[], data: object, title: string | null = null) => [id, { id, parentID, childrenIds, data, title, createdAt: 720_000_000 }]
const tabData = (url: string) => ({ tab: { savedURL: url, savedTitle: url, timeLastActiveAt: 720_000_100 } })
put(
  `${SUPPORT}/Arc/StorableSidebar.json`,
  JSON.stringify({
    sidebar: {
      containers: [
        { global: {} },
        {
          topAppsContainerIDs: [{ default: true }, 'top'],
          spaces: ['s1', { id: 's1', title: 'Travail flow', customInfo: { iconType: { emoji_v2: '💼' } }, containerIDs: ['pinned', 'pin', 'unpinned', 'today'] }],
          items: [
            ...item('top', null, ['fav'], { itemContainer: {} }),
            ...item('fav', 'top', [], tabData('https://flow-favori.example/')),
            ...item('pin', null, ['a', 'b', 'sv'], { itemContainer: {} }),
            ...item('a', 'pin', [], tabData('https://flow-a.example/')),
            ...item('b', 'pin', [], tabData('https://flow-b.example/')),
            ...item('sv', 'pin', ['c', 'd'], { splitView: { layoutOrientation: 'horizontal', itemWidthFactors: ['c', 0.5] } }),
            ...item('c', 'sv', [], tabData('https://flow-c.example/')),
            ...item('d', 'sv', [], tabData('https://flow-d.example/')),
            ...item('today', null, [], { itemContainer: {} })
          ]
        }
      ]
    }
  })
)
put(`${SUPPORT}/Arc/User Data/Default/History`, chromeHistory([['https://flow-arc-hist.example/', 'Arc', 2]]))
put(`${SUPPORT}/Firefox/Profiles/x.default/places.sqlite`, sqlite(`CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER);
  CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT);
  INSERT INTO moz_places VALUES (1, 'https://flow-fox.example/', 'Fox', 2, ${WHEN * 1000});
  INSERT INTO moz_bookmarks VALUES (3, 2, NULL, 1, 0, 'toolbar'), (10, 1, 1, 3, 0, 'Fox signet');`))

let n: number
let now: number
let state: SidebarState
let dispatched: Action[]
let history: HistoryStore
let chosen: string | null
const tmps: string[] = []

// The browsers' applications, as the import sheet finds them on this Mac (their bundles give the names the sentences quote).
const APPLICATIONS = fakeApplications(join(root, 'Applications'), TEST_BROWSERS)
const make = (extra: Partial<ImportDeps> = {}) => {
  const ctx = (): Ctx => ({ now, newId: () => `flow${++n}` })
  return new ImportService({
    home: root,
    ctx,
    dispatch: (action) => {
      dispatched.push(action)
      state = reduce(state, action, ctx())
    },
    state: () => state,
    mergeHistory: (entries) => history.merge(entries),
    countHistory: (entries) => history.wouldChange(entries),
    mergeHistoryTracked: (entries) => history.mergeTracked(entries),
    chooseFile: async () => chosen,
    applications: [APPLICATIONS],
    ...extra
  })
}
beforeEach(() => {
  n = 0
  now = WHEN
  dispatched = []
  chosen = null
  state = createInitialState({ now, newId: () => `base${++n}` })
  const dir = mkdtempSync(join(tmpdir(), 'lucium-import-flow-history-'))
  tmps.push(dir)
  history = new HistoryStore(join(dir, 'history.json'))
  n = 0
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const chrome: ImportRequest = { source: 'chrome', profile: 'Default', categories: ['bookmarks', 'history'] }
const historyUrls = () => history.search('', 1000).map((e) => e.url).sort()

describe('the preview', () => {
  it('writes nothing: no action, no page in the history, no file', async () => {
    const before = structuredClone(state)
    const preview = await make().preview(chrome)
    expect(preview.ok).toBe(true)
    expect(dispatched).toEqual([])
    expect(state).toEqual(before)
    expect(history.size()).toBe(0)
    expect(history.isDirty()).toBe(false)
  })

  it('counts the bookmarks, the folders and the pages of the history that the import would bring, and gives the key to confirm', async () => {
    const preview = await make().preview(chrome)
    expect(preview).toMatchObject({ ok: true, bookmarks: 2, folders: 1, history: 2, skipped: 1, duplicates: 1 })
    expect(preview.token).toMatch(/^[0-9a-f-]{36}$/)
    expect(preview.message).toBe(frenchSpaces('Prêt à importer depuis Google Chrome : 2 signets (onglets épinglés) dans 1 dossier, 2 pages d’historique. 1 élément ignoré (ce n’est pas une page web, ou l’import ne sait pas le reprendre).'))
    const lines = (preview.details ?? []).join('\n')
    expect(lines).toContain(frenchSpaces('nouvel espace « Chrome »'))
    expect(lines).toContain('2 adresses web lues, 2 nouvelles ou mises à jour')
    expect(lines).toContain('1 signet en double')
  })

  it('counts only the pages that the history does not have already', async () => {
    history.merge([{ url: 'https://flow-hist-un.example/', title: 'Déjà là', visitCount: 3, lastVisitAt: WHEN }])
    const preview = await make().preview(chrome)
    expect(preview.history).toBe(1)
    expect((preview.details ?? []).join('\n')).toContain('2 adresses web lues, 1 nouvelle ou mise à jour')
  })

  it('says when a bookmark is already pinned in the sidebar, and brings it in all the same', async () => {
    state = reduce(state, { type: 'tab/open', url: 'https://flow-un.example/' }, { now, newId: () => 'mine' })
    state = reduce(state, { type: 'tab/pin', id: state.tabs[0]!.id }, { now, newId: () => 'mine2' })
    const preview = await make().preview({ ...chrome, categories: ['bookmarks'] })
    expect((preview.details ?? []).join('\n')).toContain('1 signet est déjà épinglé dans vos espaces')
    expect(preview.bookmarks).toBe(2)
  })

  it('gives a failure the way an import does, with no key to confirm', async () => {
    const report = await make().preview({ source: 'chrome', profile: '../../etc', categories: ['bookmarks'] })
    expect(report.ok).toBe(false)
    expect(report.token).toBeUndefined()
    expect(report.message).toContain('Aucun profil')
    expect((await make().preview({ source: 'html', categories: ['bookmarks'] })).message).toBe('Import annulé.')
  })

  it('has no key when there is nothing new to bring (Arc imported twice)', async () => {
    const svc = make()
    const first = await svc.preview({ source: 'arc', categories: ['sidebar'] })
    expect(first.token).toBeDefined()
    svc.commit(first.token!)
    const second = await svc.preview({ source: 'arc', categories: ['sidebar'] })
    expect(second).toMatchObject({ ok: true, spaces: 0, bookmarks: 0 })
    expect(second.token).toBeUndefined()
    expect(second.message).toContain('Rien de nouveau')
  })

  it('previews Arc with the counts the import then brings', async () => {
    const svc = make()
    const preview = await svc.preview({ source: 'arc', categories: ['sidebar', 'history'] })
    expect(preview.message).toMatch(/^Prêt à importer depuis Arc\u00a0: 1 espace, 4 onglets, 0 dossier, 1 favori, 1 vue scindée, 1 page d’historique\./)
    expect(dispatched).toEqual([])
    const done = svc.commit(preview.token!)
    expect(done).toMatchObject({ ok: true, spaces: preview.spaces, bookmarks: preview.bookmarks, favorites: preview.favorites, splits: preview.splits, history: preview.history })
    expect(done.message).toMatch(/^Importé depuis Arc\u00a0: /)
  })
})

describe('confirming', () => {
  it('brings in what the preview showed, once', async () => {
    const svc = make()
    const preview = await svc.preview(chrome)
    const done = svc.commit(preview.token!)
    expect(done).toMatchObject({ ok: true, bookmarks: 2, folders: 1, history: 2 })
    expect(done.message).toMatch(/^Importé depuis Google Chrome\u00a0: 2 onglets épinglés et 1 dossier, 2 pages d’historique\./)
    expect(state.spaces.map((s) => s.name)).toContain('Chrome')
    expect(historyUrls()).toEqual(['https://flow-hist-deux.example/', 'https://flow-hist-un.example/'])
    // The second try finds nothing to confirm and writes nothing more.
    const count = dispatched.length
    expect(svc.commit(preview.token!)).toMatchObject({ ok: false, message: 'Cet aperçu n’est plus valable. Relancez l’import.' })
    expect(dispatched).toHaveLength(count)
  })

  it('brings in what the preview read, not what the files say a minute later', async () => {
    const svc = make()
    const path = join(root, `${SUPPORT}/Google/Chrome/Default/Bookmarks`)
    const preview = await svc.preview({ ...chrome, categories: ['bookmarks'] })
    const original = (await import('node:fs')).readFileSync(path, 'utf8')
    try {
      writeFileSync(path, JSON.stringify({ roots: { bookmark_bar: { type: 'folder', name: 'b', children: [link('Autre', 'https://flow-autre.example/')] } } }))
      svc.commit(preview.token!)
    } finally {
      writeFileSync(path, original)
    }
    expect(state.tabs.map((t) => t.url).sort()).toEqual(['https://flow-deux.example/', 'https://flow-un.example/'])
  })

  it('refuses a key it did not give, and one that is not the latest preview', async () => {
    const svc = make()
    const first = await svc.preview(chrome)
    const second = await svc.preview(chrome)
    expect(svc.commit(first.token!).ok).toBe(false)
    expect(svc.commit('00000000-0000-0000-0000-000000000000').ok).toBe(false)
    expect(dispatched).toEqual([])
    expect(svc.commit(second.token!).ok).toBe(true)
  })

  it('refuses a preview that was left alone for longer than it stays valid, and writes nothing', async () => {
    const svc = make()
    const preview = await svc.preview(chrome)
    now += PREVIEW_VALID_MS + 1
    const report = svc.commit(preview.token!)
    expect(report).toMatchObject({ ok: false })
    expect(report.message).toContain('est trop ancien')
    expect(dispatched).toEqual([])
    expect(history.size()).toBe(0)
  })

  it('forgets a preview when the next one fails: the old key does not work any more', async () => {
    const svc = make()
    const first = await svc.preview(chrome)
    await svc.preview({ source: 'chrome', profile: 'Profile 9', categories: ['bookmarks'] })
    expect(svc.commit(first.token!).ok).toBe(false)
    expect(dispatched).toEqual([])
  })

  it('is what `run` does in one step', async () => {
    const stepwise = make()
    const a = stepwise.commit((await stepwise.preview(chrome)).token!)
    const stateA = structuredClone(state)
    const { token: _t, undoToken: _u, ...doneA } = a
    n = 0
    state = createInitialState({ now, newId: () => `base${++n}` })
    n = 0
    history = new HistoryStore(join(tmps[0]!, 'other.json'))
    const b = await make().run(chrome)
    const { undoToken: _v, ...doneB } = b
    expect(doneB).toEqual(doneA)
    expect(state).toEqual(stateA)
  })
})

describe('taking an import back', () => {
  it('brings the sidebar and the history back to what they were', async () => {
    history.merge([{ url: 'https://flow-hist-un.example/', title: 'Déjà là', visitCount: 1, lastVisitAt: WHEN - 99_999 }])
    state = reduce(state, { type: 'tab/open', url: 'https://perso.example/' }, { now, newId: () => 'perso' })
    const stateBefore = structuredClone(state)
    const historyBefore = JSON.stringify(history.search('', 100))
    const svc = make()
    const done = svc.commit((await svc.preview(chrome)).token!)
    expect(state.spaces).toHaveLength(stateBefore.spaces.length + 1)
    expect(done.undoToken).toBeDefined()
    const undone = svc.undo(done.undoToken!)
    expect(undone).toMatchObject({ ok: true, bookmarks: 2, folders: 1, history: 2 })
    expect(undone.message).toBe(frenchSpaces('Import annulé : 2 onglets épinglés et 1 dossier, 2 pages d’historique retirés.'))
    expect(state).toEqual(stateBefore)
    expect(JSON.stringify(history.search('', 100))).toBe(historyBefore)
  })

  it('is refused while a space is locked, with the reason, and can still be done once it is unlocked', async () => {
    let locked = true
    const sentence = 'Déverrouillez vos espaces verrouillés avant d’annuler l’import.'
    const svc = make({ undoRefusal: () => (locked ? sentence : null) })
    const stateBefore = structuredClone(state)
    const done = svc.commit((await svc.preview(chrome)).token!)
    const imported = structuredClone(state)
    dispatched.length = 0
    expect(svc.undo(done.undoToken!)).toMatchObject({ ok: false, message: sentence })
    expect(dispatched).toEqual([])
    expect(state).toEqual(imported)
    locked = false
    expect(svc.undo(done.undoToken!).ok).toBe(true)
    expect(state).toEqual(stateBefore)
  })

  it('takes Arc’s import back too: spaces, tabs, favourites and split views', async () => {
    const svc = make()
    const stateBefore = structuredClone(state)
    const done = svc.commit((await svc.preview({ source: 'arc', categories: ['sidebar', 'history'] })).token!)
    expect(state.splits).toHaveLength(1)
    expect(state.favorites).toHaveLength(1)
    svc.undo(done.undoToken!)
    expect(state).toEqual(stateBefore)
    expect(history.size()).toBe(0)
  })

  it('works after `run` as well (the engine checks and the old way of importing)', async () => {
    const svc = make()
    const done = await svc.run(chrome)
    expect(svc.undo(done.undoToken!).ok).toBe(true)
    expect(state.spaces.map((s) => s.name)).not.toContain('Chrome')
  })

  it('can be done once, and only for the latest import', async () => {
    const svc = make()
    const first = await svc.run({ source: 'firefox', categories: ['bookmarks'] })
    const second = await svc.run(chrome)
    expect(svc.undo(first.undoToken!)).toMatchObject({ ok: false, message: frenchSpaces('Cet import ne peut plus être annulé : un autre import l’a remplacé.') })
    expect(state.spaces.map((s) => s.name)).toEqual(expect.arrayContaining(['Firefox', 'Chrome']))
    expect(svc.undo(second.undoToken!).ok).toBe(true)
    expect(svc.undo(second.undoToken!).ok).toBe(false)
    expect(state.spaces.map((s) => s.name)).toContain('Firefox')
  })

  it('refuses a key it did not give', async () => {
    const svc = make()
    await svc.run(chrome)
    const count = dispatched.length
    expect(svc.undo('00000000-0000-0000-0000-000000000000').ok).toBe(false)
    expect(dispatched).toHaveLength(count)
  })

  it('stops being possible after a while, says so, and leaves everything in place', async () => {
    const svc = make()
    const done = await svc.run(chrome)
    now += UNDO_WINDOW_MS + 1
    const report = svc.undo(done.undoToken!)
    expect(report.ok).toBe(false)
    expect(report.message).toContain('Supprimez l’espace importé à la main')
    expect(state.spaces.map((s) => s.name)).toContain('Chrome')
    expect(history.size()).toBe(2)
    expect(svc.undo(done.undoToken!).message).toContain('ne peut plus être annulé')
  })

  it('leaves alone what the user did since: a tab of their own in another space, a page they visited', async () => {
    const svc = make()
    const done = await svc.run(chrome)
    state = reduce(state, { type: 'tab/open', url: 'https://apres.example/', spaceId: state.spaces[0]!.id }, { now, newId: () => 'apres' })
    history.record('https://flow-hist-un.example/', 'Histoire un', WHEN + 5000)
    svc.undo(done.undoToken!)
    expect(state.tabs.map((t) => t.url)).toEqual(['https://apres.example/'])
    expect(historyUrls()).toEqual(['https://flow-hist-un.example/'])
  })

  it('takes away only what the import added: an entry that another import brought between the preview and the confirmation is not its own', async () => {
    const first = make()
    const second = make()
    const preview = await first.preview({ source: 'arc', categories: ['sidebar'] })
    // Another import of the same file brings the same entries (their ids come from the file's) before the first one is confirmed.
    const other = await second.run({ source: 'arc', categories: ['sidebar'] })
    expect(other.ok).toBe(true)
    const kept = structuredClone(state)
    const done = first.commit(preview.token!)
    expect(done).toMatchObject({ ok: true, bookmarks: 0, spaces: 0 })
    expect(done.message).toContain('Rien de nouveau depuis Arc')
    expect(done.undoToken).toBeUndefined()
    expect(state).toEqual(kept)
    expect(first.undo('00000000-0000-0000-0000-000000000000').ok).toBe(false)
    expect(second.undo(other.undoToken!).ok).toBe(true)
    expect(state.spaces.map((s) => s.name)).not.toContain('Travail flow')
  })

  it('has no key to give when the import brought nothing (so the sheet offers no button)', async () => {
    const svc = make()
    await svc.run({ source: 'arc', categories: ['sidebar'] })
    const again = await svc.run({ source: 'arc', categories: ['sidebar'] })
    expect(again.undoToken).toBeUndefined()
  })

  it('keeps the import undoable and says why when the undo itself fails', async () => {
    const failing = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let broken = false
    const svc = make({
      dispatch: (action) => {
        if (broken && action.type === 'import/revert') throw new Error('disque plein')
        dispatched.push(action)
        state = reduce(state, action, { now, newId: () => `flow${++n}` })
      }
    })
    const done = await svc.run(chrome)
    broken = true
    const report = svc.undo(done.undoToken!)
    expect(report.ok).toBe(false)
    expect(report.message).toBe(frenchSpaces('L’annulation a échoué : disque plein'))
    expect(failing).toHaveBeenCalledWith('[import] cannot take the import back:', expect.any(Error))
    expect(state.spaces.map((s) => s.name)).toContain('Chrome')
    broken = false
    expect(svc.undo(done.undoToken!).ok).toBe(true)
  })

  it('takes back the sidebar only, when the history has no way back (a service built without it)', async () => {
    const svc = make({ mergeHistoryTracked: undefined })
    const done = await svc.run(chrome)
    const undone = svc.undo(done.undoToken!)
    expect(undone.history).toBe(0)
    expect(state.spaces.map((s) => s.name)).not.toContain('Chrome')
    expect(history.size()).toBe(2)
  })
})

describe('another browser: the user picks the file and its name tells the format', () => {
  const pick = (relative: string) => {
    chosen = join(root, relative)
  }

  it('lists it, with no profile, whether or not anything is installed', () => {
    const other = make().listSources().find((s) => s.id === 'other')
    expect(other).toMatchObject({ name: 'Autre navigateur', profiles: [], categories: ['bookmarks', 'history'] })
  })

  it('reads a Chromium bookmarks file, and only the bookmarks of a request for both', async () => {
    pick(`${SUPPORT}/Google/Chrome/Default/Bookmarks`)
    const preview = await make().preview({ source: 'other', categories: ['bookmarks', 'history'] })
    expect(preview).toMatchObject({ ok: true, bookmarks: 2, history: 0 })
    expect(preview.message).toContain('depuis Autre navigateur')
  })

  it('speaks only of the kind of data the picked file holds, not of what else was ticked', async () => {
    pick(`${SUPPORT}/Google/Chrome/Default/History`)
    const svc = make()
    const preview = await svc.preview({ source: 'other', categories: ['bookmarks', 'history'] })
    expect(preview.message).toBe(frenchSpaces('Prêt à importer depuis Autre navigateur : 2 pages d’historique.'))
    expect(svc.commit(preview.token!).message).toBe(frenchSpaces('Importé depuis Autre navigateur : 2 pages d’historique.'))
  })

  it('reads a Chromium history file', async () => {
    pick(`${SUPPORT}/Google/Chrome/Default/History`)
    expect(await make().preview({ source: 'other', categories: ['bookmarks', 'history'] })).toMatchObject({ ok: true, bookmarks: 0, history: 2 })
  })

  it('reads a Firefox file for both its bookmarks and its history', async () => {
    pick(`${SUPPORT}/Firefox/Profiles/x.default/places.sqlite`)
    expect(await make().preview({ source: 'other', categories: ['bookmarks', 'history'] })).toMatchObject({ ok: true, bookmarks: 1, history: 1 })
  })

  it('reads a bookmarks file in HTML', async () => {
    put('Desktop/flow.html', '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://flow-html.example/">H</A></DL><p>')
    pick('Desktop/flow.html')
    expect(await make().preview({ source: 'other', categories: ['bookmarks', 'history'] })).toMatchObject({ ok: true, bookmarks: 1, history: 0 })
  })

  it('refuses a file whose name it does not know, and says which names it knows', async () => {
    put('Desktop/notes.txt', 'rien')
    pick('Desktop/notes.txt')
    const report = await make().preview({ source: 'other', categories: ['bookmarks'] })
    expect(report.ok).toBe(false)
    expect(report.message).toContain('notes.txt n’est pas un fichier que l’import sait lire')
    expect(report.message).toContain('places.sqlite')
  })

  it('does not read a Chromium file through the wrong reader: a property list called Bookmarks is not JSON', async () => {
    put('Desktop/faux/Bookmarks', '<?xml version="1.0"?><plist version="1.0"><dict/></plist>')
    pick('Desktop/faux/Bookmarks')
    const report = await make().preview({ source: 'other', categories: ['bookmarks'] })
    expect(report.ok).toBe(false)
    expect(report.message).toMatch(/^Bookmarks est tronqué ou abîmé/)
    expect(dispatched).toEqual([])
  })

  it('refuses a folder named like a bookmarks file: it is not an ordinary file', async () => {
    put('Desktop/dossier/Bookmarks/.keep', 'x')
    pick('Desktop/dossier/Bookmarks')
    const report = await make().preview({ source: 'other', categories: ['bookmarks'] })
    expect(report.ok).toBe(false)
    expect(report.message).toContain('pas un fichier ordinaire')
  })

  it('does not take a file of another family for the one a named browser expects: a Safari file is not Chrome’s', async () => {
    put('Desktop/safari/Bookmarks.plist', '<?xml version="1.0"?><plist version="1.0"><dict><key>Children</key><array/></dict></plist>')
    pick('Desktop/safari/Bookmarks.plist')
    const report = await make().preview({ source: 'chrome', profile: 'Default', categories: ['bookmarks'], pick: true })
    expect(report.ok).toBe(false)
    expect(dispatched).toEqual([])
    expect(report.message).toBe('Aucun signet web à importer depuis Google Chrome.')
    chosen = join(root, `${SUPPORT}/Firefox/Profiles/x.default/places.sqlite`)
    expect((await make().preview({ source: 'chrome', profile: 'Default', categories: ['bookmarks'], pick: true })).ok).toBe(false)
  })

  it('does not wait for a pipe that was picked: it is not an ordinary file', async () => {
    put('Desktop/pipe/Bookmarks', (path) => execFileSync('/usr/bin/mkfifo', [path]))
    pick('Desktop/pipe/Bookmarks')
    const report = await make().preview({ source: 'other', categories: ['bookmarks'] })
    expect(report.ok).toBe(false)
    expect(report.message).toContain('pas un fichier ordinaire')
  })

  it('does nothing when the user cancels the file chooser', async () => {
    expect(await make().preview({ source: 'other', categories: ['bookmarks'] })).toMatchObject({ ok: false, message: 'Import annulé.' })
  })
})

describe('what is held for a later answer', () => {
  it('is let go once its time has passed, at the next question, and when the sheet is opened again', async () => {
    const svc = make()
    expect(svc.holdsAnswer()).toBe(false)
    const preview = await svc.preview(chrome)
    expect(svc.holdsAnswer()).toBe(true)
    svc.listSources()
    expect(svc.holdsAnswer()).toBe(false)
    expect(svc.commit(preview.token!).ok).toBe(false)

    const done = await svc.run(chrome)
    expect(svc.holdsAnswer()).toBe(true)
    svc.listSources()
    expect(svc.holdsAnswer()).toBe(true)
    now += UNDO_WINDOW_MS + 1
    svc.listSources()
    expect(svc.holdsAnswer()).toBe(false)
    expect(svc.undo(done.undoToken!).ok).toBe(false)
  })

  it('does not keep a preview that was confirmed, nor an import that was undone', async () => {
    const svc = make()
    const done = svc.commit((await svc.preview(chrome)).token!)
    svc.undo(done.undoToken!)
    expect(svc.holdsAnswer()).toBe(false)
  })
})

describe('what the import never touches', () => {
  it('opens neither the passwords nor the cookies of a browser: files that hold them, made unreadable, are never met', async () => {
    const traps = [`${SUPPORT}/Google/Chrome/Default/Login Data`, `${SUPPORT}/Google/Chrome/Default/Cookies`, `${SUPPORT}/Google/Chrome/Default/Web Data`, `${SUPPORT}/Firefox/Profiles/x.default/logins.json`, `${SUPPORT}/Firefox/Profiles/x.default/key4.db`, `${SUPPORT}/Firefox/Profiles/x.default/cookies.sqlite`]
    for (const trap of traps) {
      put(trap, 'secret')
      chmodSync(join(root, trap), 0o000)
    }
    try {
      for (const request of [chrome, { source: 'firefox', categories: ['bookmarks', 'history'] } as ImportRequest]) {
        const report = await make().preview(request)
        expect(report.ok, request.source).toBe(true)
        expect(report.needsDiskAccess, request.source).toBeUndefined()
        expect((report.details ?? []).join(' '), request.source).not.toContain('protégée par macOS')
      }
    } finally {
      for (const trap of traps) chmodSync(join(root, trap), 0o644)
    }
  })

  it('reads the names of the profiles of a Chromium browser from a file of a bounded size: a huge one is ignored and the folders name the profiles', () => {
    const state = JSON.stringify({ profile: { info_cache: { Default: { name: 'Trop gros' } } } })
    put(`${SUPPORT}/Brave Fixture/Local State`, (path) => writeFileSync(path, state + ' '.repeat(MAX_LOCAL_STATE_BYTES)))
    put(`${SUPPORT}/Brave Fixture/Default/Bookmarks`, '{}')
    const service = new ImportService({ home: root, ctx: () => ({ now: 1, newId: () => 'x' }), dispatch: () => undefined, state: () => state0(), mergeHistory: () => 0, chooseFile: async () => null })
    const def = { id: 'fixture', name: 'Fixture', kind: 'chromium' as const, support: 'Brave Fixture', categories: ['bookmarks' as const], blurb: () => '' }
    expect(service.profilesOf(def)).toEqual([{ id: 'Default', name: 'Default' }])
    // The same file within the bound is read: the control that makes the bound the reason for the answer above.
    put(`${SUPPORT}/Brave Fixture/Local State`, state)
    expect(service.profilesOf(def)).toEqual([{ id: 'Default', name: 'Trop gros' }])
  })
})

// What the service keeps for the guide « Vous venez d’Arc ? » (shared/arc-guide.ts): the window asks for it when the sheet that ran the import is left.
describe('the guide for people coming from Arc: what the service holds for it', () => {
  const arcSidebar: ImportRequest = { source: 'arc', categories: ['sidebar'] }
  const sidebarBrought = { spaces: 1, tabs: 4, folders: 0, favorites: 1, splits: 1 }
  const NOTHING = { spaces: 0, tabs: 0, folders: 0, favorites: 0, splits: 0 }

  it('holds what an import from Arc brought, and gives it once', async () => {
    const svc = make()
    expect(svc.takeArcGuide()).toBeNull()
    await svc.run(arcSidebar)
    expect(svc.takeArcGuide()).toEqual(sidebarBrought)
    expect(svc.takeArcGuide()).toBeNull()
  })

  it('holds nothing for a preview, whose key has not been confirmed, and holds the figures of the confirmation', async () => {
    const svc = make()
    const preview = await svc.preview(arcSidebar)
    expect(svc.takeArcGuide()).toBeNull()
    svc.commit(preview.token!)
    expect(svc.takeArcGuide()).toEqual(sidebarBrought)
  })

  it('adds up the imports of one visit to the sheet (the history, then the sidebar)', async () => {
    const svc = make()
    await svc.run({ source: 'arc', categories: ['history'] })
    await svc.run(arcSidebar)
    expect(svc.takeArcGuide()).toEqual(sidebarBrought)
  })

  it('holds the history of Arc alone as an import that brought nothing to name (the guide then speaks of the names only)', async () => {
    const svc = make()
    const done = await svc.run({ source: 'arc', categories: ['history'] })
    expect(done.undoToken).toBeDefined()
    expect(svc.takeArcGuide()).toEqual(NOTHING)
  })

  it('holds nothing for another browser, a bookmarks file or a file picked for “another browser”', async () => {
    put('Desktop/guide.html', '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://guide-html.example/">H</A></DL><p>')
    const svc = make()
    for (const request of [chrome, { source: 'firefox', categories: ['bookmarks', 'history'] } as ImportRequest]) {
      expect((await svc.run(request)).ok, request.source).toBe(true)
    }
    chosen = join(root, 'Desktop/guide.html')
    expect((await svc.run({ source: 'html', categories: ['bookmarks'] })).ok).toBe(true)
    chosen = join(root, `${SUPPORT}/Google/Chrome/Default/Bookmarks`)
    expect((await svc.run({ source: 'other', categories: ['bookmarks'] })).ok).toBe(true)
    expect(svc.takeArcGuide()).toBeNull()
  })

  it('holds nothing for an import from Arc that failed or brought nothing (everything was there already)', async () => {
    put('Desktop/notes-guide.txt', 'rien')
    chosen = join(root, 'Desktop/notes-guide.txt')
    const svc = make()
    expect((await svc.run({ ...arcSidebar, pick: true })).ok).toBe(false)
    expect(svc.takeArcGuide()).toBeNull()
    // Another import of the same file brings the entries between the preview and its confirmation: this one brought none.
    const other = make()
    const preview = await svc.preview(arcSidebar)
    await other.run(arcSidebar)
    other.takeArcGuide()
    expect(svc.commit(preview.token!).undoToken).toBeUndefined()
    expect(svc.takeArcGuide()).toBeNull()
  })

  it('forgets an import that is taken back, and keeps the ones before it', async () => {
    const svc = make()
    await svc.run({ source: 'arc', categories: ['history'] })
    const second = await svc.run(arcSidebar)
    expect(svc.undo(second.undoToken!).ok).toBe(true)
    expect(svc.takeArcGuide()).toEqual(NOTHING)
  })

  it('holds nothing for the only import, once it is taken back', async () => {
    const svc = make()
    const done = await svc.run(arcSidebar)
    expect(svc.undo(done.undoToken!).ok).toBe(true)
    expect(svc.takeArcGuide()).toBeNull()
  })

  it('keeps an import whose undo failed: it is still in the sidebar', async () => {
    const failing = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let broken = false
    const svc = make({
      dispatch: (action) => {
        if (broken && action.type === 'import/revert') throw new Error('disque plein')
        state = reduce(state, action, { now, newId: () => `flow${++n}` })
      }
    })
    const done = await svc.run(arcSidebar)
    broken = true
    expect(svc.undo(done.undoToken!).ok).toBe(false)
    expect(failing).toHaveBeenCalled()
    expect(svc.takeArcGuide()).toEqual(sidebarBrought)
  })
})

const state0 = () => createInitialState({ now: 1, newId: () => 'y' })
