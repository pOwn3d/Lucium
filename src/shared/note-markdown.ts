// The Markdown of a note, read into the pieces the editor draws (renderer/NoteTextEditor.tsx, shared/note-doc.ts). The text of the note is the only
// truth: a line is cut into pieces whose texts, put back end to end, are the line again, character for character, so drawing a note and reading it
// back never changes it (an old note in plain text included). What is recognised: `# ` to `### ` titles, `- ` / `* ` / `+ ` lists, `1. ` numbered
// lists, `- [ ] ` boxes, `> ` quotes, blocks of code between two lines of three backquotes, **bold** (or __bold__), *italic* (or _italic_),
// ~~struck~~, `code`, [text](address), bare addresses and a backslash before a sign that would be read as a mark (`\*`). Anything else is text, kept
// as it is. Only data comes out of here: the editor makes elements and text nodes of it, never HTML, and an address is a link only when it is http,
// https or mailto. The pure edits of the raw Markdown field are here too (Return in a list, ⌘B, ⌘I, ⌘K, the boxes), with the plain text the list of
// notes shows.

/** A piece of a line. `mark`: a mark of Markdown, never shown by the editor; `box`: the `[ ]` of a task, drawn as a box; `number`: an item's number. */
export interface NotePiece {
  kind: 'text' | 'mark' | 'box' | 'number'
  /** Its characters in the note, exactly. */
  text: string
  strong?: true
  em?: true
  strike?: true
  code?: true
  /** The address a link opens (http, https or mailto), on the text of a link and on a bare address. */
  href?: string
  /** The address of `[text](address)`, a mark drawn as an address. */
  url?: true
  /** The blanks before the sign of an item inside another. */
  indent?: true
  /** A character written after a backslash (`\*` is a star, not a mark): the backslash is the mark before it. */
  escaped?: true
  /** A bare address: its text is its own address. */
  bare?: true
}

export type NoteLineKind = 'paragraph' | 'heading' | 'bullet' | 'ordered' | 'task' | 'quote' | 'blank' | 'code' | 'fence'

export interface NoteLine {
  kind: NoteLineKind
  /** The level of a title, 1 to 3. */
  level?: 1 | 2 | 3
  /** A task whose box is checked. */
  checked?: boolean
  pieces: NotePiece[]
  /** How many characters start the line before its text (its title mark, sign, number, box or quote mark, with the blanks before them); absent: none. */
  prefix?: number
  /** A line of three backquotes: the one that opens a block of code, or the one that closes it (`kind` 'fence'). */
  fence?: 'open' | 'close'
  /** The language an opening fence names (```js), when it names one. */
  lang?: string
}

/** The longest address a link of a note keeps. */
const HREF_MAX = 4096

/**
 * The address a link of a note may open, as the URL parser writes it, or null: a web page (http, https) or a mail address (`mailto:`, without a host,
 * as a mail link is written). `javascript:`, `data:`, `file:` are never links.
 */
export function safeNoteHref(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length > HREF_MAX || !URL.canParse(trimmed)) return null
  // An address that starts so is one of the two (URL.canParse said it is one).
  if (/^https?:\/\//i.test(trimmed)) return new URL(trimmed).href
  if (/^mailto:[^/]/i.test(trimmed)) {
    const url = new URL(trimmed)
    // A control character or a blank has no place in a mail address: the parser would keep some of them.
    return url.protocol === 'mailto:' && url.host === '' && url.username === '' && !/[\s\u0000-\u001f\u007f]/.test(trimmed) ? url.href : null
  }
  return null
}

/**
 * A bare address without what usually ends the sentence it is in: `.`, `,`, a closing bracket it does not open. The brackets are counted once and
 * the count follows the end as it comes back (an address followed by thousands of `)` took a recount of the whole text at each one: 80 ms a key).
 */
