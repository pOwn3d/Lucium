// IPC of the quick notes (File › Notes…, File › Nouvelle note, the command bar, the shortcuts): the panel's requests, and the command bar's; and a
// note's way out of the panel and in (`handleNoteFileRequest`: a .md file saved where the user says, the clipboard, the share sheet of the Mac, a .md
// file imported as a new note, a mail link opened in the mail application). Registered for each window with the window's own scoped IPC and guard (see
// registerFeatureIpc). Refused as a whole in a private window (nothing is read, nothing is written) and while the function is off (the file is not even
// opened). The request is checked field by field, and the main process checks again what the panel cannot be trusted with: the address of a page is
// normalised here, a space must exist, a note of a locked space is neither shown nor touched, a file to import is read here (bounded) and checked.

import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, shell, ShareMenu, type WebContents } from 'electron'
import { Channel } from '@shared/ipc'
import { externalLinkOf } from '@shared/external-links'
import { noteHtml } from '@shared/note-doc'
import { isMarkdownName, NOTE_FILE_EXTENSIONS, NOTE_FILE_MAX_BYTES, noteFileName, noteFileText, noteFromFile, noteFromText, notePlainCopy, parseNoteFileRequest, type NoteFileReply, type NoteImportProblem } from '@shared/note-files'
import { cleanNoteText, defaultNoteLink, NEW_NOTE_REQUEST, notePageAddress, notesContext, noteTextProblem, NOTE_TEXT_MAX, parseNotesRequest, sameNoteLink, type Note, type NoteLink, type NotesContext, type NotesReply } from '@shared/notes'
import { activeTab } from '@shared/sidebar'
import { hostOf } from '@shared/url'
import { t } from '@shared/i18n'
import type { StateStore } from '../store'
import { getLockService } from '../lock-service'
import { notesFile, type NotesFile } from '../notes-store'
import type { Browser } from './browser'
import type { ScopedIpc } from './ipc-scope'
import { settingsPath } from '@shared/settings-path'

export interface NotesDeps {
  /** A private window keeps nothing: every request is refused there. */
  isPrivate: () => boolean
  /** The switch of the function (`notes`): off, nothing is read. */
  enabled: () => boolean
  /** The file, asked for only once the request is allowed (null before it is configured). */
  file: () => NotesFile | null
  spaceExists: (id: string) => boolean
  /** The spaces locked now: their notes are hidden and refused, as their tabs are. */
  lockedSpaces: () => readonly string[]
  /** Opens the panel in the window (the command bar's route); `compose`: on a new note. */
  open: (compose: boolean) => void
  /** What is on screen in the window now: the page a note of the command bar is tied to, else the space. */
  context: () => NotesContext
  /** The name of a space, for the notice of a note tied to it. */
  spaceName: (id: string) => string | undefined
  /** The notice of the window (a toast): how the command bar's note went, since the bar has closed. */
  notify: (message: string) => void
}

const refused = (message: string): NotesReply => ({ ok: false, message, notes: [] })

/** What the notice says of a note the command bar made: where it was put. */
function jotNotice(link: NoteLink | null, deps: Pick<NotesDeps, 'spaceName'>): string {
  if (link?.kind === 'page') return t('notes.note-ajoutee-a-la-page', { host: hostOf(link.url) || link.url })
  const name = link?.kind === 'space' ? deps.spaceName(link.spaceId) : undefined
  return name !== undefined ? t('notes.note-ajoutee-a-l-espace', { name }) : t('notes.note-enregistree')
}

/** The checked link of a request, or the sentence of why it cannot be kept. `own` is the note's current link: keeping it as it is needs no check. */
function checkedLink(link: NoteLink | null, own: NoteLink | undefined, deps: NotesDeps): { ok: true; link: NoteLink | null } | { ok: false; message: string } {
  if (link === null) return { ok: true, link: null }
  if (link.kind === 'page') {
    const url = notePageAddress(link.url)
    return url === null ? { ok: false, message: t('notes.cette-adresse-ne-peut-pas-recevoir-de-note') } : { ok: true, link: { kind: 'page', url } }
  }
  if (deps.lockedSpaces().includes(link.spaceId)) return { ok: false, message: t('notes.cet-espace-est-verrouille') }
  // A note of a space that was deleted keeps its link when it is edited; a new link must name a space that exists.
  if (!sameNoteLink(link, own) && !deps.spaceExists(link.spaceId)) return { ok: false, message: t('notes.cet-espace-n-existe-plus') }
  return { ok: true, link }
}

