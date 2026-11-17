// The IPC of the quick notes against a real file: refused in a private window and while the function is off (the file is not even opened), the request
// checked field by field, the address of a page and the space of a note checked again by the main process, and the notes of a locked space hidden.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc'
import { defaultSettings } from '@shared/model'
import { NEW_NOTE_REQUEST, NOTE_TEXT_MAX, notesFileText, type NotesContext, type NotesReply } from '@shared/notes'
import { NOTE_FILE_MAX_BYTES } from '@shared/note-files'
import { createInitialState } from '@shared/sidebar'
import { takePersistenceNotices } from '../persistence-notices'
import { NotesFile, configureNotes } from '../notes-store'
import { tempDir } from '../temp-dir'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'
import { handleNoteFileRequest, handleNotesRequest, registerNotesIpc, type NoteFileDeps, type NotesDeps } from './notes-ipc'
import { methodsOf, overlayHost, showedPanel } from './browser-fake.test-support'
import { played, resetPlayedPlatform } from '../platform/platform.test-support'
import { frenchSpaces } from '@shared/french-typography'

// The menu, the registration of the features and the shell reach Electron only when a message arrives, a menu is built or a method runs.
vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  const target: Record<string, unknown> = { Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu: () => {} } }
  return new Proxy(target, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})
// The menu of macOS on any machine, and of another system when a test asks (⌥⌘E exists on macOS only: shared/platform.ts, NON_MAC_DEFAULTS).
vi.mock('../platform', async (original) => (await import('../platform/platform.test-support')).playedPlatform(await original()))
const { buildMenu } = await import('./menu')
const { registerFeatureIpc } = await import('./feature-ipc')
const { Browser: BrowserClass } = await import('./browser')
const shell = methodsOf(BrowserClass.prototype)

