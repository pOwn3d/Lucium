// What the CSS of a shared Tweak may contain. A Tweak that comes from a file or a link is hostile until proven otherwise, and a
// stylesheet is more than colours: it can load other files (`@import`, `url()`, `image-set()`), and a request made from a rule is how
// a page's content leaks (an attribute selector chooses which address is fetched). The Tweak editor keeps the CSS the user writes
// as it is; this module judges the CSS that arrives from outside, and refuses all of these:
//
//   @import                                   another stylesheet
//   url(...)                                  any address, quoted or not, whatever it points to (http, https, data, a path, a fragment)
//   image-set(), src(), image(), cross-fade() functions that take an address as a string
//   attr(... type(<url>))                     an address taken from the page's own attributes
//   expression(), behavior, -moz-binding      script hooks of old engines (inert in Chromium, refused all the same)
//
// The check reads the text the way a CSS parser does, because a textual search is easy to get around: `u\72l(` is `url(`, `@\69mport`
// is `@import`, a comment or a string can hide or hold what looks like a function. So the text goes through the tokenizer of the CSS
// Syntax specification (names with their escapes decoded, strings and comments skipped), and the rules apply to the tokens. Where the
// two readings could differ, the check errs towards refusing: a Tweak with a harmless but odd rule is refused, a hostile one never passes.

export type CssRefusal =
  /** A character that cannot be part of honest CSS: NUL and other controls, the marks that reorder a line and the line ends that are not drawn. */
  | 'hidden-character'
  | 'import'
  | 'url'
  | 'image-function'
  | 'attr-url'
  | 'expression'
  | 'behavior'
  | 'binding'

export type CssScan = { ok: true } | { ok: false; rule: CssRefusal; line: number }

/** Controls other than tab and the line breaks, and the characters that change how text is read or hide that there is any. */
const HIDDEN = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\uFFF9-\\uFFFB\\u{E0000}-\\u{E007F}]',
  'u'
)

/** True when the text holds a character from `HIDDEN`: what a name or a selector of a Tweak must not hold. */
export const hasHiddenCharacter = (text: string): boolean => HIDDEN.test(text)

/** The line (from 1) of the first character of `HIDDEN` in the text, or 0 when it holds none: what a warning tells the person who has to find it. */
export function hiddenCharacterLine(text: string): number {
  const at = text.search(HIDDEN)
  return at < 0 ? 0 : text.slice(0, at).split('\n').length
}

// The one rule for code a person reads before it runs (a user script, the stylesheet and the script of a Tweak). Reading is the only guard
// there, so a text that does not show what it runs is refused: a character that reorders how a line is drawn (embeddings, overrides and
// isolates) lets it read as one thing and run as another, and the two line ends that a text field does not draw (U+2028 and U+2029) end a
// comment for JavaScript where the reader sees it go on. Every other character that cannot be seen (a zero-width space, a soft hyphen, the
// joiner of a composed emoji) is found in honest code: the text is taken, and a warning names the first line to read again.
const REORDERS = /[\u202A-\u202E\u2066-\u2069]/u
const UNSEEN_LINE_ENDS = /[\u2028\u2029]/u
const CONTROLS = /[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/u

export type UnreadableCode = { kind: 'reorders' | 'line-end'; line: number }

const lineAt = (text: string, at: number): number => text.slice(0, at).split('\n').length

/** Why a person could not read this code as it runs, with the line (from 1) of the first such character; null for code that shows what it is. */
export function unreadableCode(text: string): UnreadableCode | null {
  const reorders = text.search(REORDERS)
  const lineEnd = text.search(UNSEEN_LINE_ENDS)
  if (reorders < 0 && lineEnd < 0) return null
  return lineEnd < 0 || (reorders >= 0 && reorders < lineEnd) ? { kind: 'reorders', line: lineAt(text, reorders) } : { kind: 'line-end', line: lineAt(text, lineEnd) }
}

/** The line (from 1) of the first control character other than tab and the line breaks, or 0: no honest stylesheet or script of a Tweak holds one. */
export function controlCharacterLine(text: string): number {
  const at = text.search(CONTROLS)
  return at < 0 ? 0 : lineAt(text, at)
}

const IMAGE_FUNCTIONS = new Set(['image-set', 'image', 'src', 'cross-fade'])
const BEHAVIOR_NAMES = new Set(['behavior', '-ms-behavior'])
const BINDING_NAMES = new Set(['-moz-binding'])

/** `-webkit-image-set` is `image-set`: the vendor prefixes are not part of the name the rules are written for. */
const unprefixed = (name: string): string => name.replace(/^-(?:webkit|moz|ms|o)-/, '')

const isHex = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
const isNameStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80
const isNameChar = (c: number): boolean => isNameStart(c) || (c >= 48 && c <= 57) || c === 45

/** Two code points `\` and the next one form an escape unless the next one ends the line. The end of the text counts as an escape (it means U+FFFD). */
const validEscape = (s: string, at: number): boolean => s.charCodeAt(at) === 92 && (at + 1 >= s.length || s.charCodeAt(at + 1) !== 10)

/** Would the code points at `at` begin a name (CSS Syntax §4.3.9)? */
function startsName(s: string, at: number): boolean {
  const c = s.charCodeAt(at)
  if (c === 45) {
    const next = s.charCodeAt(at + 1)
    return isNameStart(next) || next === 45 || validEscape(s, at + 1)
  }
  return isNameStart(c) || validEscape(s, at)
}

/** The character an escape stands for and where the text goes on; `at` is the backslash. */
function readEscape(s: string, at: number): [char: string, next: number] {
  const first = at + 1
  if (first >= s.length) return ['\uFFFD', first]
  let end = first
  while (end < s.length && end - first < 6 && isHex(s.charCodeAt(end))) end++
  if (end === first) return [s[first]!, first + 1]
  const value = Number.parseInt(s.slice(first, end), 16)
  // One white space after a hexadecimal escape belongs to it.
  const next = end < s.length && /[ \t\n]/.test(s[end]!) ? end + 1 : end
  const usable = value !== 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
  return [usable ? String.fromCodePoint(value) : '\uFFFD', next]
}

/** A name with its escapes decoded; `at` must start a name. */
function readName(s: string, at: number): [name: string, next: number] {
  let name = ''
  let i = at
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (isNameChar(c)) {
      name += s[i]
      i++
    } else if (validEscape(s, i)) {
      const [char, next] = readEscape(s, i)
      name += char
      i = next
    } else break
  }
  return [name, i]
}

