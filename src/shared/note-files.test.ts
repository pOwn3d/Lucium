// A note out of the panel and into it, the pure rules: the name a note is offered under (its title, as a safe file name), what a file must be to become
// a note (a Markdown file, of text, holding something, no longer than a note), and the requests the panel may send, each exactly.

import { describe, expect, it } from 'vitest'
import { NOTE_TEXT_MAX } from './notes'
import { isMarkdownName, NOTE_FILE_MAX_BYTES, noteFileName, noteFileText, noteFromFile, noteFromText, parseNoteFileRequest } from './note-files'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('the name a note is offered under', () => {
  it('is its title, the first line that says something, without its marks', () => {
    expect(noteFileName('# Réunion produit — 9 nov.\nPoints vus')).toBe('Réunion produit — 9 nov.md')
    expect(noteFileName('\n\n**Courses** du *samedi*\n- pain')).toBe('Courses du samedi.md')
    expect(noteFileName('- [ ] appeler [Loïc](mailto:loic@example.org)')).toBe('appeler Loïc.md')
    expect(noteFileName('```\nconst a = 1\n```')).toBe('const a = 1.md')
  })

  it('holds no path, no character a disk or a screen reads otherwise, no dot first, and is cut at 100 characters', () => {
    expect(noteFileName('../../etc/passwd')).toBe('etc-passwd.md')
    expect(noteFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j.md')
    expect(noteFileName('fdp‮exe.txt')).toBe('fdp-exe.txt.md')
    expect(noteFileName('.cache')).toBe('cache.md')
    expect(noteFileName('x'.repeat(300))).toBe(`${'x'.repeat(100)}.md`)
    expect(noteFileName('\u0000\u0007ok')).toBe('ok.md')
  })

  it('is « note » for a note that says nothing a name can hold', () => {
    expect(noteFileName('')).toBe('note.md')
    expect(noteFileName('   \n\n')).toBe('note.md')
    expect(noteFileName('/// ...')).toBe('note.md')
  })

  it('is the text of the note in the file, with the line feed a text file ends with', () => {
    expect(noteFileText('# T\nx')).toBe('# T\nx\n')
  })
})

describe('a file made a note', () => {
  it('is a Markdown file: .md or .markdown, whatever its case; anything else is refused', () => {
    expect(isMarkdownName('note.md')).toBe(true)
    expect(isMarkdownName('NOTE.MD')).toBe(true)
    expect(isMarkdownName('a.markdown')).toBe(true)
    for (const name of ['note.txt', 'note.md.exe', 'md', '.md', 'note', 'note.mdx', 'note.html']) expect(isMarkdownName(name), name).toBe(false)
    expect(noteFromFile('note.txt', bytes('du texte'))).toEqual({ ok: false, problem: 'not-markdown' })
  })

  it('becomes the note it holds, its lines read (CR LF, a byte-order mark and the blanks around it dropped)', () => {
    expect(noteFromFile('n.md', bytes('﻿# Titre\r\n- un\r\n\r\n'))).toEqual({ ok: true, text: '# Titre\n- un' })
  })

  it('is refused unread past the most a note can be written in, and refused past the length of a note, with that length said', () => {
    expect(noteFromFile('n.md', new Uint8Array(NOTE_FILE_MAX_BYTES + 1).fill(97))).toEqual({ ok: false, problem: 'too-big' })
    expect(noteFromFile('n.md', bytes('a'.repeat(NOTE_TEXT_MAX)))).toEqual({ ok: true, text: 'a'.repeat(NOTE_TEXT_MAX) })
    expect(noteFromFile('n.md', bytes('a'.repeat(NOTE_TEXT_MAX + 1)))).toEqual({ ok: false, problem: 'too-long', length: NOTE_TEXT_MAX + 1 })
    // Four bytes a character: the largest note still fits in what is read.
    expect(noteFromFile('n.md', bytes('😀'.repeat(NOTE_TEXT_MAX / 2))).ok).toBe(true)
  })

  it('is refused when it is not text (a NUL, bytes that are no UTF-8) or holds nothing', () => {
    expect(noteFromFile('n.md', new Uint8Array([0x23, 0x00, 0x41]))).toEqual({ ok: false, problem: 'not-text' })
    expect(noteFromFile('n.md', new Uint8Array([0xff, 0xfe, 0x41]))).toEqual({ ok: false, problem: 'not-text' })
    expect(noteFromFile('n.md', bytes(' \n\t\n'))).toEqual({ ok: false, problem: 'empty' })
    expect(noteFromText('a\u0000b')).toEqual({ ok: false, problem: 'not-text' })
  })
})

describe('the requests of the panel for the files of a note', () => {
  it('are each exactly one of the kinds, with its fields', () => {
    expect(parseNoteFileRequest({ kind: 'save', text: 'x' })).toEqual({ kind: 'save', text: 'x' })
    expect(parseNoteFileRequest({ kind: 'share', text: 'x' })).toEqual({ kind: 'share', text: 'x' })
    expect(parseNoteFileRequest({ kind: 'copy', format: 'rich', text: 'x' })).toEqual({ kind: 'copy', format: 'rich', text: 'x' })
    expect(parseNoteFileRequest({ kind: 'import', link: null })).toEqual({ kind: 'import', link: null })
    expect(parseNoteFileRequest({ kind: 'import-text', name: 'a.md', text: 'x', link: { kind: 'space', spaceId: 's1' } })).toEqual({ kind: 'import-text', name: 'a.md', text: 'x', link: { kind: 'space', spaceId: 's1' } })
    expect(parseNoteFileRequest({ kind: 'mail', url: 'mailto:a@b.c' })).toEqual({ kind: 'mail', url: 'mailto:a@b.c' })
  })

  it('refuse anything else: an unknown kind, a missing or extra field, a text too long to be a note, a format that is not one', () => {
    for (const raw of [
      null,
      'save',
      { kind: 'delete' },
      { kind: 'save' },
      { kind: 'save', text: 'x', path: '/etc/passwd' },
      { kind: 'save', text: 'x'.repeat(NOTE_TEXT_MAX * 2 + 1) },
      { kind: 'copy', format: 'html', text: 'x' },
      { kind: 'import', link: 'page' },
      { kind: 'import-text', name: 'a.md', text: 'x' },
      { kind: 'import-text', name: 'a'.repeat(1025), text: 'x', link: null },
      { kind: 'mail', url: 'x'.repeat(2049) }
    ]) {
      expect(parseNoteFileRequest(raw), JSON.stringify(raw)?.slice(0, 80)).toBeNull()
    }
  })
})