let ids = 0
afterEach(() => {
  vi.restoreAllMocks()
  takePersistenceNotices()
  resetPlayedPlatform()
})
beforeEach(() => {
  ids = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

function setup(over: Partial<NotesDeps> & { private?: boolean; on?: boolean; locked?: string[]; here?: NotesContext } = {}) {
  const dir = tempDir('lucium-notes-ipc-')
  const file = new NotesFile(join(dir, 'notes.json'), () => 1000, () => `n${++ids}`)
  const asked = { file: 0, open: 0, compose: 0 }
  const notices: string[] = []
  const deps: NotesDeps = {
    isPrivate: () => over.private === true,
    enabled: () => over.on !== false,
    file: () => {
      asked.file++
      return file
    },
    spaceExists: (id) => ['s1', 's2'].includes(id),
    lockedSpaces: () => over.locked ?? [],
    open: (compose) => {
      asked.open++
      if (compose) asked.compose++
    },
    context: () => over.here ?? { pageUrl: 'https://example.org/article', spaceId: 's1' },
    spaceName: (id) => ({ s1: 'Travail', s2: 'Maison' })[id],
    notify: (message) => void notices.push(message),
    ...over
  }
  return { dir, file, asked, notices, deps, call: (raw: unknown): NotesReply => handleNotesRequest(raw, deps) }
}

describe('the notes IPC in a private window', () => {
  it('refuses every request, reads nothing and writes nothing', () => {
    const t = setup({ private: true })
    writeFileSync(t.file.path, 'pas du JSON')
    for (const request of [{ kind: 'list' }, { kind: 'open' }, { kind: 'open', compose: true }, { kind: 'jot', text: 'secret' }, { kind: 'create', text: 'secret', link: { kind: 'page', url: 'https://example.org/' } }, { kind: 'update', id: 'n1', text: 'x', link: null }, { kind: 'remove', id: 'n1' }]) {
      expect(t.call(request)).toEqual({ ok: false, message: frenchSpaces('Les notes ne sont pas disponibles dans une fenêtre privée : rien n’y est gardé.'), notes: [] })
    }
    expect(t.asked).toEqual({ file: 0, open: 0, compose: 0 })
    expect(t.notices).toEqual([])
    // Not even read: a damaged file would have been set aside.
    expect(readdirSync(t.dir)).toEqual(['notes.json'])
    expect(readFileSync(t.file.path, 'utf8')).toBe('pas du JSON')
  })
})

describe('the notes IPC while the function is off', () => {
  it('costs nothing: no request reaches the file, which is neither read nor written, and the panel does not open', () => {
    const t = setup({ on: false })
    writeFileSync(t.file.path, 'pas du JSON')
    for (const request of [{ kind: 'list' }, { kind: 'open' }, { kind: 'open', compose: true }, { kind: 'jot', text: 'x' }, { kind: 'create', text: 'x', link: null }, { kind: 'remove', id: 'n1' }]) {
      expect(t.call(request)).toEqual({ ok: false, message: 'Les notes sont désactivées (Réglages › Fonctions en option › Signets et notes).', notes: [] })
    }
    expect(t.asked).toEqual({ file: 0, open: 0, compose: 0 })
    expect(t.notices).toEqual([])
    expect(readdirSync(t.dir)).toEqual(['notes.json'])
  })
})

describe('the notes IPC', () => {
  it('lists, creates, changes and deletes notes', () => {
    const t = setup()
    expect(t.call({ kind: 'list' })).toEqual({ ok: true, notes: [] })
    const made = t.call({ kind: 'create', text: '  Acheter du pain\r\n', link: { kind: 'space', spaceId: 's1' } })
    expect(made).toEqual({ ok: true, id: 'n1', notes: [{ id: 'n1', text: 'Acheter du pain', createdAt: 1000, updatedAt: 1000, link: { kind: 'space', spaceId: 's1' } }] })
    expect(t.call({ kind: 'update', id: 'n1', text: 'Acheter du pain complet', link: null })).toMatchObject({ ok: true, notes: [{ id: 'n1', text: 'Acheter du pain complet' }] })
    expect(t.call({ kind: 'list' }).notes[0]).not.toHaveProperty('link')
    expect(t.call({ kind: 'remove', id: 'n1' })).toEqual({ ok: true, notes: [] })
    expect(JSON.parse(readFileSync(t.file.path, 'utf8'))).toEqual({ version: 1, notes: [] })
  })

  it('opens the panel for the command bar without reading the file, on a new note when asked', () => {
    const t = setup()
    expect(t.call({ kind: 'open' })).toEqual({ ok: true, notes: [] })
    expect(t.asked).toEqual({ file: 0, open: 1, compose: 0 })
    expect(t.call({ kind: 'open', compose: true })).toEqual({ ok: true, notes: [] })
    expect(t.asked).toEqual({ file: 0, open: 2, compose: 1 })
  })

  it('makes the note of the command bar at once, tied to the page on screen, and says so in a notice', () => {
    const t = setup({ here: { pageUrl: 'https://example.org/article', spaceId: 's1' } })
    expect(t.call({ kind: 'jot', text: '  Relire la conclusion ' })).toEqual({
      ok: true,
      id: 'n1',
      notes: [{ id: 'n1', text: 'Relire la conclusion', createdAt: 1000, updatedAt: 1000, link: { kind: 'page', url: 'https://example.org/article' } }]
    })
    expect(t.notices).toEqual(['Note ajoutée à la page example.org.'])
    expect(JSON.parse(readFileSync(t.file.path, 'utf8')).notes).toHaveLength(1)
  })

  it('ties the note of the command bar to the space when the tab on screen is no web page, and to nothing without a space', () => {
    const inSpace = setup({ here: { pageUrl: null, spaceId: 's2' } })
    expect(inSpace.call({ kind: 'jot', text: 'Ordre du jour' }).notes[0]!.link).toEqual({ kind: 'space', spaceId: 's2' })
    expect(inSpace.notices).toEqual([frenchSpaces('Note ajoutée à l’espace « Maison ».')])
    const nowhere = setup({ here: { pageUrl: null, spaceId: null } })
    expect(nowhere.call({ kind: 'jot', text: 'Sans lieu' }).notes[0]).not.toHaveProperty('link')
    expect(nowhere.notices).toEqual(['Note enregistrée.'])
  })

  it('keeps nothing of an empty note of the command bar, nor of one the lock refuses, and the notice says why', () => {
    const t = setup()
    expect(t.call({ kind: 'jot', text: ' \n ' })).toMatchObject({ ok: false, message: 'La note est vide.' })
    const locked = setup({ locked: ['s2'], here: { pageUrl: null, spaceId: 's2' } })
    expect(locked.call({ kind: 'jot', text: 'secret' })).toMatchObject({ ok: false, message: frenchSpaces('Cet espace est verrouillé : déverrouillez-le pour lui lier une note.') })
    expect([...t.notices, ...locked.notices]).toEqual(['La note est vide.', frenchSpaces('Cet espace est verrouillé : déverrouillez-le pour lui lier une note.')])
    expect(existsSync(t.file.path)).toBe(false)
    expect(existsSync(locked.file.path)).toBe(false)
  })

  it('sends no notice for the notes of the panel: it shows them itself', () => {
    const t = setup()
    t.call({ kind: 'create', text: 'x', link: null })
    t.call({ kind: 'create', text: '', link: null })
    expect(t.notices).toEqual([])
  })

  it('ties a note to the address of a page as the main process normalises it, and refuses what is not a web page', () => {
    const t = setup()
    expect(t.call({ kind: 'create', text: 'x', link: { kind: 'page', url: 'https://Example.org/a?utm_source=x#frag' } }).notes[0]!.link).toEqual({ kind: 'page', url: 'https://example.org/a' })
    for (const url of ['file:///etc/passwd', 'about:blank', 'javascript:alert(1)']) {
      expect(t.call({ kind: 'create', text: 'x', link: { kind: 'page', url } }), url).toMatchObject({ ok: false, message: 'Seule une page web (http ou https) peut recevoir une note.' })
    }
    expect(t.call({ kind: 'list' }).notes).toHaveLength(1)
  })

  it('refuses a space that does not exist, but lets a note keep the link to a space deleted since', () => {
    const t = setup()
    expect(t.call({ kind: 'create', text: 'x', link: { kind: 'space', spaceId: 'disparu' } })).toMatchObject({ ok: false, message: 'Cet espace n’existe plus.' })
    writeFileSync(t.file.path, notesFileText([{ id: 'vieille', text: 'de l’espace parti', createdAt: 1, updatedAt: 1, link: { kind: 'space', spaceId: 'disparu' } }]))
    expect(t.call({ kind: 'update', id: 'vieille', text: 'revue', link: { kind: 'space', spaceId: 'disparu' } })).toMatchObject({ ok: true, notes: [{ text: 'revue', link: { kind: 'space', spaceId: 'disparu' } }] })
    expect(t.call({ kind: 'update', id: 'vieille', text: 'revue', link: { kind: 'space', spaceId: 'autre-disparu' } })).toMatchObject({ ok: false, message: 'Cet espace n’existe plus.' })
  })

  it('refuses an empty note and a note too long, with the reason, and writes nothing', () => {
    const t = setup()
    expect(t.call({ kind: 'create', text: ' \n\t', link: null })).toMatchObject({ ok: false, message: 'La note est vide.' })
    expect(t.call({ kind: 'create', text: 'x'.repeat(4001), link: null })).toMatchObject({ ok: false, message: 'La note dépasse 4000 caractères.' })
    expect(existsSync(t.file.path)).toBe(false)
  })

  it('refuses a request that is not exactly one of the five, and acts on nothing', () => {
    const t = setup()
    for (const bad of [null, 'list', { kind: 'list', all: true }, { kind: 'open', compose: 'yes' }, { kind: 'open', compose: false }, { kind: 'jot' }, { kind: 'jot', text: 'x', link: null }, { kind: 'jot', text: 'x'.repeat(8001) }, { kind: 'create', text: 'x', link: 'https://example.org/' }, { kind: 'remove', id: '*' }, { kind: 'erase-all' }]) {
      expect(t.call(bad), JSON.stringify(bad)).toEqual({ ok: false, message: 'Demande invalide.', notes: [] })
    }
    expect(t.asked.file).toBe(0)
    expect(t.notices).toEqual([])
    expect(existsSync(t.file.path)).toBe(false)
  })

  it('neither shows nor touches the notes of a locked space, and ties none to it', () => {
    const t = setup({ locked: ['s2'] })
    writeFileSync(t.file.path, notesFileText([{ id: 'cachee', text: 'secret', createdAt: 1, updatedAt: 1, link: { kind: 'space', spaceId: 's2' } }, { id: 'visible', text: 'libre', createdAt: 1, updatedAt: 1 }]))
    expect(t.call({ kind: 'list' }).notes.map((n) => n.id)).toEqual(['visible'])
    expect(t.call({ kind: 'remove', id: 'cachee' })).toMatchObject({ ok: false, message: 'Cette note n’existe plus.', notes: [{ id: 'visible' }] })
    expect(t.call({ kind: 'update', id: 'cachee', text: 'x', link: null })).toMatchObject({ ok: false, message: 'Cette note n’existe plus.' })
    expect(t.call({ kind: 'create', text: 'x', link: { kind: 'space', spaceId: 's2' } })).toMatchObject({ ok: false, message: frenchSpaces('Cet espace est verrouillé : déverrouillez-le pour lui lier une note.') })
    expect(t.call({ kind: 'update', id: 'visible', text: 'x', link: { kind: 'space', spaceId: 's2' } })).toMatchObject({ ok: false, message: frenchSpaces('Cet espace est verrouillé : déverrouillez-le pour lui lier une note.') })
    // The hidden note is still in the file, whole.
    expect(JSON.parse(readFileSync(t.file.path, 'utf8')).notes.map((n: { id: string }) => n.id)).toEqual(['cachee', 'visible'])
  })

  it('says the notes are not there when the file was never configured', () => {
    const t = setup({ file: () => null })
    expect(t.call({ kind: 'list' })).toEqual({ ok: false, message: 'Les notes ne sont pas disponibles.', notes: [] })
  })
})

describe('the registration of the notes IPC', () => {
  type Handler = (event: { sender: object }, ...args: unknown[]) => unknown

  function register(options: { private?: boolean; trusted?: boolean; notes?: boolean } = {}) {
    const handlers = new Map<string, Handler>()
    const listeners: string[] = []
    const ipc: ScopedIpc = {
      on: (channel) => void listeners.push(channel),
      handle: (channel, listener) => void handlers.set(channel, listener as Handler)
    }
    const opened: unknown[] = []
    const toasts: string[] = []
    const browser = { isPrivate: () => options.private === true, openOverlay: (request: unknown) => void opened.push(request), showToast: (message: string) => void toasts.push(message) } as unknown as Browser
    const state = { ...createInitialState({ now: 0, newId: () => 's1' }), settings: { ...defaultSettings(), notes: options.notes !== false } }
    const subscribe = vi.fn()
    const store = { get: () => state, subscribe } as unknown as StateStore
    registerNotesIpc(ipc, () => options.trusted !== false, browser, store)
    const call = (raw: unknown) => handlers.get(Channel.notes)!({ sender: {} }, raw) as NotesReply
    return { handlers, listeners, subscribe, opened, toasts, call }
  }

  it('adds two handlers (the notes, their files) and nothing that listens: no subscription to the state, no other channel', () => {
    const r = register()
    expect([...r.handlers.keys()]).toEqual([Channel.notes, Channel.noteFiles])
    expect(r.listeners).toEqual([])
    expect(r.subscribe).not.toHaveBeenCalled()
  })

  it('opens the panel of its own window for the command bar, on a new note when asked', () => {
    const r = register()
    expect(r.call({ kind: 'open' })).toEqual({ ok: true, notes: [] })
    expect(r.call({ kind: 'open', compose: true })).toEqual({ ok: true, notes: [] })
    expect(r.opened).toEqual([{ panel: 'notes' }, { panel: 'notes', compose: true }])
    // The command bar's "Nouvelle note" asks for the very request of the menu, its shortcut and the toolbar's button.
    expect(r.opened[1]).toBe(NEW_NOTE_REQUEST)
  })

  it('ties the note of the command bar to the tab on screen of its own window, and says so in the window’s notice', () => {
    const dir = tempDir('lucium-notes-ipc-')
    configureNotes(join(dir, 'notes.json'))
    const r = register()
    // The state of the window has a single space and no tab: the note goes to that space.
    expect(r.call({ kind: 'jot', text: 'Idée' })).toMatchObject({ ok: true, notes: [{ text: 'Idée', link: { kind: 'space', spaceId: 's1' } }] })
    expect(r.toasts).toEqual([frenchSpaces('Note ajoutée à l’espace « Perso ».')])
  })

  it('reads the switch of the function and the kind of window at each request', () => {
    const dir = tempDir('lucium-notes-ipc-')
    writeFileSync(join(dir, 'notes.json'), 'pas du JSON')
    configureNotes(join(dir, 'notes.json'))
    expect(register({ notes: false }).call({ kind: 'list' })).toMatchObject({ ok: false, message: 'Les notes sont désactivées (Réglages › Fonctions en option › Signets et notes).' })
    expect(register({ private: true }).call({ kind: 'list' })).toMatchObject({ ok: false, message: frenchSpaces('Les notes ne sont pas disponibles dans une fenêtre privée : rien n’y est gardé.') })
    expect(readdirSync(dir)).toEqual(['notes.json'])
    // On, in a normal window: the damaged file is read, and set aside.
    expect(register().call({ kind: 'list' })).toEqual({ ok: true, notes: [] })
    expect(readdirSync(dir).some((name) => name.startsWith('notes.json.corrupt-'))).toBe(true)
  })

  it('refuses a sender that is not one of the application’s own pages', () => {
    const r = register({ trusted: false })
    expect(r.call({ kind: 'open' })).toEqual({ ok: false, message: 'Demande refusée.', notes: [] })
    expect(r.opened).toEqual([])
  })
})

// The window, the menu and the registration of the IPC, run without Electron: the menu is built from its template, the window's method runs on a
// stand-in (browser-fake.test-support.ts), and the registration of the features is made on a scoped IPC that keeps the handlers.
describe('the ways into the notes in the window', () => {
  const stateOf = (notes: boolean) => ({ ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), notes } })
  const storeOf = (notes: boolean) => ({ get: () => stateOf(notes) }) as unknown as StateStore

  it('opens no panel of notes while the function is off, whoever asks', () => {
    const off = overlayHost({ notes: false })
    shell['openOverlay']!.call(off.self, { panel: 'notes' })
    expect(showedPanel(off, 'notes')).toBe(false)
    const on = overlayHost({ notes: true })
    shell['openOverlay']!.call(on.self, { panel: 'notes' })
    expect(showedPanel(on, 'notes')).toBe(true)
  })

  it('hides the menu entry and kills its shortcut while the function is off, and in a private window', () => {
    const notesEntry = (notes: boolean, options: { private?: boolean } = {}, label = 'Notes…') => {
      const opened: unknown[] = []
      const browser = new Proxy({ openOverlay: (request: unknown) => void opened.push(request), currentOverlay: () => null } as Record<string, unknown>, {
        get: (target, prop: string) => (prop in target ? target[prop] : () => false)
      })
      const actions = new Proxy({ windows: () => [], extensions: () => [], sessionStart: 0, window: () => ({}) } as Record<string, unknown>, { get: (target, prop: string) => (prop in target ? target[prop] : () => {}) })
      const items = leaves(buildMenu(browser as never, storeOf(notes), actions as never, options) as unknown as MenuItem[])
      return { item: items.find((i) => i.label === label)!, items, opened }
    }
    const on = notesEntry(true)
    expect(on.item).toMatchObject({ visible: true, enabled: true })
    expect(on.item.accelerator).toBeTruthy()
    on.item.click!()
    expect(on.opened).toEqual([{ panel: 'notes' }])
    expect(notesEntry(false).item).toMatchObject({ visible: false, enabled: false })
    expect(notesEntry(true, { private: true }).item).toMatchObject({ visible: false, enabled: false })
    // File › Nouvelle note, just under Notes…, with ⌥⌘E: the panel on a new note. Hidden and dead with the function, and in a private window.
    const fresh = notesEntry(true, {}, 'Nouvelle note')
    expect(fresh.items.indexOf(fresh.item)).toBe(fresh.items.findIndex((i) => i.label === 'Notes…') + 1)
    expect(fresh.item).toMatchObject({ visible: true, enabled: true, accelerator: 'CmdOrCtrl+Alt+E' })
    // Off macOS the entry stays, without the shortcut: Ctrl+Alt+E is AltGr+E, the € of most European keyboards.
    played.id = 'linux'
    const elsewhere = notesEntry(true, {}, 'Nouvelle note').item
    expect(elsewhere).toMatchObject({ visible: true, enabled: true })
    expect(elsewhere.accelerator).toBeUndefined()
    played.id = 'darwin'
    fresh.item.click!()
    expect(fresh.opened).toEqual([{ panel: 'notes', compose: true }])
    // One request for every way in (menu and ⌥⌘E, the command bar, the notes panel's own button): none can drift from the others.
    expect(fresh.opened[0]).toBe(NEW_NOTE_REQUEST)
    expect(notesEntry(false, {}, 'Nouvelle note').item).toMatchObject({ visible: false, enabled: false })
    expect(notesEntry(true, { private: true }, 'Nouvelle note').item).toMatchObject({ visible: false, enabled: false })
  })

  it('is registered with the window’s own scoped IPC and guard', () => {
    const handlers = new Map<string, (event: { sender: unknown }, raw: unknown) => unknown>()
    const ipc = { handle: (channel: string, handler: never) => void handlers.set(channel, handler), on: () => {} } as unknown as ScopedIpc
    const sender = { id: 7 }
    const guard = vi.fn((_sender: unknown, _channel: string) => false)
    const browser = { isPrivate: () => true, useTranslator: () => undefined } as unknown as Browser
    registerFeatureIpc(ipc, guard as never, browser, storeOf(true), {} as never)
    expect(handlers.get(Channel.notes)!({ sender }, { kind: 'list' })).toEqual({ ok: false, message: 'Demande refusée.', notes: [] })
    expect(guard).toHaveBeenLastCalledWith(sender, Channel.notes)
    guard.mockReturnValue(true)
    expect(handlers.get(Channel.notes)!({ sender }, { kind: 'list' })).toMatchObject({ ok: false, message: frenchSpaces('Les notes ne sont pas disponibles dans une fenêtre privée : rien n’y est gardé.') })
  })
})

