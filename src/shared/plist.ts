// A reader for XML property lists (what `plutil -convert xml1 -o -` prints for Safari's Bookmarks.plist). Binary plists are converted
// to XML by macOS itself; reading them here would mean a second parser to keep right. Values come out as plain JSON-like data.

export type PlistValue = string | number | boolean | Date | PlistValue[] | { [key: string]: PlistValue } | null

const MAX_DEPTH = 64
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name] ?? whole
  })

/** The most text a property list may hold: a bookmarks file weighs a few megabytes, and the reader keeps every token in memory. */
export const MAX_PLIST_CHARS = 64 * 1024 * 1024

type Token = { tag: string; close: boolean; self: boolean } | { text: string }

const fail = (why: string): never => {
  throw new Error(`Invalid property list: ${why}`)
}

/**
 * Cuts the text into tags and text, in one pass. Every construct is closed with `indexOf` from where it opens and the scan resumes after
 * the close, so the work is proportional to the size of the text: a regular expression with lazy `[\s\S]*?` re-scanned to the end of
 * the file from each unterminated `<!--` or `<!DOCTYPE`, which took 35 s on a file of 100 000 of them. An opening that is never closed
 * is an error, not text.
 */
function tokenize(xml: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < xml.length) {
    if (xml[at] !== '<') {
      const next = xml.indexOf('<', at)
      const end = next === -1 ? xml.length : next
      tokens.push({ text: xml.slice(at, end) })
      at = end
      continue
    }
    if (xml.startsWith('<!--', at)) {
      const end = xml.indexOf('-->', at + 4)
      if (end === -1) return fail('unterminated comment')
      at = end + 3
    } else if (xml.startsWith('<?', at)) {
      const end = xml.indexOf('?>', at + 2)
      if (end === -1) return fail('unterminated processing instruction')
      at = end + 2
    } else if (xml.startsWith('<!DOCTYPE', at)) {
      const end = xml.indexOf('>', at + 9)
      if (end === -1) return fail('unterminated <!DOCTYPE>')
      at = end + 1
    } else {
      const end = xml.indexOf('>', at + 1)
      if (end === -1) return fail('unterminated tag')
      const inner = xml.slice(at + 1, end)
      const parts = /^(\/?)([a-zA-Z]+)(\s[^]*|\/)?$/.exec(inner)
      if (!parts) return fail('malformed tag')
      tokens.push({ tag: parts[2]!, close: parts[1] === '/', self: inner.endsWith('/') })
      at = end + 1
    }
  }
  return tokens
}

/** Parses an XML plist. Throws on anything that is not one (an unterminated container, a stray tag, nesting deeper than 64, a text larger than `MAX_PLIST_CHARS`). */
export function parsePlist(xml: string): PlistValue {
  if (xml.length > MAX_PLIST_CHARS) fail('too large')
  const tokens = tokenize(xml)
  let at = 0
  const skipText = () => {
    while (at < tokens.length && 'text' in tokens[at]!) at++
  }
  /** The next tag, text between containers skipped; null at the end. */
  const nextTag = (): { tag: string; close: boolean; self: boolean } | null => {
    skipText()
    const t = tokens[at]
    return t && !('text' in t) ? t : null
  }
  const expectClose = (tag: string) => {
    const t = nextTag()
    if (!t || !t.close || t.tag !== tag) fail(`expected </${tag}>`)
    at++
  }
  const textUntilClose = (tag: string): string => {
    let out = ''
    while (at < tokens.length && 'text' in tokens[at]!) out += (tokens[at++] as { text: string }).text
    expectClose(tag)
    return decode(out)
  }
  const value = (depth: number): PlistValue => {
    if (depth > MAX_DEPTH) return fail('nested too deep')
    const t = nextTag()
    if (!t || t.close) return fail('a value was expected')
    at++
    switch (t.tag) {
      case 'true':
        return true
      case 'false':
        return false
      case 'string':
      case 'data': {
        const text = t.self ? '' : textUntilClose(t.tag)
        // The bytes of a Data value are of no use here; keep the base64 text.
        return t.tag === 'data' ? text.replace(/\s+/g, '') : text
      }
      case 'integer':
      case 'real': {
        const n = Number(textUntilClose(t.tag).trim())
        return Number.isFinite(n) ? n : fail('a number was expected')
      }
      case 'date': {
        const d = new Date(textUntilClose('date').trim())
        return Number.isNaN(d.getTime()) ? fail('a date was expected') : d
      }
      case 'array': {
        const items: PlistValue[] = []
        if (t.self) return items
        for (;;) {
          const next = nextTag()
          if (!next) return fail('unterminated <array>')
          if (next.close) break
          items.push(value(depth + 1))
        }
        expectClose('array')
        return items
      }
      case 'dict': {
        const entries: Record<string, PlistValue> = {}
        if (t.self) return entries
        for (;;) {
          const next = nextTag()
          if (!next) return fail('unterminated <dict>')
          if (next.close) break
          if (next.tag !== 'key') return fail('a <key> was expected')
          at++
          const key = textUntilClose('key')
          // A plain assignment of "__proto__" would set the prototype of the dictionary instead of adding a key to it.
          Object.defineProperty(entries, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true })
        }
        expectClose('dict')
        return entries
      }
      default:
        return fail(`unknown tag <${t.tag}>`)
    }
  }
  let root = nextTag()
  while (root && (root.close || root.tag !== 'plist')) {
    at++
    root = nextTag()
  }
  if (!root) return fail('no <plist> element')
  at++
  return value(0)
}
