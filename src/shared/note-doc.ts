// The note as the visual editor shows it (renderer/NoteTextEditor.tsx): blocks (a line, or a block of code) holding the text a reader sees, the marks
// of Markdown taken out. The Markdown stays the only truth: every block knows where its text is in the note, character by character, so that a place
// on screen is a place in the note and back, and an edit made on screen is an edit of the Markdown.
//
// Two ways of changing the note, tried in this order:
//  - a splice: the characters typed (or the ones deleted) put into (or taken out of) the Markdown where they are, every other character kept as it was.
//    Typing Markdown therefore still formats it as it is typed (the second `*` of `*mot*` makes it italic), and a note that is only read never changes;
//  - when a splice would change what the note looks like elsewhere (a `*` typed inside an italic would end it, a deletion would leave half of a mark),
//    the blocks it touches are written again from what they show (`writeBlock`): their characters and the look of each, the marks put back around them,
//    a backslash before a sign that would otherwise be read as one. What is written is read back and must show the same; when it cannot, nothing is
//    changed, so a character is never lost.
//
// Only data comes in and out: no element, no HTML read. What the toolbar makes (titles, bold, italic, struck, lists, boxes, quotes, code, links) is
// written in a form that reads back as itself.

import { lineSource, parseNote, parseNoteLine, safeNoteHref, type NoteEdit, type NoteLine } from './note-markdown'
import { escapeHtml } from './html-escape'

// ---------- what the editor shows ----------

/** The look of a character of the text: bold, italic, struck, code, a link (`bare`: an address written as such, a link by itself). */
export interface CharStyle {
  strong?: true
  em?: true
  strike?: true
  code?: true
  href?: string
  bare?: true
}

/** A character the reader sees, with its look; `esc`: it was written after a backslash, and is written so again. */
export interface StyledChar extends CharStyle {
  ch: string
  esc?: true
}

/** Characters of the note shown as they are, with one look. */
export interface DocRun {
  /** Where they start in the note; for an escaped character, where its backslash is. */
  from: number
  text: string
  style: CharStyle
  /** One character written after a backslash: its Markdown is the backslash and the character. */
  esc?: true
  /** Where its text starts in the text of its block. */
  at: number
}

export type BlockKind = 'paragraph' | 'heading' | 'bullet' | 'ordered' | 'task' | 'quote' | 'blank' | 'code'

export interface DocBlock {
  kind: BlockKind
  level?: 1 | 2 | 3
  checked?: boolean
  /** An item's number as it is written (`1.`, `2)`). */
  number?: string
  /** The blanks before the sign of an item inside another. */
  indent: number
  /** The language a block of code names. */
  lang?: string
  /** How many lines a block of code holds (0: its two fences follow each other). */
  codeLines?: number
  /** Where the block is in the note: its first character, and the end of its last line (its line feed excluded). */
  from: number
  to: number
  /** Where its text is: after its title mark, sign or box; for a block of code, the lines between its fences. */
  contentFrom: number
  contentTo: number
  runs: DocRun[]
  /** What it shows; for a block of code, its lines joined by line feeds. */
  text: string
  /** Where its text starts in the text of the note (the blocks' texts joined by line feeds). */
  start: number
}

export interface NoteDoc {
  source: string
  blocks: DocBlock[]
  /** What the note shows: the texts of its blocks, joined by line feeds. */
  text: string
}

const styleOf = (piece: { strong?: true; em?: true; strike?: true; code?: true; href?: string; bare?: true }): CharStyle => ({
  ...(piece.strong ? { strong: true } : {}),
  ...(piece.em ? { em: true } : {}),
  ...(piece.strike ? { strike: true } : {}),
  ...(piece.code ? { code: true } : {}),
  ...(piece.href !== undefined ? { href: piece.href } : {}),
  ...(piece.bare ? { bare: true } : {})
})

function lineBlock(line: NoteLine, from: number, start: number): DocBlock {
  const source = lineSource(line)
  const prefix = line.prefix ?? 0
  const runs: DocRun[] = []
  let at = from
  let shown = 0
  let indent = 0
  let number: string | undefined
  for (const piece of line.pieces) {
    const begins = at
    at += piece.text.length
    if (begins < from + prefix) {
      if (piece.indent) indent = piece.text.length
      if (piece.kind === 'number') number = piece.text.trim()
      continue
    }
    if (piece.kind !== 'text') continue
    // An escaped character: the backslash just before it is part of what it is written as.
    const run: DocRun = piece.escaped ? { from: begins - 1, text: piece.text, style: styleOf(piece), esc: true, at: shown } : { from: begins, text: piece.text, style: styleOf(piece), at: shown }
    runs.push(run)
    shown += piece.text.length
  }
  const kind: BlockKind = line.kind === 'fence' || line.kind === 'code' ? 'paragraph' : line.kind
  return {
    kind,
    ...(line.level ? { level: line.level } : {}),
    ...(line.kind === 'task' ? { checked: line.checked === true } : {}),
    ...(number !== undefined ? { number } : {}),
    indent,
    from,
    to: from + source.length,
    contentFrom: from + prefix,
    contentTo: from + source.length,
    runs,
    text: runs.map((run) => run.text).join(''),
    start
  }
}

/** The blocks of a note: one per line, a block of code for its fences and the lines between them. */
export function readDoc(source: string): NoteDoc {
  const lines = parseNote(source)
  const blocks: DocBlock[] = []
  let offset = 0
  let start = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.kind === 'fence' && line.fence === 'open') {
      let close = index + 1
      while (lines[close]?.kind === 'code') close++
      const code = lines.slice(index + 1, close).map(lineSource)
      const opening = lineSource(line)
      const content = code.join('\n')
      const contentFrom = offset + opening.length + 1
      const to = contentFrom + (code.length > 0 ? content.length + 1 : 0) + lineSource(lines[close]!).length
      blocks.push({
        kind: 'code',
        ...(line.lang ? { lang: line.lang } : {}),
        codeLines: code.length,
        indent: 0,
        from: offset,
        to,
        contentFrom,
        contentTo: contentFrom + content.length,
        runs: content === '' ? [] : [{ from: contentFrom, text: content, style: {}, at: 0 }],
        text: content,
        start
      })
      offset = to + 1
      start += content.length + 1
      index = close
      continue
    }
    const block = lineBlock(line, offset, start)
    blocks.push(block)
    offset = block.to + 1
    start += block.text.length + 1
  }
  return { source, blocks, text: blocks.map((block) => block.text).join('\n') }
}

/** The block a place of the text is in: at the end of a block, that block. */
export function blockIndexAt(doc: NoteDoc, visible: number): number {
  const blocks = doc.blocks
  for (let index = 0; index < blocks.length; index++) if (visible <= blocks[index]!.start + blocks[index]!.text.length) return index
  return blocks.length - 1
}

/** The run that holds character `local` of a block. */
const runOf = (block: DocBlock, local: number): DocRun | undefined => block.runs.find((run) => local >= run.at && local < run.at + run.text.length)

/** Where character `local` of a block is written, and where it ends. */
function charSpan(block: DocBlock, local: number): [number, number] {
  const run = runOf(block, local)!
  if (run.esc) return [run.from, run.from + 2]
  const at = run.from + (local - run.at)
  return [at, at + 1]
}

/**
 * The place in the note of a place of the text. Marks hidden between two characters can put it on either side of them: `left` is right after the
 * character before (inside a bold run that ends there), `right` right before the character after (after the marks that open the next run).
 */
