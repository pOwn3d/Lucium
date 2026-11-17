// The Markdown of a note as the editor reads it: every case it recognises, read and put back without losing a character; an old note in plain text
// the same text; no address but a web page ever a link; and the edits of the editor's keys (Return in a list, ⌘B, ⌘I, ⌘K, the boxes, the history).

import { describe, expect, it } from 'vitest'
import {
  enterEdit,
  linkEdit,
  NoteHistory,
  notePlainText,
  noteSource,
  parseNote,
  parseNoteLine,
  pastedText,
  pasteEdit,
  safeNoteHref,
  toggleMarks,
  toggleTaskLine,
  toggleTasksEdit,
  TYPING_STEP_MS,
  withinLimit,
  type NoteEdit,
  type NoteLine,
  type NotePiece
} from './note-markdown'

/** The pieces of a line with the look they get, in a short form: `**`(mark), gras(strong)… */
const look = (line: NoteLine): string[] =>
  line.pieces.map((piece) => {
    const marks = [piece.kind !== 'text' ? piece.kind : '', piece.strong ? 'strong' : '', piece.em ? 'em' : '', piece.strike ? 'strike' : '', piece.code ? 'code' : '', piece.url ? 'url' : '', piece.href ? `→${piece.href}` : ''].filter(Boolean)
    return marks.length > 0 ? `${piece.text}(${marks.join(' ')})` : piece.text
  })

const allPieces = (source: string): NotePiece[] => parseNote(source).flatMap((line) => line.pieces)

/** Every case the field recognises, as it is typed. */
const CASES: Record<string, string> = {
  bold: 'du **gras** ici',
  italic: 'de l’*italique* ici',
  code: 'la commande `pnpm test`',
  heading1: '# Titre',
  heading2: '## Sous-titre',
  heading3: '### Petit titre',
  dashList: '- pain',
  starList: '* lait',
  numbered: '1. premier',
  numberedParen: '2) second',
  task: '- [ ] appeler',
  taskDone: '- [x] écrire',
  taskStar: '* [X] fait',
  quote: '> une citation',
  link: 'voir [la doc](https://example.org/doc?x=1)',
  bare: 'collée : https://example.org/a_b(c), ensuite',
  nested: '**gras et *italique*** puis `code *pas italique*`',
  boldLink: '[**lien gras**](https://example.org/)',
  indented: '  - sous-élément'
}

