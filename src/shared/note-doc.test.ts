// The note as the visual editor shows it: every construct the toolbar makes reads back as itself (Markdown → editor → Markdown, character for
// character), any other Markdown is kept as the text it is; a place on screen is a place in the Markdown and back; and the edits made on screen
// (typing, deleting, Return, the marks, the blocks, the links) write Markdown that shows what was meant, formats what is typed in Markdown, and never
// lose a character.

import { describe, expect, it } from 'vitest'
import {
  blockChars,
  deleteBackward,
  deleteForward,
  deleteVisible,
  deletionStep,
  enter,
  insertText,
  linkAddress,
  noteHtml,
  pasteMarkdown,
  readDoc,
  selectionMarkdown,
  selectionStyle,
  setBlocks,
  readableAddress,
  setLink,
  sourceAt,
  toggleCodeBlock,
  toggleInline,
  visibleAt,
  wordAt,
  writeBlock,
  type NoteDoc
} from './note-doc'

/** A note in a short form: its blocks, each `kind:text` with its looks: `**b**`, `*i*`, `~s~`, `` `c` ``, `[l→href]`. */
function look(doc: NoteDoc): string[] {
  return doc.blocks.map((block) => {
    let out = ''
    let open = ''
    const close = (): void => {
      out += open
      open = ''
    }
    for (const char of blockChars(block)) {
      const marks = `${char.strong ? '**' : ''}${char.em ? '*' : ''}${char.strike ? '~' : ''}${char.code ? '`' : ''}${char.href && !char.bare ? `[→${char.href}]` : ''}`
      if (marks !== open) {
        close()
        out += marks
        open = marks
      }
      out += char.ch
    }
    close()
    const kind = block.kind === 'heading' ? `h${block.level}` : block.kind === 'task' ? (block.checked ? 'done' : 'task') : block.kind
    return `${kind}:${out}`
  })
}

const shows = (source: string): string[] => look(readDoc(source))

/** The edit of a note at a place of its text (`|` marks it in `marked`): the Markdown and where the caret goes in it. */
function at(marked: string): { text: string; start: number; end: number } {
  const start = marked.indexOf('|')
  const second = marked.indexOf('|', start + 1)
  const text = marked.replace(/\|/g, '')
  return { text, start, end: second === -1 ? start : second - 1 }
}

/** An edit as `Markdown` with `|` where the caret (or the selection) is. */
const marked = (edit: { text: string; start: number; end: number } | null): string | null => {
  if (edit === null) return null
  const { text, start, end } = edit
  return start === end ? `${text.slice(0, start)}|${text.slice(start)}` : `${text.slice(0, start)}|${text.slice(start, end)}|${text.slice(end)}`
}

/** What the toolbar makes, as Markdown, each read back as itself. */
const CONSTRUCTS: Record<string, string> = {
  heading1: '# Réunion produit',
  heading2: '## Points vus',
  bold: 'avec **Loïc** sur la bêta',
  italic: 'une *idée* à creuser',
  strike: 'la ~~vieille~~ version',
  code: 'la version `0.2.14` est sortie',
  link: 'voir [la page](https://lucium.app/nouveautes)',
  mail: 'écrire à [Loïc](mailto:loic@example.org)',
  bullet: '- Contraste de la page validé',
  ordered: '1. premier\n2. second',
  task: '- [ ] Barre collée\n- [x] Contraste de la page',
  quote: '> Garder la publication à la main',
  codeBlock: '```\nconst a = 1\n\nreturn a\n```',
  codeBlockLang: '```js\nconsole.log("*pas italique*")\n```',
  nested: '**gras et *italique***',
  boldLink: '[**lien gras**](https://example.org/)',
  boldItalicNext: '**gras** *italique*',
  mixed: '*a **b** c*',
  escaped: 'une \\*étoile\\* et un \\`accent\\`'
}