export function sourceAt(doc: NoteDoc, visible: number, side: 'left' | 'right' = 'left'): number {
  const block = doc.blocks[blockIndexAt(doc, visible)]!
  const local = Math.max(0, Math.min(visible - block.start, block.text.length))
  if (side === 'left') return local === 0 ? block.contentFrom : charSpan(block, local - 1)[1]
  return local === block.text.length ? block.contentTo : charSpan(block, local)[0]
}

/** Both sides of a place of the text (equal when no mark is hidden there). */
export const sidesAt = (doc: NoteDoc, visible: number): [number, number] => [sourceAt(doc, visible, 'left'), sourceAt(doc, visible, 'right')]

/** The place of the text a place of the note shows as: inside a mark, a title mark or a fence, the place of the text next to it. */
export function visibleAt(doc: NoteDoc, source: number): number {
  const blocks = doc.blocks
  let index = blocks.findIndex((block) => source <= block.to)
  if (index === -1) index = blocks.length - 1
  const block = blocks[index]!
  if (source <= block.contentFrom) return block.start
  if (source >= block.contentTo) return block.start + block.text.length
  let local = 0
  for (const run of block.runs) {
    if (run.esc) local += source >= run.from + 2 ? 1 : 0
    else local += Math.max(0, Math.min(run.text.length, source - run.from))
  }
  return block.start + local
}

/** The characters of a block between two places of its text, with their look. */
export function blockChars(block: DocBlock, from = 0, to = block.text.length): StyledChar[] {
  const out: StyledChar[] = []
  for (const run of block.runs) {
    for (let k = 0; k < run.text.length; k++) {
      const local = run.at + k
      if (local < from || local >= to) continue
      out.push({ ch: run.text[k]!, ...run.style, ...(run.esc ? { esc: true } : {}) })
    }
  }
  return out
}

// ---------- the look at a place ----------

const FLAGS = ['strong', 'em', 'strike', 'code'] as const
export type InlineMark = (typeof FLAGS)[number]

const explicitHref = (style: CharStyle | undefined): string | undefined => (style && !style.bare ? style.href : undefined)

/** The look of character `visible` of the text, or undefined past its end or on a line feed. */
function charStyle(doc: NoteDoc, visible: number): CharStyle | undefined {
  const block = doc.blocks[blockIndexAt(doc, visible)]!
  const local = visible - block.start
  if (block.kind === 'code' || local < 0 || local >= block.text.length) return undefined
  return runOf(block, local)?.style
}

/**
 * What a character typed at `source` should look like: the look of the run it goes on (the one before when the caret is inside its marks, the one
 * after when it is past the marks that open it), without a link or code it would only touch the end of (typing after a link does not lengthen it).
 */
export function typingStyle(doc: NoteDoc, source: number): CharStyle {
  const visible = visibleAt(doc, source)
  const block = doc.blocks[blockIndexAt(doc, visible)]!
  if (block.kind === 'code') return {}
  const local = visible - block.start
  const before = local > 0 ? charStyle(doc, visible - 1) : undefined
  const after = local < block.text.length ? charStyle(doc, visible) : undefined
  const [left, right] = sidesAt(doc, visible)
  const base = left === right ? (before ?? after) : source <= left ? before : source >= right ? after : (before ?? after)
  const out: CharStyle = {}
  for (const flag of FLAGS) if (base?.[flag]) out[flag] = true
  // Code and links go on only inside them: on both sides of the caret.
  if (out.code && !(before?.code && after?.code)) delete out.code
  const href = explicitHref(base)
  if (href !== undefined && explicitHref(before) === href && explicitHref(after) === href) out.href = href
  return out
}

/** The marks every character of a selection has (blanks aside), or the look typing would get for an empty one; and the link of the selection. */
export function selectionStyle(doc: NoteDoc, start: number, end: number): CharStyle {
  if (start === end) {
    const visible = visibleAt(doc, start)
    const out = typingStyle(doc, start)
    // The caret on a link (inside it, or at one of its ends): the link the toolbar shows and edits.
    const href = explicitHref(charStyle(doc, visible)) ?? explicitHref(visible > 0 ? charStyle(doc, visible - 1) : undefined)
    return href !== undefined ? { ...out, href } : out
  }
  const vs = visibleAt(doc, start)
  const ve = visibleAt(doc, end)
  const chars = selectedChars(doc, vs, ve).filter((char) => char.ch.trim() !== '')
  if (chars.length === 0) return {}
  const out: CharStyle = {}
  for (const flag of FLAGS) if (chars.every((char) => char[flag])) out[flag] = true
  const href = explicitHref(chars[0])
  if (href !== undefined && chars.every((char) => explicitHref(char) === href)) out.href = href
  return out
}

/** The characters shown between two places of the text, blocks of code left out. */
function selectedChars(doc: NoteDoc, vs: number, ve: number): StyledChar[] {
  const out: StyledChar[] = []
  for (const block of doc.blocks) {
    if (block.kind === 'code' || block.start + block.text.length < vs || block.start > ve) continue
    out.push(...blockChars(block, Math.max(0, vs - block.start), Math.min(block.text.length, ve - block.start)))
  }
  return out
}

/** The blocks a selection touches (a caret: its block). */
export function blocksIn(doc: NoteDoc, start: number, end: number): number[] {
  const first = blockIndexAt(doc, visibleAt(doc, Math.min(start, end)))
  const last = blockIndexAt(doc, visibleAt(doc, Math.max(start, end)))
  return Array.from({ length: last - first + 1 }, (_, k) => first + k)
}

// ---------- writing a block again ----------

/** What a mark is written as. */
const ESCAPABLE = /[\\*_`[\]~]/

/** The sign of a line that would make it a title, an item, a quote or a fence: the character a backslash goes before so that it stays text. */
function protectStart(line: string): string {
  const lead = line.length - line.trimStart().length
  const rest = line.slice(lead)
  // A bullet `•` is no ASCII sign a backslash protects: such a line is left as it is (and reads as an item).
  if (/^#{1,3} /.test(rest) || /^[-*+] /.test(rest) || /^>/.test(rest) || /^```/.test(rest)) return `${line.slice(0, lead)}\\${rest}`
  const ordered = /^(\d{1,9})([.)])( |$)/.exec(rest)
  if (ordered) return `${line.slice(0, lead)}${ordered[1]}\\${rest.slice(ordered[1]!.length)}`
  return line
}

type OpenMark = { kind: 'link'; href: string } | { kind: InlineMark }

const hasMark = (char: StyledChar, mark: OpenMark): boolean => (mark.kind === 'link' ? explicitHref(char) === mark.href : char[mark.kind] === true)

/**
 * The characters as they are meant to read once written: bold, italic and struck never start or end on a blank (a mark next to a blank is no
 * mark), so the blanks at the ends of their runs lose them.
 */
export function settleChars(chars: readonly StyledChar[], prefixed = false): StyledChar[] {
  let out = chars.map((char) => ({ ...char }))
  // The blanks a title mark, a sign or a box is followed by belong to it.
  if (prefixed) {
    let lead = 0
    while (lead < out.length && /^[ \t]$/.test(out[lead]!.ch)) lead++
    out = out.slice(lead)
  }
  for (const flag of ['strong', 'em', 'strike'] as const) {
    let index = 0
    while (index < out.length) {
      if (!out[index]![flag]) {
        index++
        continue
      }
      let end = index
      while (end < out.length && out[end]![flag]) end++
      let first = index
      let last = end - 1
      while (first <= last && out[first]!.ch.trim() === '') delete out[first++]![flag]
      while (last >= first && out[last]!.ch.trim() === '') delete out[last--]![flag]
      index = end
    }
  }
  return out
}