interface MenuItem {
  label?: string
  accelerator?: string
  visible?: boolean
  enabled?: boolean
  click?: () => void
  submenu?: MenuItem[]
}
const leaves = (items: MenuItem[]): MenuItem[] => items.flatMap((item) => (item.submenu ? leaves(item.submenu) : [item]))

// ---------- a note out of the panel and into it ----------

function fileSetup(over: Parameters<typeof setup>[0] & { save?: string | null; picked?: string | null; read?: Uint8Array | Error; more?: boolean; copyFails?: boolean; shareFails?: boolean; writeFails?: boolean } = {}) {
  const notes = setup(over)
  const done = { saved: [] as Array<[string, string]>, copied: [] as Array<[string, string | undefined]>, shared: [] as Array<[string, string]>, mailed: [] as string[], dialogs: 0, read: [] as Array<[string, number]> }
  const deps: NoteFileDeps = {
    notes: notes.deps,
    chooseSave: async (name) => {
      done.dialogs++
      return over.save === undefined ? `/Users/moi/Downloads/${name}` : over.save
    },
    chooseOpen: async () => {
      done.dialogs++
      return over.picked === undefined ? '/Users/moi/Documents/réunion.md' : over.picked
    },
    writeFile: async (path, text) => {
      if (over.writeFails) throw new Error('disque plein')
      done.saved.push([path, text])
    },
    readFile: async (path, max) => {
      done.read.push([path, max])
      if (over.read instanceof Error) throw over.read
      return { bytes: over.read ?? new TextEncoder().encode('# Réunion\n- un'), more: over.more === true }
    },
    copy: async (text, html) => {
      if (over.copyFails) throw new Error('presse-papiers occupé')
      done.copied.push([text, html])
    },
    share: async (text, name) => {
      if (over.shareFails) throw new Error('pas de fenêtre')
      done.shared.push([text, name])
    },
    openMail: (url) => void done.mailed.push(url)
  }
  return { ...notes, done, ask: (raw: unknown) => handleNoteFileRequest(raw, deps) }
}

