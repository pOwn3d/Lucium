// The elements of the visual note editor (NoteTextEditor.tsx), made and read without React. Each block of the note (shared/note-doc.ts) is one element:
// a line, or a block of code holding one element per line of code. What a block shows is in text nodes, alone or in a span that gives them their look;
// the marks of Markdown are in none of them (the editor shows the result, not the symbols). A task's box is a checkbox the caret never goes into, a
// list's sign and number are drawn by the style sheet. Every text node knows where its text starts in its block, so that a place in the elements is a
// place in the text the note shows, and through the note's blocks a place in its Markdown, and back.
// Nothing here reads HTML: elements are made one by one and text goes into text nodes only.
// Only the few DOM calls a test can stand in for are used (note-editor-dom.test.ts runs them on a small stand-in of the DOM).

import { t } from '@shared/i18n'
import { blockIndexAt, readableAddress, sidesAt, sourceAt, visibleAt, type DocBlock, type DocRun, type NoteDoc } from '@shared/note-doc'

/** The words the elements carry for assistive technology and the pointer. */
export interface EditorLabels {
  /** The name of a task's box. */
  box: string
  /** The tooltip of a link: how to open it. */
  openLink: (url: string) => string
}

/**
 * The tooltip of a link of a note, in the language of the interface: who a mail link writes to, which page a web link opens. Called for every
 * link that is drawn, so it never throws: an address whose escapes are not valid is written as it is.
 */
export const openLinkTitle = (url: string): string =>
  url.startsWith('mailto:') ? t('notes.cmd-clic-pour-ecrire-a', { address: readableAddress(url.slice('mailto:'.length)) }) : t('notes.cmd-clic-pour-ouvrir-url', { url })

/** A place in the elements, as a selection gives it. */
export interface DomPoint {
  node: Node
  offset: number
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** Where a text node's text, or a line's, starts in the text of its block. */
const starts = new WeakMap<Node, number>()
/** What each block element was drawn from: one drawn the same way is kept (the caret, the spelling marks stay). */
const drawn = new WeakMap<Node, string>()

const isText = (node: Node): node is Text => node.nodeType === TEXT_NODE
const isElement = (node: Node): node is Element => node.nodeType === ELEMENT_NODE

/** What a block looks like, as a key: two blocks of the same key are drawn the same. */
const blockKey = (block: DocBlock): string =>
  JSON.stringify([block.kind, block.level, block.checked, block.number, block.indent, block.lang, block.codeLines, block.runs.map((run) => [run.text, run.style])])

function blockClass(block: DocBlock): string {
  const classes = ['nm-line', block.kind === 'code' ? 'nm-codeblock' : `nm-${block.kind}`]
  if (block.kind === 'heading') classes.push(`nm-h${block.level ?? 1}`)
  if (block.kind === 'task' && block.checked) classes.push('nm-done')
  if (block.text === '') classes.push('nm-blank-line')
  return classes.join(' ')
}

function runClass(run: DocRun): string {
  const classes: string[] = []
  if (run.style.strong) classes.push('nm-strong')
  if (run.style.em) classes.push('nm-em')
  if (run.style.strike) classes.push('nm-strike')
  if (run.style.code) classes.push('nm-code')
  if (run.style.href !== undefined) classes.push('nm-link')
  return classes.join(' ')
}

function runNode(doc: Document, run: DocRun, labels: EditorLabels): Node {
  const text = doc.createTextNode(run.text)
  starts.set(text, run.at)
  const className = runClass(run)
  if (className === '') return text
  const span = doc.createElement('span')
  span.className = className
  // The address was checked by safeNoteHref: a web page or a mail address, never `javascript:`. It opens with ⌘-click (the editor's own handler).
  if (run.style.href !== undefined) {
    span.setAttribute('data-href', run.style.href)
    span.setAttribute('title', labels.openLink(run.style.href))
  }
  span.appendChild(text)
  return span
}

/** The element of one block. An empty line holds a `<br>`, so that it has its height and can take the caret. */
export function blockElement(doc: Document, block: DocBlock, labels: EditorLabels): HTMLElement {
  const element = doc.createElement('div')
  element.className = blockClass(block)
  if (block.kind === 'ordered' && block.number !== undefined) element.setAttribute('data-number', block.number)
  // An item inside another: one step of indent for every two blanks before its sign.
  if (block.indent > 0) element.setAttribute('data-depth', String(Math.min(4, Math.ceil(block.indent / 2))))
  if (block.kind === 'code') {
    if (block.lang) element.setAttribute('data-lang', block.lang)
    let at = 0
    for (const text of block.text.split('\n')) {
      const line = doc.createElement('div')
      line.className = 'nm-code-line'
      starts.set(line, at)
      if (text === '') line.appendChild(doc.createElement('br'))
      else {
        const node = doc.createTextNode(text)
        starts.set(node, at)
        line.appendChild(node)
      }
      element.appendChild(line)
      at += text.length + 1
    }
  } else {
    starts.set(element, 0)
    if (block.kind === 'task') {
      // Not editable: the browser takes it as one thing, and the caret never goes inside. It is clicked, or checked with ⇧⌘U from its line.
      const box = doc.createElement('span')
      box.className = 'nm-box'
      box.setAttribute('contenteditable', 'false')
      const input = doc.createElement('input')
      input.setAttribute('type', 'checkbox')
      input.setAttribute('tabindex', '-1')
      input.setAttribute('aria-label', labels.box)
      if (block.checked) input.setAttribute('checked', '')
      box.appendChild(input)
      element.appendChild(box)
    }
    for (const run of block.runs) element.appendChild(runNode(doc, run, labels))
    if (block.runs.length === 0) element.appendChild(doc.createElement('br'))
  }
  drawn.set(element, blockKey(block))
  return element
}

/** The note drawn in `root`, one element per block. A block drawn the same way as the element in its place, and not changed since, keeps it. */
export function drawDoc(root: HTMLElement, doc: NoteDoc, labels: EditorLabels): void {
  const owner = root.ownerDocument
  doc.blocks.forEach((block, index) => {
    const old = root.childNodes[index]
    if (old !== undefined && drawn.get(old) === blockKey(block) && blockText(old) === block.text) return
    const element = blockElement(owner, block, labels)
    if (old === undefined) root.appendChild(element)
    else root.replaceChild(element, old)
  })
  while (root.childNodes.length > doc.blocks.length) root.removeChild(root.lastChild!)
}

/** The text nodes of a block element in their order (a task's box holds none). */
function textNodes(block: Node): Text[] {
  const out: Text[] = []
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (isText(child)) out.push(child)
      else if (isElement(child)) walk(child)
    }
  }
  walk(block)
  return out
}

