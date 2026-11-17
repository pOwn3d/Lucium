import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { BOOKMARK_IMPORT_SCAN_MAX } from '@shared/bookmarks'
import { exportLibraryHtml } from '@shared/bookmarks-html'
import { BOOKMARK_TAGS_MAX, BOOKMARK_TAG_MAX, BOOKMARK_TITLE_MAX, defaultSettings, type Bookmark, type SidebarState } from '@shared/model'
import { createInitialState, reduce, type Action } from '@shared/sidebar'

const dialogs = vi.hoisted(() => ({ showOpenDialog: vi.fn(), showSaveDialog: vi.fn() }))
vi.mock('electron', () => ({ dialog: dialogs }))

import { BOOKMARKS_FILE_MAX_BYTES, libraryEmptyMessage, libraryEntriesFromHtml, libraryOffMessage, libraryPrivateMessage, transferBookmarks } from './bookmarks-library'
import { frenchSpaces } from '@shared/french-typography'

let dir: string
const win = {} as BrowserWindow
const ctx = { now: 1_700_000_000_000, newId: (() => { let n = 0; return () => `id${++n}` })() }
const bm = (n: number, over: Partial<Bookmark> = {}): Bookmark => ({ id: `b${n}`, url: `https://site${n}.example/page`, title: `Page ${n}`, tags: [], addedAt: 1_600_000_000_000 + n * 1000, ...over })
const stateWith = (bookmarks: Bookmark[], on = true): SidebarState => ({ ...createInitialState(ctx), settings: { ...defaultSettings(), bookmarkManager: on }, bookmarks })

/** The target of a transfer, with the actions it dispatched collected and reduced into a state, as the store would. */
function target(state: SidebarState, isPrivate = false) {
  const dispatched: Action[] = []
  let current = state
  return {
    dispatched,
    state: () => current,
    value: {
      win,
      get state() {
        return current
      },
      isPrivate,
      dispatch: (action: Action) => {
        dispatched.push(action)
        current = reduce(current, action, ctx)
      }
    }
  }
}
const choose = (path: string) => dialogs.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lucium-library-'))
  dialogs.showOpenDialog.mockReset()
  dialogs.showSaveDialog.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('what a bookmarks file gives the library', () => {
  it('takes the tags of the file and the name of the folder a link sits in, the date and the note', () => {
    const html = `<DL><p><DT><H3>Recettes</H3><DL><p><DT><A HREF="https://a.example/" ADD_DATE="1600000000" TAGS="cuisine,été">Tarte</A><DD>Une note &amp; plus<DT><A HREF="https://b.example/">Sans tags</A></DL><p><DT><A HREF="https://c.example/">Racine</A></DL>`
    const { entries } = libraryEntriesFromHtml(html)
    expect(entries).toEqual([
      { url: 'https://a.example/', title: 'Tarte', tags: ['cuisine', 'été', 'Recettes'], note: 'Une note & plus', addedAt: 1_600_000_000 },
      { url: 'https://b.example/', title: 'Sans tags', tags: ['Recettes'] },
      { url: 'https://c.example/', title: 'Racine', tags: [] }
    ])
  })

  it('bounds what a hostile file holds: tags, titles, depth, folder names, and the number of entries', () => {
    const control = 'x\u0000y,'.repeat(50)
    const tags = Array.from({ length: 100 }, (_, i) => `étiquette-${i}-${'z'.repeat(80)}`).join(',')
    const oversized = `<DT><A HREF="https://trop-long.example/" TAGS="${'t,'.repeat(20_000)}">Trop long</A>`
    const deep = '<DL><p><DT><H3>niveau</H3>'.repeat(200) + '<DL><p><DT><A HREF="https://profond.example/">Profond</A>' + '</DL>'.repeat(201)
    const many = Array.from({ length: BOOKMARK_IMPORT_SCAN_MAX + 500 }, (_, i) => `<DT><A HREF="https://m${i}.example/">M</A>`).join('')
    const parsed = libraryEntriesFromHtml(`<DL><p>${oversized}<DT><A HREF="https://a.example/" TAGS="${tags}">${'T'.repeat(10_000)}</A><DT><A HREF="https://b.example/" TAGS="${control}">B</A>${deep}</DL>`)
    const [a, b] = parsed.entries
    expect(a!.tags).toHaveLength(BOOKMARK_TAGS_MAX)
    expect((a!.tags as string[]).every((t) => t.length <= BOOKMARK_TAG_MAX)).toBe(true)
    expect(String(a!.title).length).toBeLessThanOrEqual(5000)
    expect(b!.tags).toEqual(['x y'])
    expect(parsed.entries.find((e) => e.url === 'https://profond.example/')).toBeDefined()
    // A tag longer than the parser reads (16 KB) is text, not a link.
    expect(parsed.entries.find((e) => e.url === 'https://trop-long.example/')).toBeUndefined()
    const big = libraryEntriesFromHtml(`<DL>${many}</DL>`)
    expect(big.entries).toHaveLength(BOOKMARK_IMPORT_SCAN_MAX)
    expect(big.truncated).toBe(true)
  })

  it('gives entries that the library still checks: a script address is carried as data and refused later', () => {
    const { entries } = libraryEntriesFromHtml('<DL><DT><A HREF="javascript:alert(1)">X</A><DT><A HREF="data:text/html,<script>1</script>">Y</A><DT><A HREF="https://ok.example/">Z</A></DL>')
    expect(entries.map((e) => e.url)).toEqual(['javascript:alert(1)', 'data:text/html,<script>1</script>', 'https://ok.example/'])
    const state = reduce(stateWith([]), { type: 'bookmarks/import', entries }, ctx)
    expect(state.bookmarks.map((b) => b.url)).toEqual(['https://ok.example/'])
  })
})

