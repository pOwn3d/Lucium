// The elements of the visual note editor, made and read on a small stand-in of the DOM (no browser in the tests): a note is drawn as what it shows
// (no mark of Markdown in any text node), every place of the elements is a place in the Markdown and back, an input method's writing is read back as
// text, and only text nodes, spans, lines, a `<br>` and the checkbox of a task are made: never an element of the note's own text, and only a web page
// or a mail address is ever the address of a link.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readDoc, readableAddress, sourceAt, visibleAt } from '@shared/note-doc'
import { blockIndexOfNode, drawDoc, openLinkTitle, pointOfSource, readShown, sourceOfPoint, visibleOfPoint, type EditorLabels } from './note-editor-dom'

// ---------- a stand-in of the DOM: what note-editor-dom.ts calls, no more ----------

class FakeNode {
  parentNode: FakeElement | null = null
  childNodes: FakeNode[] = []
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly ownerDocument: FakeDocument
  ) {}
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }
  contains(node: FakeNode | null): boolean {
    for (let at = node; at !== null; at = at.parentNode) if (at === this) return true
    return false
  }
}

class FakeText extends FakeNode {
  constructor(
    public data: string,
    doc: FakeDocument
  ) {
    super(3, '#text', doc)
  }
}

class FakeElement extends FakeNode {
  className = ''
  readonly attributes = new Map<string, string>()
  constructor(tag: string, doc: FakeDocument) {
    super(1, tag.toUpperCase(), doc)
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  appendChild<T extends FakeNode>(node: T): T {
    node.parentNode?.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }
  removeChild<T extends FakeNode>(node: T): T {
    this.childNodes.splice(this.childNodes.indexOf(node), 1)
    node.parentNode = null
    return node
  }
  replaceChild<T extends FakeNode>(node: T, old: FakeNode): T {
    node.parentNode?.removeChild(node)
    this.childNodes[this.childNodes.indexOf(old)] = node
    node.parentNode = this
    old.parentNode = null
    return node as T
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this)
  }
  createTextNode(data: string): FakeText {
    return new FakeText(data, this)
  }
}

const labels: EditorLabels = { box: 'Tâche faite', openLink: (url) => `⌘-clic pour ouvrir ${url}` }

/** A field with a note drawn in it. */
function field(text: string): FakeElement {
  const root = new FakeDocument().createElement('div')
  drawDoc(root as unknown as HTMLElement, readDoc(text), labels)
  return root
}
const asNode = (node: FakeNode): Node => node as unknown as Node

describe('the title of a link of a note', () => {
  it('names the address of a mail link as a person reads it, and the page of a web link', () => {
    expect(openLinkTitle('mailto:lo%C3%AFc@example.org')).toBe('⌘-clic pour écrire à loïc@example.org')
    expect(openLinkTitle('https://example.org/a%20b')).toBe('⌘-clic pour ouvrir https://example.org/a%20b dans un onglet')
  })

  it('writes a mail address whose escapes are not valid as it is, instead of throwing: the note is still drawn', () => {
    // `%E9` is « é » in Latin-1 (a link copied from an old page), and a `%` alone is no escape at all.
    expect(openLinkTitle('mailto:ren%E9@exemple.fr')).toBe('⌘-clic pour écrire à ren%E9@exemple.fr')
    expect(openLinkTitle('mailto:a%@b.c')).toBe('⌘-clic pour écrire à a%@b.c')
    const root = new FakeDocument().createElement('div')
    drawDoc(root as unknown as HTMLElement, readDoc('écrire à [René](mailto:ren%E9@exemple.fr), puis la suite'), { box: 'Tâche faite', openLink: openLinkTitle })
    const link = elements(root).find((element) => element.getAttribute('data-href') === 'mailto:ren%E9@exemple.fr')
    expect(link?.getAttribute('title')).toBe('⌘-clic pour écrire à ren%E9@exemple.fr')
    expect(readShown(root as unknown as HTMLElement)).toContain('puis la suite')
  })
})

/** Every element under a node, itself excluded. */
const elements = (node: FakeNode): FakeElement[] => node.childNodes.flatMap((child) => (child instanceof FakeElement ? [child, ...elements(child)] : []))
const texts = (node: FakeNode): FakeText[] => node.childNodes.flatMap((child) => (child instanceof FakeText ? [child] : texts(child)))