describe('the files of a note', () => {
  it('are refused in a private window and while the function is off, before any dialog, the clipboard, the disk or the share sheet', async () => {
    for (const options of [{ private: true }, { on: false }]) {
      const t = fileSetup(options)
      for (const request of [{ kind: 'save', text: 'x' }, { kind: 'share', text: 'x' }, { kind: 'copy', format: 'markdown', text: 'x' }, { kind: 'import', link: null }, { kind: 'import-text', name: 'a.md', text: 'x', link: null }, { kind: 'mail', url: 'mailto:a@b.c' }]) {
        expect((await t.ask(request)).ok, JSON.stringify(request)).toBe(false)
      }
      expect(t.done).toEqual({ saved: [], copied: [], shared: [], mailed: [], dialogs: 0, read: [] })
      expect(t.asked.file).toBe(0)
    }
  })

  it('refuse a request that is not one', async () => {
    const t = fileSetup()
    expect(await t.ask({ kind: 'save', text: 'x', path: '/etc/passwd' })).toEqual({ ok: false, message: 'Demande invalide.' })
    expect(t.done.dialogs).toBe(0)
  })

  it('download the note as a .md file named after its title, where the user says, its text and a line feed', async () => {
    const t = fileSetup()
    const reply = await t.ask({ kind: 'save', text: '# Réunion produit\n- **un**\r\n' })
    expect(t.done.saved).toEqual([['/Users/moi/Downloads/Réunion produit.md', '# Réunion produit\n- **un**\n']])
    expect(reply).toEqual({ ok: true, message: frenchSpaces('Note enregistrée dans « Réunion produit.md ».') })
  })

  it('write nothing when the save dialog is given up, and say why when the file cannot be written', async () => {
    const given = fileSetup({ save: null })
    expect(await given.ask({ kind: 'save', text: 'x' })).toEqual({ ok: true })
    expect(given.done.saved).toEqual([])
    const full = fileSetup({ writeFails: true })
    expect(await full.ask({ kind: 'save', text: 'x' })).toEqual({ ok: false, message: 'Le fichier n’a pas pu être enregistré (disque plein).' })
    expect(console.error).toHaveBeenCalled()
  })

  it('refuse to download, copy or share a note that holds nothing', async () => {
    const t = fileSetup()
    for (const request of [{ kind: 'save', text: '  \n' }, { kind: 'share', text: '' }, { kind: 'copy', format: 'rich', text: ' ' }]) expect(await t.ask(request)).toEqual({ ok: false, message: 'La note est vide.' })
    expect(t.done).toMatchObject({ saved: [], copied: [], shared: [], dialogs: 0 })
  })

  it('copy the note as Markdown, or as formatted text (HTML beside its plain text)', async () => {
    const t = fileSetup()
    expect(await t.ask({ kind: 'copy', format: 'markdown', text: '# T\n- **a**' })).toEqual({ ok: true, message: 'Note copiée en Markdown.' })
    expect(await t.ask({ kind: 'copy', format: 'rich', text: '# T\n- **a** <b>' })).toEqual({ ok: true, message: 'Note copiée en texte mis en forme.' })
    expect(t.done.copied).toEqual([
      ['# T\n- **a**', undefined],
      ['T\n• a <b>', '<h1>T</h1><ul><li><strong>a</strong> &lt;b&gt;</li></ul>']
    ])
    const busy = fileSetup({ copyFails: true })
    expect(await busy.ask({ kind: 'copy', format: 'markdown', text: 'x' })).toEqual({ ok: false, message: 'La note n’a pas pu être copiée.' })
  })

  it('share the note through the share sheet, as text and as a file named after its title; say so when it cannot', async () => {
    const t = fileSetup()
    expect(await t.ask({ kind: 'share', text: '# Courses\n- pain' })).toEqual({ ok: true })
    expect(t.done.shared).toEqual([['# Courses\n- pain', 'Courses.md']])
    const none = fileSetup({ shareFails: true })
    expect(await none.ask({ kind: 'share', text: 'x' })).toEqual({ ok: false, message: 'La note n’a pas pu être partagée (pas de fenêtre).' })
  })

  it('import a .md file as a new note tied to the link asked for, read here, at most the bytes a note can take', async () => {
    const t = fileSetup()
    const reply = await t.ask({ kind: 'import', link: { kind: 'space', spaceId: 's1' } })
    expect(t.done.read).toEqual([['/Users/moi/Documents/réunion.md', NOTE_FILE_MAX_BYTES]])
    expect(reply).toMatchObject({ ok: true, message: frenchSpaces('Note importée depuis « réunion.md ».'), id: 'n1' })
    expect(t.file.read()).toMatchObject([{ id: 'n1', text: '# Réunion\n- un', link: { kind: 'space', spaceId: 's1' } }])
  })

  it('import nothing when the dialog is given up', async () => {
    const t = fileSetup({ picked: null })
    expect(await t.ask({ kind: 'import', link: null })).toEqual({ ok: true })
    expect(t.done.read).toEqual([])
    expect(t.file.read()).toEqual([])
  })

  it('refuse a file that is not Markdown, too big, too long, empty, not text, or that cannot be read, saying which, and make no note', async () => {
    const cases: Array<[Parameters<typeof fileSetup>[0], string]> = [
      [{ picked: '/tmp/note.txt' }, 'Seul un fichier Markdown (.md) peut devenir une note.'],
      [{ more: true }, frenchSpaces('Ce fichier est trop gros pour une note (4000 caractères au plus) : rien n’a été importé.')],
      [{ read: new TextEncoder().encode('a'.repeat(NOTE_TEXT_MAX + 5)) }, frenchSpaces('Ce fichier fait 4005 caractères : une note en tient 4000 au plus. Rien n’a été importé.')],
      [{ read: new TextEncoder().encode('\n  \n') }, frenchSpaces('Ce fichier est vide : rien n’a été importé.')],
      [{ read: new Uint8Array([0x00, 0x01]) }, frenchSpaces('Ce fichier n’est pas du texte : rien n’a été importé.')],
      [{ read: new Error('EACCES') }, 'Le fichier n’a pas pu être lu (EACCES).']
    ]
    for (const [options, message] of cases) {
      const t = fileSetup(options)
      expect(await t.ask({ kind: 'import', link: null }), message).toEqual({ ok: false, message })
      expect(t.file.read()).toEqual([])
    }
  })

  it('import a dropped .md file the panel read, checked again here: its name, its length, its link', async () => {
    const t = fileSetup()
    expect(await t.ask({ kind: 'import-text', name: '../../secret/liste.md', text: '- [ ] pain\r\n', link: null })).toMatchObject({ ok: true, message: frenchSpaces('Note importée depuis « liste.md ».'), id: 'n1' })
    expect(t.file.read()).toMatchObject([{ id: 'n1', text: '- [ ] pain' }])
    expect(await t.ask({ kind: 'import-text', name: 'liste.txt', text: 'x', link: null })).toEqual({ ok: false, message: 'Seul un fichier Markdown (.md) peut devenir une note.' })
    expect(await t.ask({ kind: 'import-text', name: 'long.md', text: 'a'.repeat(NOTE_TEXT_MAX + 1), link: null })).toMatchObject({ ok: false, message: frenchSpaces('Ce fichier fait 4001 caractères : une note en tient 4000 au plus. Rien n’a été importé.') })
    // The link goes through the checks of a new note: a space that does not exist is refused.
    expect(await t.ask({ kind: 'import-text', name: 'a.md', text: 'x', link: { kind: 'space', spaceId: 'nope' } })).toMatchObject({ ok: false, message: 'Cet espace n’existe plus.' })
    expect(t.file.read()).toHaveLength(1)
  })

  it('open a mail link in the mail application, and nothing else', async () => {
    const t = fileSetup()
    expect(await t.ask({ kind: 'mail', url: 'mailto:loic@example.org' })).toEqual({ ok: true })
    for (const url of ['https://example.org/', 'tel:+33100000000', 'javascript:alert(1)', 'mailto://host/x', ' mailto:a@b.c']) expect(await t.ask({ kind: 'mail', url }), url).toEqual({ ok: false, message: 'Cette adresse mail ne peut pas être ouverte.' })
    expect(t.done.mailed).toEqual(['mailto:loic@example.org'])
  })
})