describe('a note read by the visual editor', () => {
  it('shows the result of each construct, its marks taken out', () => {
    expect(shows(CONSTRUCTS['heading1']!)).toEqual(['h1:Réunion produit'])
    expect(shows(CONSTRUCTS['heading2']!)).toEqual(['h2:Points vus'])
    expect(shows(CONSTRUCTS['bold']!)).toEqual(['paragraph:avec **Loïc** sur la bêta'])
    expect(shows(CONSTRUCTS['italic']!)).toEqual(['paragraph:une *idée* à creuser'])
    expect(shows(CONSTRUCTS['strike']!)).toEqual(['paragraph:la ~vieille~ version'])
    expect(shows(CONSTRUCTS['code']!)).toEqual(['paragraph:la version `0.2.14` est sortie'])
    expect(shows(CONSTRUCTS['link']!)).toEqual(['paragraph:voir [→https://lucium.app/nouveautes]la page[→https://lucium.app/nouveautes]'])
    expect(shows(CONSTRUCTS['mail']!)).toEqual(['paragraph:écrire à [→mailto:loic@example.org]Loïc[→mailto:loic@example.org]'])
    expect(shows(CONSTRUCTS['bullet']!)).toEqual(['bullet:Contraste de la page validé'])
    expect(shows(CONSTRUCTS['ordered']!)).toEqual(['ordered:premier', 'ordered:second'])
    expect(shows(CONSTRUCTS['task']!)).toEqual(['task:Barre collée', 'done:Contraste de la page'])
    expect(shows(CONSTRUCTS['quote']!)).toEqual(['quote:Garder la publication à la main'])
    expect(shows(CONSTRUCTS['codeBlock']!)).toEqual(['code:const a = 1\n\nreturn a'])
    expect(shows(CONSTRUCTS['codeBlockLang']!)).toEqual(['code:console.log("*pas italique*")'])
    expect(shows(CONSTRUCTS['mixed']!)).toEqual(['paragraph:*a ****b**** c*'])
    expect(shows(CONSTRUCTS['escaped']!)).toEqual(['paragraph:une *étoile* et un `accent`'])
  })

  it('keeps any other Markdown as the text it is: tables, images, HTML, a fence nothing closes, deeper titles', () => {
    const other = ['| a | b |', '|---|---|', '![image](https://example.org/i.png)', '<b>gras ?</b> <script>alert(1)</script>', '#### quatre', '```', 'pas fermé', '***', '\\', 'C:\\Users\\moi']
    const doc = readDoc(other.join('\n'))
    // An image is no construct of a note: its `!` stays text before a link to the picture.
    expect(doc.text).toBe(['| a | b |', '|---|---|', '!image', '<b>gras ?</b> <script>alert(1)</script>', '#### quatre', '```', 'pas fermé', '***', '\\', 'C:\\Users\\moi'].join('\n'))
    expect(doc.blocks.every((block) => block.kind === 'paragraph')).toBe(true)
  })
})

describe('a place on screen and in the Markdown', () => {
  it('goes from one to the other, either side of the marks hidden there', () => {
    const doc = readDoc('a **gras** b')
    // "a |gras": before the bold run (left) or inside it (right).
    expect(sourceAt(doc, 2, 'left')).toBe(2)
    expect(sourceAt(doc, 2, 'right')).toBe(4)
    expect(sourceAt(doc, 6, 'left')).toBe(8)
    expect(sourceAt(doc, 6, 'right')).toBe(10)
    for (let source = 0; source <= doc.source.length; source++) expect(visibleAt(doc, sourceAt(doc, visibleAt(doc, source)))).toBe(visibleAt(doc, source))
  })

  it('puts a place at the start of a line after its title mark, sign or box, never inside it', () => {
    const doc = readDoc('# Titre\n- [ ] tâche\n```js\ncode\n```')
    expect(sourceAt(doc, 0, 'left')).toBe(2)
    expect(sourceAt(doc, 6, 'right')).toBe(14)
    expect(visibleAt(doc, 0)).toBe(0)
    expect(visibleAt(doc, 9)).toBe(6)
    // In a block of code: its lines, the fences out of reach.
    expect(sourceAt(doc, 12, 'left')).toBe(doc.source.indexOf('code'))
    expect(visibleAt(doc, doc.source.indexOf('```js'))).toBe(12)
  })
})