const NOTES = [
  '',
  '# Titre\n## Sous-titre\n### Petit',
  'du **gras**, de l’*italique*, du ~~barré~~ et du `code`',
  '- pain\n* lait\n1. un\n2) deux',
  '- [ ] appeler\n- [x] écrire\n  * [X] imbriqué',
  '> une citation\n>sans espace',
  'voir [la doc](https://example.org/doc), [Loïc](mailto:loic@example.org) et https://example.org/a.',
  '```js\nconst a = 1\n\nreturn a\n```\nsuite',
  'Liste de courses\n\n5 * 3 * 2\n#tag\n<script>alert(1)</script>\n\tfin   \n\n',
  '- [ ]',
  '**gras et *italique***'
]

describe('a note drawn', () => {
  it('shows what the note shows, and no mark of Markdown: its text nodes hold the text of its blocks only', () => {
    for (const text of NOTES) {
      const root = field(text)
      expect(readShown(asNode(root)), JSON.stringify(text)).toBe(readDoc(text).text)
    }
    expect(texts(field('# **Titre**\n- [x] *fait*')).map((node) => node.data)).toEqual(['Titre', 'fait'])
  })

  it('makes one element per block, a block of code one per line, an empty line holding a <br> so that it can take the caret', () => {
    const root = field('a\n\nb')
    expect(root.childNodes.map((line) => line.nodeName)).toEqual(['DIV', 'DIV', 'DIV'])
    expect(root.childNodes[1]!.childNodes.map((node) => node.nodeName)).toEqual(['BR'])
    const code = field('```\nx\n\ny\n```').childNodes[0] as FakeElement
    expect(code.className).toBe('nm-line nm-codeblock')
    expect(code.childNodes.map((line) => (line as FakeElement).childNodes.map((node) => node.nodeName))).toEqual([['#text'], ['BR'], ['#text']])
  })

  it('gives each block the look of its kind, an item its number or its depth, and each run the look of its marks', () => {
    const root = field('# Titre\n- [x] fait\n3. trois\n  - dedans\n**g** *i* ~~s~~ `c` [l](https://example.org)\n```py\nx\n```')
    const blocks = root.childNodes as FakeElement[]
    expect(blocks.map((line) => line.className)).toEqual(['nm-line nm-heading nm-h1', 'nm-line nm-task nm-done', 'nm-line nm-ordered', 'nm-line nm-bullet', 'nm-line nm-paragraph', 'nm-line nm-codeblock'])
    expect(blocks[2]!.getAttribute('data-number')).toBe('3.')
    expect(blocks[3]!.getAttribute('data-depth')).toBe('1')
    expect(blocks[5]!.getAttribute('data-lang')).toBe('py')
    const spans = elements(blocks[4]!).map((span) => `${span.className}:${texts(span).map((node) => node.data).join('')}`)
    expect(spans).toEqual(['nm-strong:g', 'nm-em:i', 'nm-strike:s', 'nm-code:c', 'nm-link:l'])
  })

  it('makes no element of the note’s own text, and links only to a web page or a mail address', () => {
    const hostile = '<img src=x onerror=alert(1)> **<script>alert(2)</script>** [x](javascript:alert(3)) [y](javascript:void0) [z](data:text/html,x) [f](file:///etc/passwd) [m](mailto:a@example.org)'
    const root = field(hostile)
    const tags = new Set(elements(root).map((element) => element.nodeName))
    expect([...tags].every((tag) => ['DIV', 'SPAN', 'BR'].includes(tag))).toBe(true)
    const hrefs = elements(root).map((element) => element.getAttribute('data-href')).filter((href) => href !== null)
    expect(hrefs).toEqual(['mailto:a@example.org'])
    expect(readShown(asNode(root))).toContain('<script>alert(2)</script>')
  })

  it('draws a task’s box as a checkbox the caret never goes into, named for assistive technology', () => {
    const line = field('- [x] fait').childNodes[0] as FakeElement
    const box = line.childNodes[0] as FakeElement
    expect(box.className).toBe('nm-box')
    expect(box.getAttribute('contenteditable')).toBe('false')
    const input = box.childNodes[0] as FakeElement
    expect([input.nodeName, input.getAttribute('type'), input.getAttribute('aria-label'), input.getAttribute('checked'), input.getAttribute('tabindex')]).toEqual(['INPUT', 'checkbox', 'Tâche faite', '', '-1'])
  })

  it('keeps the elements of a block drawn the same way, and draws again one the browser changed', () => {
    const root = field('un\ndeux')
    const first = root.childNodes[0]
    const second = root.childNodes[1]!
    drawDoc(root as unknown as HTMLElement, readDoc('un\ndeux!'), labels)
    expect(root.childNodes[0]).toBe(first)
    expect(root.childNodes[1]).not.toBe(second)
    // An input method wrote in the first line: it is drawn again from the note.
    ;(texts(root.childNodes[0]!)[0] as FakeText).data = 'unXX'
    drawDoc(root as unknown as HTMLElement, readDoc('un\ndeux!'), labels)
    expect(readShown(asNode(root))).toBe('un\ndeux!')
  })
})