interface WriteOptions {
  /** The italic mark: `*`, or `_` where a `*` would touch a bold one. */
  em: '*' | '_'
  /** Every sign that could be read as a mark gets a backslash, not only the ones written so before. */
  escapeAll: boolean
}

/** The Markdown of a run of characters, the marks opened and closed around them in order (a link outside, code inside). */
export function writeInline(chars: readonly StyledChar[], options: WriteOptions = { em: '*', escapeAll: false }): string {
  let out = ''
  const stack: OpenMark[] = []
  const extent = (from: number, mark: OpenMark): number => {
    let end = from
    while (end < chars.length && hasMark(chars[end]!, mark)) end++
    return end - from
  }
  const close = (mark: OpenMark, at: number): void => {
    if (mark.kind === 'link') out += `](${mark.href})`
    else if (mark.kind === 'code') out += codeTicks(chars, at)
    else out += mark.kind === 'strong' ? '**' : mark.kind === 'em' ? options.em : '~~'
  }
  let codeFrom = -1
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!
    const keep = stack.findIndex((mark) => !hasMark(char, mark))
    if (keep !== -1) {
      for (let top = stack.length - 1; top >= keep; top--) close(stack[top]!, codeFrom)
      stack.length = keep
    }
    const wanted: OpenMark[] = []
    const href = explicitHref(char)
    if (href !== undefined && !stack.some((mark) => mark.kind === 'link')) wanted.push({ kind: 'link', href })
    const flags = (['strong', 'em', 'strike'] as const).filter((flag) => char[flag] && !stack.some((mark) => mark.kind === flag)).map((flag) => ({ kind: flag }) as OpenMark)
    // The run that goes on longest opens first, so that it holds the others.
    flags.sort((a, b) => extent(index, b) - extent(index, a))
    wanted.push(...flags)
    if (char.code && !stack.some((mark) => mark.kind === 'code')) wanted.push({ kind: 'code' })
    for (const mark of wanted) {
      if (mark.kind === 'link') out += '['
      else if (mark.kind === 'code') {
        codeFrom = index
        out += codeTicks(chars, index)
      } else out += mark.kind === 'strong' ? '**' : mark.kind === 'em' ? options.em : '~~'
      stack.push(mark)
    }
    if (char.code || char.bare) out += char.ch
    else if (ESCAPABLE.test(char.ch) && (char.esc || options.escapeAll)) out += `\\${char.ch}`
    else out += char.ch
  }
  for (let top = stack.length - 1; top >= 0; top--) close(stack[top]!, codeFrom)
  return out
}

/** The backquotes around the code that starts at `from`: one more than the longest run of them inside. */
function codeTicks(chars: readonly StyledChar[], from: number): string {
  let text = ''
  for (let index = from; index >= 0 && index < chars.length && chars[index]!.code; index++) text += chars[index]!.ch
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(longest + 1)
}

/** What a block is, for writing it: its kind, and the prefix it had when it keeps it. */
export interface BlockShape {
  kind: Exclude<BlockKind, 'code'>
  level?: 1 | 2 | 3
  checked?: boolean
  /** The number of an ordered item (1 when absent). */
  number?: number
  indent?: number
  /** The start of the line as it was written (a title's `## `, an item's `* ` or `3) `): kept when the block keeps its kind. */
  prefix?: string
}

/** The start of a line of this kind, as the toolbar writes it. */
export function prefixFor(shape: BlockShape): string {
  const indent = ' '.repeat(shape.indent ?? 0)
  switch (shape.kind) {
    case 'heading':
      return `${'#'.repeat(shape.level ?? 1)} `
    case 'bullet':
      return `${indent}- `
    case 'ordered':
      return `${indent}${shape.number ?? 1}. `
    case 'task':
      return `${indent}- [${shape.checked ? 'x' : ' '}] `
    case 'quote':
      return '> '
    default:
      return ''
  }
}

const charKey = (char: StyledChar): string => `${char.ch}|${char.strong ? 1 : 0}${char.em ? 1 : 0}${char.strike ? 1 : 0}${char.code ? 1 : 0}|${explicitHref(char) ?? ''}`

/** What a line reads as: its kind, and the characters it shows as `blockChars` gives them. */
function lineChars(line: string): { kind: BlockKind; level?: 1 | 2 | 3; checked?: boolean; chars: StyledChar[] } {
  const block = lineBlock(parseNoteLine(line), 0, 0)
  return { kind: block.kind, ...(block.level ? { level: block.level } : {}), ...(block.checked !== undefined ? { checked: block.checked } : {}), chars: blockChars(block) }
}

/** Whether a line read back is a block of the shape it was written for. */
function readsAs(back: ReturnType<typeof lineChars>, shape: BlockShape, empty: boolean): boolean {
  const plain = shape.kind === 'paragraph' || shape.kind === 'blank'
  if (plain) return back.kind === (empty ? 'blank' : 'paragraph')
  if (back.kind !== shape.kind) return false
  if (shape.kind === 'heading' && back.level !== (shape.level ?? 1)) return false
  return shape.kind !== 'task' || shape.checked === undefined || back.checked === shape.checked
}

/**
 * A line of Markdown that reads back as a block of this shape holding these characters, each with its look, or null when none can be written (a
 * character would be lost or changed). The plainest writing is tried first; the other italic mark and a backslash before every sign after it.
 */
export function writeBlock(shape: BlockShape, chars: readonly StyledChar[]): string | null {
  const prefixed = shape.kind !== 'paragraph' && shape.kind !== 'blank'
  const prefix = prefixed ? (shape.prefix ?? prefixFor(shape)) : ''
  const meant = settleChars(chars, prefixed)
  const meantKeys = meant.map(charKey).join('\n')
  const meantText = meant.map((char) => char.ch).join('')
  const tries: string[] = []
  for (const options of [
    { em: '*', escapeAll: false },
    { em: '_', escapeAll: false },
    { em: '*', escapeAll: true },
    { em: '_', escapeAll: true }
  ] as const) {
    const inline = writeInline(meant, options)
    const line = prefix + (prefixed ? inline : protectStart(inline))
    tries.push(line)
    const back = lineChars(line)
    if (readsAs(back, shape, meant.length === 0) && back.chars.map(charKey).join('\n') === meantKeys) return line
  }
  // The look could not be kept whole (a mark no Markdown of a note can write next to another): the text is, at least.
  for (const line of tries) {
    const back = lineChars(line)
    if (readsAs(back, shape, meant.length === 0) && back.chars.map((char) => char.ch).join('') === meantText) return line
  }
  return null
}

const shapeOf = (block: DocBlock, source: string): BlockShape => {
  const kind = block.kind === 'code' ? 'paragraph' : block.kind
  return {
    kind,
    ...(block.level ? { level: block.level } : {}),
    ...(block.checked !== undefined ? { checked: block.checked } : {}),
    indent: block.indent,
    prefix: source.slice(block.from, block.contentFrom)
  }
}

// ---------- telling a change that keeps the look from one that does not ----------

interface SourceChar {
  shown: boolean
  key: string
}