function trimAddress(raw: string): string {
  let end = raw.length
  // Only `)` is ever taken off the end: the opening ones stay what they were.
  const opened = count(raw, '(')
  let closed = count(raw, ')')
  for (;;) {
    const last = raw[end - 1]
    if (last === undefined) break
    if ('.,;:!?\'"»*_~'.includes(last)) end--
    else if (last === ')' && opened < closed) {
      end--
      closed--
    } else break
  }
  return raw.slice(0, end)
}

const count = (text: string, char: string): number => text.split(char).length - 1

type Style = Pick<NotePiece, 'strong' | 'em' | 'strike' | 'href'>

/** A letter, a digit or `_`: an underscore next to one is part of a word (snake_case), never a mark. */
const WORD = '[\\p{L}\\p{N}_]'

// One of, at the earliest place of the line (never across a line): a backslash before a sign; `code` (between runs of backquotes of one length); a
// [text](address); a bare address; **bold**; __bold__; *italic* (which may hold a **bold**); _italic_; ~~struck~~. A mark next to a blank is no mark:
// "5 * 3 * 2" is text. A bold run ends on a `**` that no other `*` follows, so that `***` closes an italic inside it first.
const INLINE = new RegExp(
  [
    '\\\\(?<esc>[!-/:-@\\[-`{-~])',
    '(?<!`)(?<ticks>`+)(?<code>[^`\\n](?:[^\\n]*?[^`\\n])?)\\k<ticks>(?!`)',
    '\\[(?<label>(?:\\\\.|[^\\]\\\\\\n])+)\\]\\((?<address>[^()\\s]+)\\)',
    '(?<bare>https?:\\/\\/[^\\s<>]+)',
    '\\*\\*(?=\\S)(?<strong>[^\\n]*?\\S)\\*\\*(?!\\*)',
    `(?<!${WORD})__(?=\\S)(?<strong2>[^\\n]*?\\S)__(?!${WORD})`,
    '\\*(?=[^\\s*]|\\*\\*[^\\s*])(?<em>(?:[^*\\n]|\\*\\*(?=[^\\s*])[^*\\n]*?[^\\s*]\\*\\*)+?)(?<=\\S)\\*',
    `(?<!${WORD})_(?=[^\\s_])(?<em2>[^_\\n]*?[^\\s_])_(?!${WORD})`,
    '~~(?=\\S)(?<strike>[^\\n]*?\\S)~~(?!~)'
  ].join('|'),
  'gu'
)

function push(out: NotePiece[], piece: NotePiece): void {
  if (piece.text !== '') out.push(piece)
}

/** The pieces of a run of text, in order; `style` is what the run is inside of (a bold run's italic, a link's bold). */
function inline(text: string, style: Style, out: NotePiece[], links = true): void {
  const pattern = new RegExp(INLINE.source, INLINE.flags)
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const at = match.index
    const whole = match[0]
    const groups = match.groups ?? {}
    const before = (): void => push(out, { kind: 'text', text: text.slice(last, at), ...style })
    const wrap = (mark: string, inner: string, added: Style, nested = links): void => {
      before()
      push(out, { kind: 'mark', text: mark, ...style })
      inline(inner, { ...style, ...added }, out, nested)
      push(out, { kind: 'mark', text: mark, ...style })
    }
    if (groups['esc'] !== undefined) {
      before()
      push(out, { kind: 'mark', text: '\\', ...style })
      push(out, { kind: 'text', text: groups['esc'], ...style, escaped: true })
    } else if (groups['code'] !== undefined && groups['ticks'] !== undefined) {
      before()
      push(out, { kind: 'mark', text: groups['ticks'], ...style })
      push(out, { kind: 'text', text: groups['code'], ...style, code: true })
      push(out, { kind: 'mark', text: groups['ticks'], ...style })
    } else if (groups['label'] !== undefined && groups['address'] !== undefined) {
      const href = links ? safeNoteHref(groups['address']) : null
      // A link to anything but a web page or a mail address is no link: its text stays as it was typed, and the rest of the line is read on from the
      // next character.
      if (href === null) {
        pattern.lastIndex = at + 1
        continue
      }
      before()
      push(out, { kind: 'mark', text: '[', ...style })
      inline(groups['label'], { ...style, href }, out, false)
      push(out, { kind: 'mark', text: '](', ...style })
      push(out, { kind: 'mark', text: groups['address'], ...style, url: true })
      push(out, { kind: 'mark', text: ')', ...style })
    } else if (groups['bare'] !== undefined) {
      const kept = trimAddress(groups['bare'])
      const href = links && style.href === undefined ? safeNoteHref(kept) : null
      if (href === null) {
        pattern.lastIndex = at + 1
        continue
      }
      before()
      push(out, { kind: 'text', text: kept, ...style, href, bare: true })
      last = at + kept.length
      pattern.lastIndex = last
      continue
    } else if (groups['strong'] !== undefined) wrap('**', groups['strong'], { strong: true })
    else if (groups['strong2'] !== undefined) wrap('__', groups['strong2'], { strong: true })
    else if (groups['em'] !== undefined) wrap('*', groups['em'], { em: true })
    else if (groups['em2'] !== undefined) wrap('_', groups['em2'], { em: true })
    else if (groups['strike'] !== undefined) wrap('~~', groups['strike'], { strike: true })
    last = at + whole.length
  }
  push(out, { kind: 'text', text: text.slice(last), ...style })
}

