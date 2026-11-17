// The file of the quick notes against real files: what is written is read back, a write goes through a temporary file (the file in place is never left
// half written), a file that cannot be read is set aside rather than written over, and nothing of a file is ever read before a note is asked for.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTES_FILE_MAX_BYTES, NOTES_MAX, notesFileText, type Note } from '@shared/notes'
import { takePersistenceNotices } from './persistence-notices'
import { NotesFile, configureNotes, notesFile, notesForExport } from './notes-store'
import { tempDir } from './temp-dir'
import { frenchSpaces } from '@shared/french-typography'

let ids = 0
let clock = 1000
const make = (dir = tempDir('lucium-notes-')) => new NotesFile(join(dir, 'notes.json'), () => clock, () => `n${++ids}`)
const onDisk = (file: NotesFile): unknown => JSON.parse(readFileSync(file.path, 'utf8'))
const named = (file: NotesFile, kind: string): string[] => readdirSync(join(file.path, '..')).filter((name) => name.startsWith(`notes.json.${kind}-`))

let logged: string[] = []
beforeEach(() => {
  ids = 0
  clock = 1000
  logged = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
})
afterEach(() => {
  vi.restoreAllMocks()
  takePersistenceNotices()
})

describe('writing notes', () => {
  it('starts with none and no file, and writes the first note to the file', () => {
    const file = make()
    expect(file.read()).toEqual([])
    expect(existsSync(file.path)).toBe(false)
    const made = file.create('Penser au **pain**', { kind: 'page', url: 'https://example.org/' })
    expect(made).toEqual({ ok: true, id: 'n1', notes: [{ id: 'n1', text: 'Penser au **pain**', createdAt: 1000, updatedAt: 1000, link: { kind: 'page', url: 'https://example.org/' } }] })
    expect(onDisk(file)).toEqual({ version: 1, notes: made.notes })
    expect(file.read()).toEqual(made.notes)
  })

  it('puts the newest first, changes a note with its date of change, and writes nothing when nothing changes', () => {
    const file = make()
    file.create('un', null)
    clock = 2000
    file.create('deux', { kind: 'space', spaceId: 's1' })
    expect(file.read().map((n) => n.id)).toEqual(['n2', 'n1'])
    clock = 3000
    expect(file.update('n1', 'un, revu', { kind: 'space', spaceId: 's1' })).toMatchObject({ ok: true })
    expect(file.read().find((n) => n.id === 'n1')).toEqual({ id: 'n1', text: 'un, revu', createdAt: 1000, updatedAt: 3000, link: { kind: 'space', spaceId: 's1' } })
    // Taking the link away leaves no link behind.
    clock = 4000
    file.update('n2', 'deux', null)
    expect(file.read().find((n) => n.id === 'n2')).toEqual({ id: 'n2', text: 'deux', createdAt: 2000, updatedAt: 4000 })
    const before = statSync(file.path).mtimeMs
    const text = readFileSync(file.path, 'utf8')
    clock = 5000
    expect(file.update('n2', 'deux', null)).toMatchObject({ ok: true })
    expect(readFileSync(file.path, 'utf8')).toBe(text)
    expect(statSync(file.path).mtimeMs).toBe(before)
  })

  it('deletes a note, and says when a note is not there any more', () => {
    const file = make()
    file.create('un', null)
    file.create('deux', null)
    expect(file.remove('n1')).toMatchObject({ ok: true, notes: [{ id: 'n2' }] })
    expect(file.read().map((n) => n.id)).toEqual(['n2'])
    expect(file.remove('n1')).toMatchObject({ ok: false, message: 'Cette note n’existe plus.' })
    expect(file.update('n1', 'x', null)).toMatchObject({ ok: false, message: 'Cette note n’existe plus.' })
  })

  it('never gives two notes the same id, and stops at the limit', () => {
    const dir = tempDir('lucium-notes-')
    const path = join(dir, 'notes.json')
    writeFileSync(path, notesFileText(Array.from({ length: NOTES_MAX - 1 }, (_, i): Note => ({ id: `n${i + 1}`, text: 'x', createdAt: 1, updatedAt: 1 }))))
    const taken = ['n1', 'n2', 'libre']
    const file = new NotesFile(path, () => 1, () => taken.shift()!)
    expect(file.create('dernière', null)).toMatchObject({ ok: true, id: 'libre' })
    expect(file.create('une de trop', null)).toMatchObject({ ok: false, message: frenchSpaces(`Il y a déjà ${NOTES_MAX} notes : supprimez-en une avant d’en écrire une autre.`) })
    expect(file.read()).toHaveLength(NOTES_MAX)
  })

  it('keeps the file for its owner only, like the other files of the application', () => {
    const file = make()
    file.create('privé', null)
    expect(statSync(file.path).mode & 0o777).toBe(0o600)
  })

  // Through a temporary file renamed into place (persist.ts): a write that cannot be made leaves the file in place whole, and says so.
  it('leaves the file in place untouched when the new one cannot be written, and keeps no half-written file', () => {
    const file = make()
    file.create('à garder', null)
    const before = readFileSync(file.path, 'utf8')
    // The temporary file cannot be made: a folder stands where it would go.
    mkdirSync(`${file.path}.tmp`)
    const outcome = file.create('perdue', null)
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ message: expect.stringContaining('Les notes n’ont pas pu être enregistrées') })
    expect(readFileSync(file.path, 'utf8')).toBe(before)
    expect(file.read().map((n) => n.text)).toEqual(['à garder'])
    expect(logged.some((line) => line.includes('[notes] cannot write'))).toBe(true)
  })
})