/** For each character of the note: whether it is shown (or is a mark, a sign, a fence), and its look. */
function sourceChars(doc: NoteDoc): SourceChar[] {
  const out: SourceChar[] = Array.from({ length: doc.source.length }, () => ({ shown: false, key: '' }))
  for (const block of doc.blocks) {
    for (const run of block.runs) {
      const key = charKey({ ch: '', ...run.style })
      if (run.esc) out[run.from + 1] = { shown: true, key }
      else for (let k = 0; k < run.text.length; k++) out[run.from + k] = { shown: true, key }
    }
  }
  return out
}

/** The flags of a look, as a key: `0110|href`. */
const flagsOf = (key: string): string => key.split('|')[1] ?? ''
const hrefOf = (key: string): string => key.split('|')[2] ?? ''

/**
 * Whether a change of the note keeps every character that was there as it looked: `map` says where each of them went (null: deleted). No mark may
 * ever become text. `adding` (typing): characters may gain a look (typing a `*` that closes an italic) and a sign may become a mark, but none may
 * lose its look; `restyling` (a sign typed that became a mark itself, such as the second `*` of `**gras**`, after the first made `*gras` italic):
 * a look may also change. Otherwise (a deletion, Return) the look must stay exactly as it was.
 */
function keepsLook(before: NoteDoc, after: NoteDoc, map: (at: number) => number | null, adding: boolean, restyling = false): boolean {
  const old = sourceChars(before)
  const now = sourceChars(after)
  for (let at = 0; at < old.length; at++) {
    const where = map(at)
    if (where === null) continue
    const was = old[at]!
    const is = now[where]
    if (is === undefined) return false
    if (!was.shown) {
      // A mark, a sign or a fence: it stays one (a deletion may still take it, with the run it closed).
      if (is.shown) return false
      continue
    }
    if (!is.shown) {
      if (adding) continue
      return false
    }
    if (restyling) continue
    if (adding) {
      const a = flagsOf(was.key)
      const b = flagsOf(is.key)
      for (let k = 0; k < a.length; k++) if (a[k] === '1' && b[k] !== '1') return false
      if (hrefOf(was.key) !== '' && hrefOf(was.key) !== hrefOf(is.key)) return false
    } else if (was.key !== is.key) return false
  }
  return true
}

// ---------- the edits ----------

const caret = (text: string, at: number): NoteEdit => ({ text, start: at, end: at })

/** Replaces blocks `first` to `last` of a note with `lines` (none: they go, with the line feed that joined them to the others). */
function replaceBlocks(doc: NoteDoc, first: number, last: number, lines: readonly string[]): string {
  const source = doc.source
  const from = doc.blocks[first]!.from
  const to = doc.blocks[last]!.to
  if (lines.length > 0) return source.slice(0, from) + lines.join('\n') + source.slice(to)
  if (to < source.length) return source.slice(0, from) + source.slice(to + 1)
  return source.slice(0, Math.max(0, from - 1))
}

/** The edit at a place of the text of a note just written: the caret where `visible` is, on the side asked for. */
function caretAt(text: string, visible: number, side: 'left' | 'right' = 'left'): NoteEdit {
  return caret(text, sourceAt(readDoc(text), visible, side))
}

/**
 * Text typed at the caret (or over the selection, which goes first), as it is written: put into the Markdown where the caret is, so that what is typed
 * formats itself; elsewhere in its run's marks, or written with the look it is meant to have (`pending`: the look ⌘B, ⌘I… asked for with no
 * selection), when that would change the look of what was already there.
 */
