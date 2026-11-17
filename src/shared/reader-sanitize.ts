// The HTML of an article, cleaned before it goes into the reader's document. It comes from a page (Readability serialises the page's own DOM), so it is
// treated as hostile: the document's Content-Security-Policy already forbids every script, frame and connection (shared/reader.ts), and this keeps the
// markup itself from doing what the policy does not cover: a `<meta http-equiv="refresh">` that sends the reader elsewhere, a `<form>`, a link that is not
// a web address, an `id` or a `class` that stands in for an element of the reader (its scripts look elements up by them), a `style` that covers the page.
//
// An allowlist, written without regular expressions that can backtrack: the article is up to two million characters, and the work is one pass over it.
// What is not on the list loses its tag and keeps its text; what could run, navigate or send (`DROPPED`) is removed with everything inside it. What the
// policy lets load (`img-src http: https: data:`) is the only thing that may load: an image whose address is anything else is left out.

import { escapeHtml } from './html-escape'

/** Elements kept, with only the attributes of `ATTRIBUTES` and of every element (`lang`, `dir`, `title`). */
const KEPT: ReadonlySet<string> = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's',
  'samp', 'section', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr'
])

/** Elements removed with what is inside them: they run, navigate, send, load something the policy forbids, or hold text that is not the article's. */
const DROPPED: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'noframes', 'noembed', 'noscript', 'object', 'embed', 'applet', 'template', 'form', 'input', 'button', 'select', 'option', 'optgroup',
  'textarea', 'link', 'meta', 'base', 'svg', 'math', 'title', 'head', 'canvas', 'audio', 'video', 'track', 'xmp', 'plaintext', 'dialog', 'param'
])

/** Elements with no end tag. */
const VOID: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

/** Elements whose content is text up to the first end tag, whatever it looks like (the others are skipped by their nesting). */
const RAW_TEXT: ReadonlySet<string> = new Set(['script', 'style', 'iframe', 'noembed', 'noframes', 'xmp', 'textarea', 'title', 'plaintext'])

/** What an element keeps besides `lang`, `dir` and `title`. */
const ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href'],
  img: ['src', 'srcset', 'alt', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'reversed'],
  li: ['value'],
  time: ['datetime'],
  details: ['open']
}

/** How deep the output nests: past it a tag is dropped and its text kept, so that a page cannot hand the browser a document of a million levels. */
const MAX_DEPTH = 100

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f'])
const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')

interface Tag {
  name: string
  closing: boolean
  attributes: Array<[name: string, value: string | null]>
  /** Where the tag ends: the index after its `>`. */
  end: number
}

/** The tag that starts at `from` (a `<` followed by a letter or `/`), or null when it never ends. */
function readTag(html: string, from: number): Tag | null {
  let i = from + 1
  const closing = html[i] === '/'
  if (closing) i++
  const startName = i
  while (i < html.length && !WHITESPACE.has(html[i]!) && html[i] !== '/' && html[i] !== '>') i++
  const name = html.slice(startName, i).toLowerCase()
  const attributes: Tag['attributes'] = []
  while (i < html.length) {
    while (i < html.length && (WHITESPACE.has(html[i]!) || html[i] === '/')) i++
    if (i >= html.length) return null
    if (html[i] === '>') return { name, closing, attributes, end: i + 1 }
    const startAttribute = i
    // An attribute may start with `=` (the parser takes it as part of the name): the loop moves on at least one character.
    i++
    while (i < html.length && !WHITESPACE.has(html[i]!) && html[i] !== '/' && html[i] !== '>' && html[i] !== '=') i++
    const attribute = html.slice(startAttribute, i).toLowerCase()
    while (i < html.length && WHITESPACE.has(html[i]!)) i++
    if (html[i] !== '=') {
      attributes.push([attribute, null])
      continue
    }
    i++
    while (i < html.length && WHITESPACE.has(html[i]!)) i++
    const quote = html[i]
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1)
      if (close === -1) return null
      attributes.push([attribute, html.slice(i + 1, close)])
      i = close + 1
    } else {
      const startValue = i
      while (i < html.length && !WHITESPACE.has(html[i]!) && html[i] !== '>') i++
      attributes.push([attribute, html.slice(startValue, i)])
    }
  }
  return null
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' }

