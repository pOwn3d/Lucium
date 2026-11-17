// The rules of the quick notes: the address a page is known by, what a note may hold, the file that holds them, the requests of the panel, and the order
// the panel shows them in. Pure: the file and the IPC are in main/notes-store.test.ts and main/shell/notes-ipc.test.ts.

import { describe, expect, it, vi } from 'vitest'
import {
  NOTES_MAX,
  NOTE_TEXT_MAX,
  NOTE_URL_MAX,
  NewerNotesFileError,
  cleanNoteLink,
  cleanNoteText,
  defaultNoteLink,
  defaultNotesScope,
  givingUpClosesPanel,
  noteLinkChoices,
  noteMatches,
  notePageAddress,
  noteTextProblem,
  noteTitle,
  notesContext,
  notesFileText,
  notesInScope,
  notesScopes,
  notesSections,
  openingNotesScope,
  parseNotesFile,
  parseNotesRequest,
  usableNotesScope,
  type Note
} from './notes'
import { createUndoQueue, type UndoTimers } from './undo-queue'

const note = (id: string, over: Partial<Note> = {}): Note => ({ id, text: `Note ${id}`, createdAt: 1, updatedAt: 1, ...over })

describe('the address of a page', () => {
  it('drops the fragment, the credentials and the tracking parameters, and keeps the parameters that pick the page', () => {
    expect(notePageAddress('https://user:secret@Docs.Example.org:443/guide?id=7&utm_source=news&lang=fr&fbclid=abc#section-2')).toBe('https://docs.example.org/guide?id=7&lang=fr')
    expect(notePageAddress('http://example.org/a#b')).toBe('http://example.org/a')
  })

  it('reads the same page whatever was around it: one page, one address', () => {
    const one = notePageAddress('https://example.org/article?utm_campaign=x#top')
    expect(notePageAddress('https://EXAMPLE.org/article')).toBe(one)
    expect(notePageAddress('https://example.org/article?')).toBe(one)
    expect(notePageAddress('https://example.org/article#comments')).toBe(one)
    expect(one).toBe('https://example.org/article')
  })

  it('takes web pages only, of a sensible length', () => {
    for (const bad of ['about:blank', 'file:///Users/moi/secret.txt', 'chrome-extension://abc/page.html', 'javascript:alert(1)', 'data:text/html,x', 'pas une adresse', '', 42, null, undefined]) {
      expect(notePageAddress(bad), String(bad)).toBeNull()
    }
    expect(notePageAddress(`https://example.org/${'a'.repeat(NOTE_URL_MAX)}`)).toBeNull()
    expect(notePageAddress(`https://example.org/${'a'.repeat(NOTE_URL_MAX - 30)}`)).not.toBeNull()
  })
})

describe('the text of a note', () => {
  it('keeps its lines and tabs, and loses the other control characters and the blanks around it', () => {
    expect(cleanNoteText('  \r\n# Titre\r\n\t- un\u0000\u0007\n- deux\u001b  \n\n')).toBe('# Titre\n\t- un\n- deux')
  })

  it('is refused empty or too long, with the reason', () => {
    expect(noteTextProblem('  \n\t ')).toBe('empty')
    expect(noteTextProblem('\u0000\u0001')).toBe('empty')
    expect(noteTextProblem('x'.repeat(NOTE_TEXT_MAX))).toBeNull()
    expect(noteTextProblem('x'.repeat(NOTE_TEXT_MAX + 1))).toBe('too-long')
    // The blanks around it do not count.
    expect(noteTextProblem(`  ${'x'.repeat(NOTE_TEXT_MAX)}  `)).toBeNull()
  })

  it('is named in the list by its first line, without the marks of Markdown', () => {
    expect(noteTitle('\n\n# **Courses** du *samedi*\n- pain')).toBe('Courses du samedi')
    expect(noteTitle('- [ ] appeler\nensuite')).toBe('appeler')
    expect(noteTitle('1. premier point')).toBe('premier point')
    expect(noteTitle('x'.repeat(200))).toHaveLength(80)
    expect(noteTitle('x'.repeat(200)).endsWith('…')).toBe(true)
    expect(noteTitle('   ')).toBe('')
  })
})