const HEADING = /^(#{1,3})( +)/
const TASK = /^(\s*)([-*+] +)(\[[ xX]\])(?=\s|$)( *)/
const BULLET = /^(\s*)([-*+•] +)/
const ORDERED = /^(\s*)(\d{1,9}[.)] +)/
const QUOTE = /^(\s*)(> ?)/
/** The line that opens a block of code: three backquotes, a language maybe; and the one that closes it. */
export const FENCE_OPEN = /^```([A-Za-z0-9_+#.-]{0,30})[ \t]*$/
export const FENCE_CLOSE = /^```[ \t]*$/

/** One line of a note, cut into pieces (alone: a line of three backquotes is text here; `parseNote` knows the blocks of code). */
export function parseNoteLine(source: string): NoteLine {
  if (source === '') return { kind: 'blank', pieces: [] }
  const pieces: NotePiece[] = []
  const rest = (from: number): NotePiece[] => {
    inline(source.slice(from), {}, pieces)
    return pieces
  }
  const heading = HEADING.exec(source)
  if (heading) {
    push(pieces, { kind: 'mark', text: heading[0] })
    return { kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, prefix: heading[0].length, pieces: rest(heading[0].length) }
  }
  const task = TASK.exec(source)
  if (task) {
    push(pieces, { kind: 'text', text: task[1]!, indent: true })
    push(pieces, { kind: 'mark', text: task[2]! })
    push(pieces, { kind: 'box', text: task[3]! })
    push(pieces, { kind: 'mark', text: task[4]! })
    return { kind: 'task', checked: task[3] !== '[ ]', prefix: task[0].length, pieces: rest(task[0].length) }
  }
  const bullet = BULLET.exec(source)
  if (bullet) {
    push(pieces, { kind: 'text', text: bullet[1]!, indent: true })
    push(pieces, { kind: 'mark', text: bullet[2]! })
    return { kind: 'bullet', prefix: bullet[0].length, pieces: rest(bullet[0].length) }
  }
  const ordered = ORDERED.exec(source)
  if (ordered) {
    push(pieces, { kind: 'text', text: ordered[1]!, indent: true })
    push(pieces, { kind: 'number', text: ordered[2]! })
    return { kind: 'ordered', prefix: ordered[0].length, pieces: rest(ordered[0].length) }
  }
  const quote = QUOTE.exec(source)
  if (quote) {
    push(pieces, { kind: 'text', text: quote[1]!, indent: true })
    push(pieces, { kind: 'mark', text: quote[2]! })
    return { kind: 'quote', prefix: quote[0].length, pieces: rest(quote[0].length) }
  }
  return { kind: 'paragraph', pieces: rest(0) }
}