/** The value of an attribute with its character references read (the few the serialiser writes, and numeric ones); an unknown name stays as written. */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  let out = ''
  let i = 0
  while (i < value.length) {
    const amp = value.indexOf('&', i)
    if (amp === -1) break
    out += value.slice(i, amp)
    // The name of a reference is short: the `;` is looked for in the next few characters only, not to the end of a long value.
    const reach = value.slice(amp + 1, amp + 14).indexOf(';')
    const semicolon = reach === -1 ? -1 : amp + 1 + reach
    const body = semicolon === -1 ? '' : value.slice(amp + 1, semicolon)
    let decoded: string | undefined
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff && /^#(x[0-9a-f]+|\d+)$/i.test(body)) decoded = String.fromCodePoint(code)
    } else if (body !== '') {
      decoded = NAMED_ENTITIES[body.toLowerCase()]
    }
    if (decoded === undefined) {
      out += '&'
      i = amp + 1
    } else {
      out += decoded
      i = semicolon + 1
    }
  }
  return out + value.slice(i)
}

/**
 * An address as written, without the blanks around it. Only an address that starts with an allowed scheme passes, so a scheme written in a way the browser
 * would read otherwise (a tab or a control character inside it, a character reference) is no link: the mistake can only leave a link out, never let one in.
 */
const normalizedAddress = (value: string): string => value.trim()

const hasWebScheme = (address: string): boolean => {
  const lower = address.slice(0, 8).toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://')
}

/** A link goes to a web page, a mail or phone address, or a place in the article. Anything else (`javascript:`, `data:`, `file:`…) is no link. */
function safeLink(value: string): string | null {
  const address = normalizedAddress(value)
  const lower = address.slice(0, 7).toLowerCase()
  return hasWebScheme(address) || lower.startsWith('mailto:') || lower.startsWith('tel:') || address.startsWith('#') ? address : null
}

/** An image address the policy lets load: a web address, or an inline picture. */
function safeImage(value: string): string | null {
  const address = normalizedAddress(value)
  if (hasWebScheme(address)) return address
  const head = address.slice(0, 30).toLowerCase()
  return /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/.test(head) ? address : null
}

/** The first address of a `srcset`: what a picture with no `src` shows. */
const firstSrcsetAddress = (value: string): string => {
  const trimmed = value.trimStart()
  let end = 0
  while (end < trimmed.length && !WHITESPACE.has(trimmed[end]!)) end++
  return trimmed.slice(0, end).replace(/,$/, '')
}

/** What an attribute keeps of its value, or null when the attribute goes: `allowed` is what the element may carry besides `lang`, `dir` and `title`. */
function keptValue(attribute: string, value: string, allowed: readonly string[]): string | null {
  if (attribute === 'lang') return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(value) ? value : null
  if (attribute === 'dir') return value === 'ltr' || value === 'rtl' || value === 'auto' ? value : null
  if (attribute === 'title') return value.slice(0, 500)
  if (!allowed.includes(attribute)) return null
  if (attribute === 'href') return safeLink(value)
  if (attribute === 'src') return safeImage(value)
  if (attribute === 'alt') return value.slice(0, 500)
  if (attribute === 'datetime') return /^[0-9TZ:+. -]{1,40}$/.test(value) ? value : null
  if (attribute === 'open' || attribute === 'reversed') return ''
  // width, height, colspan, rowspan, span, start, value: a number.
  return /^\d{1,5}$/.test(value) ? value : null
}