export function insertText(source: string, start: number, end: number, typed: string, pending: CharStyle | null = null): NoteEdit {
  if (typed === '') return { text: source, start, end }
  let doc = readDoc(source)
  let at = start
  let wanted = pending
  if (start !== end) {
    const vs = visibleAt(doc, Math.min(start, end))
    const ve = visibleAt(doc, Math.max(start, end))
    // What replaces a selection takes the look of its first character.
    if (wanted === null && vs < ve) {
      const first = charStyle(doc, vs)
      if (first) wanted = { ...(first.strong ? { strong: true } : {}), ...(first.em ? { em: true } : {}), ...(first.strike ? { strike: true } : {}), ...(first.code ? { code: true } : {}), ...(explicitHref(first) ? { href: first.href! } : {}) }
    }
    const removed = deleteVisible(source, vs, ve)
    if (removed === null) return { text: source, start, end }
    doc = readDoc(removed.text)
    at = removed.start
  }
  const visible = visibleAt(doc, at)
  const block = doc.blocks[blockIndexAt(doc, visible)]!
  if (block.kind === 'code') {
    // A block of code takes what is typed as it is; one with no line yet gets its first.
    const put = block.codeLines === 0 ? `${typed}\n` : typed
    const spot = Math.max(block.contentFrom, Math.min(at, block.contentTo))
    return caret(doc.source.slice(0, spot) + put + doc.source.slice(spot), spot + typed.length)
  }
  const style = wanted ?? typingStyle(doc, at)
  const [left, right] = sidesAt(doc, visible)
  // The places the text may go: the caret's, then either side of the hidden marks, then the places between them, nearest first.
  const places = [...new Set([at, right, left, ...Array.from({ length: right - left + 1 }, (_, k) => left + k).sort((a, b) => Math.abs(a - at) - Math.abs(b - at))])]
  for (const place of places) {
    const text = doc.source.slice(0, place) + typed + doc.source.slice(place)
    const next = readDoc(text)
    const map = (k: number): number => (k < place ? k : k + typed.length)
    // Signs of emphasis typed that all became marks: they close (or open) a run, whose look may change what was written before it. Not a letter
    // that went into the hidden address of a link.
    const consumed = /^[*_~`]+$/.test(typed) && sourceChars(next)
      .slice(place, place + typed.length)
      .every((char) => !char.shown)
    if (!keepsLook(doc, next, map, true, consumed && wanted === null)) continue
    if (!typedAs(next, place, typed, style, wanted !== null)) continue
    return caret(text, place + typed.length)
  }
  // Written again with the look it is meant to have.
  const local = visible - block.start
  // One character per unit of the text, as blockChars gives them (an emoji is two).
  const chars = [...blockChars(block, 0, local), ...typed.split('').map((unit) => ({ ch: unit, ...style })), ...blockChars(block, local)]
  const line = writeBlock(shapeOf(block, doc.source), chars)
  if (line === null) return { text: doc.source, start: at, end: at }
  const text = replaceBlocks(doc, doc.blocks.indexOf(block), doc.blocks.indexOf(block), [line])
  return caretAt(text, visible + typed.length)
}

/** A line that starts a block of its own when it starts a line: a title, an item, a quote, a fence. */
const STARTS_BLOCK = /^(#{1,3} |\s*[-*+•] |\s*\d{1,9}[.)] |> ?|```)/

/**
 * A paste: Markdown (the clipboard's text, or what its HTML was written as by note-paste.ts) over the selection, cut to what the note still has room
 * for (`max` characters). It goes where it formats itself without changing the look of what was there, as typing does; one that starts with a title
 * or an item starts a line of its own. In a block of code, it is code.
 */
export function pasteMarkdown(source: string, start: number, end: number, markdown: string, max: number): NoteEdit {
  let edit: NoteEdit = { text: source, start, end }
  if (start !== end) {
    const doc = readDoc(source)
    const removed = deleteVisible(source, visibleAt(doc, Math.min(start, end)), visibleAt(doc, Math.max(start, end)))
    if (removed === null) return edit
    edit = removed
  }
  const doc = readDoc(edit.text)
  const visible = visibleAt(doc, edit.start)
  const block = doc.blocks[blockIndexAt(doc, visible)]!
  let put = markdown.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
  if (block.kind !== 'code' && visible > block.start && STARTS_BLOCK.test(put)) put = `\n${put}`
  put = put.slice(0, Math.max(0, max - edit.text.length))
  if (put === '') return edit
  if (block.kind === 'code') {
    const at = Math.max(block.contentFrom, Math.min(edit.start, block.contentTo))
    const text = edit.text.slice(0, at) + put + (block.codeLines === 0 ? '\n' : '') + edit.text.slice(at)
    return caret(text, at + put.length)
  }
  const [left, right] = sidesAt(doc, visible)
  const places = [edit.start, ...Array.from({ length: right - left + 1 }, (_, k) => left + k).filter((place) => place !== edit.start)]
  for (const place of places) {
    const text = edit.text.slice(0, place) + put + edit.text.slice(place)
    if (keepsLook(doc, readDoc(text), (k) => (k < place ? k : k + put.length), true)) return caret(text, place + put.length)
  }
  // One line that formats nothing without undoing the look around it: typed instead (its signs written so that they stay signs). Several: as they are.
  if (!put.includes('\n')) return insertText(edit.text, edit.start, edit.start, put)
  return caret(edit.text.slice(0, edit.start) + put + edit.text.slice(edit.start), edit.start + put.length)
}

/**
 * Whether the characters typed at `place` read with the look asked for: a link or code only if asked; bold, italic and struck at least (exactly, for a
 * look asked for by a button: typing after ⌘B that took bold off is not bold).
 */
function typedAs(doc: NoteDoc, place: number, typed: string, style: CharStyle, exact: boolean): boolean {
  const chars = sourceChars(doc).slice(place, place + typed.length)
  for (const char of chars) {
    // A sign that became a mark (the `*` that closes an italic): typing Markdown formats it.
    if (!char.shown) continue
    const flags = flagsOf(char.key)
    const want = [style.strong, style.em, style.strike]
    for (let k = 0; k < 3; k++) {
      if (want[k] && flags[k] !== '1') return false
      if (exact && !want[k] && flags[k] === '1') return false
    }
    if (flags[3] === '1' && !style.code) return false
    if (style.code && flags[3] !== '1') return false
    const href = hrefOf(char.key)
    if (href !== (style.href ?? '')) return false
  }
  return true
}

/**
 * The text shown between two places taken out. Within a block, the characters go and the marks of a run that is left empty with them; across
 * blocks, what is left of the last joins the first (which keeps its kind). A block of code is never joined to another: what is selected of it goes,
 * and the whole of it when all of it is selected.
 */
export function deleteVisible(source: string, vs: number, ve: number): NoteEdit | null {
  const doc = readDoc(source)
  const from = Math.max(0, Math.min(vs, ve))
  const to = Math.min(doc.text.length, Math.max(vs, ve))
  if (from === to) return caret(source, sourceAt(doc, from))
  const first = blockIndexAt(doc, from)
  const last = blockIndexAt(doc, to)
  const a = doc.blocks[first]!
  const b = doc.blocks[last]!
  if (first === last && a.kind === 'code') {
    const cut = a.contentFrom + (from - a.start)
    return caret(source.slice(0, cut) + source.slice(a.contentFrom + (to - a.start)), cut)
  }
  // The plainest way: the Markdown between the two places taken out, when what is left reads as it did.
  if (a.kind !== 'code' && b.kind !== 'code') {
    const cutFrom = sourceAt(doc, from, 'right')
    const cutTo = sourceAt(doc, to, 'left')
    if (cutFrom <= cutTo) {
      const text = source.slice(0, cutFrom) + source.slice(cutTo)
      const next = readDoc(text)
      const map = (k: number): number | null => (k < cutFrom ? k : k >= cutTo ? k - (cutTo - cutFrom) : null)
      if (next.text === doc.text.slice(0, from) + doc.text.slice(to) && keepsLook(doc, next, map, false) && sameKinds(next, doc, first, last)) return caretAt(text, from)
    }
  }
  if (a.kind === 'code' || b.kind === 'code') {
    const lines: string[] = []
    const keepA = from - a.start
    if (a.kind === 'code') {
      if (keepA > 0) lines.push(codeBlock(a, source, a.text.slice(0, keepA)))
    } else {
      const line = writeBlock(shapeOf(a, source), blockChars(a, 0, keepA))
      if (line === null) return null
      lines.push(line)
    }
    const keepB = to - b.start
    if (b.kind === 'code') {
      if (keepB < b.text.length) lines.push(codeBlock(b, source, b.text.slice(keepB)))
    } else {
      const line = writeBlock(shapeOf(b, source), blockChars(b, keepB))
      if (line === null) return null
      lines.push(line)
    }
    const text = replaceBlocks(doc, first, last, lines)
    const next = readDoc(text)
    return caret(text, sourceAt(next, Math.min(from, next.text.length)))
  }
  const chars = [...blockChars(a, 0, from - a.start), ...blockChars(b, to - b.start)]
  const line = writeBlock(shapeOf(a, source), chars)
  if (line === null) return null
  return caretAt(replaceBlocks(doc, first, last, [line]), from)
}

/** Whether a note kept the kind of the blocks of a deletion: the first one's, for the one they make. */
function sameKinds(next: NoteDoc, doc: NoteDoc, first: number, last: number): boolean {
  if (next.blocks.length !== doc.blocks.length - (last - first)) return false
  return next.blocks.every((block, index) => {
    const was = doc.blocks[index < first ? index : index === first ? first : index + (last - first)]!
    return block.kind === was.kind && block.level === was.level && block.checked === was.checked
  })
}

/** A block of code with another text, its fences kept. */
function codeBlock(block: DocBlock, source: string, text: string): string {
  const opening = source.slice(block.from, block.contentFrom - 1)
  const closing = source.slice(source.lastIndexOf('\n', block.to - 1) + 1, block.to)
  return `${opening}\n${text}\n${closing}`
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** The place one character (as it is drawn: an emoji with its parts) before `local` in a text, or after it. */
export function graphemeStep(text: string, local: number, forward: boolean): number {
  if (!segmenter) return Math.max(0, Math.min(text.length, local + (forward ? 1 : -1)))
  let previous = 0
  for (const { index } of segmenter.segment(text)) {
    if (forward && index > local) return index
    if (!forward && index >= local) return previous
    previous = index
  }
  return forward ? text.length : previous
}

const wordSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null

/** What a deletion takes: a character (⌫), a word (⌥⌫), the rest of the line (⌘⌫). */
export type DeleteUnit = 'char' | 'word' | 'line'

/**
 * Where a deletion of `unit` from `local` in a block's text stops, before it or after it, never past the line it is on (a block of code has several):
 * a character as it is drawn, the start of the word before (with the blanks after it) or the end of the word after, the start or the end of the line.
 */
export function deletionStep(text: string, local: number, unit: DeleteUnit, forward: boolean): number {
  const lineStart = text.lastIndexOf('\n', local - 1) + 1
  const next = text.indexOf('\n', local)
  const lineEnd = next === -1 ? text.length : next
  if (unit === 'char') return graphemeStep(text, local, forward)
  if (unit === 'line') return forward ? lineEnd : lineStart
  const line = text.slice(lineStart, lineEnd)
  const at = local - lineStart
  const words = wordSegmenter ? [...wordSegmenter.segment(line)].filter((segment) => segment.isWordLike).map((segment) => [segment.index, segment.index + segment.segment.length] as const) : [...line.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => [match.index, match.index + match[0].length] as const)
  if (forward) {
    const word = words.find(([, end]) => end > at)
    return lineStart + (word ? word[1] : line.length)
  }
  const word = [...words].reverse().find(([from]) => from < at)
  return lineStart + (word ? word[0] : 0)
}

/** The word a place of a block's text is in or next to (a correction of the spelling replaces it), or null. */
export function wordAt(text: string, local: number): [number, number] | null {
  const words = wordSegmenter ? [...wordSegmenter.segment(text)].filter((segment) => segment.isWordLike).map((segment) => [segment.index, segment.index + segment.segment.length] as [number, number]) : []
  return words.find(([from, to]) => from <= local && local <= to) ?? null
}

/**
 * ⌫ with the caret at the start of a block: a title, an item, a box or a quote becomes a paragraph; a block of code is unwrapped; a paragraph joins
 * the block before (a block of code takes no other: an empty line after one goes, any other line leaves the caret at its end). Elsewhere: the
 * character before goes, or the word before (⌥⌫), or the start of the line (⌘⌫).
 */
export function deleteBackward(source: string, start: number, end: number, unit: DeleteUnit = 'char'): NoteEdit | null {
  const doc = readDoc(source)
  if (start !== end) return deleteVisible(source, visibleAt(doc, start), visibleAt(doc, end))
  const visible = visibleAt(doc, start)
  const index = blockIndexAt(doc, visible)
  const block = doc.blocks[index]!
  const local = visible - block.start
  if (local > 0) {
    return deleteVisible(source, block.start + deletionStep(block.text, local, unit, false), visible)
  }
  if (block.kind === 'code') return unwrapCode(doc, index, 0)
  if (block.kind !== 'paragraph' && block.kind !== 'blank') return setPrefix(doc, index, { kind: 'paragraph' }, visible)
  if (index === 0) return null
  const before = doc.blocks[index - 1]!
  if (before.kind === 'code') {
    if (block.text !== '') return caret(source, before.contentTo)
    return caret(source.slice(0, before.to) + source.slice(block.to), before.contentTo)
  }
  return deleteVisible(source, visible - 1, visible)
}

/**
 * ⌦ with the caret at the end of a block: the block after joins it (never a block of code, nor into one: an empty line next to one goes). Elsewhere:
 * the character after goes, or the word after, or the rest of the line.
 */
export function deleteForward(source: string, start: number, end: number, unit: DeleteUnit = 'char'): NoteEdit | null {
  const doc = readDoc(source)
  if (start !== end) return deleteVisible(source, visibleAt(doc, start), visibleAt(doc, end))
  const visible = visibleAt(doc, start)
  const index = blockIndexAt(doc, visible)
  const block = doc.blocks[index]!
  const local = visible - block.start
  if (local < block.text.length) {
    return deleteVisible(source, visible, block.start + deletionStep(block.text, local, unit, true))
  }
  const after = doc.blocks[index + 1]
  if (!after) return null
  if (block.kind === 'code' || after.kind === 'code') {
    if (after.kind !== 'code' && after.text === '' && after.kind === 'blank') return caret(source.slice(0, block.to) + source.slice(after.to), start)
    if (block.kind !== 'code' && block.text === '' && block.kind === 'blank') return caret(source.slice(0, block.from) + source.slice(block.to + 1), block.from)
    return null
  }
  return deleteVisible(source, visible, visible + 1)
}

/** A block of code unwrapped: its lines become lines of the note, as they are; the caret at `local` of its text. */
function unwrapCode(doc: NoteDoc, index: number, local: number): NoteEdit {
  const block = doc.blocks[index]!
  const text = replaceBlocks(doc, index, index, [block.text])
  return caret(text, block.from + local)
}

/** A block given another start of line (a paragraph: none), its text kept as it shows; the caret where `visible` is. */
function setPrefix(doc: NoteDoc, index: number, shape: BlockShape, visible: number): NoteEdit | null {
  const block = doc.blocks[index]!
  const line = shapeLine(doc, block, shape)
  if (line === null) return null
  return caretAt(replaceBlocks(doc, index, index, [line]), visible, 'right')
}

/** The line of a block with another shape: its text as it was written when that reads the same, else written again. */
function shapeLine(doc: NoteDoc, block: DocBlock, shape: BlockShape): string | null {
  const content = doc.source.slice(block.contentFrom, block.to)
  const plain = prefixFor(shape) + (shape.kind === 'paragraph' || shape.kind === 'blank' ? protectStart(content) : content)
  const meant = settleChars(blockChars(block), shape.kind !== 'paragraph' && shape.kind !== 'blank')
  const back = lineChars(plain)
  if (readsAs(back, shape, meant.length === 0) && back.chars.map(charKey).join('\n') === meant.map(charKey).join('\n')) return plain
  return writeBlock(shape, blockChars(block))
}

/**
 * ↩: a new block. In a list, a task or a quote it is one more of the same (the next number, an empty box); on one that holds nothing it ends them
 * instead. After a title, a paragraph; at the start of a title or a quote that holds text, an empty line before it. "```" (and a language) followed
 * by ↩ opens a block of code; in a block of code, a new line, and ↩ on an empty last line leaves it.
 */
export function enter(source: string, start: number, end: number): NoteEdit | null {
  let edit: NoteEdit = { text: source, start, end }
  if (start !== end) {
    const doc = readDoc(source)
    const removed = deleteVisible(source, visibleAt(doc, start), visibleAt(doc, end))
    if (removed === null) return null
    edit = removed
  }
  const doc = readDoc(edit.text)
  const visible = visibleAt(doc, edit.start)
  const index = blockIndexAt(doc, visible)
  const block = doc.blocks[index]!
  const local = visible - block.start
  const text = edit.text
  if (block.kind === 'code') {
    const lines = block.text.split('\n')
    if (local === block.text.length && lines.length >= 2 && lines[lines.length - 1] === '') {
      // Out of the block: its empty last line becomes the line after it.
      const shorter = text.slice(0, block.contentTo - 1) + text.slice(block.contentTo, block.to) + '\n' + text.slice(block.to)
      return caret(shorter, block.to)
    }
    const at = Math.max(block.contentFrom, Math.min(edit.start, block.contentTo))
    return caret(text.slice(0, at) + (block.codeLines === 0 ? '\n\n' : '\n') + text.slice(at), at + 1)
  }
  const fence = /^```([A-Za-z0-9_+#.-]{0,30})\s*$/.exec(block.text)
  if (block.kind === 'paragraph' && fence && local === block.text.length && block.runs.every((run) => !run.esc && Object.keys(run.style).length === 0)) {
    const opening = `\`\`\`${fence[1]}`
    const made = replaceBlocks(doc, index, index, [`${opening}\n\n\`\`\``])
    return caret(made, block.from + opening.length + 1)
  }
  if (local === 0 && block.text !== '' && (block.kind === 'heading' || block.kind === 'quote')) {
    return caret(text.slice(0, block.from) + '\n' + text.slice(block.from), edit.start + 1)
  }
  const next = enterSplice(text, edit.start, block)
  if (next !== null) {
    const after = readDoc(next.text)
    const map = (k: number): number => (k < edit.start ? k : k + (next.text.length - text.length))
    if (keepsLook(doc, after, map, false) && after.text === doc.text.slice(0, visible) + '\n' + doc.text.slice(visible)) return next
    // Ending a list on an empty item: its sign goes, nothing else changes.
    if (after.text === doc.text && after.blocks.length === doc.blocks.length) return next
  }
  // Cut inside a run: both halves written again, the second as the block that follows this kind.
  const firstLine = writeBlock(shapeOf(block, text), blockChars(block, 0, local))
  const followShape: BlockShape =
    block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'blank'
      ? { kind: 'paragraph' }
      : { kind: block.kind, indent: block.indent, ...(block.kind === 'ordered' ? { number: (Number.parseInt(block.number ?? '1', 10) || 1) + 1 } : {}), ...(block.kind === 'task' ? { checked: false } : {}) }
  const secondLine = writeBlock(followShape, blockChars(block, local))
  if (firstLine === null || secondLine === null) return null
  const made = replaceBlocks(doc, index, index, [firstLine, secondLine])
  return caretAt(made, visible + 1, 'right')
}

/** Return as the raw Markdown field makes it (note-markdown.ts `enterEdit`), at a caret. */
function enterSplice(text: string, at: number, block: DocBlock): NoteEdit | null {
  const line = text.slice(block.from, block.to)
  const inLine = at - block.from
  const goesOn = /^(\s*)([-*+] +)(\[[ xX]\])(?=\s|$)( *)/.exec(line) ?? /^(\s*)([-*+•] +)/.exec(line) ?? /^(\s*)(\d{1,9})([.)])( +)/.exec(line) ?? /^(\s*)(> ?)/.exec(line)
  if (!goesOn || block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'blank') return caret(text.slice(0, at) + '\n' + text.slice(at), at + 1)
  const prefix = block.contentFrom - block.from
  if (inLine < prefix) return caret(text.slice(0, at) + '\n' + text.slice(at), at + 1)
  if (block.text === '') return caret(text.slice(0, block.from) + text.slice(block.contentFrom), block.from)
  let next: string
  if (block.kind === 'task') next = `${' '.repeat(block.indent)}${line.slice(block.indent).match(/^[-*+] +/)![0]}[ ] `
  else if (block.kind === 'ordered') {
    const number = /^(\s*)(\d{1,9})([.)])( +)/.exec(line)!
    next = `${number[1]}${Number(number[2]) + 1}${number[3]}${number[4]}`
  } else if (block.kind === 'quote') next = `${' '.repeat(block.indent)}> `
  else next = line.slice(0, prefix)
  return caret(text.slice(0, at) + '\n' + next + text.slice(at), at + 1 + next.length)
}