describe('the round trip of a note: Markdown → editor → Markdown', () => {
  it('writes every construct of the toolbar again exactly as it was, block by block', () => {
    for (const [name, source] of Object.entries(CONSTRUCTS)) {
      const doc = readDoc(source)
      for (const block of doc.blocks) {
        if (block.kind === 'code') continue
        const written = writeBlock({ kind: block.kind, ...(block.level ? { level: block.level } : {}), ...(block.checked !== undefined ? { checked: block.checked } : {}), prefix: source.slice(block.from, block.contentFrom) }, blockChars(block))
        expect(written, name).toBe(source.slice(block.from, block.to))
      }
    }
  })

  it('changes nothing in a note that is only read, whatever it holds', () => {
    let seed = 7
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const alphabet = ['*', '**', '_', '__', '~~', '`', '```', '\\', '[', ']', '(', ')', '](', '# ', '- ', '> ', '1. ', '[ ]', ' ', '\n', 'a', 'é', 'https://x.org', 'mailto:a@b.c']
    for (let run = 0; run < 1500; run++) {
      const text = Array.from({ length: Math.floor(next() * 24) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('')
      const doc = readDoc(text)
      expect(doc.source).toBe(text)
      // Every place of the text is a place of the Markdown, and back.
      for (let visible = 0; visible <= doc.text.length; visible++) {
        expect(visibleAt(doc, sourceAt(doc, visible, 'left')), JSON.stringify(text)).toBe(visible)
        expect(visibleAt(doc, sourceAt(doc, visible, 'right')), JSON.stringify(text)).toBe(visible)
      }
    }
  })
})

describe('typing', () => {
  const type = (text: string, typed: string) => {
    let edit = at(text)
    for (const ch of typed) edit = insertText(edit.text, edit.start, edit.end, ch)
    return marked(edit)
  }

  it('puts the text where the caret is, the rest of the note as it was', () => {
    expect(type('Réunion |', 'produit')).toBe('Réunion produit|')
    expect(type('# |', 'Titre')).toBe('# Titre|')
  })

  it('formats Markdown as it is typed: titles, lists, boxes, quotes, bold, italic, struck, code, links', () => {
    expect(shows(at(type('|', '# Titre')!).text)).toEqual(['h1:Titre'])
    expect(shows(at(type('|', '- [ ] tâche')!).text)).toEqual(['task:tâche'])
    expect(shows(at(type('|', '> cité')!).text)).toEqual(['quote:cité'])
    expect(shows(at(type('|', 'du **gras** et *ital* et ~~barré~~ et `code`')!).text)).toEqual(['paragraph:du **gras** et *ital* et ~barré~ et `code`'])
    expect(shows(at(type('|', 'voir [ici](https://example.org)')!).text)).toEqual(['paragraph:voir [→https://example.org/]ici[→https://example.org/]'])
  })

  it('makes bold of `**gras**` typed one sign after the other, though `**gras*` read as an italic on the way', () => {
    expect(type('du |', '**gras**')).toBe('du **gras**|')
    expect(shows(at(type('du |', '**gras** et __ceci__')!).text)).toEqual(['paragraph:du **gras** et **ceci**'])
  })

  it('never puts what is typed after a link into its hidden address', () => {
    const edit = at('[lien](https://example.org/)|')
    // The caret at the end of the label (where the browser puts it at the end of the line): typed text goes after the link.
    expect(marked(insertText(edit.text, 5, 5, 'x'))).toBe('[lien](https://example.org/)x|')
    expect(marked(insertText(edit.text, 5, 5, '*'))).toBe('[lien](https://example.org/)*|')
    // Nor into it when the place after the link is inside the code that follows: the text goes between them.
    expect(marked(insertText('[a](https://e.org/)`c`', 2, 2, 'x'))).toBe('[a](https://e.org/)x|`c`')
  })

  it('goes on with the look of a bold or italic run it ends, but not with a link or code', () => {
    expect(type('**gras|**', 'x')).toBe('**grasx|**')
    expect(type('[lien|](https://example.org)', 'x')).toBe('[lien](https://example.org)x|')
    expect(type('`code|`', 'x')).toBe('`code`x|')
  })

  it('never ends a run by what it types inside it: a star or a blank in an italic', () => {
    expect(shows(at(type('*ab|cd*', '*')!).text)).toEqual(['paragraph:*ab*cd*'])
    expect(shows(at(type('*mot|*', ' suite')!).text)).toEqual(['paragraph:*mot* suite'])
    // A star typed at the end of an italic, inside it: the italic's own closing mark never becomes the star that shows.
    expect(insertText('*a*', 2, 2, '*').text).toBe('_a*_')
  })

  it('never changes the look of what was there to that of a run a sign closes, when a button asked for another look', () => {
    // `**gras*` reads as a star and an italic; ⌘B (bold off) then `*` must not make it bold.
    const out = insertText('**gras*', 7, 7, '*', {})
    const chars = blockChars(readDoc(out.text).blocks[0]!).map((char) => `${char.ch}${char.em ? '/i' : ''}${char.strong ? '/b' : ''}`)
    expect(chars).toEqual(['*', 'g/i', 'r/i', 'a/i', 's/i', '*'])
  })

  it('types with the look asked for with no selection (⌘B then typing), as a run of its own', () => {
    const edit = at('un |')
    const next = insertText(edit.text, edit.start, edit.end, 'g', { strong: true })
    expect(marked(next)).toBe('un **g|**')
    const out = insertText('**gras**', 6, 6, 'x', {})
    expect(shows(out.text)).toEqual(['paragraph:**gras**x'])
  })

  it('replaces a selection by what is typed, with the look of the selection', () => {
    expect(shows(insertText('a **gras** b', 4, 8, 'X').text)).toEqual(['paragraph:a **X** b'])
  })

  it('takes a first line in a block of code with none', () => {
    expect(marked(insertText('```\n```', 4, 4, 'x'))).toBe('```\nx|\n```')
    expect(marked(insertText('```\n\n```', 4, 4, 'x'))).toBe('```\nx|\n```')
  })
})

describe('deleting', () => {
  const del = (text: string) => {
    const edit = at(text)
    const doc = readDoc(edit.text)
    return marked(deleteVisible(edit.text, visibleAt(doc, edit.start), visibleAt(doc, edit.end)))
  }
  const back = (text: string) => {
    const edit = at(text)
    return marked(deleteBackward(edit.text, edit.start, edit.end))
  }
  const forward = (text: string) => {
    const edit = at(text)
    return marked(deleteForward(edit.text, edit.start, edit.end))
  }

  it('takes the characters out, and the marks of a run it empties', () => {
    expect(back('**ab|**')).toBe('**a|**')
    expect(del('a **|gras|** b')).toBe('a | b')
    expect(back('a **g|** b')).toBe('a | b')
  })

  it('never leaves half of a mark: what is left keeps its look', () => {
    const out = del('**ab|cd** e|f')
    expect(shows(at(out!).text)).toEqual(['paragraph:**ab**f'])
  })

  it('turns a title, an item, a box or a quote into a paragraph at the start of its text, and joins a paragraph to the line before', () => {
    expect(back('# |Titre')).toBe('|Titre')
    expect(back('- [ ] |tâche')).toBe('|tâche')
    expect(back('> |cité')).toBe('|cité')
    expect(back('un\n|deux')).toBe('un|deux')
    // The caret after the last character of the line before: what is typed there goes on with its look.
    expect(back('**un**\n|deux')).toBe('**un|**deux')
    expect(forward('un|\ndeux')).toBe('un|deux')
  })

  it('keeps what a line holds when its start goes, even when it reads as Markdown on its own', () => {
    expect(shows(at(back('- |# pas un titre')!).text)).toEqual(['paragraph:# pas un titre'])
  })

  it('unwraps a block of code at its start, and never joins a line to one', () => {
    expect(back('```\n|a\nb\n```')).toBe('|a\nb')
    expect(back('```\na\n```\n|suite')).toBe('```\na|\n```\nsuite')
    expect(back('```\na\n```\n|')).toBe('```\na|\n```')
  })

  it('across blocks, keeps the first block’s kind and joins what is left', () => {
    expect(shows(at(del('# Ti|tre\n- un\n- de|ux')!).text)).toEqual(['h1:Tiux'])
    expect(shows(at(del('a|b\n```\nc|d\n```')!).text)).toEqual(['paragraph:a', 'code:d'])
  })

  it('takes a whole emoji with ⌫', () => {
    expect(back('a👍🏽|')).toBe('a|')
  })

  it('takes the word before with ⌥⌫ (its run kept), the start of the line with ⌘⌫, the word or the rest of the line after with ⌥⌦ and ⌘⌦', () => {
    const word = (text: string, forward = false) => {
      const edit = at(text)
      return marked((forward ? deleteForward : deleteBackward)(edit.text, edit.start, edit.end, 'word'))
    }
    expect(word('un **mot gras** fin|')).toBe('un **mot gras** |')
    expect(word('un **mot gras** |')).toBe('un **mot** |')
    expect(word('|un mot', true)).toBe('| mot')
    const edit = at('# un **deux** |trois')
    expect(marked(deleteBackward(edit.text, edit.start, edit.end, 'line'))).toBe('# |trois')
    expect(marked(deleteForward(edit.text, edit.start, edit.end, 'line'))).toBe('# un **deux** |')
    // In a block of code, never past its line.
    const code = at('```\nabc\nde|f\n```')
    expect(marked(deleteBackward(code.text, code.start, code.end, 'line'))).toBe('```\nabc\n|f\n```')
    expect(deletionStep('abc def', 7, 'word', false)).toBe(4)
    expect(deletionStep('abc def', 0, 'word', true)).toBe(3)
    expect(wordAt('un mot ici', 4)).toEqual([3, 6])
    expect(wordAt('un  ici', 3)).toBeNull()
  })
})

describe('Return', () => {
  const ret = (text: string) => {
    const edit = at(text)
    return marked(enter(edit.text, edit.start, edit.end))
  }

  it('goes on with a list, the numbers, a box, a quote; ends them on an empty one', () => {
    expect(ret('- pain|')).toBe('- pain\n- |')
    expect(ret('9. neuf|')).toBe('9. neuf\n10. |')
    expect(ret('- [x] fait|')).toBe('- [x] fait\n- [ ] |')
    expect(ret('> cité|')).toBe('> cité\n> |')
    expect(ret('- pain\n- |')).toBe('- pain\n|')
  })

  it('cuts a run in two, each half keeping its look', () => {
    const out = ret('**ab|cd**')
    expect(shows(at(out!).text)).toEqual(['paragraph:**ab**', 'paragraph:**cd**'])
    expect(at(out!).start).toBe(at(out!).text.indexOf('cd'))
  })

  it('makes a paragraph after a title, an empty line before a title it starts', () => {
    expect(ret('# Titre|')).toBe('# Titre\n|')
    expect(ret('# |Titre')).toBe('\n# |Titre')
  })

  it('opens a block of code after ``` and leaves it on an empty last line', () => {
    expect(ret('```js|')).toBe('```js\n|\n```')
    expect(ret('```\na|\n```')).toBe('```\na\n|\n```')
    expect(ret('```\na\n|\n```')).toBe('```\na\n```\n|')
  })
})

describe('the buttons of the toolbar', () => {
  const inline = (text: string, mark: 'strong' | 'em' | 'strike' | 'code') => {
    const edit = at(text)
    return marked(toggleInline(edit.text, edit.start, edit.end, mark))
  }
  const blocks = (text: string, choice: Parameters<typeof setBlocks>[3]) => {
    const edit = at(text)
    return marked(setBlocks(edit.text, edit.start, edit.end, choice))
  }

  it('put bold, italic, struck and code on a selection, which stays on its text, and take them off', () => {
    expect(inline('du |gras| ici', 'strong')).toBe('du **|gras|** ici')
    expect(inline('du **|gras|** ici', 'strong')).toBe('du |gras| ici')
    expect(inline('un |mot|', 'em')).toBe('un *|mot|*')
    expect(inline('la |vieille| version', 'strike')).toBe('la ~~|vieille|~~ version')
    expect(inline('la |0.2.14|', 'code')).toBe('la `|0.2.14|`')
    // Part of a bold run: only that part loses it.
    expect(shows(at(inline('**b|old|**', 'strong')!).text)).toEqual(['paragraph:**b**old'])
    // Blanks at the ends stay outside the marks.
    expect(inline('a| mot |b', 'strong')).toBe('a| **mot** |b')
  })

  it('mix bold and italic next to each other and inside each other, each reading back as itself', () => {
    const one = toggleInline('gras italique', 0, 4, 'strong')!
    const two = toggleInline(one.text, readDocSource(one.text, 5), readDocSource(one.text, 13), 'em')!
    expect(shows(two.text)).toEqual(['paragraph:**gras** *italique*'])
    // A caret alone changes nothing in the note: the look is for what is typed next (the editor keeps it).
    expect(toggleInline('abcd', 2, 2, 'em')).toBeNull()
    const adjacent = toggleInline('**ab**cd', 6, 8, 'em')!
    expect(shows(adjacent.text)).toEqual(['paragraph:**ab***cd*'])
  })

  it('make titles, lists, boxes and quotes of the lines of a selection, and paragraphs again', () => {
    expect(blocks('Réunion|', { kind: 'heading', level: 1 })).toBe('# Réunion|')
    expect(blocks('# Réunion|', { kind: 'heading', level: 2 })).toBe('## Réunion|')
    expect(blocks('## Réunion|', { kind: 'heading', level: 2 })).toBe('Réunion|')
    expect(blocks('|un\n\ndeux|', { kind: 'bullet' })).toBe('- |un\n\n- deux|')
    expect(blocks('|un\ndeux|', { kind: 'ordered' })).toBe('1. |un\n2. deux|')
    expect(blocks('1. un\n|deux|', { kind: 'ordered' })).toBe('1. un\n2. |deux|')
    expect(blocks('|un|', { kind: 'task' })).toBe('- [ ] |un|')
    expect(blocks('- [ ] |un|', { kind: 'task' })).toBe('|un|')
    expect(blocks('|cité|', { kind: 'quote' })).toBe('> |cité|')
    expect(blocks('- |un|', { kind: 'ordered' })).toBe('1. |un|')
    expect(blocks('|', { kind: 'bullet' })).toBe('- |')
  })

  it('keep a paragraph a paragraph when its text reads as Markdown alone', () => {
    expect(shows(at(blocks('# |- pas une liste|', { kind: 'heading', level: 1 })!).text)).toEqual(['paragraph:- pas une liste'])
  })

  it('wrap lines in a block of code, and unwrap it', () => {
    expect(marked(toggleCodeBlock('', 0, 0))).toBe('```\n|\n```')
    const wrapped = toggleCodeBlock('**a**\nb', 0, 7)!
    expect(wrapped.text).toBe('```\na\nb\n```')
    expect(toggleCodeBlock(wrapped.text, wrapped.start, wrapped.end)!.text).toBe('a\nb')
  })

  it('link a selection to an address, change it, and take it off; a caret alone writes the address as a link', () => {
    const linked = setLink('voir la page', 5, 12, 'https://lucium.app/nouveautes')!
    expect(linked.text).toBe('voir [la page](https://lucium.app/nouveautes)')
    expect(selectionStyle(readDoc(linked.text), linked.start, linked.end).href).toBe('https://lucium.app/nouveautes')
    const caretOn = linked.text.indexOf('page')
    expect(setLink(linked.text, caretOn, caretOn, 'https://example.org/autre')!.text).toBe('voir [la page](https://example.org/autre)')
    expect(setLink(linked.text, caretOn, caretOn, null)!.text).toBe('voir la page')
    expect(setLink('écrire à ', 9, 9, 'mailto:loic@example.org')!.text).toBe('écrire à [loic@example.org](mailto:loic@example.org)')
    // An address whose escapes are not valid (Latin-1, a `%` alone) is written as it is: inserting the link does not throw.
    expect(setLink('écrire à ', 9, 9, 'mailto:lo%C3%AFc@example.org')!.text).toBe('écrire à [loïc@example.org](mailto:lo%C3%AFc@example.org)')
    expect(setLink('écrire à ', 9, 9, 'mailto:ren%E9@exemple.fr')!.text).toBe('écrire à [ren%E9@exemple.fr](mailto:ren%E9@exemple.fr)')
    expect(setLink('x', 0, 1, 'https://fr.wikipedia.org/wiki/Paris_(ville)')!.text).toBe('[x](https://fr.wikipedia.org/wiki/Paris_%28ville%29)')
  })

  it('a mail address whose escapes are not UTF-8, or that holds a lone %, makes a link labelled as it is written instead of throwing', () => {
    // `%E9` is « é » in Latin-1: what a page of that encoding writes in a link. decodeURIComponent throws on it.
    expect(readableAddress('ren%E9@exemple.fr')).toBe('ren%E9@exemple.fr')
    expect(readableAddress('a%@b.c')).toBe('a%@b.c')
    expect(readableAddress('ren%C3%A9@exemple.fr')).toBe('rené@exemple.fr')
    expect(setLink('écrire à ', 9, 9, 'mailto:ren%E9@exemple.fr')!.text).toBe('écrire à [ren%E9@exemple.fr](mailto:ren%E9@exemple.fr)')
  })

  it('refuse an address that is not a web page or a mail address', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'mailto://host/x', 'ftp://example.org']) {
      expect(linkAddress(bad), bad).toBeNull()
      expect(setLink('mot', 0, 3, bad), bad).toBeNull()
      // A link already there stays as it was.
      expect(setLink('[mot](https://e.org/)', 1, 4, bad), bad).toBeNull()
    }
  })
})