describe('exporting, then importing', () => {
  it('writes the library at the path the user chose, and only there, and reads back what it wrote', async () => {
    const library = [bm(1, { tags: ['à voir', 'dev'], note: 'Une note' }), bm(2, { title: 'Tom & "Jerry" <b>' }), bm(3)]
    const chosen = join(dir, 'biblio.html')
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: chosen })
    const out = target(stateWith(library))
    const reply = await transferBookmarks(out.value, { op: 'export' })
    expect(reply).toMatchObject({ ok: true })
    expect(reply.message).toContain(`Enregistré dans ${chosen}`)
    expect(reply.message).toContain('3 signets')
    expect(readFileSync(chosen, 'utf8')).toBe(exportLibraryHtml(library).html)
    expect(readdirSync(dir)).toEqual(['biblio.html'])

    choose(chosen)
    const back = target(stateWith([]))
    const imported = await transferBookmarks(back.value, { op: 'import' })
    expect(imported.ok).toBe(true)
    expect(imported.message).toContain('3 signets ajoutés')
    expect(back.state().bookmarks.map(({ id: _id, ...rest }) => rest)).toEqual(library.map(({ id: _id, ...rest }) => rest))
  })

  it('importing the same file twice adds nothing the second time', async () => {
    const chosen = join(dir, 'deux.html')
    writeFileSync(chosen, exportLibraryHtml([bm(1, { tags: ['a'] }), bm(2)]).html)
    choose(chosen)
    const out = target(stateWith([]))
    await transferBookmarks(out.value, { op: 'import' })
    const second = await transferBookmarks(out.value, { op: 'import' })
    expect(out.state().bookmarks).toHaveLength(2)
    expect(second.message).toContain('0 signet ajouté')
    expect(second.message).toContain('2 déjà présents')
  })

  it('reads the file another browser writes: folders become tags', async () => {
    const chosen = join(dir, 'chrome.html')
    writeFileSync(chosen, '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Barre de favoris</H3><DL><p><DT><A HREF="https://a.example/">A</A></DL><p></DL>')
    choose(chosen)
    const out = target(stateWith([]))
    await transferBookmarks(out.value, { op: 'import' })
    expect(out.state().bookmarks.map((b) => [b.url, b.tags])).toEqual([['https://a.example/', ['Barre de favoris']]])
  })
})

