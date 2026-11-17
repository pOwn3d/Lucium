// Quick notes: short texts kept on this Mac only, in a file of their own (notes.json in the data folder, see
// main/notes-store.ts), each tied to nothing, to a space or to a page. No account, no sync, no telemetry, no assistant. Pure rules: what a note may
// hold, the address a page is known by, the order the panel shows them in, the requests the interface may send. Never in a private window.

import { stripTrackingParams } from './privacy'
import { isRecord } from './record'
import { foldMarks } from './fold'
import { notePlainText, parseNoteLine, plainLine } from './note-markdown'
import type { OverlayRequest } from './ipc'
import type { Settings } from './model'

export const NOTES_FILE_VERSION = 1
/** The longest text of a note, in characters: a short note, not a document. */
export const NOTE_TEXT_MAX = 4000
/** How many notes the file keeps. */
export const NOTES_MAX = 1000
/** The longest address a note can be tied to. */
export const NOTE_URL_MAX = 2048
/**
 * The most the file is read for: every note at its largest (a UTF-16 unit is at most 3 bytes of UTF-8 once in JSON, control characters are never kept),
 * and some room for the structure. More is a damaged or hostile file, set aside unread.
 */
export const NOTES_FILE_MAX_BYTES = NOTES_MAX * (NOTE_TEXT_MAX * 3 + NOTE_URL_MAX * 3 + 400) + 10_000

const ID = /^[A-Za-z0-9_-]{1,64}$/
/** A space id as the sidebar makes them (a word or a uuid), and nothing a record would inherit. */
const SPACE_ID = /^[^\s\p{Cc}]{1,128}$/u
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype'])
/** Control characters other than the tab and the line feed: a note keeps its lines. */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g

export type NoteLink = { kind: 'space'; spaceId: string } | { kind: 'page'; url: string }

export interface Note {
  id: string
  /** Markdown, kept as it was typed: the editor draws it as it is written (note-markdown.ts), never as HTML; an old note in plain text is the same text. */
  text: string
  createdAt: number
  updatedAt: number
  /** Absent: a note of its own, shown under "Toutes les notes". */
  link?: NoteLink
}

export const isNoteId = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
export const isSpaceId = (value: unknown): value is string => typeof value === 'string' && SPACE_ID.test(value) && !FORBIDDEN_IDS.has(value)

/**
 * The address a page is known by for its notes: a web page (http, https) without its fragment, its credentials and its tracking parameters (the fixed
 * list of privacy.ts). The other parameters keep their order and their spelling: they pick the page. Null for anything else, or too long.
 */
export function notePageAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > NOTE_URL_MAX * 2 || !URL.canParse(raw)) return null
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  parsed.hash = ''
  parsed.username = ''
  parsed.password = ''
  const stripped = new URL(stripTrackingParams(parsed.href) ?? parsed.href)
  // "https://site/?" is the page without parameters: setting an empty query again drops the lone "?".
  if (stripped.search === '') stripped.search = ''
  return stripped.href.length <= NOTE_URL_MAX ? stripped.href : null
}

export type NoteTextProblem = 'empty' | 'too-long'

/** The text of a note as it is kept: its lines (CR LF read as LF), no other control character, no blank around it. */
export function cleanNoteText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim()
}

/** What is wrong with a text for a note, or null. */
export function noteTextProblem(raw: string): NoteTextProblem | null {
  const text = cleanNoteText(raw)
  if (text === '') return 'empty'
  return text.length > NOTE_TEXT_MAX ? 'too-long' : null
}

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key))
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** A link as a request or the file writes it, or null when it is not one (a page link is normalised again here). */
export function cleanNoteLink(raw: unknown): NoteLink | null {
  if (!isRecord(raw)) return null
  if (raw['kind'] === 'space' && exactKeys(raw, ['kind', 'spaceId']) && isSpaceId(raw['spaceId'])) return { kind: 'space', spaceId: raw['spaceId'] }
  if (raw['kind'] === 'page' && exactKeys(raw, ['kind', 'url'])) {
    const url = notePageAddress(raw['url'])
    return url ? { kind: 'page', url } : null
  }
  return null
}

export const sameNoteLink = (a: NoteLink | null | undefined, b: NoteLink | null | undefined): boolean => noteLinkKey(a) === noteLinkKey(b)

/** One word for a link (`page:<url>`, `space:<id>`, `none`): what the editor's choices are told apart by. */
export function noteLinkKey(link: NoteLink | null | undefined): string {
  if (!link) return 'none'
  return link.kind === 'page' ? `page:${link.url}` : `space:${link.spaceId}`
}

