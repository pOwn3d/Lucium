// A paste of formatted text into a note (renderer/NoteTextEditor.tsx): the HTML of the clipboard, parsed by the browser into an inert document
// (DOMParser: no script runs, nothing is fetched), is read here node by node and written as the Markdown a note knows. Kept: titles, paragraphs and
// line breaks, bold, italic, struck, code (and blocks of code), links to a web page or a mail address, lists (numbered, with boxes) and quotes. Dropped:
// everything else, keeping only its text (a table's cells, a span's words), and some things with their text too (scripts, styles, forms, embedded
// content). Nothing here reads an attribute but `href`, `type`, `checked`, `start` and the font weight, style and decoration of `style`; nothing of
// it is ever put back into a page.

import { DROPPED_TAGS, cleanText, withoutTrailing } from './markdown-export'
import { linkAddress, writeBlock, type BlockShape, type CharStyle, type StyledChar } from './note-doc'

/** What is read of a node of the parsed document: a text, or an element with its name, a few attributes and its children. */
export interface PasteNode {
  nodeType: number
  nodeName: string
  childNodes: ArrayLike<PasteNode>
  /** A text node's text. */
  data?: string
  getAttribute?: (name: string) => string | null
}

/** How much of a paste is read: past these, the rest is left out (a paste is a few paragraphs, not a book). */
export const PASTE_LIMITS = { nodes: 20_000, depth: 64, chars: 100_000 } as const

const TEXT_NODE = 3
const ELEMENT_NODE = 1

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'figure', 'figcaption', 'address', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'caption', 'dl', 'dt', 'dd', 'hr', 'details', 'summary', 'body', 'html', 'center', 'form', 'fieldset'
])
/** Inside a block of code, these are only what they hold. */
const CODE_TAGS = new Set(['code', 'kbd', 'samp', 'tt'])
/** Dropped with their text, beyond the export's list: pictures say nothing in a note. */
const DROPPED = new Set([...DROPPED_TAGS, 'img', 'picture'])

interface Block {
  shape: BlockShape
  chars: StyledChar[]
}

interface Code {
  code: string
}

interface Context {
  style: CharStyle
  /** The lists the node is in, the innermost last. */
  lists: Array<{ ordered: boolean; next: number }>
  quote: boolean
}

/** The weight, style and decoration a `style` attribute gives (Google Docs writes its bold as `font-weight:700`, and wraps all in a `<b>` of normal weight). */
function inlineStyle(raw: string | null, style: CharStyle): CharStyle {
  if (!raw) return style
  const out = { ...style }
  const weight = /font-weight\s*:\s*([a-z0-9]+)/i.exec(raw)?.[1]?.toLowerCase()
  if (weight !== undefined) {
    if (weight === 'bold' || weight === 'bolder' || (/^\d+$/.test(weight) && Number(weight) >= 600)) out.strong = true
    else if (weight === 'normal' || weight === 'lighter' || /^\d+$/.test(weight)) delete out.strong
  }
  const italic = /font-style\s*:\s*([a-z]+)/i.exec(raw)?.[1]?.toLowerCase()
  if (italic === 'italic' || italic === 'oblique') out.em = true
  else if (italic === 'normal') delete out.em
  if (/text-decoration(-line)?\s*:[^;]*line-through/i.test(raw)) out.strike = true
  return out
}

const attribute = (node: PasteNode, name: string): string | null => node.getAttribute?.(name) ?? null

/** Whether an element holds a checkbox before any text: an item of a list of tasks. */
function checkboxOf(node: PasteNode, depth = 0): PasteNode | null {
  if (depth > 4) return null
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE && (child.data ?? '').trim() !== '') return null
    if (child.nodeType !== ELEMENT_NODE) continue
    const tag = child.nodeName.toLowerCase()
    if (tag === 'input') return attribute(child, 'type')?.toLowerCase() === 'checkbox' ? child : null
    const inner = checkboxOf(child, depth + 1)
    if (inner) return inner
  }
  return null
}

/** The text a node holds, as it is (for a block of code). */
function textOf(node: PasteNode, budget: { nodes: number }, depth = 0): string {
  if (budget.nodes-- <= 0 || depth > PASTE_LIMITS.depth) return ''
  if (node.nodeType === TEXT_NODE) return node.data ?? ''
  if (node.nodeType !== ELEMENT_NODE) return ''
  const tag = node.nodeName.toLowerCase()
  if (DROPPED.has(tag)) return ''
  if (tag === 'br') return '\n'
  let out = ''
  for (const child of Array.from(node.childNodes)) out += textOf(child, budget, depth + 1)
  return BLOCK_TAGS.has(tag) && tag !== 'pre' && out !== '' && !out.endsWith('\n') ? `${out}\n` : out
}

/**
 * The Markdown of a pasted document (its `body`): one line per block, the marks of its runs, a backslash before a sign that would otherwise be read as
 * a mark. Empty when it holds no text.
 */