describe('what stops a transfer', () => {
  it('asks nothing and does nothing in a private window, or with the setting off', async () => {
    const priv = target(stateWith([bm(1)]), true)
    expect(await transferBookmarks(priv.value, { op: 'import' })).toEqual({ ok: false, message: libraryPrivateMessage() })
    expect(await transferBookmarks(priv.value, { op: 'export' })).toEqual({ ok: false, message: libraryPrivateMessage() })
    const off = target(stateWith([bm(1)], false))
    expect(await transferBookmarks(off.value, { op: 'import' })).toEqual({ ok: false, message: libraryOffMessage() })
    expect(await transferBookmarks(off.value, { op: 'export' })).toEqual({ ok: false, message: libraryOffMessage() })
    expect(dialogs.showOpenDialog).not.toHaveBeenCalled()
    expect(dialogs.showSaveDialog).not.toHaveBeenCalled()
    expect(priv.dispatched).toEqual([])
    expect(off.dispatched).toEqual([])
  })

  it('says nothing and changes nothing when the dialog is given up', async () => {
    dialogs.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    dialogs.showSaveDialog.mockResolvedValue({ canceled: true })
    const out = target(stateWith([bm(1)]))
    expect(await transferBookmarks(out.value, { op: 'import' })).toEqual({ ok: false, message: '' })
    expect(await transferBookmarks(out.value, { op: 'export' })).toEqual({ ok: false, message: '' })
    expect(out.dispatched).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses a file that is too big, a folder, a file that is not text and a file with no bookmark, each with a sentence', async () => {
    const out = target(stateWith([]))
    const big = join(dir, 'gros.html')
    writeFileSync(big, Buffer.alloc(BOOKMARKS_FILE_MAX_BYTES + 1, 0x20))
    choose(big)
    expect((await transferBookmarks(out.value, { op: 'import' })).message).toContain('trop volumineux')
    mkdirSync(join(dir, 'dossier.html'))
    choose(join(dir, 'dossier.html'))
    expect((await transferBookmarks(out.value, { op: 'import' })).message).toContain('pas un fichier ordinaire')
    // Bytes that are no text at all are read as whatever they come to, and hold no bookmark: the answer is about bookmarks (it said "not a Tweak nor a theme").
    const binary = join(dir, 'binaire.html')
    writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81]))
    choose(binary)
    expect((await transferBookmarks(out.value, { op: 'import' })).message).toContain('Aucun signet dans binaire.html')
    const empty = join(dir, 'vide.html')
    writeFileSync(empty, '<html><body>Pas de signets ici</body></html>')
    choose(empty)
    const none = await transferBookmarks(out.value, { op: 'import' })
    expect(none.ok).toBe(false)
    expect(none.message).toContain('Aucun signet dans vide.html')
    choose(join(dir, 'absent.html'))
    expect((await transferBookmarks(out.value, { op: 'import' })).message).toContain('n’existe plus')
    expect(out.dispatched).toEqual([])
  })

  it('reads a bookmarks file another program saved in UTF-16 or Windows-1252, instead of refusing it as "not UTF-8"', async () => {
    const html = '<DL><DT><A HREF="https://accent.example/" TAGS="été">Crème brûlée</A></DL>'
    const utf16 = join(dir, 'utf16.html')
    writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(html, 'utf16le')]))
    const latin = join(dir, 'latin.html')
    writeFileSync(latin, Buffer.from(`<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=windows-1252">${html}`, 'latin1'))
    for (const file of [utf16, latin]) {
      const out = target(stateWith([]))
      choose(file)
      const reply = await transferBookmarks(out.value, { op: 'import' })
      expect(reply.ok, reply.message).toBe(true)
      expect(out.state().bookmarks.map((b) => b.title)).toEqual(['Crème brûlée'])
      expect(out.state().bookmarks[0]!.tags).toEqual(['été'])
    }
  })

  it('says so when the library is empty, and logs and tells when the file cannot be written', async () => {
    const empty = target(stateWith([]))
    expect(await transferBookmarks(empty.value, { op: 'export' })).toEqual({ ok: false, message: libraryEmptyMessage() })
    expect(dialogs.showSaveDialog).not.toHaveBeenCalled()
    dialogs.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(dir, 'absent', 'sous-dossier', 'x.html') })
    const out = target(stateWith([bm(1)]))
    const reply = await transferBookmarks(out.value, { op: 'export' })
    expect(reply.ok).toBe(false)
    expect(reply.message).toContain(frenchSpaces('Enregistrement impossible dans x.html : le dossier choisi n’existe plus'))
    expect(reply.message).not.toMatch(/ENOENT|no such file|\/absent/)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[bookmarks] cannot write'), expect.anything())
  })

  it('keeps a title cut at its bound when a hostile file has a huge one', async () => {
    const chosen = join(dir, 'titre.html')
    writeFileSync(chosen, `<DL><DT><A HREF="https://a.example/">${'T'.repeat(4000)}</A></DL>`)
    choose(chosen)
    const out = target(stateWith([]))
    await transferBookmarks(out.value, { op: 'import' })
    expect(out.state().bookmarks[0]!.title).toHaveLength(BOOKMARK_TITLE_MAX)
  })
})