/** The file was written by a more recent version: not damaged, only not readable here. The store keeps it aside, untouched. */
export class NewerNotesFileError extends Error {
  constructor(readonly version: number) {
    super(`notes file version ${version} is newer than the ${NOTES_FILE_VERSION} this application reads`)
  }
}

/**
 * The notes of the text of a file. Throws when it is not a notes file at all (the store sets it aside); a note that is not one, a second note of the
 * same id, or one beyond NOTES_MAX is left out and counted (the store keeps a copy of the file first).
 */
export function parseNotesFile(text: string): { notes: Note[]; dropped: number } {
  const raw: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (!isRecord(raw) || !Array.isArray(raw['notes'])) throw new Error('not a notes file')
  const version = raw['version']
  if (typeof version === 'number' && Number.isInteger(version) && version > NOTES_FILE_VERSION) throw new NewerNotesFileError(version)
  if (version !== NOTES_FILE_VERSION) throw new Error(`unknown notes file version ${String(version).slice(0, 20)}`)
  return cleanStoredNotes(raw['notes'] as unknown[])
}

/**
 * The notes of a list read from a file (notes.json, or the `notes` of an export that Restaurer les données puts back): a note that is not one, a second
 * note of the same id, or one beyond NOTES_MAX is left out and counted.
 */
export function cleanStoredNotes(entries: readonly unknown[]): { notes: Note[]; dropped: number } {
  const notes: Note[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of entries) {
    const note = cleanStoredNote(entry)
    if (!note || seen.has(note.id) || notes.length >= NOTES_MAX) {
      dropped++
      continue
    }
    seen.add(note.id)
    notes.push(note)
  }
  return { notes, dropped }
}

function cleanStoredNote(entry: unknown): Note | null {
  if (!isRecord(entry) || !exactKeys(entry, ['id', 'text', 'createdAt', 'updatedAt', 'link'])) return null
  const { id, text, createdAt, updatedAt } = entry
  if (!isNoteId(id) || typeof text !== 'string' || noteTextProblem(text) !== null || !isTime(createdAt) || !isTime(updatedAt)) return null
  const link = entry['link'] === undefined ? undefined : cleanNoteLink(entry['link'])
  if (link === null) return null
  // A note is never modified before it was made: a clock that went back counts as the moment it was made.
  return { id, text: cleanNoteText(text), createdAt, updatedAt: Math.max(createdAt, updatedAt), ...(link ? { link } : {}) }
}

/** The text of the file for these notes. */
export const notesFileText = (notes: readonly Note[]): string => `${JSON.stringify({ version: NOTES_FILE_VERSION, notes })}\n`

// ---------- the requests of the panel ----------

export type NotesRequest =
  | { kind: 'list' }
  /** The command bar asks the main process to open the panel (the bar is replaced by it); `compose` opens it on a new note ("Nouvelle note"). */
  | { kind: 'open'; compose?: true }
  /** The command bar's "note <text>": the note is made at once, tied to what is on screen as the main process reads it, and a notice says so. */
  | { kind: 'jot'; text: string }
  | { kind: 'create'; text: string; link: NoteLink | null }
  | { kind: 'update'; id: string; text: string; link: NoteLink | null }
  | { kind: 'remove'; id: string }

export interface NotesReply {
  ok: boolean
  /** The sentence the panel shows: what went wrong, or nothing. */
  message?: string
  /** Every note the window may see, as the file holds them now. Empty when refused. */
  notes: Note[]
  /** The note a creation made. */
  id?: string
}

/** A text as a request may carry it: bounded before it is cleaned, so that a field cannot send a book. */
const requestText = (value: unknown): value is string => typeof value === 'string' && value.length <= NOTE_TEXT_MAX * 2

/** The link of a request: absent or null is none; a link that is not one makes the request invalid (undefined). The page address is checked by the handler. */
function requestLink(value: unknown): NoteLink | null | undefined {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) return undefined
  if (value['kind'] === 'space' && exactKeys(value, ['kind', 'spaceId']) && isSpaceId(value['spaceId'])) return { kind: 'space', spaceId: value['spaceId'] }
  if (value['kind'] === 'page' && exactKeys(value, ['kind', 'url']) && typeof value['url'] === 'string' && value['url'].length <= NOTE_URL_MAX * 2) return { kind: 'page', url: value['url'] }
  return undefined
}

