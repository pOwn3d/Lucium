// Page → Markdown. The page side (src/main/engine/markdown-picker.ts) walks the DOM of the tab, applies what the user chose to keep or leave
// out, and sends a snapshot: a tree of plain data holding only the tags and attributes listed here. This file checks that tree (it comes
// from a renderer, so it is not trusted: shape, size, depth, tags, attributes and addresses are all re-validated) and writes the Markdown.
// Nothing here touches a DOM or Electron: a script, an event handler or a `javascript:` address cannot reach the output because the
// snapshot never carries them and the converter only ever emits text it escaped itself.

/** A snapshot node: a piece of text, or an element reduced to its tag, a few attributes and its children. */
import { t } from './i18n'
import { isRecord } from './record'

export type MdNode = string | MdElement
export interface MdElement {
  t: string
  a?: Record<string, string>
  c?: MdNode[]
}

/** What one export is allowed to cost: past these the snapshot is cut and the result says so. */
export const MD_LIMITS = {
  nodes: 100_000,
  depth: 100,
  textChars: 4_000_000,
  url: 4096,
  alt: 1000,
  warnings: 50,
  warningChars: 200,
  /** `colspan` and `rowspan` above this are read as this: a hostile value would otherwise multiply the cells of a table. */
  span: 32
} as const

/** Downloading the images of a page into an archive: the caps of the save with images. */
export const IMAGE_LIMITS = {
  count: 100,
  perImageBytes: 10 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  timeoutMs: 15_000,
  deadlineMs: 120_000,
  parallel: 4
} as const

/** The image types an archive accepts, with the extension each is stored under. Anything else the server answers is refused. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico'
}

/** `images/image-007.png`: the name of the seventh image in the archive. */
export const archiveImageName = (index: number, extension: string): string => `images/image-${String(index + 1).padStart(3, '0')}.${extension}`

// ---------- what the page side is told, and what it answers ----------

/** An answer from the page longer than this is refused unread: it is a page of several megabytes of text, not a snapshot within the limits. */
export const MAX_REPLY_CHARS = 40_000_000

export interface MdPick {
  /** What the user asked for in the bar. */
  action: 'copy' | 'save'
  /** Whether they exported a text selection or chose blocks of the page. */
  scope: 'selection' | 'blocks'
  snapshot: unknown
}

/** What a JSON text from the page holds, or null when it is too long to be read, is not JSON, or is not an object. */
export function parseReply(reply: unknown): Record<string, unknown> | null {
  if (typeof reply !== 'string' || reply.length > MAX_REPLY_CHARS) return null
  try {
    const value: unknown = JSON.parse(reply)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/** The answer of the picker (a JSON text): what was chosen, or `{ error }` when the page could not build its snapshot; null for anything else. */
export function parsePick(reply: unknown): MdPick | { error: string } | null {
  const value = parseReply(reply)
  if (!value) return null
  if (typeof value['error'] === 'string') return { error: cleanText(value['error']).slice(0, 300) }
  const { action, scope } = value
  if ((action !== 'copy' && action !== 'save') || (scope !== 'selection' && scope !== 'blocks') || !isRecord(value['snapshot'])) return null
  return { action, scope, snapshot: value['snapshot'] }
}

// ---------- validating the snapshot ----------

const BLOCK_DEFAULT = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'figure', 'figcaption', 'address', 'form', 'fieldset', 'legend', 'hgroup', 'center', 'details', 'summary', 'body', 'html', 'menu', 'dir'])
/** Always a block, whatever the page's CSS says about it. */
const ALWAYS_BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'hr', 'dl', 'dt', 'dd'])
/** Always inline: a cell is part of its row, a break is part of its line. */
const ALWAYS_INLINE = new Set(['br', 'td', 'th'])
const INLINE_KNOWN = new Set(['a', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'code', 'kbd', 'samp', 'tt', 'var', 'q', 'cite', 'dfn', 'abbr', 'time', 'label', 'font', 'img', 'wbr', 'bdi', 'bdo', 'ruby', 'data', 'output'])
const KNOWN_TAGS = new Set([...BLOCK_DEFAULT, ...ALWAYS_BLOCK, ...ALWAYS_INLINE, ...INLINE_KNOWN])
/** Never exported, with everything inside: code, forms, embedded or drawn content, ruby annotations. */
export const DROPPED_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base', 'object', 'embed', 'applet', 'param',
  'input', 'textarea', 'select', 'option', 'optgroup', 'datalist', 'button', 'iframe', 'frame', 'frameset', 'canvas', 'video',
  'audio', 'svg', 'math', 'map', 'area', 'source', 'track', 'colgroup', 'col', 'rt', 'rp'
])
const TAG_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
/** Dropped tags the user should hear about when they were inside what they chose: the page shows something there that Markdown cannot hold. */
const UNSUPPORTED_TAGS = ['iframe', 'canvas', 'video', 'audio', 'svg', 'math', 'object', 'embed']