/** The attributes an element keeps, written back with their values escaped; null when the element is useless without the one it lost (an image with no address). */
function keptAttributes(name: string, attributes: Tag['attributes']): string | null {
  const allowed = ATTRIBUTES[name] ?? []
  const seen = new Set<string>()
  let out = ''
  let src: string | null = null
  let srcsetAddress: string | null = null
  for (const [attribute, raw] of attributes) {
    if (seen.has(attribute)) continue
    seen.add(attribute)
    const value = decodeEntities(raw ?? '')
    if (attribute === 'srcset' && allowed.includes('srcset')) {
      srcsetAddress = safeImage(firstSrcsetAddress(value))
      continue
    }
    const kept = keptValue(attribute, value, allowed)
    if (attribute === 'src') src = kept
    if (kept === null) continue
    out += attribute === 'open' || attribute === 'reversed' ? ` ${attribute}` : ` ${attribute}="${escapeHtml(kept)}"`
  }
  if (name === 'img') {
    // An image that has no usable `src` shows the first picture of its `srcset`; one with neither is left out.
    const address = src ?? srcsetAddress
    if (address === null) return null
    if (src === null) out += ` src="${escapeHtml(address)}"`
  }
  return out
}

/** The end tag of each raw-text element, and the start and end tags of each of the others dropped, made once (their names are the fixed ones above). */
const END_TAG = new Map([...RAW_TEXT].map((name): [string, RegExp] => [name, new RegExp(`</${name}[\\s/>]`, 'ig')]))
const EITHER_TAG = new Map([...DROPPED].filter((name) => !RAW_TEXT.has(name) && !VOID.has(name)).map((name): [string, RegExp] => [name, new RegExp(`<(/?)${name}[\\s/>]`, 'ig')]))

/** Where an element dropped with its content ends: the index after its end tag, or the end of the text when it never closes. */
function skipElement(html: string, from: number, name: string): number {
  const end = END_TAG.get(name)
  if (end) {
    end.lastIndex = from
    const found = end.exec(html)
    if (!found) return html.length
    const close = html.indexOf('>', found.index)
    return close === -1 ? html.length : close + 1
  }
  const both = EITHER_TAG.get(name)!
  both.lastIndex = from
  let depth = 1
  for (let found = both.exec(html); found; found = both.exec(html)) {
    depth += found[1] === '/' ? -1 : 1
    if (depth === 0) {
      const close = html.indexOf('>', found.index)
      return close === -1 ? html.length : close + 1
    }
  }
  return html.length
}

/** The HTML of an article with only what a reader shows: text, links to web pages, images the policy lets load, tables and lists. */
export function sanitizeArticleHtml(html: string): string {
  const out: string[] = []
  // The elements still open in the output, and how many of each: a closing tag closes something that is open, or nothing.
  const stack: string[] = []
  const open = new Map<string, number>()
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      out.push(html.slice(i))
      break
    }
    if (lt > i) out.push(html.slice(i, lt))
    i = lt
    if (html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4)
      i = close === -1 ? html.length : close + 3
      continue
    }
    const next = html[i + 1] ?? ''
    if (next === '!' || next === '?') {
      // A declaration, a CDATA section or a processing instruction: nothing of an article.
      const close = html.indexOf('>', i)
      i = close === -1 ? html.length : close + 1
      continue
    }
    if (!isLetter(next) && !(next === '/' && isLetter(html[i + 2] ?? ''))) {
      out.push('&lt;')
      i++
      continue
    }
    const tag = readTag(html, i)
    if (!tag) {
      // A tag that never ends (the text runs out inside it): what is left is text. Reading on from the next `<` would go through the same text again, once per `<`.
      out.push(html.slice(i).replace(/</g, '&lt;'))
      break
    }
    i = tag.end
    const { name } = tag
    if (tag.closing) {
      if (!KEPT.has(name) || VOID.has(name) || (open.get(name) ?? 0) === 0) continue
      for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
        open.set(top, open.get(top)! - 1)
        out.push(`</${top}>`)
        if (top === name) break
      }
      continue
    }
    if (DROPPED.has(name)) {
      if (!VOID.has(name)) i = skipElement(html, i, name)
      continue
    }
    if (!KEPT.has(name) || stack.length >= MAX_DEPTH) continue
    const attributes = keptAttributes(name, tag.attributes)
    if (attributes === null) continue
    out.push(`<${name}${attributes}>`)
    if (!VOID.has(name)) {
      stack.push(name)
      open.set(name, (open.get(name) ?? 0) + 1)
    }
  }
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) out.push(`</${top}>`)
  return out.join('')
}