export function htmlToNoteMarkdown(root: PasteNode): string {
  const out: Array<Block | Code> = []
  let current: Block | null = null
  const budget = { nodes: PASTE_LIMITS.nodes, chars: PASTE_LIMITS.chars }

  const end = (): void => {
    if (current === null) return
    // Blanks around a line are not part of it.
    while (current.chars.length > 0 && current.chars[0]!.ch === ' ') current.chars.shift()
    while (current.chars.length > 0 && current.chars[current.chars.length - 1]!.ch === ' ') current.chars.pop()
    if (current.chars.length > 0 || current.shape.kind === 'task') out.push(current)
    current = null
  }

  const shapeFor = (context: Context, item: BlockShape | null): BlockShape => {
    if (item) return item
    if (context.quote) return { kind: 'quote' }
    return { kind: 'paragraph' }
  }

  const add = (text: string, context: Context, item: () => BlockShape | null): void => {
    if (budget.chars <= 0) return
    const plain = cleanText(text).replace(/[\t\n\r\f ]+/g, ' ').slice(0, budget.chars)
    if (plain === '') return
    if (current === null) {
      if (plain.trim() === '') return
      current = { shape: shapeFor(context, item()), chars: [] }
    }
    // One blank between words, however many the HTML had.
    // One character per unit of the text, as the editor counts them (an emoji is two).
    for (const unit of plain.split('')) {
      if (unit === ' ' && (current.chars.length === 0 || current.chars[current.chars.length - 1]!.ch === ' ')) continue
      current.chars.push({ ch: unit, ...context.style })
    }
    budget.chars -= plain.length
  }

  // The item a list's `<li>` opens, given to the first text of it.
  let pendingItem: BlockShape | null = null
  const takeItem = (): BlockShape | null => {
    const item = pendingItem
    pendingItem = null
    return item
  }

  const visit = (node: PasteNode, context: Context, depth: number): void => {
    if (budget.nodes-- <= 0 || depth > PASTE_LIMITS.depth) return
    if (node.nodeType === TEXT_NODE) return add(node.data ?? '', context, takeItem)
    if (node.nodeType !== ELEMENT_NODE) return
    const tag = node.nodeName.toLowerCase()
    if (DROPPED.has(tag)) return
    if (tag === 'br') {
      end()
      return
    }
    if (tag === 'pre') {
      end()
      // Cut to what is left of the budget first, then the line ends taken off by a loop from the end: a pattern anchored there costs the square of
      // a long run of them elsewhere in the text, and the clipboard holds what a page put in it.
      const code = withoutTrailing(cleanText(textOf(node, budget)).slice(0, budget.chars), '\n')
      budget.chars -= code.length
      // A line of three backquotes would end the block: such a block is pasted as its lines.
      if (code !== '' && !code.split('\n').some((line) => /^```/.test(line))) out.push({ code })
      else for (const line of code.split('\n')) if (line.trim() !== '') out.push({ shape: { kind: 'paragraph' }, chars: line.split('').map((ch) => ({ ch })) })
      return
    }
    const block = BLOCK_TAGS.has(tag)
    let next: Context = context
    if (block) end()
    if (tag === 'ul' || tag === 'ol') {
      const start = Number.parseInt(attribute(node, 'start') ?? '1', 10)
      next = { ...context, lists: [...context.lists, { ordered: tag === 'ol', next: Number.isFinite(start) && start >= 0 && start < 1e9 ? start : 1 }] }
    } else if (tag === 'li') {
      const list = context.lists[context.lists.length - 1]
      const indent = Math.max(0, context.lists.length - 1) * 2
      const box = checkboxOf(node)
      if (box) pendingItem = { kind: 'task', checked: attribute(box, 'checked') !== null, indent }
      else if (list?.ordered) pendingItem = { kind: 'ordered', number: list.next++, indent }
      else pendingItem = { kind: 'bullet', indent }
    } else if (tag === 'blockquote') next = { ...context, quote: true }
    else if (/^h[1-6]$/.test(tag)) pendingItem = { kind: 'heading', level: Math.min(3, Number(tag[1])) as 1 | 2 | 3 }
    else if (tag === 'b' || tag === 'strong') next = { ...context, style: { ...context.style, strong: true } }
    else if (tag === 'i' || tag === 'em') next = { ...context, style: { ...context.style, em: true } }
    else if (tag === 's' || tag === 'strike' || tag === 'del') next = { ...context, style: { ...context.style, strike: true } }
    else if (CODE_TAGS.has(tag)) next = { ...context, style: { ...context.style, code: true } }
    else if (tag === 'a') {
      const href = linkAddress(attribute(node, 'href') ?? '')
      if (href !== null) next = { ...context, style: { ...context.style, href } }
    } else if (tag === 'td' || tag === 'th') {
      // The cells of a row, side by side on its line.
      if (current !== null && current.chars.length > 0) add(' ', context, () => null)
    }
    if (tag !== 'a' && !CODE_TAGS.has(tag)) next = { ...next, style: inlineStyle(attribute(node, 'style'), next.style) }
    for (const child of Array.from(node.childNodes)) visit(child, next, depth + 1)
    if (block) {
      end()
      if (tag === 'li') pendingItem = null
    }
    if (/^h[1-6]$/.test(tag)) pendingItem = null
  }

  visit(root, { style: {}, lists: [], quote: false }, 0)
  end()
  const lines: string[] = []
  for (const item of out) {
    if ('code' in item) {
      lines.push(`\`\`\`\n${item.code}\n\`\`\``)
      continue
    }
    // The look could not be written (it never happens with these marks): the text, at least, as a paragraph that reads as itself.
    lines.push(writeBlock(item.shape, item.chars) ?? writeBlock({ kind: 'paragraph' }, item.chars.map((char) => ({ ch: char.ch }))) ?? '')
  }
  return lines.join('\n')
}