/** The request the interface sent, exactly one of the six, or null. */
export function parseNotesRequest(raw: unknown): NotesRequest | null {
  if (!isRecord(raw)) return null
  switch (raw['kind']) {
    case 'list':
      return exactKeys(raw, ['kind']) ? { kind: 'list' } : null
    case 'open':
      if (!exactKeys(raw, ['kind', 'compose'])) return null
      if (raw['compose'] === undefined) return { kind: 'open' }
      return raw['compose'] === true ? { kind: 'open', compose: true } : null
    case 'jot':
      return exactKeys(raw, ['kind', 'text']) && requestText(raw['text']) ? { kind: 'jot', text: raw['text'] } : null
    case 'create': {
      if (!exactKeys(raw, ['kind', 'text', 'link']) || !requestText(raw['text'])) return null
      const link = requestLink(raw['link'])
      return link === undefined ? null : { kind: 'create', text: raw['text'], link }
    }
    case 'update': {
      if (!exactKeys(raw, ['kind', 'id', 'text', 'link']) || !isNoteId(raw['id']) || !requestText(raw['text'])) return null
      const link = requestLink(raw['link'])
      return link === undefined ? null : { kind: 'update', id: raw['id'], text: raw['text'], link }
    }
    case 'remove':
      return exactKeys(raw, ['kind', 'id']) && isNoteId(raw['id']) ? { kind: 'remove', id: raw['id'] } : null
    default:
      return null
  }
}

// ---------- what the panel shows ----------

/** Where the panel is opened: the page on screen (its note address, null when it is not a web page or is a private tab) and the space on screen. */
export interface NotesContext {
  pageUrl: string | null
  spaceId: string | null
}

/** The context of a window: the space on screen, and its tab when that is a web page of a tab that is not private. */
export function notesContext(spaceId: string | null, tab: { url: string; private?: boolean } | undefined): NotesContext {
  return { spaceId, pageUrl: tab && tab.private !== true ? notePageAddress(tab.url) : null }
}

export interface NotesSections {
  /** The notes of the page on screen. */
  page: Note[]
  /** The notes of the space on screen. */
  space: Note[]
  /** Every other note: of no place, of another page, of another space. */
  others: Note[]
}

const foldText = foldMarks