/** What the script that runs in the page needs to know to build a snapshot this file will accept (it is given as data, not copied). */
export const MD_PAGE_CONFIG = {
  limits: { nodes: MD_LIMITS.nodes, depth: MD_LIMITS.depth, textChars: MD_LIMITS.textChars, url: MD_LIMITS.url, alt: MD_LIMITS.alt, warnings: MD_LIMITS.warnings },
  dropped: [...DROPPED_TAGS],
  unsupported: UNSUPPORTED_TAGS,
  /** Tags whose display the converter fixes: the page does not say how it shows them. */
  structural: [...ALWAYS_BLOCK, ...ALWAYS_INLINE],
  /** Tags the converter takes for blocks when the page does not say otherwise. */
  blockDefault: [...BLOCK_DEFAULT]
} as const

// Control characters except tab and newline, DEL and C1, zero-width marks that only add noise, and the characters that reorder text on
// screen (U+202E turns "fdp.exe" into "exe.pdf"). U+0001 is among them: the converter keeps its own line-break mark there.
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\ufeff\u2060\u202a-\u202e\u2066-\u2069]/g

/** Text as the page gave it, without what must never reach a file: control and reordering characters; every line ending becomes `\n`. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(UNSAFE_TEXT, '')
}

/** An absolute address with one of `schemes`, normalised (spaces and angle brackets percent-encoded by the URL parser); null for anything else. */
export function safeUrl(value: unknown, schemes: readonly string[]): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MD_LIMITS.url) return null
  if (!URL.canParse(value)) return null
  const url = new URL(value)
  return schemes.includes(url.protocol) ? url.href : null
}

const WEB = ['http:', 'https:'] as const
const LINK = ['http:', 'https:', 'mailto:', 'tel:'] as const

interface Budget {
  nodes: number
  chars: number
  truncated: boolean
}

function intIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return null
  return Math.min(Math.max(Number(value), min), max)
}