/**
 * ⌘B, ⌘I, the struck and the code of the toolbar over a selection: the mark is put on every character of it, or taken off when they all have it
 * (blanks aside). Blocks of code are left as they are. Null with no selection (the editor keeps the look for what is typed next).
 */
export function toggleInline(source: string, start: number, end: number, mark: InlineMark): NoteEdit | null {
  if (start === end) return null
  const doc = readDoc(source)
  const vs = visibleAt(doc, Math.min(start, end))
  const ve = visibleAt(doc, Math.max(start, end))
  if (vs === ve) return null
  const all = selectedChars(doc, vs, ve).filter((char) => char.ch.trim() !== '' || mark === 'code')
  const on = !(all.length > 0 && all.every((char) => char[mark]))
  return restyle(doc, vs, ve, (char) => {
    const next = { ...char }
    if (on) next[mark] = true
    else delete next[mark]
    return next
  })
}

/**
 * The text of a `mailto:` address as a person reads it: its escapes decoded when they are valid, and the text as it is written when they are not
 * (`ren%E9@exemple.fr` copied from a page in Latin-1, a `%` alone). A link that is drawn or inserted must never throw: a note whose editor
 * throws cannot be opened, changed or exported any more.
 */
export function readableAddress(escaped: string): string {
  try {
    return decodeURIComponent(escaped)
  } catch {
    return escaped
  }
}