/** What a block element shows, as the browser left it: its text nodes (a block of code's lines joined by line feeds). */
export function blockText(element: Node): string {
  if (isElement(element) && element.className.split(' ').includes('nm-codeblock')) {
    return Array.from(element.childNodes)
      .map((line) => textNodes(line).map((node) => node.data).join(''))
      .join('\n')
  }
  return textNodes(element)
    .map((node) => node.data)
    .join('')
}

/** What the elements show, as the browser left them (after an input method wrote in them): the blocks' texts joined by line feeds. */
export const readShown = (root: Node): string => Array.from(root.childNodes).map(blockText).join('\n')

/** The block element `node` is in, and its index; null outside the elements of the note. */
function blockOf(root: Node, node: Node): { element: Node; index: number } | null {
  let at: Node | null = node
  while (at !== null && at.parentNode !== root) at = at.parentNode
  if (at === null) return null
  return { element: at, index: Array.prototype.indexOf.call(root.childNodes, at) as number }
}

/** The line a node is in: a block's own element, or a line of a block of code. */
function lineOf(block: Node, node: Node): Node {
  for (let at: Node | null = node; at !== null && at !== block; at = at.parentNode) if (isElement(at) && at.className === 'nm-code-line') return at
  return block
}

/**
 * The place in the text a point of the elements is at, and its side: at the start of a text node, after the marks hidden before it (`right`); at its
 * end, before the marks after it (`left`).
 */