describe('pasting', () => {
  const paste = (text: string, markdown: string, max = 4000) => {
    const edit = at(text)
    return marked(pasteMarkdown(edit.text, edit.start, edit.end, markdown, max))
  }

  it('puts the Markdown where the caret is, formatting itself, over the selection', () => {
    expect(paste('un | ici', '**gras**')).toBe('un **gras**| ici')
    expect(paste('un |mot| ici', 'autre')).toBe('un autre| ici')
  })

  it('starts a line of its own with a paste that starts with a title or an item', () => {
    expect(paste('texte|', '- un\n- deux')).toBe('texte\n- un\n- deux|')
    expect(paste('|', '# Titre')).toBe('# Titre|')
  })

  it('is cut to what the note still has room for', () => {
    expect(paste('abc|', 'defgh', 6)).toBe('abcdef|')
    expect(paste('abcdef|', 'x', 6)).toBe('abcdef|')
  })

  it('is code in a block of code, and never breaks the look of what was there', () => {
    expect(paste('```\nx|\n```', ' = *1*')).toBe('```\nx = *1*|\n```')
    expect(paste('*ab|cd*', 'x*y')).toBe('_abx*y|cd_')
  })
})

describe('copying', () => {
  it('gives the Markdown of a selection, its cut runs closed', () => {
    expect(selectionMarkdown('a **gras** b', 5, 7)).toBe('**ra**')
    expect(selectionMarkdown('# Titre\n- un', 0, 12)).toBe('# Titre\n- un')
    expect(selectionMarkdown('- un', 2, 4)).toBe('- un')
    expect(selectionMarkdown('- un deux', 2, 4)).toBe('un')
  })

  it('gives HTML with only the tags it writes, every text escaped', () => {
    expect(noteHtml('# T\n**g** *i* ~~s~~ `c` [l](https://e.org)\n- a\n- [x] b\n1. c\n> q\n```\n<x>\n```')).toBe(
      '<h1>T</h1><p><strong>g</strong> <em>i</em> <s>s</s> <code>c</code> <a href="https://e.org/">l</a></p><ul><li>a</li><li>☑ b</li></ul><ol><li>c</li></ol><blockquote><p>q</p></blockquote><pre><code>&lt;x&gt;</code></pre>'
    )
    expect(noteHtml('<img src=x onerror=alert(1)> "q" & [x](javascript:alert(1))')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; [x](javascript:alert(1))</p>')
    // The one escape of the application (html-escape.ts): the apostrophe too.
    expect(noteHtml("l'été [d'ici](https://e.org) `c'est`")).toBe('<p>l&#39;été <a href="https://e.org/">d&#39;ici</a> <code>c&#39;est</code></p>')
  })
})

/** The place in the Markdown of a place of the text it shows. */
function readDocSource(text: string, visible: number): number {
  return sourceAt(readDoc(text), visible, visible === 0 ? 'right' : 'left')
}