describe('a place in the elements and in the Markdown', () => {
  it('goes from one to the other and back, for every place of every note', () => {
    for (const text of NOTES) {
      const doc = readDoc(text)
      const root = field(text)
      for (let source = 0; source <= text.length; source++) {
        const point = pointOfSource(asNode(root), doc, source)
        const back = sourceOfPoint(asNode(root), doc, point)
        // The same place of the text, on the same side of the marks hidden there.
        expect(back === null ? null : visibleAt(doc, back), `${JSON.stringify(text)} @${source}`).toBe(visibleAt(doc, source))
      }
    }
  })

  it('keeps the side of the hidden marks: inside the bold run at its end, after them at the start of the next run', () => {
    const text = 'a **gras** b'
    const doc = readDoc(text)
    const root = field(text)
    const inside = pointOfSource(asNode(root), doc, sourceAt(doc, 6, 'left'))
    expect((inside.node as unknown as FakeText).data).toBe('gras')
    expect(inside.offset).toBe(4)
    const after = pointOfSource(asNode(root), doc, sourceAt(doc, 6, 'right'))
    expect((after.node as unknown as FakeText).data).toBe(' b')
    expect(after.offset).toBe(0)
    expect(sourceOfPoint(asNode(root), doc, inside)).toBe(8)
    expect(sourceOfPoint(asNode(root), doc, after)).toBe(10)
  })

  it('puts the caret of an empty line before its <br>, of a task after its box, and reads a place in the box as the start of the text', () => {
    const doc = readDoc('a\n\n- [ ] t')
    const root = field('a\n\n- [ ] t')
    expect(pointOfSource(asNode(root), doc, 2)).toEqual({ node: root.childNodes[1], offset: 0 })
    const task = root.childNodes[2] as FakeElement
    expect(pointOfSource(asNode(root), doc, doc.source.length - 1)).toEqual({ node: texts(task)[0], offset: 0 })
    const box = task.childNodes[0] as FakeElement
    expect(visibleOfPoint(asNode(root), doc, { node: asNode(box.childNodes[0]!), offset: 0 })).toBe(3)
    expect(sourceOfPoint(asNode(root), doc, { node: asNode(task), offset: 0 })).toBe(doc.source.length - 1)
  })

  it('reads a place between the lines of a block of code as the start of the line after', () => {
    const text = '```\nab\ncd\n```'
    const doc = readDoc(text)
    const root = field(text)
    const code = root.childNodes[0]!
    expect(visibleOfPoint(asNode(root), doc, { node: asNode(code), offset: 1 })).toBe(3)
    expect(pointOfSource(asNode(root), doc, text.indexOf('cd'))).toEqual({ node: texts(code.childNodes[1]!)[0], offset: 0 })
  })

  it('finds the block of a node', () => {
    const root = field('a\n- [ ] b')
    const box = (root.childNodes[1] as FakeElement).childNodes[0]!
    expect(blockIndexOfNode(asNode(root), asNode(box))).toBe(1)
    expect(blockIndexOfNode(asNode(root), null)).toBe(-1)
  })
})

describe('a link whose address cannot be decoded', () => {
  it('is read for its hint by the tolerant reader in the editor: a note with such a link is still drawn', () => {
    // The hint of every link is made as the note is drawn; one that throws leaves a note that can no longer be opened.
    for (const name of ['./NoteTextEditor.tsx', './note-editor-dom.ts']) {
      expect(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8'), name).not.toContain('decodeURIComponent(')
    }
    const hint = (url: string): string => (url.startsWith('mailto:') ? `write to ${readableAddress(url.slice('mailto:'.length))}` : url)
    expect(hint('mailto:ren%E9@exemple.fr')).toBe('write to ren%E9@exemple.fr')
  })
})