function checkedText(raw: string): { ok: true; text: string } | { ok: false; message: string } {
  const problem = noteTextProblem(raw)
  if (problem === 'empty') return { ok: false, message: t('notes.la-note-est-vide') }
  if (problem === 'too-long') return { ok: false, message: t('notes.la-note-est-trop-longue', { max: NOTE_TEXT_MAX }) }
  return { ok: true, text: cleanNoteText(raw) }
}

/** The answer to one request of the panel. Pure but for the file it is handed. */
export function handleNotesRequest(raw: unknown, deps: NotesDeps): NotesReply {
  // The order matters: a private window and a switched-off function never reach the file.
  if (deps.isPrivate()) return refused(t('notes.pas-de-notes-dans-une-fenetre-privee'))
  if (!deps.enabled()) return refused(t('notes.les-notes-sont-desactivees', { settingsPath: settingsPath('notes') }))
  const request = parseNotesRequest(raw)
  if (!request) return refused(t('feature.demande-invalide'))
  if (request.kind === 'open') {
    deps.open(request.compose === true)
    return { ok: true, notes: [] }
  }
  const file = deps.file()
  if (!file) return refused(t('notes.les-notes-ne-sont-pas-disponibles'))
  const locked = new Set(deps.lockedSpaces())
  const hiddenByLock = (note: Note): boolean => note.link?.kind === 'space' && locked.has(note.link.spaceId)
  const visible = (notes: readonly Note[]): Note[] => notes.filter((note) => !hiddenByLock(note))
  const reply = (outcome: { ok: boolean; notes: Note[]; message?: string; id?: string }): NotesReply => ({
    ok: outcome.ok,
    ...(outcome.message ? { message: outcome.message } : {}),
    notes: visible(outcome.notes),
    ...(outcome.id ? { id: outcome.id } : {})
  })

  if (request.kind === 'list') return reply({ ok: true, notes: file.read() })
  if (request.kind === 'create' || request.kind === 'jot') {
    // The command bar names no link: the note goes to the page on screen (a web page of a tab that is not private), else to the space, as a new
    // note of the panel does. The bar has closed by then, so a notice says what became of it, done or refused.
    const jot = request.kind === 'jot'
    const answer = (outcome: NotesReply, kept: NoteLink | null): NotesReply => {
      if (jot) deps.notify(outcome.ok ? jotNotice(kept, deps) : (outcome.message ?? t('notes.la-demande-a-echoue')))
      return outcome
    }
    const text = checkedText(request.text)
    if (!text.ok) return answer(reply({ ok: false, message: text.message, notes: file.read() }), null)
    const link = checkedLink(jot ? defaultNoteLink(deps.context()) : request.link, undefined, deps)
    if (!link.ok) return answer(reply({ ok: false, message: link.message, notes: file.read() }), null)
    return answer(reply(file.create(text.text, link.link)), link.link)
  }
  // A note the lock hides is, for the interface, a note that does not exist.
  const notes = file.read()
  const target = notes.find((note) => note.id === request.id)
  if (!target || hiddenByLock(target)) return reply({ ok: false, message: t('notes.cette-note-n-existe-plus'), notes })
  if (request.kind === 'remove') return reply(file.remove(request.id))
  const text = checkedText(request.text)
  if (!text.ok) return reply({ ok: false, message: text.message, notes })
  const link = checkedLink(request.link, target.link, deps)
  if (!link.ok) return reply({ ok: false, message: link.message, notes })
  return reply(file.update(request.id, text.text, link.link))
}

// ---------- a note out of the panel, and into it ----------

/** What the requests of the files need of Electron and the disk: a seam for the tests, which answer without a dialog. */
export interface NoteFileDeps {
  /** The rules of the notes (private window, switch, creation of the imported note). */
  notes: NotesDeps
  /** The save dialog, on `name`; null when the user gave up. */
  chooseSave: (name: string) => Promise<string | null>
  /** The open dialog for a .md file; null when the user gave up. */
  chooseOpen: () => Promise<string | null>
  writeFile: (path: string, text: string) => Promise<void>
  /** At most `max` bytes of a file, and whether it held more. */
  readFile: (path: string, max: number) => Promise<{ bytes: Uint8Array; more: boolean }>
  /** The clipboard: plain text, and HTML beside it when given. */
  copy: (text: string, html?: string) => Promise<void>
  /** The share sheet of the Mac, with the note as text and as a file named `name`. */
  share: (text: string, name: string) => Promise<void>
  /** A mail link, to the mail application. */
  openMail: (url: string) => void
}