/**
 * The lines of a note, one per line of its text (an empty text is one blank line). A line of three backquotes opens a block of code when a later one
 * closes it: the lines between are code, kept as they are (nothing in them is a mark); a fence that nothing closes is text.
 */
export function parseNote(source: string): NoteLine[] {
  const sources = source.split('\n')
  const lines: NoteLine[] = []
  for (let index = 0; index < sources.length; index++) {
    const line = sources[index]!
    const open = FENCE_OPEN.exec(line)
    const close = open ? sources.findIndex((each, at) => at > index && FENCE_CLOSE.test(each)) : -1
    if (!open || close === -1) {
      lines.push(parseNoteLine(line))
      continue
    }
    lines.push({ kind: 'fence', fence: 'open', pieces: [{ kind: 'mark', text: line }], ...(open[1] ? { lang: open[1] } : {}) })
    for (let inner = index + 1; inner < close; inner++) {
      const code = sources[inner]!
      lines.push({ kind: 'code', pieces: code === '' ? [] : [{ kind: 'text', text: code, code: true }] })
    }
    lines.push({ kind: 'fence', fence: 'close', pieces: [{ kind: 'mark', text: sources[close]! }] })
    index = close
  }
  return lines
}

/** The text a line was read from. */
export const lineSource = (line: NoteLine): string => line.pieces.map((piece) => piece.text).join('')

/** The text the lines were read from: `noteSource(parseNote(text)) === text`, whatever the text. */
export const noteSource = (lines: readonly NoteLine[]): string => lines.map(lineSource).join('\n')


// ---------- the plain text of the list ----------

/** What a line says, without its marks: the text of its links, not their addresses; a list's sign or number only when `signs` asks for it. */
export function plainLine(line: NoteLine, signs = false): string {
  const body = line.pieces
    .filter((piece) => piece.kind === 'text' || (signs && piece.kind === 'number'))
    .map((piece) => piece.text)
    .join('')
  if (!signs) return body.trim()
  const sign = line.kind === 'bullet' ? '• ' : line.kind === 'task' ? (line.checked ? '☑ ' : '☐ ') : ''
  // The indent of an item stays before its sign.
  const indent = body.length - body.trimStart().length
  return sign === '' ? body : `${body.slice(0, indent)}${sign}${body.slice(indent)}`
}

/** A note as plain text, for the row of the list: its lines kept, its marks taken out, a box or a sign for the items of a list, no fence of a block of code. */
export const notePlainText = (source: string): string =>
  parseNote(source)
    .filter((line) => line.kind !== 'fence')
    .map((line) => (line.kind === 'code' ? lineSource(line) : plainLine(line, true)))
    .join('\n')
    .trim()

// ---------- the edits of the editor's keys ----------

/** A text and its selection (`start` ≤ `end`, in characters). */
export interface NoteEdit {
  text: string
  start: number
  end: number
}

const ordered = (edit: NoteEdit): NoteEdit => (edit.start <= edit.end ? edit : { ...edit, start: edit.end, end: edit.start })

/** The selection replaced by `insert`; the caret after it, or the part of it `select` names (offsets inside `insert`). */
export function replaceSelection(edit: NoteEdit, insert: string, select?: [number, number]): NoteEdit {
  const { text, start, end } = ordered(edit)
  const [from, to] = select ?? [insert.length, insert.length]
  return { text: text.slice(0, start) + insert + text.slice(end), start: start + from, end: start + to }
}

/** Where the line holding `offset` starts and ends (its line feed excluded). */
export function lineAround(text: string, offset: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', offset - 1) + 1
  const next = text.indexOf('\n', offset)
  return { start, end: next === -1 ? text.length : next }
}

/** The start of a list item, a task or a quote, and what the next line starts with. Null for any other line. */
function continuation(line: string): { prefix: string; next: string } | null {
  const task = TASK.exec(line)
  if (task) return { prefix: task[0], next: `${task[1]}${task[2]}[ ] ` }
  const bullet = BULLET.exec(line)
  if (bullet) return { prefix: bullet[0], next: bullet[0] }
  const number = /^(\s*)(\d{1,9})([.)])( +)/.exec(line)
  if (number) return { prefix: number[0], next: `${number[1]}${Number(number[2]) + 1}${number[3]}${number[4]}` }
  const quote = QUOTE.exec(line)
  if (quote) return { prefix: quote[0], next: `${quote[1]}> ` }
  return null
}