describe('a file that cannot be read', () => {
  it('is set aside, never written over, and the notes start again from none', () => {
    const file = make()
    writeFileSync(file.path, '{"version":1,"notes":[{"id":')
    expect(file.read()).toEqual([])
    expect(existsSync(file.path)).toBe(false)
    const aside = named(file, 'corrupt')
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(file.path, '..', aside[0]!), 'utf8')).toBe('{"version":1,"notes":[{"id":')
    expect(takePersistenceNotices()).toEqual([expect.objectContaining({ kind: 'set-aside', file: 'notes.json' })])
    // The next note makes a new file; the damaged one stays where it was put.
    expect(file.create('nouvelle', null)).toMatchObject({ ok: true })
    expect(file.read().map((n) => n.text)).toEqual(['nouvelle'])
    expect(named(file, 'corrupt')).toEqual(aside)
  })

  it('is set aside unread when it is far larger than notes can be', () => {
    const file = make()
    writeFileSync(file.path, Buffer.alloc(NOTES_FILE_MAX_BYTES + 1, 0x20))
    expect(file.read()).toEqual([])
    expect(named(file, 'corrupt')).toHaveLength(1)
  })

  it('is kept untouched when a more recent version wrote it, and is never mistaken for a damaged one', () => {
    const file = make()
    const newer = JSON.stringify({ version: 2, notes: [{ id: 'x', text: 'de demain' }] })
    writeFileSync(file.path, newer)
    expect(file.read()).toEqual([])
    expect(named(file, 'corrupt')).toEqual([])
    const kept = named(file, 'future')
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(file.path, '..', kept[0]!), 'utf8')).toBe(newer)
    expect(takePersistenceNotices()).toEqual([expect.objectContaining({ kind: 'newer-version', file: 'notes.json' })])
  })

  it('keeps a copy before notes it held that are not notes are lost, once for the same file', () => {
    const file = make()
    const text = JSON.stringify({ version: 1, notes: [{ id: 'bon', text: 'gardée', createdAt: 1, updatedAt: 1 }, { id: 'mauvais', text: '' }] })
    writeFileSync(file.path, text)
    expect(file.read().map((n) => n.id)).toEqual(['bon'])
    expect(file.read().map((n) => n.id)).toEqual(['bon'])
    const copies = named(file, 'dropped')
    expect(copies).toHaveLength(1)
    expect(readFileSync(join(file.path, '..', copies[0]!), 'utf8')).toBe(text)
    // The next save writes the notes that are notes; the copy keeps the others.
    file.create('nouvelle', null)
    expect((onDisk(file) as { notes: Note[] }).notes.map((n) => n.id)).toEqual(['n1', 'bon'])
    expect(named(file, 'dropped')).toEqual(copies)
  })
})

describe('the file of the running application', () => {
  it('is only a path until a note is asked for: configuring it reads nothing, and nothing is there before', () => {
    const dir = tempDir('lucium-notes-')
    const path = join(dir, 'notes.json')
    writeFileSync(path, 'pas du JSON')
    expect(notesFile()).toBeNull()
    configureNotes(path)
    // A damaged file that is not read stays where it is: nothing looked at it.
    expect(readdirSync(dir)).toEqual(['notes.json'])
    expect(notesFile()?.path).toBe(path)
    expect(notesFile()).toBe(notesFile())
  })

  it('gives the export its notes only while the function is on, and reads nothing while it is off', () => {
    const dir = tempDir('lucium-notes-')
    const path = join(dir, 'notes.json')
    writeFileSync(path, notesFileText([{ id: 'a', text: 'exportée', createdAt: 1, updatedAt: 1 }]))
    configureNotes(path)
    expect(notesForExport(true)).toEqual([{ id: 'a', text: 'exportée', createdAt: 1, updatedAt: 1 }])
    writeFileSync(path, 'abîmé')
    expect(notesForExport(false)).toBeNull()
    expect(readdirSync(dir)).toEqual(['notes.json'])
  })
})

describe('putting back the notes of an export (Restaurer les données)', () => {
  const kept = { id: 'old', text: 'avant', createdAt: 1, updatedAt: 1 }
  const restored: Note[] = [{ id: 'new', text: 'restaurée', createdAt: 2, updatedAt: 3 }]

  it('copies the file as it was beside it, then writes the notes of the export in its place', () => {
    const file = make()
    writeFileSync(file.path, notesFileText([kept]))
    expect(file.restore(restored)).toBeNull()
    expect(file.read()).toEqual(restored)
    const copies = named(file, 'avant-restauration')
    expect(copies).toHaveLength(1)
    expect(readFileSync(join(file.path, '..', copies[0]!), 'utf8')).toBe(notesFileText([kept]))
  })

  it('writes them without a copy when there was no file, and keeps no more notes than a file holds', () => {
    const file = make()
    const many = Array.from({ length: NOTES_MAX + 3 }, (_, i): Note => ({ id: `r${i}`, text: `note ${i}`, createdAt: 1, updatedAt: 1 }))
    expect(file.restore(many)).toBeNull()
    expect(file.read()).toHaveLength(NOTES_MAX)
    expect(named(file, 'avant-restauration')).toEqual([])
  })

  it('writes nothing, and says why, when the file cannot be copied first', () => {
    const file = make()
    mkdirSync(file.path)
    expect(file.restore(restored)).toMatch(/copie de notes\.json/)
    expect(statSync(file.path).isDirectory()).toBe(true)
    expect(logged.join('\n')).toContain('no copy of notes.json before the restore')
  })
})