describe('the link of a note', () => {
  it('is a space or a web page, written exactly so', () => {
    expect(cleanNoteLink({ kind: 'space', spaceId: 'travail' })).toEqual({ kind: 'space', spaceId: 'travail' })
    expect(cleanNoteLink({ kind: 'page', url: 'https://example.org/a?utm_medium=x#y' })).toEqual({ kind: 'page', url: 'https://example.org/a' })
    for (const bad of [null, 'travail', { kind: 'space' }, { kind: 'space', spaceId: '' }, { kind: 'space', spaceId: '__proto__' }, { kind: 'space', spaceId: 'a b' }, { kind: 'space', spaceId: 'x', extra: 1 }, { kind: 'page', url: 'file:///etc/passwd' }, { kind: 'tab', id: 't1' }]) {
      expect(cleanNoteLink(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('the file of the notes', () => {
  it('reads back what it writes', () => {
    const notes = [note('a', { link: { kind: 'page', url: 'https://example.org/' } }), note('b', { link: { kind: 'space', spaceId: 's1' } }), note('c')]
    expect(parseNotesFile(notesFileText(notes))).toEqual({ notes, dropped: 0 })
  })

  it('throws for what is not a notes file at all, so that the store sets it aside', () => {
    for (const text of ['', '{', 'null', '[]', '{"version":1}', '{"notes":[]}', '{"version":"1","notes":[]}', '{"version":0,"notes":[]}']) {
      expect(() => parseNotesFile(text), text).toThrow()
    }
  })

  it('tells a file of a newer version from a damaged one', () => {
    expect(() => parseNotesFile('{"version":2,"notes":[]}')).toThrow(NewerNotesFileError)
    expect(() => parseNotesFile('{"version":"x","notes":[]}')).not.toThrow(NewerNotesFileError)
  })

  it('leaves out, and counts, the notes that are not notes, the second of an id and those beyond the limit', () => {
    const raw = {
      version: 1,
      notes: [
        note('a'),
        note('a', { text: 'doublon' }),
        { ...note('b'), text: '' },
        { ...note('c'), text: 'x'.repeat(NOTE_TEXT_MAX + 1) },
        { ...note('d'), link: { kind: 'page', url: 'file:///x' } },
        { ...note('e'), createdAt: -1 },
        { ...note('f'), extra: true },
        { ...note('g h') },
        'texte',
        note('ok')
      ]
    }
    const { notes, dropped } = parseNotesFile(JSON.stringify(raw))
    expect(notes.map((n) => n.id)).toEqual(['a', 'ok'])
    expect(notes[0]!.text).toBe('Note a')
    expect(dropped).toBe(8)
    const many = { version: 1, notes: Array.from({ length: NOTES_MAX + 2 }, (_, i) => note(`n${i}`)) }
    expect(parseNotesFile(JSON.stringify(many))).toMatchObject({ dropped: 2 })
  })

  it('reads a file an editor saved with a byte-order mark, and a clock that went back as the moment the note was made', () => {
    const { notes } = parseNotesFile(`﻿${JSON.stringify({ version: 1, notes: [note('a', { createdAt: 50, updatedAt: 10 })] })}`)
    expect(notes[0]).toMatchObject({ createdAt: 50, updatedAt: 50 })
  })

  it('normalises again the address of a page written by hand', () => {
    const { notes } = parseNotesFile(JSON.stringify({ version: 1, notes: [note('a', { link: { kind: 'page', url: 'https://Example.org/p?gclid=1#x' } })] }))
    expect(notes[0]!.link).toEqual({ kind: 'page', url: 'https://example.org/p' })
  })
})

describe('the requests of the panel', () => {
  it('reads each of the six', () => {
    expect(parseNotesRequest({ kind: 'list' })).toEqual({ kind: 'list' })
    expect(parseNotesRequest({ kind: 'open' })).toEqual({ kind: 'open' })
    expect(parseNotesRequest({ kind: 'open', compose: true })).toEqual({ kind: 'open', compose: true })
    // The command bar's note names no link: the main process ties it to what is on screen.
    expect(parseNotesRequest({ kind: 'jot', text: 'x' })).toEqual({ kind: 'jot', text: 'x' })
    expect(parseNotesRequest({ kind: 'create', text: 'x', link: null })).toEqual({ kind: 'create', text: 'x', link: null })
    expect(parseNotesRequest({ kind: 'create', text: 'x' })).toEqual({ kind: 'create', text: 'x', link: null })
    expect(parseNotesRequest({ kind: 'create', text: 'x', link: { kind: 'space', spaceId: 's1' } })).toEqual({ kind: 'create', text: 'x', link: { kind: 'space', spaceId: 's1' } })
    // The address is checked by the handler (it says why it is refused); here it is only bounded.
    expect(parseNotesRequest({ kind: 'update', id: 'n1', text: 'y', link: { kind: 'page', url: 'about:blank' } })).toEqual({ kind: 'update', id: 'n1', text: 'y', link: { kind: 'page', url: 'about:blank' } })
    expect(parseNotesRequest({ kind: 'remove', id: 'n1' })).toEqual({ kind: 'remove', id: 'n1' })
  })

  it('refuses anything else, whole', () => {
    for (const bad of [
      null,
      'list',
      [],
      { kind: 'list', extra: 1 },
      { kind: 'open', id: 'n1' },
      { kind: 'open', compose: false },
      { kind: 'open', compose: 'yes' },
      { kind: 'jot' },
      { kind: 'jot', text: 42 },
      { kind: 'jot', text: 'x'.repeat(NOTE_TEXT_MAX * 2 + 1) },
      { kind: 'jot', text: 'x', link: { kind: 'space', spaceId: 's1' } },
      { kind: 'create' },
      { kind: 'create', text: 42 },
      { kind: 'create', text: 'x'.repeat(NOTE_TEXT_MAX * 2 + 1) },
      { kind: 'create', text: 'x', link: 'https://example.org/' },
      { kind: 'create', text: 'x', link: { kind: 'tab', id: 't1' } },
      { kind: 'create', text: 'x', link: { kind: 'space', spaceId: '__proto__' } },
      { kind: 'create', text: 'x', link: { kind: 'page', url: 'https://example.org/', title: 'x' } },
      { kind: 'update', text: 'x' },
      { kind: 'update', id: '../x', text: 'x' },
      { kind: 'remove' },
      { kind: 'remove', id: '*' },
      { kind: 'remove', id: 'n1', all: true },
      { kind: 'erase-all' }
    ]) {
      expect(parseNotesRequest(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull()
    }
  })
})

describe('the context of the panel', () => {
  it('is the space on screen and its web page, never the page of a private tab', () => {
    expect(notesContext('s1', { url: 'https://example.org/a#x' })).toEqual({ spaceId: 's1', pageUrl: 'https://example.org/a' })
    expect(notesContext('s1', { url: 'https://example.org/a', private: true })).toEqual({ spaceId: 's1', pageUrl: null })
    expect(notesContext('s1', { url: 'about:blank' })).toEqual({ spaceId: 's1', pageUrl: null })
    expect(notesContext('s1', undefined)).toEqual({ spaceId: 's1', pageUrl: null })
  })
})

describe('the order of the panel', () => {
  const page = 'https://example.org/article'
  const notes = [
    note('autre-page', { updatedAt: 90, link: { kind: 'page', url: 'https://example.org/autre' } }),
    note('espace-ancien', { updatedAt: 10, link: { kind: 'space', spaceId: 's1' } }),
    note('page', { updatedAt: 5, link: { kind: 'page', url: page } }),
    note('libre', { updatedAt: 70 }),
    note('autre-espace', { updatedAt: 80, link: { kind: 'space', spaceId: 's2' } }),
    note('espace-recent', { updatedAt: 60, link: { kind: 'space', spaceId: 's1' } }),
    note('page-recente', { updatedAt: 50, link: { kind: 'page', url: page } })
  ]
  const ids = (list: Note[]) => list.map((n) => n.id)

  it('shows the notes of the page on screen, then those of its space, then all the others, the most recently changed first', () => {
    const sections = notesSections(notes, { pageUrl: page, spaceId: 's1' })
    expect(ids(sections.page)).toEqual(['page-recente', 'page'])
    expect(ids(sections.space)).toEqual(['espace-recent', 'espace-ancien'])
    expect(ids(sections.others)).toEqual(['autre-page', 'autre-espace', 'libre'])
  })

  it('shows every note once: without a page on screen its notes are among the others', () => {
    const sections = notesSections(notes, { pageUrl: null, spaceId: 's1' })
    expect(sections.page).toEqual([])
    expect(ids(sections.others)).toEqual(['autre-page', 'autre-espace', 'libre', 'page-recente', 'page'])
    expect([...sections.page, ...sections.space, ...sections.others]).toHaveLength(notes.length)
  })

  it('does not depend on the order of the file for notes changed at the same moment', () => {
    const tied = [note('b', { updatedAt: 5, createdAt: 2 }), note('a', { updatedAt: 5, createdAt: 2 }), note('c', { updatedAt: 5, createdAt: 3 })]
    expect(ids(notesSections(tied, { pageUrl: null, spaceId: null }).others)).toEqual(['c', 'a', 'b'])
    expect(ids(notesSections([...tied].reverse(), { pageUrl: null, spaceId: null }).others)).toEqual(['c', 'a', 'b'])
  })

  it('keeps the notes that answer every word of a search, in their text or their address, accents and case ignored', () => {
    const list = [note('a', { text: 'Réunion de lundi' }), note('b', { text: 'Courses', link: { kind: 'page', url: 'https://boulangerie.example/' } }), note('c', { text: 'reunion annulée mardi' })]
    expect(ids(notesSections(list, { pageUrl: null, spaceId: null }, 'REUNION').others)).toEqual(['a', 'c'])
    expect(ids(notesSections(list, { pageUrl: null, spaceId: null }, 'réunion lundi').others)).toEqual(['a'])
    expect(ids(notesSections(list, { pageUrl: null, spaceId: null }, 'boulangerie').others)).toEqual(['b'])
    expect(noteMatches(list[0]!, '   ')).toBe(true)
  })

  it('hides the notes being deleted, and shows them again when the deletion is taken back', () => {
    const timers: UndoTimers = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer) }
    vi.useFakeTimers()
    try {
      const removed: string[] = []
      const queue = createUndoQueue(6000, timers)
      const context = { pageUrl: page, spaceId: 's1' }
      queue.remove('page', 'Note supprimée', () => removed.push('page'))
      expect(ids(notesSections(notes, context, '', new Set(queue.pending())).page)).toEqual(['page-recente'])
      expect(queue.undo()).toBe(true)
      expect(ids(notesSections(notes, context, '', new Set(queue.pending())).page)).toEqual(['page-recente', 'page'])
      vi.advanceTimersByTime(10_000)
      expect(removed).toEqual([])
      // Not taken back: the deletion is made once the eight seconds have passed, not before.
      queue.remove('libre', 'Note supprimée', () => removed.push('libre'))
      vi.advanceTimersByTime(5_999)
      expect(removed).toEqual([])
      vi.advanceTimersByTime(1)
      expect(removed).toEqual(['libre'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('what the list of the panel shows', () => {
  const page = 'https://example.org/article'
  const here = { pageUrl: page, spaceId: 's1' }
  const notes = [
    note('autre-page', { updatedAt: 90, link: { kind: 'page', url: 'https://example.org/autre' } }),
    note('espace', { updatedAt: 10, link: { kind: 'space', spaceId: 's1' } }),
    note('page', { updatedAt: 5, link: { kind: 'page', url: page } }),
    note('libre', { updatedAt: 70 }),
    note('autre-espace', { updatedAt: 80, link: { kind: 'space', spaceId: 's2' } }),
    note('page-recente', { updatedAt: 50, link: { kind: 'page', url: page } })
  ]
  const ids = (list: Note[]) => list.map((n) => n.id)

  it('offers the page and the space on screen, then every note; a page that cannot have notes, or no space, is not offered', () => {
    expect(notesScopes(here)).toEqual(['page', 'space', 'all'])
    expect(notesScopes({ pageUrl: null, spaceId: 's1' })).toEqual(['space', 'all'])
    expect(notesScopes({ pageUrl: page, spaceId: null })).toEqual(['page', 'all'])
    expect(notesScopes({ pageUrl: null, spaceId: null })).toEqual(['all'])
  })

  it('opens on the page when it has notes, else on every note rather than on an empty list', () => {
    expect(defaultNotesScope(notes, here)).toBe('page')
    // Notes in the space, none on the page: all of them, the space's at the top.
    expect(defaultNotesScope(notes, { pageUrl: 'https://example.org/vide', spaceId: 's1' })).toBe('all')
    // A note of the page of a private tab is not the page on screen (its context has no page).
    expect(defaultNotesScope(notes, { pageUrl: null, spaceId: 's1' })).toBe('all')
    expect(defaultNotesScope([], here)).toBe('all')
  })

  it('opens on « Toutes » when the request forces it, whether or not the page has notes, and on its own choice otherwise', () => {
    expect(openingNotesScope(notes, here, 'all')).toBe('all')
    expect(openingNotesScope(notes, here)).toBe('page')
    expect(openingNotesScope(notes, here, undefined)).toBe(defaultNotesScope(notes, here))
    expect(openingNotesScope(notes, { pageUrl: 'https://example.org/vide', spaceId: 's1' })).toBe('all')
    expect(openingNotesScope([], here, 'all')).toBe('all')
  })

  it('shows every note when the choice no longer applies, and keeps it otherwise', () => {
    expect(usableNotesScope('page', { pageUrl: null, spaceId: 's1' })).toBe('all')
    expect(usableNotesScope('space', { pageUrl: page, spaceId: null })).toBe('all')
    expect(usableNotesScope('page', here)).toBe('page')
    expect(usableNotesScope('space', here)).toBe('space')
    expect(usableNotesScope('all', { pageUrl: null, spaceId: null })).toBe('all')
  })

  it('keeps only the notes of the page, or of the space, and every note under « Toutes », in the order of the groups', () => {
    expect(notesSections(notes, here, '', new Set(), 'page')).toEqual({ page: [notes[5], notes[2]], space: [], others: [] })
    expect(notesSections(notes, here, '', new Set(), 'space')).toEqual({ page: [], space: [notes[1]], others: [] })
    const all = notesSections(notes, here, '', new Set(), 'all')
    expect([ids(all.page), ids(all.space), ids(all.others)]).toEqual([['page-recente', 'page'], ['espace'], ['autre-page', 'autre-espace', 'libre']])
    expect(notesSections(notes, here)).toEqual(all)
  })

  it('searches the notes of the choice only', () => {
    const list = [note('ici', { text: 'Réunion ici', link: { kind: 'page', url: page } }), note('ailleurs', { text: 'Réunion ailleurs' })]
    expect(ids(notesSections(list, here, 'réunion', new Set(), 'page').page)).toEqual(['ici'])
    expect(notesSections(list, here, 'ailleurs', new Set(), 'page')).toEqual({ page: [], space: [], others: [] })
    expect(ids(notesSections(list, here, 'ailleurs', new Set(), 'all').others)).toEqual(['ailleurs'])
  })

  it('counts the notes of the choice for the header, the search aside, without the ones being deleted', () => {
    expect(notesInScope(notes, here, 'page')).toBe(2)
    expect(notesInScope(notes, here, 'space')).toBe(1)
    expect(notesInScope(notes, here, 'all')).toBe(6)
    expect(notesInScope(notes, here, 'page', new Set(['page']))).toBe(1)
    expect(notesInScope(notes, here, 'all', new Set(['libre', 'espace']))).toBe(4)
    // Without a page on screen, nothing is « this page ».
    expect(notesInScope(notes, { pageUrl: null, spaceId: 's1' }, 'page')).toBe(0)
  })
})

describe('the links the editor offers', () => {
  const context = { pageUrl: 'https://example.org/a', spaceId: 's1' }

  it('starts a new note on the page on screen, else on its space, else on nothing', () => {
    expect(defaultNoteLink(context)).toEqual({ kind: 'page', url: 'https://example.org/a' })
    expect(defaultNoteLink({ pageUrl: null, spaceId: 's1' })).toEqual({ kind: 'space', spaceId: 's1' })
    expect(defaultNoteLink({ pageUrl: null, spaceId: null })).toBeNull()
  })

  it('offers the note’s own link first, then the page and the space on screen, then none, each once', () => {
    expect(noteLinkChoices(undefined, context)).toEqual([{ kind: 'page', url: 'https://example.org/a' }, { kind: 'space', spaceId: 's1' }, null])
    expect(noteLinkChoices({ kind: 'space', spaceId: 's9' }, context)).toEqual([{ kind: 'space', spaceId: 's9' }, { kind: 'page', url: 'https://example.org/a' }, { kind: 'space', spaceId: 's1' }, null])
    expect(noteLinkChoices({ kind: 'page', url: 'https://example.org/a' }, context)).toEqual([{ kind: 'page', url: 'https://example.org/a' }, { kind: 'space', spaceId: 's1' }, null])
    expect(noteLinkChoices(undefined, { pageUrl: null, spaceId: null })).toEqual([null])
  })
})

describe('the note "Nouvelle note" opens the panel on', () => {
  it('closes the panel when it is given up while empty: nothing is kept', () => {
    for (const text of ['', '  ', '\n\t']) expect(givingUpClosesPanel({ id: null, text }, true), JSON.stringify(text)).toBe(true)
  })

  it('is given up as in the panel once something is written in it, and so is any note the panel itself started or opened', () => {
    expect(givingUpClosesPanel({ id: null, text: 'Relire' }, true)).toBe(false)
    expect(givingUpClosesPanel({ id: null, text: '' }, false)).toBe(false)
    expect(givingUpClosesPanel({ id: 'n1', text: '' }, true)).toBe(false)
    expect(givingUpClosesPanel(null, true)).toBe(false)
  })
})