/** Past a string: it ends at its closing quote, or before an unescaped line break (a bad string), or with the text. */
function skipString(s: string, at: number): number {
  const quote = s[at]
  let i = at + 1
  while (i < s.length) {
    const c = s[i]
    if (c === quote) return i + 1
    if (c === '\n') return i
    // A backslash takes the next character with it, a line break included (the string goes on over the line).
    i += c === '\\' ? 2 : 1
  }
  return s.length
}

/** Judges the CSS of an imported Tweak. `line` is where the first refused construct begins (1 for the first line). */
export function scanBoostCss(css: string): CssScan {
  // The line breaks of the specification: CR, CRLF and FF are one line feed.
  const s = css.replace(/\r\n?|\f/g, '\n')
  const refuse = (rule: CssRefusal, at: number): CssScan => ({ ok: false, rule, line: s.slice(0, at).split('\n').length })
  const unreadable = unreadableCode(s)
  const control = controlCharacterLine(s)
  if (unreadable || control > 0) return { ok: false, rule: 'hidden-character', line: Math.min(unreadable?.line ?? Infinity, control || Infinity) }

  // The open parentheses, by the name of the function they belong to ('' for a bare one): `attr()` is judged by what it holds.
  const open: string[] = []
  // How many of them are an `attr(`. Counted as they open and close: looking for one in the stack at each name would read the whole stack
  // again each time, and a text of nothing but `a(a(a(…` would cost the square of its length.
  let attrs = 0
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      i = end === -1 ? s.length : end + 2
    } else if (c === '"' || c === "'") {
      i = skipString(s, i)
    } else if (c === '@') {
      if (startsName(s, i + 1)) {
        const [name, next] = readName(s, i + 1)
        if (name.toLowerCase() === 'import') return refuse('import', i)
        i = next
      } else i++
    } else if (c === '#') {
      // A hash token: its name is not a function, whatever follows it.
      i++
      while (i < s.length && (isNameChar(s.charCodeAt(i)) || validEscape(s, i))) i = validEscape(s, i) ? readEscape(s, i)[1] : i + 1
    } else if (startsName(s, i)) {
      const begin = i
      const [name, next] = readName(s, i)
      const lower = name.toLowerCase()
      // A name always takes at least its first character; the scan moves on whatever happens.
      i = Math.max(next, begin + 1)
      if (s[i] === '(') {
        i++
        const bare = unprefixed(lower)
        if (bare === 'url') return refuse('url', begin)
        if (bare === 'expression') return refuse('expression', begin)
        if (IMAGE_FUNCTIONS.has(bare)) return refuse('image-function', begin)
        if (attrs > 0 && bare === 'type') return refuse('attr-url', begin)
        open.push(bare)
        if (bare === 'attr') attrs++
      } else {
        // `.behavior` is a class of the page, not the property of old engines.
        const isClass = s[begin - 1] === '.'
        if (!isClass && BEHAVIOR_NAMES.has(lower)) return refuse('behavior', begin)
        if (!isClass && BINDING_NAMES.has(lower)) return refuse('binding', begin)
        if (attrs > 0 && lower === 'url') return refuse('attr-url', begin)
      }
    } else if (c === '(') {
      open.push('')
      i++
    } else if (c === ')') {
      if (open.pop() === 'attr') attrs--
      i++
    } else i++
  }
  return { ok: true }
}