/**
 * The link of a selection: `href` set on every character of it (or taken off with null). With a caret on a link, the whole link; with a caret
 * elsewhere, the address written there as a link of its own. Null when nothing changes.
 */
export function setLink(source: string, start: number, end: number, href: string | null): NoteEdit | null {
  const doc = readDoc(source)
  let vs = visibleAt(doc, Math.min(start, end))
  let ve = visibleAt(doc, Math.max(start, end))
  const address = href === null ? null : linkAddress(href)
  if (href !== null && address === null) return null
  if (vs === ve) {
    const current = selectionStyle(doc, start, end).href
    if (current === undefined) {
      if (address === null) return null
      const label = address.startsWith('mailto:') ? readableAddress(address.slice('mailto:'.length).split('?')[0] ?? '') : address
      return insertText(source, start, end, label || address, { href: address })
    }
    // The whole link around the caret.
    while (vs > 0 && explicitHref(charStyle(doc, vs - 1)) === current) vs--
    while (ve < doc.text.length && explicitHref(charStyle(doc, ve)) === current) ve++
  }
  return restyle(doc, vs, ve, (char) => {
    const next = { ...char }
    delete next.bare
    if (address === null) delete next.href
    else next.href = address
    return next
  })
}

/** An address as a link of a note writes it: one safeNoteHref accepts, its brackets written so that they do not end the link. */
export function linkAddress(raw: string): string | null {
  const href = safeNoteHref(raw)
  if (href === null) return null
  const written = href.replace(/\(/g, '%28').replace(/\)/g, '%29')
  return safeNoteHref(written) === written ? written : null
}

/** The characters between two places of the text given another look, block by block (blocks of code aside), the selection kept on them. */
function restyle(doc: NoteDoc, vs: number, ve: number, change: (char: StyledChar) => StyledChar): NoteEdit | null {
  let text = doc.source
  const touched = doc.blocks.map((block, index) => ({ block, index })).filter(({ block }) => block.kind !== 'code' && block.start + block.text.length >= vs && block.start <= ve)
  // From the last block up, so that the places of the ones before stay where they are.
  for (const { block, index } of touched.reverse()) {
    const from = Math.max(0, vs - block.start)
    const to = Math.min(block.text.length, ve - block.start)
    if (from >= to) continue
    const chars = [...blockChars(block, 0, from), ...blockChars(block, from, to).map(change), ...blockChars(block, to)]
    const line = writeBlock(shapeOf(block, doc.source), chars)
    if (line === null) return null
    text = replaceBlocks({ ...doc, source: text }, index, index, [line])
  }
  if (text === doc.source) return null
  const next = readDoc(text)
  return { text, start: sourceAt(next, vs, 'right'), end: sourceAt(next, ve, 'left') }
}

export type BlockChoice = { kind: 'heading'; level: 1 | 2 } | { kind: 'bullet' } | { kind: 'ordered' } | { kind: 'task' } | { kind: 'quote' }

/** Whether a block is of the kind a button of the toolbar makes. */
export const isBlockOf = (block: DocBlock, choice: BlockChoice): boolean => block.kind === choice.kind && (choice.kind !== 'heading' || block.level === choice.level)