describe('a note read and put back', () => {
  it('gives back every case it recognises, character for character', () => {
    for (const [name, source] of Object.entries(CASES)) expect(noteSource(parseNote(source)), name).toBe(source)
    const all = Object.values(CASES).join('\n')
    expect(noteSource(parseNote(all))).toBe(all)
  })

  it('gives back any text at all: random runs of the characters Markdown reads, two thousand of them', () => {
    // A fixed sequence (a linear congruential generator): the same texts on every run.
    let seed = 42
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const alphabet = ['*', '**', '`', '[', ']', '(', ')', '](', '#', '# ', '- ', '-', '>', '> ', '1. ', '[ ]', '[x]', ' ', '  ', '\n', '\t', 'a', 'é', 'mot', 'https://', 'example.org', 'javascript:', '<b>', '.', ',']
    for (let run = 0; run < 2000; run++) {
      const text = Array.from({ length: Math.floor(next() * 30) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('')
      expect(noteSource(parseNote(text)), JSON.stringify(text)).toBe(text)
      expect(allPieces(text).every((piece) => piece.href === undefined || safeNoteHref(piece.href) === piece.href), JSON.stringify(text)).toBe(true)
    }
  })

  it('reads **bold**, *italic* and `code` with their marks apart', () => {
    expect(look(parseNoteLine(CASES['bold']!))).toEqual(['du ', '**(mark)', 'gras(strong)', '**(mark)', ' ici'])
    expect(look(parseNoteLine(CASES['italic']!))).toEqual(['de l’', '*(mark)', 'italique(em)', '*(mark)', ' ici'])
    expect(look(parseNoteLine(CASES['code']!))).toEqual(['la commande ', '`(mark)', 'pnpm test(code)', '`(mark)'])
    // Inside code nothing else is read; inside bold, italic is.
    expect(look(parseNoteLine(CASES['nested']!))).toEqual(['**(mark)', 'gras et (strong)', '*(mark strong)', 'italique(strong em)', '*(mark strong)', '**(mark)', ' puis ', '`(mark)', 'code *pas italique*(code)', '`(mark)'])
  })

  it('reads the titles, the lists, the tasks and the quotes by the start of their line', () => {
    expect(parseNoteLine('# Titre')).toMatchObject({ kind: 'heading', level: 1 })
    expect(parseNoteLine('## Sous-titre')).toMatchObject({ kind: 'heading', level: 2 })
    expect(parseNoteLine('### Petit titre')).toMatchObject({ kind: 'heading', level: 3 })
    expect(look(parseNoteLine('# Titre'))).toEqual(['# (mark)', 'Titre'])
    expect(parseNoteLine('- pain').kind).toBe('bullet')
    expect(parseNoteLine('* lait').kind).toBe('bullet')
    expect(look(parseNoteLine('1. premier'))).toEqual(['1. (number)', 'premier'])
    expect(parseNoteLine('2) second').kind).toBe('ordered')
    expect(parseNoteLine('- [ ] appeler')).toMatchObject({ kind: 'task', checked: false })
    expect(look(parseNoteLine('- [ ] appeler'))).toEqual(['- (mark)', '[ ](box)', ' (mark)', 'appeler'])
    expect(parseNoteLine('- [x] écrire')).toMatchObject({ kind: 'task', checked: true })
    expect(parseNoteLine('* [X] fait')).toMatchObject({ kind: 'task', checked: true })
    expect(look(parseNoteLine('> une citation'))).toEqual(['> (mark)', 'une citation'])
    expect(look(parseNoteLine('  - sous-élément'))).toEqual(['  ', '- (mark)', 'sous-élément'])
  })

  it('reads [text](address) as a link to that address, and a bare address as a link without what ends its sentence', () => {
    expect(look(parseNoteLine(CASES['link']!))).toEqual(['voir ', '[(mark)', 'la doc(→https://example.org/doc?x=1)', ']((mark)', 'https://example.org/doc?x=1(mark url)', ')(mark)'])
    expect(look(parseNoteLine(CASES['bare']!))).toEqual(['collée : ', 'https://example.org/a_b(c)(→https://example.org/a_b(c))', ', ensuite'])
    expect(look(parseNoteLine('(voir https://example.org/x).'))).toEqual(['(voir ', 'https://example.org/x(→https://example.org/x)', ').'])
    expect(look(parseNoteLine(CASES['boldLink']!))).toEqual(['[(mark)', '**(mark →https://example.org/)', 'lien gras(strong →https://example.org/)', '**(mark →https://example.org/)', ']((mark)', 'https://example.org/(mark url)', ')(mark)'])
  })
})

describe('a bare address followed by a long run of closing brackets', () => {
  it('keeps the brackets it opens, drops the others, and takes a time that grows with the text, not with its square', () => {
    expect(look(parseNoteLine('https://example.org/a(b))))'))).toEqual(['https://example.org/a(b)(→https://example.org/a(b))', ')))'])
    const line = `https://x.example/${')'.repeat(20_000)}`
    const start = performance.now()
    const pieces = parseNoteLine(line)
    // The recount at each bracket took about 2 s for this line; once, a few milliseconds.
    expect(performance.now() - start).toBeLessThan(250)
    expect(look(pieces)[0]).toBe('https://x.example/(→https://x.example/)')
  })
})

describe('an old note, in plain text', () => {
  const OLD = [
    'Liste de courses',
    '',
    '5 * 3 * 2 = 30 et 2 ** 3',
    '#mot-clé sans espace, #### quatre dièses',
    '<b>pas du HTML</b> <script>alert(1)</script>',
    '\tune tabulation,   trois blancs, une espace insécable',
    'une étoile * seule, un `seul accent grave',
    '-[] pas une case, -pas une liste, 1.pas un numéro, >pas une citation',
    '',
    '',
    'fin   '
  ].join('\n')

  it('opens as the very text it was, every blank, line and character kept', () => {
    expect(noteSource(parseNote(OLD))).toBe(OLD)
    expect(noteSource(parseNote(''))).toBe('')
    expect(parseNote('')).toEqual([{ kind: 'blank', pieces: [] }])
  })

  it('takes nothing of it for a mark: no title, list, emphasis or link where plain text never meant one', () => {
    const lines = parseNote(OLD)
    expect(lines.map((line) => line.kind)).toEqual(['paragraph', 'blank', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph', 'blank', 'blank', 'paragraph'])
    expect(lines.flatMap((line) => line.pieces).every((piece) => piece.kind === 'text' && !piece.strong && !piece.em && !piece.code && piece.href === undefined)).toBe(true)
  })
})

describe('the addresses a note may open', () => {
  it('are web pages and mail addresses only, as the URL parser writes them', () => {
    expect(safeNoteHref('https://example.org')).toBe('https://example.org/')
    expect(safeNoteHref('HTTP://Example.org/a')).toBe('http://example.org/a')
    expect(safeNoteHref('mailto:loic@example.org')).toBe('mailto:loic@example.org')
    expect(safeNoteHref('MAILTO:loic@example.org?subject=Salut')).toBe('mailto:loic@example.org?subject=Salut')
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'vbscript:x', 'about:blank', 'chrome://settings', '//example.org', 'example.org', 'https://', '', 'mailto://host/x', 'mailto:', 'mailto:a b@c.d', 'mailto:a@b.c\u0000', 'tel:+33100000000']) {
      expect(safeNoteHref(bad), bad).toBeNull()
    }
    expect(look(parseNoteLine('[Loïc](mailto:loic@example.org)'))).toEqual(['[(mark)', 'Loïc(→mailto:loic@example.org)', ']((mark)', 'mailto:loic@example.org(mark url)', ')(mark)'])
  })

  it('never makes a link of `javascript:`, `data:` or `file:`: their text stays text, kept as it was typed', () => {
    for (const source of ['[clic](javascript:alert(1))', '[clic](JAVASCRIPT:alert(document.cookie))', '[x](data:text/html,<script>alert(1)</script>)', '[x](file:///etc/passwd)', 'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=']) {
      expect(allPieces(source).some((piece) => piece.href !== undefined), source).toBe(false)
      expect(noteSource(parseNote(source)), source).toBe(source)
    }
    // A web address after it on the same line is still a link.
    expect(allPieces('[x](javascript:alert(1)) https://example.org').filter((piece) => piece.href !== undefined).map((piece) => piece.href)).toEqual(['https://example.org/'])
  })

  it('keeps HTML as the text it is: a tag is never a piece of its own', () => {
    const source = '<img src=x onerror=alert(1)> **<script>alert(2)</script>** [<b>x</b>](https://example.org)'
    expect(noteSource(parseNote(source))).toBe(source)
    const text = allPieces(source).filter((piece) => piece.kind === 'text').map((piece) => piece.text).join('')
    expect(text).toContain('<img src=x onerror=alert(1)>')
    expect(text).toContain('<script>alert(2)</script>')
  })
})

describe('what the visual editor reads besides', () => {
  it('reads ~~struck~~, __bold__ and _italic_, but never an underscore inside a word', () => {
    expect(look(parseNoteLine('un ~~barré~~ ici'))).toEqual(['un ', '~~(mark)', 'barré(strike)', '~~(mark)', ' ici'])
    expect(look(parseNoteLine('__gras__ et _penché_'))).toEqual(['__(mark)', 'gras(strong)', '__(mark)', ' et ', '_(mark)', 'penché(em)', '_(mark)'])
    expect(look(parseNoteLine('snake_case_name et __init__.py'))).toEqual(['snake_case_name et ', '__(mark)', 'init(strong)', '__(mark)', '.py'])
    expect(look(parseNoteLine('~ seul ~ et ~~ espacé ~~'))).toEqual(['~ seul ~ et ~~ espacé ~~'])
  })

  it('reads a backslash before a sign as that sign, the backslash a mark; any other backslash is text', () => {
    expect(look(parseNoteLine('\\*pas italique\\*'))).toEqual(['\\(mark)', '*', 'pas italique', '\\(mark)', '*'])
    expect(allPieces('\\*x\\*').filter((piece) => piece.kind === 'text').every((piece) => !piece.em)).toBe(true)
    expect(look(parseNoteLine('C:\\Users\\moi'))).toEqual(['C:\\Users\\moi'])
  })

  it('reads code between runs of backquotes of one length, a backquote inside it', () => {
    expect(look(parseNoteLine('``a`b``'))).toEqual(['``(mark)', 'a`b(code)', '``(mark)'])
    expect(look(parseNoteLine('``a`'))).toEqual(['``a`'])
  })

  it('reads an italic that holds a bold, and a bold next to an italic', () => {
    expect(look(parseNoteLine('*a **b** c*'))).toEqual(['*(mark)', 'a (em)', '**(mark em)', 'b(strong em)', '**(mark em)', ' c(em)', '*(mark)'])
    expect(look(parseNoteLine('*a***b**'))).toEqual(['*(mark)', 'a(em)', '*(mark)', '**(mark)', 'b(strong)', '**(mark)'])
  })

  it('reads a block of code between two fences, nothing in it a mark; a fence nothing closes is text', () => {
    const lines = parseNote('```js\n**pas gras**\n\n```\n**gras**')
    expect(lines.map((line) => line.kind)).toEqual(['fence', 'code', 'code', 'fence', 'paragraph'])
    expect(lines[0]).toMatchObject({ fence: 'open', lang: 'js' })
    expect(lines[1]!.pieces).toEqual([{ kind: 'text', text: '**pas gras**', code: true }])
    expect(parseNote('```\npas fermé').map((line) => line.kind)).toEqual(['paragraph', 'paragraph'])
    expect(noteSource(parseNote('```\n```\n```'))).toBe('```\n```\n```')
    expect(notePlainText('# T\n```\nx = 1\n```')).toBe('T\nx = 1')
  })
})

describe('the plain text the list shows', () => {
  it('has no mark of Markdown left: a sign for an item, a box for a task, the text of a link', () => {
    expect(notePlainText('# Courses\n- **pain** et *lait*\n- [ ] appeler\n- [x] payer\n1. un\n> cité\nvoir [la doc](https://example.org/d) et `code`')).toBe(
      'Courses\n• pain et lait\n☐ appeler\n☑ payer\n1. un\ncité\nvoir la doc et code'
    )
    expect(notePlainText('  - imbriqué')).toBe('• imbriqué')
    expect(notePlainText('texte\n  - imbriqué')).toBe('texte\n  • imbriqué')
  })
})

describe('Return in the field', () => {
  const at = (text: string, caret = text.length): NoteEdit => ({ text, start: caret, end: caret })

  it('goes on with the list, the numbers, the tasks (an empty box) and the quote', () => {
    expect(enterEdit(at('- pain'))).toEqual(at('- pain\n- '))
    expect(enterEdit(at('* lait'))).toEqual(at('* lait\n* '))
    expect(enterEdit(at('  - sous'))).toEqual(at('  - sous\n  - '))
    expect(enterEdit(at('9. neuf'))).toEqual(at('9. neuf\n10. '))
    expect(enterEdit(at('1) un'))).toEqual(at('1) un\n2) '))
    expect(enterEdit(at('- [x] fait'))).toEqual(at('- [x] fait\n- [ ] '))
    expect(enterEdit(at('> cité'))).toEqual(at('> cité\n> '))
  })

  it('ends the list on an item that holds nothing yet, and adds no line', () => {
    expect(enterEdit(at('- pain\n- '))).toEqual(at('- pain\n'))
    expect(enterEdit(at('- [ ] '))).toEqual(at(''))
    expect(enterEdit(at('2. '))).toEqual(at(''))
  })

  it('is a plain new line elsewhere: in a paragraph, a title, inside the mark itself, and cuts a line in two', () => {
    expect(enterEdit(at('texte'))).toEqual(at('texte\n'))
    expect(enterEdit(at('# Titre'))).toEqual(at('# Titre\n'))
    expect(enterEdit(at('- pain', 1))).toEqual({ text: '-\n pain', start: 2, end: 2 })
    expect(enterEdit(at('- pain beurre', 7))).toEqual({ text: '- pain \n- beurre', start: 10, end: 10 })
  })
})

describe('⌘B and ⌘I', () => {
  it('put the marks around the selection, which stays on the text', () => {
    expect(toggleMarks({ text: 'du gras ici', start: 3, end: 7 }, '**')).toEqual({ text: 'du **gras** ici', start: 5, end: 9 })
    expect(toggleMarks({ text: 'un mot', start: 3, end: 6 }, '*')).toEqual({ text: 'un *mot*', start: 4, end: 7 })
    // The blanks at the ends of a selection stay outside the marks (a mark next to a blank is no mark).
    expect(toggleMarks({ text: 'a mot b', start: 1, end: 6 }, '**')).toEqual({ text: 'a **mot** b', start: 4, end: 7 })
  })

  it('take them away when they are there, around the selection or at its ends', () => {
    expect(toggleMarks({ text: 'du **gras** ici', start: 5, end: 9 }, '**')).toEqual({ text: 'du gras ici', start: 3, end: 7 })
    expect(toggleMarks({ text: 'du **gras** ici', start: 3, end: 11 }, '**')).toEqual({ text: 'du gras ici', start: 3, end: 7 })
    expect(toggleMarks({ text: 'un *mot*', start: 4, end: 7 }, '*')).toEqual({ text: 'un mot', start: 3, end: 6 })
    // Italic leaves a bold alone: `**` is not the mark of ⌘I.
    expect(toggleMarks({ text: '**gras**', start: 2, end: 6 }, '*')).toEqual({ text: '***gras***', start: 3, end: 7 })
  })

  it('without a selection, put two marks in with the caret between them, and take them back at once', () => {
    const put = toggleMarks({ text: 'a  b', start: 2, end: 2 }, '**')
    expect(put).toEqual({ text: 'a **** b', start: 4, end: 4 })
    expect(toggleMarks(put, '**')).toEqual({ text: 'a  b', start: 2, end: 2 })
  })

  it('mark each line of a selection over several', () => {
    expect(toggleMarks({ text: 'un\n\ndeux', start: 0, end: 8 }, '**')).toEqual({ text: '**un**\n\n**deux**', start: 0, end: 16 })
  })
})

describe('⌘K', () => {
  it('makes a link of the selection, its placeholder address chosen to be typed over', () => {
    const edit = linkEdit({ text: 'voir la doc', start: 5, end: 11 })
    expect(edit.text).toBe('voir [la doc](https://)')
    expect(edit.text.slice(edit.start, edit.end)).toBe('https://')
  })

  it('makes a link of a chosen address, the caret where its text goes; an empty one without a selection', () => {
    expect(linkEdit({ text: 'https://example.org', start: 0, end: 19 })).toEqual({ text: '[](https://example.org)', start: 1, end: 1 })
    expect(linkEdit({ text: 'a ', start: 2, end: 2 })).toEqual({ text: 'a [](https://)', start: 3, end: 3 })
    // A link never spans two lines.
    expect(linkEdit({ text: 'a\nb', start: 0, end: 3 })).toEqual({ text: 'a\nb', start: 0, end: 3 })
  })
})

describe('the boxes of the tasks', () => {
  it('are checked and unchecked by their line, the text keeping its length (the caret stays where it is)', () => {
    expect(toggleTaskLine('- [ ] a\n- [x] b', 0)).toBe('- [x] a\n- [x] b')
    expect(toggleTaskLine('- [ ] a\n- [x] b', 1)).toBe('- [ ] a\n- [ ] b')
    expect(toggleTaskLine('  * [X] c', 0)).toBe('  * [ ] c')
    expect(toggleTaskLine('- pas une tâche', 0)).toBe('- pas une tâche')
    expect(toggleTaskLine('- [ ] a', 5)).toBe('- [ ] a')
  })

  it('are checked from the keyboard (⇧⌘U) on every task line the selection touches', () => {
    expect(toggleTasksEdit({ text: '- [ ] a\ntexte\n- [ ] b', start: 2, end: 2 })).toEqual({ text: '- [x] a\ntexte\n- [ ] b', start: 2, end: 2 })
    expect(toggleTasksEdit({ text: '- [ ] a\ntexte\n- [ ] b', start: 0, end: 20 })).toEqual({ text: '- [x] a\ntexte\n- [x] b', start: 0, end: 20 })
  })
})

describe('a paste', () => {
  it('puts in its text only, its lines kept, without the control characters a note does not keep', () => {
    expect(pastedText('un\r\ndeux\rtrois\u0000\u0007\tquatre\u007f')).toBe('un\ndeux\ntrois\tquatre')
    expect(pastedText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
  })

  it('replaces the selection, the caret after it, and is cut to what the note still has room for', () => {
    expect(pasteEdit({ text: 'a  b', start: 2, end: 2 }, 'x\r\ny', 10)).toEqual({ text: 'a x\ny b', start: 5, end: 5 })
    expect(pasteEdit({ text: 'abcdef', start: 1, end: 3 }, 'XYZ', 8)).toEqual({ text: 'aXYZdef', start: 4, end: 4 })
    expect(pasteEdit({ text: 'abcdef', start: 6, end: 6 }, 'XYZ', 8)).toEqual({ text: 'abcdefXY', start: 8, end: 8 })
    expect(pasteEdit({ text: 'abcdef', start: 6, end: 6 }, 'XYZ', 6)).toEqual({ text: 'abcdef', start: 6, end: 6 })
  })
})

describe('the length of a note in the field', () => {
  it('stops at the most a note holds, as a field’s maxLength does, and still lets a note that is too long get shorter', () => {
    expect(withinLimit('abc', 'abcd', 4)).toBe(true)
    expect(withinLimit('abcd', 'abcde', 4)).toBe(false)
    expect(withinLimit('abcdef', 'abcde', 4)).toBe(true)
    expect(withinLimit('abcdef', 'abcdef', 4)).toBe(true)
  })
})

describe('the history of the field', () => {
  const state = (text: string): NoteEdit => ({ text, start: text.length, end: text.length })

  it('takes a run of typing back in one step, and anything else step by step', () => {
    const history = new NoteHistory(state(''))
    history.record(state('a'), true, 1000)
    history.record(state('ab'), true, 1000 + TYPING_STEP_MS - 1)
    history.record(state('ab\n'), false, 1000 + TYPING_STEP_MS)
    history.record(state('ab\nc'), true, 1000 + TYPING_STEP_MS + 1)
    expect(history.undo()).toEqual(state('ab\n'))
    expect(history.undo()).toEqual(state('ab'))
    expect(history.undo()).toEqual(state(''))
    expect(history.undo()).toBeNull()
    expect(history.redo()).toEqual(state('ab'))
  })

  it('starts a new step after a pause, and forgets what was undone once something new is typed', () => {
    const history = new NoteHistory(state(''))
    history.record(state('a'), true, 0)
    history.record(state('ab'), true, TYPING_STEP_MS + 1)
    expect(history.undo()).toEqual(state('a'))
    history.record(state('ax'), true, TYPING_STEP_MS + 2)
    expect(history.redo()).toBeNull()
    expect(history.undo()).toEqual(state('a'))
  })
})