function shownPoint(root: Node, doc: NoteDoc, point: DomPoint): { visible: number; side: 'left' | 'right' } | null {
  if (point.node === root) {
    const index = Math.min(point.offset, doc.blocks.length - 1)
    const block = doc.blocks[index]
    if (!block) return null
    return point.offset >= doc.blocks.length ? { visible: block.start + block.text.length, side: 'left' } : { visible: block.start, side: 'right' }
  }
  const found = blockOf(root, point.node)
  if (found === null) return null
  const block = doc.blocks[found.index]
  if (!block) return null
  if (isText(point.node) && starts.has(point.node)) {
    const offset = Math.max(0, Math.min(point.offset, point.node.data.length))
    return { visible: block.start + starts.get(point.node)! + offset, side: offset === 0 ? 'right' : 'left' }
  }
  // Between the lines of a block of code: the start of the line after.
  if (point.node === found.element && block.kind === 'code') {
    const next = point.node.childNodes[point.offset]
    return next === undefined ? { visible: block.start + block.text.length, side: 'left' } : { visible: block.start + (starts.get(next) ?? 0), side: 'right' }
  }
  // Between the children of an element: after the text nodes before it.
  const line = lineOf(found.element, point.node)
  let local = starts.get(line) ?? 0
  let side: 'left' | 'right' = 'right'
  const before = (node: Node): boolean => {
    // Whether `node` comes before the point (the point is before child `offset` of its node).
    const child = point.node.childNodes[point.offset]
    if (child === undefined) return point.node.contains(node) || precedes(node, point.node)
    return precedes(node, child)
  }
  for (const text of textNodes(line)) {
    if (!starts.has(text)) continue
    if (before(text)) {
      local = starts.get(text)! + text.data.length
      side = 'left'
    }
  }
  return { visible: block.start + local, side }
}

/** Whether `a` comes before `b` in the order of the document (neither holding the other). */
function precedes(a: Node, b: Node): boolean {
  const path = (node: Node): Node[] => {
    const out: Node[] = []
    for (let at: Node | null = node; at !== null; at = at.parentNode) out.unshift(at)
    return out
  }
  const pa = path(a)
  const pb = path(b)
  let k = 0
  while (k < pa.length && k < pb.length && pa[k] === pb[k]) k++
  if (k === pa.length || k === pb.length) return false
  const parent = pa[k - 1]!
  const children: Node[] = Array.from(parent.childNodes)
  return children.indexOf(pa[k]!) < children.indexOf(pb[k]!)
}

/** The place in the Markdown of a point of the elements; null outside them. */
export function sourceOfPoint(root: Node, doc: NoteDoc, point: DomPoint): number | null {
  const shown = shownPoint(root, doc, point)
  return shown === null ? null : sourceAt(doc, shown.visible, shown.side)
}

/** The place of the text a point of the elements is at (where the caret shows); null outside them. */
export function visibleOfPoint(root: Node, doc: NoteDoc, point: DomPoint): number | null {
  return shownPoint(root, doc, point)?.visible ?? null
}

/**
 * The point of the elements for a place of the Markdown: in the text node of the character before it when it is inside the marks that end that
 * character's run, in the one of the character after it when it is past the marks that open the next run.
 */
export function pointOfSource(root: Node, doc: NoteDoc, source: number): DomPoint {
  const visible = visibleAt(doc, source)
  const index = blockIndexAt(doc, visible)
  const block = doc.blocks[index]!
  const element = root.childNodes[index]
  if (element === undefined) return { node: root, offset: root.childNodes.length }
  const local = visible - block.start
  const [left, right] = sidesAt(doc, visible)
  const side: 'left' | 'right' = local === 0 ? 'right' : left !== right && source >= right ? 'right' : 'left'
  const nodes = block.kind === 'code' ? Array.from(element.childNodes).flatMap(textNodes) : textNodes(element)
  const at = (text: Text): number => starts.get(text) ?? 0
  const inside = (text: Text, end: boolean): boolean => (end ? at(text) < local && local <= at(text) + text.data.length : at(text) <= local && local < at(text) + text.data.length)
  const found = nodes.find((text) => inside(text, side === 'left')) ?? nodes.find((text) => inside(text, side !== 'left'))
  if (found) return { node: found, offset: local - at(found) }
  // No text there: an empty line (of a block of code, or a block of its own), before its `<br>`.
  if (block.kind === 'code') {
    const line = Array.from(element.childNodes).find((each) => starts.get(each) === local)
    if (line) return { node: line, offset: 0 }
  }
  const children = element.childNodes
  const last = children[children.length - 1]
  return { node: element, offset: last !== undefined && last.nodeName === 'BR' ? children.length - 1 : children.length }
}

/** The index of the block element `node` is in, or -1. */
export function blockIndexOfNode(root: Node, node: Node | null): number {
  if (node === null) return -1
  return blockOf(root, node)?.index ?? -1
}
