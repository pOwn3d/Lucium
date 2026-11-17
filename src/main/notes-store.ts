// The file of the quick notes: `notes.json` in the data folder, next to state.json but never part of it (the reducer of the sidebar knows nothing of
// notes). It is read when a request needs it, never at startup and never while the function is off, and nothing of it stays in memory between two
// requests. Written like the other files of the application: owner-only, whole, on the disk, then renamed into place (persist.ts). A file that cannot
// be read is set aside (`.corrupt-<time>`, or `.future-<time>` for a newer version) and the notes start again from none; notes it held that this
// version does not accept are left out after a copy of the file (`.dropped-<time>`). Restaurer les données puts back the notes of an export after a
// copy of the file (`.avant-restauration-<time>`, `restore`). The notes belong to the person, not to a profile.

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { NOTES_FILE_MAX_BYTES, NOTES_MAX, NewerNotesFileError, notesFileText, parseNotesFile, sameNoteLink, type Note, type NoteLink } from '@shared/notes'
import { copyBeforeRestore, isHeld, pruneSideFiles, readTextBounded, setAsideOrHold, sideFiles, writeFileAtomic } from './persist'
import { t } from '@shared/i18n'

export type NotesOutcome = { ok: true; notes: Note[]; id?: string } | { ok: false; message: string; notes: Note[] }

/** Whether two files hold the same bytes; false when either cannot be read. */
function sameContent(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

export class NotesFile {
  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID
  ) {}

  /** The notes on the disk now: none when there is no file, or when it could not be read (it is then set aside, never written over unread). */
  read(): Note[] {
    // A file that could not be read nor moved is left alone: it is tried again when a note is saved (persist.ts), not at every look.
    if (isHeld(this.path) || !existsSync(this.path)) return []
    try {
      const { notes, dropped } = parseNotesFile(readTextBounded(this.path, NOTES_FILE_MAX_BYTES))
      if (dropped > 0) this.keepDropped(dropped)
      return notes
    } catch (error) {
      setAsideOrHold(this.path, error, 'notes', error instanceof NewerNotesFileError ? 'future' : 'corrupt')
      return []
    }
  }

  /**
   * Notes the file held that this version does not accept would vanish with the next write: a copy of the file is kept first. The same file read again
   * (nothing was saved in between) is not copied again, and only the three most recent copies are kept.
   */
  private keepDropped(dropped: number): void {
    try {
      const newest = sideFiles(this.path, 'dropped')[0]
      if (newest !== undefined && sameContent(newest, this.path)) return
      const copy = `${this.path}.dropped-${this.now()}`
      copyFileSync(this.path, copy)
      pruneSideFiles(this.path, 'dropped')
      console.error(`[notes] ${dropped} note(s) of ${basename(this.path)} are not valid notes and were left out; the file as it was is kept in ${basename(copy)}`)
    } catch (error) {
      console.error(`[notes] ${dropped} note(s) of ${basename(this.path)} were left out and the file could not be copied first (${String(error)})`)
    }
  }

  /** Writes the notes in place of the file, through a temporary file. Answers the sentence of the failure, or null. */
  private save(notes: readonly Note[]): string | null {
    try {
      writeFileAtomic(this.path, notesFileText(notes))
      return null
    } catch (error) {
      console.error(`[notes] cannot write ${this.path}:`, error)
      return t('notes.enregistrement-impossible', { detail: (error as Error).message ?? String(error) })
    }
  }

  private uniqueId(notes: readonly Note[]): string {
    const taken = new Set(notes.map((note) => note.id))
    let id = this.newId()
    while (taken.has(id)) id = this.newId()
    return id
  }

  /** A new note, first of the file. `text` is already clean (shared/notes.ts) and `link` already checked by the caller. */
  create(text: string, link: NoteLink | null): NotesOutcome {
    const notes = this.read()
    if (notes.length >= NOTES_MAX) return { ok: false, message: t('notes.trop-de-notes', { max: NOTES_MAX }), notes }
    const at = this.now()
    const note: Note = { id: this.uniqueId(notes), text, createdAt: at, updatedAt: at, ...(link ? { link } : {}) }
    const next = [note, ...notes]
    const failure = this.save(next)
    return failure === null ? { ok: true, notes: next, id: note.id } : { ok: false, message: failure, notes }
  }

  /** Changes the text or the link of a note. Nothing is written when nothing changes. */
  update(id: string, text: string, link: NoteLink | null): NotesOutcome {
    const notes = this.read()
    const before = notes.find((note) => note.id === id)
    if (!before) return { ok: false, message: t('notes.cette-note-n-existe-plus'), notes }
    if (before.text === text && sameNoteLink(before.link, link)) return { ok: true, notes }
    const { link: _old, ...rest } = before
    const changed: Note = { ...rest, text, updatedAt: Math.max(before.createdAt, this.now()), ...(link ? { link } : {}) }
    const next = notes.map((note) => (note.id === id ? changed : note))
    const failure = this.save(next)
    return failure === null ? { ok: true, notes: next } : { ok: false, message: failure, notes }
  }

  /**
   * Puts the notes of an export in place of the file (Restaurer les données, export-file.ts `finishRestore`). The file as it was is copied first beside it
   * (`notes.json.avant-restauration-<time>`, like state.json): when the copy cannot be made, nothing is written, since the notes about to be replaced would
   * exist nowhere else. `notes` are already clean (`exportedNotes`). Answers the sentence of the failure, or null.
   */
  restore(notes: readonly Note[]): string | null {
    try {
      if (existsSync(this.path)) copyBeforeRestore(this.path, new Date(this.now()))
    } catch (error) {
      console.error(`[notes] no copy of ${basename(this.path)} before the restore; nothing written:`, error)
      return t('notes.copie-avant-restauration-impossible', { detail: (error as Error).message ?? String(error) })
    }
    return this.save(notes.slice(0, NOTES_MAX))
  }

  remove(id: string): NotesOutcome {
    const notes = this.read()
    if (!notes.some((note) => note.id === id)) return { ok: false, message: t('notes.cette-note-n-existe-plus'), notes }
    const next = notes.filter((note) => note.id !== id)
    const failure = this.save(next)
    return failure === null ? { ok: true, notes: next } : { ok: false, message: failure, notes }
  }
}

let configuredPath: string | null = null
let current: NotesFile | null = null

/** Where the file is. Only a path is kept: nothing is read, and no object is made, until a note is asked for. */
export function configureNotes(path: string): void {
  configuredPath = path
  current = null
}

/** The notes file of the running application (made when first asked for), or null before `configureNotes`. */
export function notesFile(): NotesFile | null {
  if (current) return current
  if (configuredPath === null) return null
  current = new NotesFile(configuredPath)
  return current
}

/** The notes "Exporter les données" adds to its file while the function is on (null otherwise, or before the file is configured: the export is then as it was). */
export function notesForExport(enabled: boolean): Note[] | null {
  if (!enabled) return null
  return notesFile()?.read() ?? null
}