const fileRefused = (message: string): NoteFileReply => ({ ok: false, message })

/** The sentence of a file that cannot become a note. */
function importMessage(problem: NoteImportProblem, length?: number): string {
  switch (problem) {
    case 'not-markdown':
      return t('notes.import-pas-markdown')
    case 'too-big':
      return t('notes.import-trop-gros', { max: NOTE_TEXT_MAX })
    case 'too-long':
      return t('notes.import-trop-long', { length: length ?? 0, max: NOTE_TEXT_MAX })
    case 'empty':
      return t('notes.import-vide')
    case 'not-text':
      return t('notes.import-pas-texte')
  }
}

const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The answer to one request of the files of a note. As the notes themselves: refused in a private window and while the function is off, before any
 * dialog, the clipboard or the disk; an imported note is made by the same request as one written in the panel (`create`), with the same checks.
 */
export async function handleNoteFileRequest(raw: unknown, deps: NoteFileDeps): Promise<NoteFileReply> {
  if (deps.notes.isPrivate()) return fileRefused(t('notes.pas-de-notes-dans-une-fenetre-privee'))
  if (!deps.notes.enabled()) return fileRefused(t('notes.les-notes-sont-desactivees', { settingsPath: settingsPath('notes') }))
  const request = parseNoteFileRequest(raw)
  if (!request) return fileRefused(t('feature.demande-invalide'))
  if (request.kind === 'mail') {
    const url = externalLinkOf(request.url)
    if (url === null || !url.startsWith('mailto:')) return fileRefused(t('notes.adresse-mail-invalide'))
    deps.openMail(url)
    return { ok: true }
  }
  if (request.kind === 'import' || request.kind === 'import-text') {
    let name: string
    let made: ReturnType<typeof noteFromText>
    if (request.kind === 'import') {
      const path = await deps.chooseOpen()
      if (path === null) return { ok: true }
      name = basename(path)
      try {
        const read = await deps.readFile(path, NOTE_FILE_MAX_BYTES)
        made = read.more ? { ok: false, problem: 'too-big' } : noteFromFile(name, read.bytes)
      } catch (error) {
        console.error('[notes] cannot read the file to import:', detail(error))
        return fileRefused(t('notes.lecture-impossible', { detail: detail(error) }))
      }
    } else {
      name = basename(request.name)
      made = isMarkdownName(name) ? noteFromText(request.text) : { ok: false, problem: 'not-markdown' }
    }
    if (!made.ok) return fileRefused(importMessage(made.problem, made.length))
    const reply = handleNotesRequest({ kind: 'create', text: made.text, link: request.link }, deps.notes)
    if (!reply.ok) return { ok: false, ...(reply.message ? { message: reply.message } : {}), notes: reply.notes }
    return { ok: true, message: t('notes.note-importee', { name }), notes: reply.notes, ...(reply.id ? { id: reply.id } : {}) }
  }
  const text = cleanNoteText(request.text)
  if (text === '') return fileRefused(t('notes.la-note-est-vide'))
  if (request.kind === 'copy') {
    try {
      if (request.format === 'markdown') await deps.copy(text)
      else await deps.copy(notePlainCopy(text), noteHtml(text))
    } catch (error) {
      console.error('[notes] cannot write to the clipboard:', detail(error))
      return fileRefused(t('notes.copie-impossible'))
    }
    return { ok: true, message: request.format === 'markdown' ? t('notes.copiee-en-markdown') : t('notes.copiee-mise-en-forme') }
  }
  const name = noteFileName(text)
  if (request.kind === 'share') {
    try {
      await deps.share(text, name)
    } catch (error) {
      console.error('[notes] cannot share the note:', detail(error))
      return fileRefused(t('notes.partage-impossible', { detail: detail(error) }))
    }
    return { ok: true }
  }
  const path = await deps.chooseSave(name)
  if (path === null) return { ok: true }
  try {
    await deps.writeFile(path, noteFileText(text))
  } catch (error) {
    console.error('[notes] cannot save the note:', detail(error))
    return fileRefused(t('notes.fichier-impossible', { detail: detail(error) }))
  }
  return { ok: true, message: t('notes.note-telechargee', { name: basename(path) }) }
}