/** Whether a note answers a search: every word of it is in the text or the address (accents and case ignored). */
export function noteMatches(note: Note, query: string): boolean {
  const words = foldText(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = foldText(`${note.text}\n${note.link?.kind === 'page' ? note.link.url : ''}`)
  return words.every((word) => haystack.includes(word))
}

/** The most recently changed first; then the most recently made; then by id, so that the order never depends on the file's. */
const byRecent = (a: Note, b: Note): number => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The group of the panel a note goes in: the page on screen, the space on screen, or the others (no place, another page, another space). */
function sectionOf(note: Note, context: NotesContext): keyof NotesSections {
  const link = note.link
  if (link?.kind === 'page' && context.pageUrl !== null && link.url === context.pageUrl) return 'page'
  if (link?.kind === 'space' && context.spaceId !== null && link.spaceId === context.spaceId) return 'space'
  return 'others'
}

/**
 * What the list of the panel shows, chosen under its header: the notes of the page on screen, those of the space on screen, or every note the window
 * is given (the main process never gives a window the notes of a locked space, and gives a private window none).
 */
export type NotesScope = 'page' | 'space' | 'all'

/** The choices of what the list shows, in their order: the page and the space only when one is on screen (a private tab, a page that is not a web page, has no notes). */
export function notesScopes(context: NotesContext): NotesScope[] {
  const scopes: NotesScope[] = []
  if (context.pageUrl !== null) scopes.push('page')
  if (context.spaceId !== null) scopes.push('space')
  return [...scopes, 'all']
}

/** What the panel opens on: the page on screen when it has notes, else every note, rather than an empty list while there are notes elsewhere. */
export function defaultNotesScope(notes: readonly Note[], context: NotesContext): NotesScope {
  return notes.some((note) => sectionOf(note, context) === 'page') ? 'page' : 'all'
}

/** What the panel opens on: « Toutes » when the request forces it (the toolbar's « Toutes les notes »), else the choice of `defaultNotesScope`. */
export const openingNotesScope = (notes: readonly Note[], context: NotesContext, requested?: 'all'): NotesScope => (requested === 'all' ? 'all' : defaultNotesScope(notes, context))

/** A choice as it can be shown now: one that no longer applies (the tab left its web page for a page that cannot have notes) shows every note. */
export const usableNotesScope = (scope: NotesScope, context: NotesContext): NotesScope => (notesScopes(context).includes(scope) ? scope : 'all')

/** How many notes a choice holds, the search aside: the count of the panel's header. `hidden` are the notes being deleted. */
export function notesInScope(notes: readonly Note[], context: NotesContext, scope: NotesScope, hidden: ReadonlySet<string> = new Set()): number {
  return notes.filter((note) => !hidden.has(note.id) && (scope === 'all' || sectionOf(note, context) === scope)).length
}

/**
 * The notes in the order the panel shows them: those of the page on screen, then those of the space on screen, then all the others, each group the most
 * recently changed first. `hidden` are the notes being deleted (they come back if the deletion is taken back); `query` keeps the ones that answer it;
 * `scope` keeps only the group of the page or of the space (every group with `all`).
 */
export function notesSections(notes: readonly Note[], context: NotesContext, query = '', hidden: ReadonlySet<string> = new Set(), scope: NotesScope = 'all'): NotesSections {
  const sections: NotesSections = { page: [], space: [], others: [] }
  for (const note of notes) {
    if (hidden.has(note.id) || !noteMatches(note, query)) continue
    const section = sectionOf(note, context)
    if (scope !== 'all' && section !== scope) continue
    sections[section].push(note)
  }
  sections.page.sort(byRecent)
  sections.space.sort(byRecent)
  sections.others.sort(byRecent)
  return sections
}

/** The links the editor offers, without doubles: the note's own (kept as it is), the page on screen, the space on screen, then none. */
export function noteLinkChoices(own: NoteLink | null | undefined, context: NotesContext): Array<NoteLink | null> {
  const choices: Array<NoteLink | null> = [
    ...(own ? [own] : []),
    ...(context.pageUrl !== null ? [{ kind: 'page', url: context.pageUrl } as const] : []),
    ...(context.spaceId !== null ? [{ kind: 'space', spaceId: context.spaceId } as const] : []),
    null
  ]
  const seen = new Set<string>()
  return choices.filter((choice) => {
    const key = noteLinkKey(choice)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The link a new note starts with: the page on screen when there is one, else the space on screen. */
export function defaultNoteLink(context: NotesContext): NoteLink | null {
  if (context.pageUrl !== null) return { kind: 'page', url: context.pageUrl }
  return context.spaceId !== null ? { kind: 'space', spaceId: context.spaceId } : null
}

/**
 * What File › Nouvelle note, its shortcut (⌥⌘E), the command bar's "Nouvelle note" and the panel's own button ask for, all the same: the panel opened on
 * a new note tied to the page on screen. One value, so that none of them can drift from the others.
 */
export const NEW_NOTE_REQUEST = { panel: 'notes', compose: true } as const satisfies OverlayRequest

/**
 * What the toolbar's button « Toutes les notes » asks for: the panel on the list of the notes, on « Toutes » (`scope`) whether or not the page on screen has
 * notes. File › Notes (⇧⌘E) asks for the panel without `scope`: it opens on the page's notes when there are some, and closes the panel when it is on screen.
 */
export const NOTES_LIST_REQUEST = { panel: 'notes', scope: 'all' } as const satisfies OverlayRequest

/**
 * Whether the toolbar shows its button « Toutes les notes »: with the function on and its own setting on,
 * never in a private window (nor a guest one, which is private underneath), where the notes are refused anyway.
 */
export function showsNotesListButton(settings: Pick<Settings, 'notes' | 'notesListButton'>, privateWindow: boolean): boolean {
  return settings.notes && settings.notesListButton && !privateWindow
}

/**
 * Whether giving up the note being written (Escape, Annuler) closes the whole panel: only the note "Nouvelle note" opened the panel on (`quick`), while
 * it is still new and holds nothing. An empty note is never sent, so nothing is kept; a note with text is given up as in the panel, which stays open.
 */
export function givingUpClosesPanel(draft: { id: string | null; text: string } | null, quick: boolean): boolean {
  return quick && draft !== null && draft.id === null && cleanNoteText(draft.text) === ''
}

/**
 * Whether giving up the note being written loses words: it holds a text, and that text is not the one already saved (`saved`: the text of the
 * note in the list, undefined for a new note). Such a note is kept a few seconds to be taken back, as a deleted note is.
 */
export function givingUpLosesText(draft: { text: string } | null, saved: string | undefined): boolean {
  if (draft === null) return false
  const text = cleanNoteText(draft.text)
  return text !== '' && text !== cleanNoteText(saved ?? '')
}

const TITLE_MAX = 80

/**
 * The line that names a note in the list: its first line that says something, without the marks of Markdown (a title's #, a list's sign or number, a
 * box, **, *, `, the address of a link), cut at 80 characters.
 */
export function noteTitle(text: string): string {
  const plain = text
    .split('\n')
    .map((line) => plainLine(parseNoteLine(line.trim())))
    .find((line) => line !== '') ?? ''
  return plain.length > TITLE_MAX ? `${plain.slice(0, TITLE_MAX - 1)}…` : plain
}

/** The plain text of a note, for the row of the list (its tooltip): its lines, without the marks of Markdown, cut at `max` characters. */
export function notePreview(text: string, max = 300): string {
  const plain = notePlainText(text)
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}