/**
 * Return: a new line. In a list, a task or a quote it starts as the line did (the next number, an empty box); on an item that holds nothing yet it ends
 * the list instead (the item's mark goes, no line is added). Inside the mark itself, it is a plain new line.
 */
export function enterEdit(edit: NoteEdit): NoteEdit {
  const { text, start, end } = ordered(edit)
  const line = lineAround(text, start)
  const goesOn = continuation(text.slice(line.start, line.end))
  if (!goesOn || start < line.start + goesOn.prefix.length) return replaceSelection(edit, '\n')
  const empty = text.slice(line.start + goesOn.prefix.length, line.end).trim() === ''
  if (empty && start === end) return { text: text.slice(0, line.start) + text.slice(line.start + goesOn.prefix.length), start: line.start, end: line.start }
  return replaceSelection(edit, `\n${goesOn.next}`)
}

/** Whether `text` ends with the mark (for `*`, an italic one: not the end of a `**`, unless it is `***`). */
function endsWithMark(text: string, mark: string): boolean {
  if (mark !== '*') return text.endsWith(mark)
  return text.endsWith('*') && (!text.endsWith('**') || text.endsWith('***'))
}

function startsWithMark(text: string, mark: string): boolean {
  if (mark !== '*') return text.startsWith(mark)
  return text.startsWith('*') && (!text.startsWith('**') || text.startsWith('***'))
}

/**
 * ⌘B (`**`) and ⌘I (`*`) in the field of the raw Markdown, and its struck (`~~`) and code (`` ` ``) buttons: the selection gets the marks, or loses
 * them when it already has them (around it or at its ends). Without a selection the two marks are put in, the caret between them. A selection over
 * several lines marks each line, as a mark never spans two.
 */
export function toggleMarks(edit: NoteEdit, mark: '**' | '*' | '~~' | '`'): NoteEdit {
  const { text, start, end } = ordered(edit)
  const before = text.slice(0, start)
  const chosen = text.slice(start, end)
  const after = text.slice(end)
  const size = mark.length
  // Around the selection (or around the caret, between two marks just put in): the marks go.
  if (endsWithMark(before, mark) && startsWithMark(after, mark)) {
    return { text: before.slice(0, -size) + chosen + after.slice(size), start: start - size, end: end - size }
  }
  if (chosen.length > size * 2 && startsWithMark(chosen, mark) && endsWithMark(chosen, mark) && !chosen.includes('\n')) {
    return { text: before + chosen.slice(size, -size) + after, start, end: end - size * 2 }
  }
  if (chosen === '') return replaceSelection(edit, mark + mark, [size, size])
  const marked = chosen
    .split('\n')
    .map((part) => {
      const core = part.trim()
      if (core === '') return part
      const lead = part.length - part.trimStart().length
      return `${part.slice(0, lead)}${mark}${core}${mark}${part.slice(lead + core.length)}`
    })
    .join('\n')
  // One line: the text that was chosen stays chosen, inside its marks; several: all of it.
  if (!chosen.includes('\n')) {
    const lead = chosen.length - chosen.trimStart().length
    const core = chosen.trim().length
    return replaceSelection(edit, marked, [lead + size, lead + size + core])
  }
  return replaceSelection(edit, marked, [0, marked.length])
}

/** The address a new link starts with: chosen at once, so that typing or pasting the real one replaces it. */
export const LINK_PLACEHOLDER = 'https://'

/**
 * ⌘K: a link. A chosen text becomes its text, the placeholder address chosen; a chosen address becomes its address, the caret where its text goes;
 * with nothing chosen, an empty link, the caret in its text. A selection over several lines is left alone.
 */