/** The folder the file of the last shared note is in: one at a time, removed by the next share and when the application quits. */
let sharedDir: string | null = null
let cleanupHooked = false

async function removeShared(): Promise<void> {
  const dir = sharedDir
  sharedDir = null
  if (dir !== null) await rm(dir, { recursive: true, force: true }).catch((error: unknown) => console.error('[notes] cannot remove the shared note:', detail(error)))
}

/** The share sheet of the Mac on a note: its Markdown as text, and as a .md file (for the services of the sheet that take files: Mail, AirDrop). */
async function shareNote(win: BrowserWindow, text: string, name: string): Promise<void> {
  await removeShared()
  if (!cleanupHooked) {
    cleanupHooked = true
    app.once('will-quit', () => void removeShared())
  }
  const dir = await mkdtemp(join(tmpdir(), 'lucium-note-'))
  sharedDir = dir
  const path = join(dir, name)
  await writeFile(path, noteFileText(text), { encoding: 'utf8', mode: 0o600 })
  new ShareMenu({ texts: [text], filePaths: [path] }).popup({ window: win })
}

/** At most `max` bytes of a file, without reading the rest. */
async function readBounded(path: string, max: number): Promise<{ bytes: Uint8Array; more: boolean }> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(max + 1)
    const { bytesRead } = await file.read(buffer, 0, max + 1, 0)
    return { bytes: new Uint8Array(buffer.subarray(0, Math.min(bytesRead, max))), more: bytesRead > max }
  } finally {
    await file.close()
  }
}

export function registerNotesIpc(ipcMain: ScopedIpc, guard: (sender: WebContents, channel: string) => boolean, browser: Browser, store: StateStore): void {
  const deps: NotesDeps = {
    isPrivate: () => browser.isPrivate(),
    enabled: () => store.get().settings.notes,
    file: notesFile,
    spaceExists: (id) => store.get().spaces.some((space) => space.id === id),
    lockedSpaces: () => getLockService()?.lockedSpaces() ?? [],
    open: (compose) => browser.openOverlay(compose ? NEW_NOTE_REQUEST : { panel: 'notes' }),
    context: () => {
      const state = store.get()
      return notesContext(state.activeSpaceId, activeTab(state))
    },
    spaceName: (id) => store.get().spaces.find((space) => space.id === id)?.name,
    notify: (message) => browser.showToast(message)
  }
  ipcMain.handle(Channel.notes, (e, raw: unknown): NotesReply => (guard(e.sender, Channel.notes) ? handleNotesRequest(raw, deps) : refused(t('feature.demande-refusee'))))
  ipcMain.handle(Channel.noteFiles, async (e, raw: unknown): Promise<NoteFileReply> => {
    if (!guard(e.sender, Channel.noteFiles)) return fileRefused(t('feature.demande-refusee'))
    const owner = BrowserWindow.fromWebContents(e.sender)
    return handleNoteFileRequest(raw, {
      notes: deps,
      chooseSave: async (name) => {
        const options = { title: t('notes.telecharger-la-note'), defaultPath: join(app.getPath('downloads'), name), filters: [{ name: 'Markdown', extensions: ['md'] }] }
        const saved = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
        return saved.canceled || !saved.filePath ? null : saved.filePath
      },
      chooseOpen: async () => {
        const options = { title: t('notes.importer-un-fichier-md'), properties: ['openFile' as const], filters: [{ name: 'Markdown', extensions: [...NOTE_FILE_EXTENSIONS] }] }
        const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
        return picked.canceled ? null : (picked.filePaths[0] ?? null)
      },
      writeFile: (path, text) => writeFile(path, text, 'utf8'),
      readFile: readBounded,
      copy: (text, html) => clipboard.write([new ClipboardItem(html === undefined ? { 'text/plain': text } : { 'text/plain': text, 'text/html': html })]),
      share: async (text, name) => {
        if (!owner) throw new Error('no window')
        await shareNote(owner, text, name)
      },
      openMail: (url) => void shell.openExternal(url).catch((error: unknown) => console.error('[notes] cannot open the mail link:', detail(error)))
    })
  })
}
