// A note out of the panel and into it: downloaded as a .md file, copied (as Markdown, or as formatted text), shared through the share sheet of the
// Mac, and a .md file imported as a new note (from a dialog, or dropped on the panel). Pure rules: the requests the panel may send, the name a file
// is offered under, what a file must be to become a note. The dialogs, the clipboard and the share sheet are the main process's (notes-ipc.ts).

import { exportFileName } from './markdown-export'
import { NOTE_TEXT_MAX, cleanNoteText, type NoteLink, type NotesReply } from './notes'
import { notePlainText, parseNote, plainLine } from './note-markdown'
import { isRecord } from './record'

/** The extensions of a Markdown file a note is imported from. */
export const NOTE_FILE_EXTENSIONS = ['md', 'markdown'] as const

/**
 * The most bytes a file is read for: a note at its largest, every character of it four bytes of UTF-8, and a byte-order mark. A larger file is
 * refused unread.
 */
export const NOTE_FILE_MAX_BYTES = NOTE_TEXT_MAX * 4 + 3

const FALLBACK = 'note'

/** The first line of a note that says something, without its marks and whatever its length (a block of code's fences aside). */
function firstLine(text: string): string {
  for (const line of parseNote(text)) {
    if (line.kind === 'fence') continue
    const plain = line.kind === 'code' ? line.pieces.map((piece) => piece.text).join('') : plainLine(line)
    if (plain.trim() !== '') return plain.trim()
  }
  return ''
}

/**
 * The name a note is offered under in the save dialog and the share sheet: its title (the first line that says something) as a file name, without
 * what a disk or a screen reads otherwise (a path, a control or reordering character, a dot at the start), cut at 100 characters, then `.md`.
 */
export function noteFileName(text: string): string {
  const title = firstLine(text)
  const name = title === '' ? '' : exportFileName(title, 'md')
  return name === '' || name === 'page.md' ? `${FALLBACK}.md` : name
}

/** What is wrong with a file to import, or null. */
export type NoteImportProblem = 'not-markdown' | 'too-big' | 'too-long' | 'empty' | 'not-text'

/** Whether a file name is one of a Markdown file. */
export const isMarkdownName = (name: string): boolean => {
  const dot = name.lastIndexOf('.')
  return dot > 0 && (NOTE_FILE_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase())
}

/**
 * The text of a note made from a file, or why there is none. The name must be a Markdown file's; the bytes at most NOTE_FILE_MAX_BYTES, of UTF-8 text
 * (no NUL); once its lines are read (CR LF as LF, the control characters out, the byte-order mark and the blanks around it gone) it must hold
 * something and at most NOTE_TEXT_MAX characters.
 */
export function noteFromFile(name: string, bytes: Uint8Array): { ok: true; text: string } | { ok: false; problem: NoteImportProblem; length?: number } {
  if (!isMarkdownName(name)) return { ok: false, problem: 'not-markdown' }
  if (bytes.length > NOTE_FILE_MAX_BYTES) return { ok: false, problem: 'too-big' }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, problem: 'not-text' }
  }
  return noteFromText(decoded)
}

/** The text of a note made from the text of a file (a file dropped on the panel is read there), or why there is none. */
export function noteFromText(raw: string): { ok: true; text: string } | { ok: false; problem: NoteImportProblem; length?: number } {
  if (raw.includes('\u0000')) return { ok: false, problem: 'not-text' }
  const text = cleanNoteText(raw.replace(/^﻿/, ''))
  if (text === '') return { ok: false, problem: 'empty' }
  if (text.length > NOTE_TEXT_MAX) return { ok: false, problem: 'too-long', length: text.length }
  return { ok: true, text }
}

/** The text a file holds once downloaded: the note as it is, and the line feed a text file ends with. */
export const noteFileText = (text: string): string => `${text}\n`

/** The plain text of a note for "Copier le texte mis en forme" (what an application that takes no HTML pastes). */
export const notePlainCopy = (text: string): string => notePlainText(text)

// ---------- the requests of the panel ----------

export type NoteFileRequest =
  /** "Télécharger en .md": the save dialog, the file named after the note's title. */
  | { kind: 'save'; text: string }
  /** "Partager…": the share sheet of the Mac, with the note as text and as a .md file. */
  | { kind: 'share'; text: string }
  /** "Copier en Markdown" or "Copier le texte mis en forme" (HTML and plain text). */
  | { kind: 'copy'; format: 'markdown' | 'rich'; text: string }
  /** "Importer un fichier .md…": the open dialog, then a new note tied to `link`. */
  | { kind: 'import'; link: NoteLink | null }
  /** A .md file dropped on the panel, read there: a new note tied to `link`. */
  | { kind: 'import-text'; name: string; text: string; link: NoteLink | null }
  /** ⌘-click on a mail link of a note: the mail application opens on it. */
  | { kind: 'mail'; url: string }

export interface NoteFileReply {
  ok: boolean
  /** The sentence the panel shows: what was done, or what went wrong. */
  message?: string
  /** After an import: the notes as the file holds them now, and the new note. */
  notes?: NotesReply['notes']
  id?: string
}

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => key in value)
/** A text as a request may carry it: bounded before it is cleaned, so that the panel cannot send a book. */
const requestText = (value: unknown): value is string => typeof value === 'string' && value.length <= NOTE_TEXT_MAX * 2
/** A link as a request names it; checked again by the main process (it is the one notes-ipc checks for a new note). */
const requestLink = (value: unknown): value is NoteLink | null => value === null || (isRecord(value) && (value['kind'] === 'space' || value['kind'] === 'page'))

/** The request the panel sent, exactly one of these, or null. */
export function parseNoteFileRequest(raw: unknown): NoteFileRequest | null {
  if (!isRecord(raw)) return null
  switch (raw['kind']) {
    case 'save':
    case 'share':
      return exactKeys(raw, ['kind', 'text']) && requestText(raw['text']) ? { kind: raw['kind'], text: raw['text'] } : null
    case 'copy':
      return exactKeys(raw, ['kind', 'format', 'text']) && (raw['format'] === 'markdown' || raw['format'] === 'rich') && requestText(raw['text']) ? { kind: 'copy', format: raw['format'], text: raw['text'] } : null
    case 'import':
      return exactKeys(raw, ['kind', 'link']) && requestLink(raw['link']) ? { kind: 'import', link: raw['link'] } : null
    case 'import-text':
      return exactKeys(raw, ['kind', 'name', 'text', 'link']) && typeof raw['name'] === 'string' && raw['name'].length <= 1024 && requestText(raw['text']) && requestLink(raw['link'])
        ? { kind: 'import-text', name: raw['name'], text: raw['text'], link: raw['link'] }
        : null
    case 'mail':
      return exactKeys(raw, ['kind', 'url']) && typeof raw['url'] === 'string' && raw['url'].length <= 2048 ? { kind: 'mail', url: raw['url'] } : null
    default:
      return null
  }
}