export function linkEdit(edit: NoteEdit): NoteEdit {
  const { text, start, end } = ordered(edit)
  const chosen = text.slice(start, end)
  if (chosen.includes('\n')) return ordered(edit)
  if (chosen === '') return replaceSelection(edit, `[](${LINK_PLACEHOLDER})`, [1, 1])
  if (safeNoteHref(chosen) !== null) return replaceSelection(edit, `[](${chosen.trim()})`, [1, 1])
  const at = chosen.length + 3
  return replaceSelection(edit, `[${chosen}](${LINK_PLACEHOLDER})`, [at, at + LINK_PLACEHOLDER.length])
}

/** The text with the box of task line `index` checked or unchecked; the same text when that line is no task. The length never changes. */
export function toggleTaskLine(text: string, index: number): string {
  const lines = text.split('\n')
  const line = lines[index]
  const task = line === undefined ? null : TASK.exec(line)
  if (!task || line === undefined) return text
  const at = task[1]!.length + task[2]!.length + 1
  lines[index] = `${line.slice(0, at)}${line[at] === ' ' ? 'x' : ' '}${line.slice(at + 1)}`
  return lines.join('\n')
}

/** ⇧⌘U: the boxes of the task lines the selection touches, checked or unchecked; the selection stays where it is. */
export function toggleTasksEdit(edit: NoteEdit): NoteEdit {
  const { text, start, end } = ordered(edit)
  const first = text.slice(0, start).split('\n').length - 1
  const last = text.slice(0, end).split('\n').length - 1
  let next = text
  for (let index = first; index <= last; index++) next = toggleTaskLine(next, index)
  return { text: next, start, end }
}

/** What a paste puts in: its lines (CR LF read as LF) without the control characters a note does not keep. Never HTML: the editor reads text/plain only. */
export const pastedText = (raw: string): string => raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')

/** A paste of the clipboard's text/plain over the selection: cleaned, and cut so that the note holds `max` characters at most. */
export function pasteEdit(edit: NoteEdit, clipboard: string, max: number): NoteEdit {
  const { text, start, end } = ordered(edit)
  const room = Math.max(0, max - (text.length - (end - start)))
  return replaceSelection(edit, pastedText(clipboard).slice(0, room))
}

/** Whether a change may be kept: a note of `max` characters at most, or one that does not grow (deleting from a note that is too long stays possible). */
export const withinLimit = (before: string, next: string, max: number): boolean => next.length <= max || next.length <= before.length

// ---------- the history of the editor ----------

/** How long a run of typing stays one step of the history (⌘Z takes the whole word back, not one letter). */
export const TYPING_STEP_MS = 1000
const HISTORY_MAX = 200

/** The steps ⌘Z and ⇧⌘Z go through: the editor draws the text itself, so the browser's own history cannot be used. */
export class NoteHistory {
  private steps: NoteEdit[]
  private at = 0
  private typingAt = -Infinity

  constructor(initial: NoteEdit) {
    this.steps = [initial]
  }

  /** A new state of the text. Typing that follows typing within TYPING_STEP_MS joins its step; anything else (Return, a paste, a mark, a box) is a step. */
  record(state: NoteEdit, typing: boolean, now: number): void {
    const joins = typing && now - this.typingAt < TYPING_STEP_MS && this.at > 0
    this.steps = this.steps.slice(0, this.at + 1)
    if (joins) this.steps[this.at] = state
    else {
      this.steps.push(state)
      if (this.steps.length > HISTORY_MAX) this.steps.shift()
      this.at = this.steps.length - 1
    }
    this.typingAt = typing ? now : -Infinity
  }

  /** The state before, or null at the first one. */
  undo(): NoteEdit | null {
    if (this.at === 0) return null
    this.at--
    this.typingAt = -Infinity
    return this.steps[this.at]!
  }

  /** The state undone last, or null. */
  redo(): NoteEdit | null {
    if (this.at >= this.steps.length - 1) return null
    this.at++
    this.typingAt = -Infinity
    return this.steps[this.at]!
  }
}