/**
 * The title, list, box and quote buttons: every block the selection touches becomes one (an empty line only when it is the only one), or a paragraph
 * again when they all were already. The numbers of a list follow on from an item just before. Blocks of code are left as they are.
 */
export function setBlocks(source: string, start: number, end: number, choice: BlockChoice): NoteEdit | null {
  const doc = readDoc(source)
  const vs = visibleAt(doc, Math.min(start, end))
  const ve = visibleAt(doc, Math.max(start, end))
  const indexes = blocksIn(doc, start, end).filter((index) => doc.blocks[index]!.kind !== 'code')
  const targets = indexes.length > 1 ? indexes.filter((index) => doc.blocks[index]!.kind !== 'blank') : indexes
  if (targets.length === 0) return null
  const off = targets.every((index) => isBlockOf(doc.blocks[index]!, choice))
  const before = doc.blocks[targets[0]! - 1]
  let number = before?.kind === 'ordered' ? (Number.parseInt(before.number ?? '0', 10) || 0) + 1 : 1
  let text = source
  const lines = new Map<number, string>()
  for (const index of targets) {
    const block = doc.blocks[index]!
    const listy = (kind: BlockKind): boolean => kind === 'bullet' || kind === 'ordered' || kind === 'task'
    const shape: BlockShape = off
      ? { kind: 'paragraph' }
      : {
          kind: choice.kind,
          ...(choice.kind === 'heading' ? { level: choice.level } : {}),
          ...(choice.kind === 'ordered' ? { number: number++ } : {}),
          ...(choice.kind === 'task' ? { checked: false } : {}),
          indent: listy(block.kind) && listy(choice.kind) ? block.indent : 0
        }
    const line = shapeLine(doc, block, shape)
    if (line === null) return null
    lines.set(index, line)
  }
  for (const index of [...lines.keys()].sort((a, b) => b - a)) text = replaceBlocks({ ...doc, source: text }, index, index, [lines.get(index)!])
  const next = readDoc(text)
  return { text, start: sourceAt(next, vs, 'right'), end: sourceAt(next, ve, 'left') }
}

/**
 * The code button with no selection, or one over several lines: the lines become a block of code (their text, as it shows), or the block of code the
 * selection is in becomes lines again. Null when a line would end the block (a line of three backquotes).
 */
export function toggleCodeBlock(source: string, start: number, end: number): NoteEdit | null {
  const doc = readDoc(source)
  const indexes = blocksIn(doc, start, end)
  const inside = indexes.find((index) => doc.blocks[index]!.kind === 'code')
  const vs = visibleAt(doc, Math.min(start, end))
  const ve = visibleAt(doc, Math.max(start, end))
  if (inside !== undefined) {
    const block = doc.blocks[inside]!
    const text = replaceBlocks(doc, inside, inside, [block.text])
    const next = readDoc(text)
    return { text, start: sourceAt(next, vs), end: sourceAt(next, ve) }
  }
  const lines = indexes.map((index) => doc.blocks[index]!.text)
  if (lines.some((line) => /^```/.test(line))) return null
  const text = replaceBlocks(doc, indexes[0]!, indexes[indexes.length - 1]!, [`\`\`\`\n${lines.join('\n')}\n\`\`\``])
  // The lines of a block of code show as the lines they were: the caret (or the selection) stays on the same text.
  const next = readDoc(text)
  return { text, start: sourceAt(next, vs), end: sourceAt(next, ve) }
}

// ---------- copying ----------

/**
 * The Markdown of a selection, written so that it reads alone as it shows: the marks of the runs it cuts closed on its edges, the start of each line
 * (a title, an item) when it holds more than one line or the whole of one.
 */
export function selectionMarkdown(source: string, start: number, end: number): string {
  const doc = readDoc(source)
  const vs = visibleAt(doc, Math.min(start, end))
  const ve = visibleAt(doc, Math.max(start, end))
  if (vs === ve) return ''
  const indexes = blocksIn(doc, start, end)
  const whole = indexes.length > 1
  const out: string[] = []
  for (const index of indexes) {
    const block = doc.blocks[index]!
    const from = Math.max(0, vs - block.start)
    const to = Math.min(block.text.length, ve - block.start)
    const all = whole || (from === 0 && to === block.text.length)
    if (block.kind === 'code') {
      const text = block.text.slice(from, to)
      out.push(all ? codeBlock(block, source, text) : text)
      continue
    }
    const chars = blockChars(block, from, to)
    const line = all ? writeBlock(shapeOf(block, source), chars) : writeBlock({ kind: 'paragraph' }, chars)
    out.push(line ?? chars.map((char) => char.ch).join(''))
  }
  return out.join('\n')
}

/** The HTML of a run of characters: every text escaped, the only tags strong, em, s, code and a (with an address safeNoteHref accepted). */
function inlineHtml(chars: readonly StyledChar[]): string {
  let out = ''
  let index = 0
  while (index < chars.length) {
    const char = chars[index]!
    const href = char.href !== undefined ? safeNoteHref(char.href) : null
    let end = index
    while (end < chars.length && (chars[end]!.href !== undefined ? safeNoteHref(chars[end]!.href!) : null) === href) end++
    const part = chars.slice(index, end)
    let inner = ''
    let k = 0
    while (k < part.length) {
      const look = part[k]!
      let stop = k
      while (stop < part.length && part[stop]!.strong === look.strong && part[stop]!.em === look.em && part[stop]!.strike === look.strike && part[stop]!.code === look.code) stop++
      let piece = escapeHtml(part.slice(k, stop).map((each) => each.ch).join(''))
      if (look.code) piece = `<code>${piece}</code>`
      if (look.strike) piece = `<s>${piece}</s>`
      if (look.em) piece = `<em>${piece}</em>`
      if (look.strong) piece = `<strong>${piece}</strong>`
      inner += piece
      k = stop
    }
    out += href !== null ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner
    index = end
  }
  return out
}

/** A note as HTML, for "Copier le texte mis en forme": titles, paragraphs, lists (a box drawn as ☐ or ☑), quotes and code; nothing of its text read as HTML. */
export function noteHtml(source: string): string {
  const doc = readDoc(source)
  const out: string[] = []
  let list: 'ul' | 'ol' | 'blockquote' | null = null
  const open = (kind: 'ul' | 'ol' | 'blockquote' | null, start?: number): void => {
    if (list === kind) return
    if (list !== null) out.push(`</${list}>`)
    if (kind !== null) out.push(kind === 'ol' && start !== undefined && start !== 1 ? `<ol start="${start}">` : `<${kind}>`)
    list = kind
  }
  for (const block of doc.blocks) {
    const html = inlineHtml(blockChars(block))
    switch (block.kind) {
      case 'heading':
        open(null)
        out.push(`<h${block.level ?? 1}>${html}</h${block.level ?? 1}>`)
        break
      case 'bullet':
        open('ul')
        out.push(`<li>${html}</li>`)
        break
      case 'task':
        open('ul')
        out.push(`<li>${block.checked ? '☑' : '☐'} ${html}</li>`)
        break
      case 'ordered':
        open('ol', Number.parseInt(block.number ?? '1', 10))
        out.push(`<li>${html}</li>`)
        break
      case 'quote':
        open('blockquote')
        out.push(`<p>${html}</p>`)
        break
      case 'code':
        open(null)
        out.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`)
        break
      case 'blank':
        open(null)
        break
      default:
        open(null)
        out.push(`<p>${html}</p>`)
    }
  }
  open(null)
  return out.join('')
}