function cleanAttributes(tag: string, raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const out: Record<string, string> = {}
  if (tag === 'a') {
    const href = safeUrl(raw['href'], LINK)
    if (href) out['href'] = href
  } else if (tag === 'img') {
    const src = safeUrl(raw['src'], WEB)
    if (src) out['src'] = src
    if (typeof raw['alt'] === 'string') out['alt'] = cleanText(raw['alt']).replace(/\s+/g, ' ').trim().slice(0, MD_LIMITS.alt)
  } else if (tag === 'ol') {
    const start = intIn(raw['start'], 0, 999_999)
    if (start !== null && start !== 1) out['start'] = String(start)
  } else if (tag === 'td' || tag === 'th') {
    for (const name of ['colspan', 'rowspan']) {
      const span = intIn(raw[name], 1, MD_LIMITS.span)
      if (span !== null && span > 1) out[name] = String(span)
    }
  } else if (tag === 'pre') {
    const lang = raw['lang']
    if (typeof lang === 'string' && /^[A-Za-z0-9_+#.-]{1,30}$/.test(lang)) out['lang'] = lang
  }
  // How the page actually shows the element: 'b' for a block, 'i' for inline. It only tells a generic element (a div shown inline, a
  // span shown as a block) from what its tag suggests.
  if (!ALWAYS_BLOCK.has(tag) && !ALWAYS_INLINE.has(tag) && (raw['d'] === 'b' || raw['d'] === 'i')) out['d'] = raw['d']
  return Object.keys(out).length > 0 ? out : undefined
}

function cleanNodes(value: unknown, depth: number, budget: Budget): MdNode[] {
  if (!Array.isArray(value)) return []
  const out: MdNode[] = []
  const count = Math.min(value.length, MD_LIMITS.nodes)
  for (let i = 0; i < count; i++) {
    if (budget.nodes <= 0 || budget.chars <= 0) {
      budget.truncated = true
      break
    }
    const item: unknown = value[i]
    if (typeof item === 'string') {
      budget.nodes--
      let text = cleanText(item)
      if (text.length > budget.chars) {
        text = text.slice(0, budget.chars)
        budget.truncated = true
      }
      budget.chars -= text.length
      if (text) out.push(text)
      continue
    }
    if (!isRecord(item)) continue
    const tag = typeof item['t'] === 'string' ? item['t'] : ''
    if (!TAG_PATTERN.test(tag) || DROPPED_TAGS.has(tag)) continue
    budget.nodes--
    if (depth >= MD_LIMITS.depth) {
      budget.truncated = true
      continue
    }
    const known = KNOWN_TAGS.has(tag) ? tag : 'span'
    const element: MdElement = { t: known }
    const attributes = cleanAttributes(known, item['a'])
    if (attributes) element.a = attributes
    const children = cleanNodes(item['c'], depth + 1, budget)
    if (children.length > 0) element.c = children
    out.push(element)
  }
  return out
}

export interface MdSnapshot {
  nodes: MdNode[]
  warnings: string[]
  truncated: boolean
}

/** The snapshot a page sent, cleaned; null when it is not a snapshot at all. Everything past the limits is dropped and `truncated` says so. */
export function parseSnapshot(raw: unknown): MdSnapshot | null {
  if (!isRecord(raw) || !Array.isArray(raw['nodes'])) return null
  const budget: Budget = { nodes: MD_LIMITS.nodes, chars: MD_LIMITS.textChars, truncated: raw['truncated'] === true }
  const nodes = cleanNodes(raw['nodes'], 0, budget)
  const warnings = Array.isArray(raw['warnings'])
    ? raw['warnings'].filter((w): w is string => typeof w === 'string').slice(0, MD_LIMITS.warnings).map((w) => cleanText(w).replace(/\s+/g, ' ').trim().slice(0, MD_LIMITS.warningChars)).filter(Boolean)
    : []
  return { nodes, warnings, truncated: budget.truncated }
}

// ---------- converting ----------

/** Marks a hard line break while a paragraph is being put together (`cleanText` removed every real U+0001). */
const BREAK = '\u0001'

export interface MdImage {
  /** The name the Markdown refers to it by: `![alt][image-1]` … `[image-1]: <address>`. */
  reference: string
  url: string
  alt: string
}

interface Context {
  images: MdImage[]
  imageByUrl: Map<string, MdImage>
  warnings: Set<string>
  /** The page without its fragment: a link to somewhere in the page itself is not worth a link in the file. */
  pageUrl: string | null
  strong: boolean
  emphasis: boolean
  strike: boolean
  link: boolean
}

const FORMATTING = new Set(['a', 'strong', 'b', 'em', 'i', 'del', 's', 'strike', 'code', 'kbd', 'samp', 'tt', 'q', 'img', 'br'])
const CODE_SPAN = new Set(['code', 'kbd', 'samp', 'tt'])
const hasBlockCache = new WeakMap<MdElement, boolean>()

const isElement = (node: MdNode | undefined): node is MdElement => typeof node === 'object' && node !== null

/** Adds items to a list one by one: a spread of a very long list would overflow the stack. */
const append = <T>(target: T[], items: readonly T[]): void => {
  for (const item of items) target.push(item)
}

/** Whether the element is laid out as a block: its tag says so, unless the page's CSS says otherwise (for the tags it leaves free). */
function isBlock(element: MdElement): boolean {
  if (ALWAYS_BLOCK.has(element.t)) return true
  if (ALWAYS_INLINE.has(element.t)) return false
  const shown = element.a?.['d']
  if (shown === 'b') return true
  if (shown === 'i') return false
  return BLOCK_DEFAULT.has(element.t)
}

function hasBlock(element: MdElement): boolean {
  const known = hasBlockCache.get(element)
  if (known !== undefined) return known
  const found = (element.c ?? []).some((child) => isElement(child) && (isBlock(child) || hasBlock(child)))
  hasBlockCache.set(element, found)
  return found
}

/** A wrapper that renders nothing of its own and holds blocks (a span around paragraphs, a custom element): its children take its place. */
function unwrapped(nodes: readonly MdNode[]): MdNode[] {
  const out: MdNode[] = []
  for (const node of nodes) {
    if (isElement(node) && !isBlock(node) && !FORMATTING.has(node.t) && hasBlock(node)) append(out, unwrapped(node.c ?? []))
    else out.push(node)
  }
  return out
}

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char)

/** Escapes what would turn text into syntax anywhere in a line. What only matters at the start of a line is `escapeLineStart`'s. */
function escapeInline(text: string): string {
  // One pass over the original text: an underscore between two letters or digits stays (it opens no emphasis), every other one is escaped.
  return text.replace(/[\\`*~[\]]|_|<(?=[A-Za-z/!?])|&(?=#?\w+;)/g, (mark, offset: number) => (mark === '_' && isWordChar(text[offset - 1]) && isWordChar(text[offset + 1]) ? mark : `\\${mark}`))
}

function escapeLineStart(line: string): string {
  return line
    .replace(/^(#{1,6})(?=\s|$)/, '\\$1')
    .replace(/^([-+])(?=\s|$)/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^>/, '\\>')
    .replace(/^(-{2,}|=+)\s*$/, '\\$&')
}

/** An address as the Markdown writes it: the URL parser has encoded spaces and angle brackets; parentheses would end the link early. */
function destination(url: string): string {
  return url.replace(/[()\\\s<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/**
 * Where the characters of `chars` stop at the start of `text`, and where they begin at its end: `text.slice(start, end)` is the text without them.
 * Two loops, one from each end. A pattern anchored at the end (`[ x]+$`) is tried again from every character of a long run that is not the last
 * one: its cost grows with the square of that run, and a page chooses the length of its runs.
 */
export function edgesWithout(text: string, chars: string): { start: number; end: number } {
  let end = text.length
  while (end > 0 && chars.includes(text[end - 1]!)) end--
  let start = 0
  while (start < end && chars.includes(text[start]!)) start++
  return { start, end }
}

/** `text` without the characters of `chars` at its end. */
export function withoutTrailing(text: string, chars: string): string {
  return text.slice(0, edgesWithout(text, chars).end)
}

/** The spaces and the breaks that stay outside a mark, and that the ends of a table cell lose. */
const EDGE_BLANKS = ' \u0001'

/** Puts `wrap` around the words of a piece of inline text, the spaces and breaks at its ends left outside (`**a **b` would not be bold). */
function around(inner: string, wrap: (words: string) => string): string {
  const { start, end } = edgesWithout(inner, EDGE_BLANKS)
  if (start === end) return inner
  return `${inner.slice(0, start)}${wrap(inner.slice(start, end))}${inner.slice(end)}`
}

const surround = (inner: string, open: string, close: string): string => around(inner, (words) => `${open}${words}${close}`)

/** What the text of these nodes says, with no markup: for code spans, alternative texts and the comparison of a link with its address. */
function plainText(nodes: readonly MdNode[] | undefined): string {
  let out = ''
  for (const node of nodes ?? []) {
    if (typeof node === 'string') out += node
    else if (node.t === 'br') out += '\n'
    else out += plainText(node.c)
  }
  return out
}

function textOf(raw: string): string {
  return escapeInline(raw.replace(/[\t\n\f ]+/g, ' ').replace(/\u00a0/g, ' '))
}

/** The length of the longest run of backticks in a text: the fence around code must be longer. (A loop: a text may hold a very large number of runs.) */
function longestRun(text: string): number {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return longest
}

function inlineCode(element: MdElement): string {
  const text = plainText(element.c).replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const longest = longestRun(text)
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

function image(element: MdElement, context: Context): string {
  const url = element.a?.['src']
  if (!url) {
    context.warnings.add(t('markdown-export.une-image-sans-adresse-web-ne-peut-pas-etre'))
    return ''
  }
  let entry = context.imageByUrl.get(url)
  if (!entry) {
    entry = { reference: `image-${context.images.length + 1}`, url, alt: element.a?.['alt'] ?? '' }
    context.images.push(entry)
    context.imageByUrl.set(url, entry)
  }
  return `![${escapeInline(element.a?.['alt'] || t('markdown-export.image'))}][${entry.reference}]`
}

function link(element: MdElement, context: Context): string {
  const inner = inline(element.c ?? [], { ...context, link: true })
  const href = element.a?.['href']
  const label = inner.replace(/\u0001+/g, ' ')
  // Links do not nest, and a link to a place in the page itself leads nowhere in a file. (A link with no text stays no link: `around` gives back its empty text.)
  if (!href || context.link || (context.pageUrl !== null && href.startsWith(`${context.pageUrl}#`))) return inner
  const text = plainText(element.c).replace(/\s+/g, ' ').trim()
  // A link that shows its own address is written as an autolink.
  if (text === href || (/^https?:/.test(href) && text === href.replace(/\/$/, ''))) return around(label, () => `<${destination(href)}>`)
  return surround(label, '[', `](${destination(href)})`)
}

function inlineElement(element: MdElement, context: Context): string {
  switch (element.t) {
    case 'br':
      return BREAK
    case 'img':
      return image(element, context)
    case 'a':
      return link(element, context)
    case 'strong':
    case 'b': {
      const inner = inline(element.c ?? [], { ...context, strong: true })
      return context.strong ? inner : surround(inner, '**', '**')
    }
    case 'em':
    case 'i': {
      const inner = inline(element.c ?? [], { ...context, emphasis: true })
      return context.emphasis ? inner : surround(inner, '*', '*')
    }
    case 'del':
    case 's':
    case 'strike': {
      const inner = inline(element.c ?? [], { ...context, strike: true })
      return context.strike ? inner : surround(inner, '~~', '~~')
    }
    case 'q':
      return `"${inline(element.c ?? [], context)}"`
    default:
      if (CODE_SPAN.has(element.t)) return inlineCode(element)
      // A block met inside a line (in a link, a cell, a heading) is set apart from its neighbours by a space.
      return isBlock(element) ? ` ${inline(element.c ?? [], context)} ` : inline(element.c ?? [], context)
  }
}

function inline(nodes: readonly MdNode[], context: Context): string {
  let out = ''
  for (const node of nodes) out += typeof node === 'string' ? textOf(node) : inlineElement(node, context)
  return out
}

/** Spaces collapsed, breaks resolved: the paragraphs a line of inline text makes (two breaks in a row end a paragraph). */
function paragraphs(text: string): string[] {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\u0001 ?/g, BREAK)
    .split(/\u0001{2,}/)
    .map((part) => part.replace(/^\u0001+|\u0001+$/g, '').trim())
    .filter(Boolean)
    .map((part) => part.split(BREAK).map((line) => escapeLineStart(line.trim())).join('  \n'))
}

/** One line of text: no break, no double space. */
const oneLine = (text: string): string => text.replace(/\u0001+/g, ' ').replace(/[ \t]+/g, ' ').trim()

const LIST_START = /^(?:[-+] |1[.)] )/

function listItem(marker: string, body: string[]): string {
  const indent = ' '.repeat(marker.length)
  let text = body[0]!
  for (const block of body.slice(1)) text += `${LIST_START.test(block) ? '\n' : '\n\n'}${block}`
  return marker + text.split('\n').map((line, i) => (i === 0 || line === '' ? line : indent + line)).join('\n')
}

function list(element: MdElement, context: Context): string[] {
  const ordered = element.t === 'ol'
  let number = Number(element.a?.['start'] ?? 1)
  const items: Array<{ marker: string; body: string[] }> = []
  for (const child of unwrapped(element.c ?? [])) {
    if (typeof child === 'string' && child.trim() === '') continue
    if (isElement(child) && (child.t === 'ul' || child.t === 'ol')) {
      // A list placed straight in a list (invalid, but pages do it) belongs to the item before it.
      const nested = list(child, context)
      const last = items.at(-1)
      if (last) append(last.body, nested)
      else if (nested.length > 0) items.push({ marker: '- ', body: nested })
      continue
    }
    const body = blocks(isElement(child) && child.t === 'li' ? (child.c ?? []) : [child], context)
    const marker = ordered ? `${number}. ` : '- '
    number++
    if (body.length > 0) items.push({ marker, body })
  }
  return items.length > 0 ? [items.map((item) => listItem(item.marker, item.body)).join('\n')] : []
}

/** The text of a `pre`: line breaks where the page has them, including the ones its markup makes between lines (a div or a li per line). */
function rawText(nodes: readonly MdNode[] | undefined): string {
  let out = ''
  for (const node of nodes ?? []) {
    if (typeof node === 'string') {
      out += node
      continue
    }
    if (node.t === 'br') {
      out += '\n'
      continue
    }
    const lined = isBlock(node) && node.t !== 'pre'
    if (lined && out !== '' && !out.endsWith('\n')) out += '\n'
    out += rawText(node.c)
    if (lined && !out.endsWith('\n')) out += '\n'
  }
  return out
}

function codeBlock(element: MdElement): string[] {
  // `trimEnd`, not a pattern anchored at the end: see `edgesWithout`.
  const code = rawText(element.c).replace(/^\n+/, '').trimEnd()
  if (!code.trim()) return []
  const longest = longestRun(code)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [`${fence}${element.a?.['lang'] ?? ''}\n${code}\n${fence}`]
}

function quote(element: MdElement, context: Context): string[] {
  const inner = blocks(element.c ?? [], context).join('\n\n')
  return inner ? [inner.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')] : []
}

function tableRows(element: MdElement): MdElement[] {
  const rows: MdElement[] = []
  for (const child of element.c ?? []) {
    if (!isElement(child)) continue
    if (child.t === 'tr') rows.push(child)
    else if (child.t === 'thead' || child.t === 'tbody' || child.t === 'tfoot') append(rows, tableRows(child))
  }
  return rows
}

const hasTable = (nodes: readonly MdNode[] | undefined): boolean => (nodes ?? []).some((node) => isElement(node) && (node.t === 'table' || hasTable(node.c)))

function table(element: MdElement, context: Context): string[] {
  const out: string[] = []
  const caption = (element.c ?? []).find((child): child is MdElement => isElement(child) && child.t === 'caption')
  if (caption) append(out, blocks(caption.c ?? [], context))
  const rows = tableRows(element)
  const cellsOf = (row: MdElement): MdElement[] => (row.c ?? []).filter((cell): cell is MdElement => isElement(cell) && (cell.t === 'td' || cell.t === 'th'))
  // A table that holds tables is a page layout, not data: its cells are read one after the other.
  if (rows.some((row) => cellsOf(row).some((cell) => hasTable(cell.c)))) {
    for (const row of rows) for (const cell of cellsOf(row)) append(out, blocks(cell.c ?? [], context))
    return out
  }
  const grid: string[][] = []
  const carry: number[] = []
  let merged = false
  for (const row of rows) {
    const line: string[] = []
    const fillCarried = (): void => {
      while ((carry[line.length] ?? 0) > 0) {
        carry[line.length] = (carry[line.length] ?? 0) - 1
        line.push('')
      }
    }
    for (const cell of cellsOf(row)) {
      fillCarried()
      const spaced = inline(cell.c ?? [], context)
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\u0001 ?/g, BREAK)
      const edges = edgesWithout(spaced, EDGE_BLANKS)
      const text = spaced
        .slice(edges.start, edges.end)
        .replace(/\|/g, '\\|')
        .replace(/\u0001+/g, '<br>')
      const colspan = Number(cell.a?.['colspan'] ?? 1)
      const rowspan = Number(cell.a?.['rowspan'] ?? 1)
      const column = line.length
      line.push(text)
      for (let extra = 1; extra < colspan; extra++) line.push('')
      if (rowspan > 1) for (let extra = 0; extra < colspan; extra++) carry[column + extra] = rowspan - 1
      if (colspan > 1 || rowspan > 1) merged = true
    }
    fillCarried()
    if (line.length > 0) grid.push(line)
  }
  if (grid.length === 0 || grid.every((line) => line.every((cell) => cell === ''))) return out
  if (merged) context.warnings.add(t('markdown-export.tableau-cellules-fusionnees'))
  const width = grid.reduce((widest, line) => Math.max(widest, line.length), 0)
  const render = (line: readonly string[]): string => `| ${Array.from({ length: width }, (_, i) => line[i] ?? '').join(' | ')} |`
  out.push([render(grid[0]!), render(Array(width).fill('---')), ...grid.slice(1).map(render)].join('\n'))
  return out
}

function heading(element: MdElement, context: Context): string[] {
  const text = oneLine(inline(element.c ?? [], context)).replace(/ #+$/, (closing) => ` \\${closing.slice(1)}`)
  return text ? [`${'#'.repeat(Number(element.t[1]))} ${text}`] : []
}

function block(element: MdElement, context: Context): string[] {
  switch (element.t) {
    case 'hr':
      return ['---']
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return heading(element, context)
    case 'pre':
      return codeBlock(element)
    case 'blockquote':
      return quote(element, context)
    case 'ul':
    case 'ol':
      return list(element, context)
    case 'li':
      return list({ t: 'ul', c: [element] }, context)
    case 'table':
      return table(element, context)
    case 'tr':
      // Rows without their table (a selection that began inside one): the cells of a row stay together on a line.
      return paragraphs((element.c ?? []).map((cell) => oneLine(inline([cell], context))).filter(Boolean).join(' | '))
    case 'dt':
    case 'summary': {
      const text = oneLine(inline(element.c ?? [], context))
      return text ? [surround(text, '**', '**')] : []
    }
    default:
      // A link, a bold text or an image the page shows as a block is still one paragraph.
      return FORMATTING.has(element.t) ? paragraphs(inline([element], context)) : blocks(element.c ?? [], context)
  }
}

function blocks(nodes: readonly MdNode[], context: Context): string[] {
  const out: string[] = []
  let run: MdNode[] = []
  const flush = (): void => {
    if (run.length > 0) append(out, paragraphs(inline(run, context)))
    run = []
  }
  for (const node of unwrapped(nodes)) {
    if (typeof node === 'string' || !isBlock(node)) {
      run.push(node)
      continue
    }
    flush()
    append(out, block(node, context))
  }
  flush()
  return out
}

// ---------- the document ----------

export interface MdOptions {
  /** The address of the tab, as the main process knows it (never the page's own claim). */
  url: string
  /** The title of the tab. */
  title: string
  /** Put the title first, unless the text already has a level-1 heading. */
  withTitle: boolean
  /** End with the address of the page. */
  withSource: boolean
}

export interface MdResult {
  /** The whole file. Empty when the page had nothing to export. */
  markdown: string
  /** The images the text refers to, in order of appearance. */
  images: MdImage[]
  /** What was left out or approximated, for the user to read. */
  warnings: string[]
  /** Everything but the address list of the images, so that the list can be rewritten (see `markdownWithImages`). */
  text: string
}

const warningsOf = (snapshot: MdSnapshot, context: Context): string[] => {
  const all = [...snapshot.warnings, ...context.warnings]
  if (snapshot.truncated) all.push(t('markdown-export.page-trop-volumineuse'))
  return [...new Set(all)].slice(0, MD_LIMITS.warnings)
}

/** The Markdown file for a snapshot, or null when `raw` is not a snapshot. */
export function exportMarkdown(raw: unknown, options: MdOptions): MdResult | null {
  const snapshot = parseSnapshot(raw)
  if (!snapshot) return null
  const pageUrl = safeUrl(options.url, WEB)
  const context: Context = {
    images: [],
    imageByUrl: new Map(),
    warnings: new Set(),
    pageUrl: pageUrl === null ? null : pageUrl.replace(/#.*$/, ''),
    strong: false,
    emphasis: false,
    strike: false,
    link: false
  }
  const body = blocks(snapshot.nodes, context)
  const warnings = warningsOf(snapshot, context)
  if (body.length === 0) return { markdown: '', images: [], warnings, text: '' }
  const title = cleanText(options.title).replace(/\s+/g, ' ').trim()
  if (options.withTitle && title && !body.some((b) => b.startsWith('# '))) body.unshift(`# ${escapeInline(title)}`)
  let text = body.join('\n\n')
  if (options.withSource && pageUrl) text += `\n\n${t('markdown-export.source-url', { url: `<${destination(pageUrl)}>` })}`
  text += '\n'
  const result: MdResult = { markdown: '', images: context.images, warnings, text }
  result.markdown = markdownWithImages(result)
  return result
}

/**
 * The folder that holds the images of `file.md` saved on its own: `<name>-images`, next to it. The name of the file is already safe
 * (`exportFileName`); only the extension goes.
 */
export const imagesFolderName = (fileName: string): string => `${fileName.replace(/\.md$/i, '')}-images`

/** What a link in the .md says to reach an image of the archive (`images/image-001.png`) once it is kept in `folder` next to the file: relative, and percent-encoded where Markdown needs it. */
export const folderImageLink = (folder: string, archiveName: string): string => `${folder.replace(/[%()\\\s<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)}/${archiveName.replace(/^images\//, '')}`

/** The file with the image list rewritten: `local` maps a reference to the path the image has now (an archive's `images/image-001.png`). */
export function markdownWithImages(result: Pick<MdResult, 'text' | 'images'>, local: ReadonlyMap<string, string> = new Map()): string {
  if (result.images.length === 0) return result.text
  const lines = result.images.map((image) => `[${image.reference}]: ${local.get(image.reference) ?? destination(image.url)}`)
  return `${result.text}\n${lines.join('\n')}\n`
}

const NAME_UNSAFE = /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** What is read of a title to name a file: far more than the 100 characters kept, and little enough for the patterns below to cost nothing. */
const NAME_SOURCE_MAX = 2000

/** A file name from a page title: no separator, no control or reordering character, no leading dot, at most 100 characters. */
export function exportFileName(title: string, extension: string): string {
  const stem = [...title.slice(0, NAME_SOURCE_MAX).normalize('NFKC').replace(NAME_UNSAFE, '-').replace(/\s+/g, ' ').replace(/^[.\s-]+|[.\s-]+$/g, '')].slice(0, 100).join('').replace(/[.\s]+$/, '')
  return `${stem || 'page'}.${extension}`
}
