// The one redaction of what the error log keeps (main/error-log.ts) and of what the report « Signaler un problème » shows (problem-report.ts).
// A line of the log can carry a path of the user's home (the name of the account is in it) or the address of a page that failed; the log is shown on
// screen and can be copied or saved, so a line is reduced when it enters it: a path keeps only its file name, an address only its host.
// Pure and idempotent: a line that was redacted comes out unchanged. Every expression reads a line in a time proportional to its length: a line
// can be written by a page, and it is reduced in the main process.

/** A folder that names a person or what is theirs: the home of an account on a Mac (`/Users/<name>`, as the system's firmlink spells it too), an external disk (`/Volumes/<name>`). */
const HOME = String.raw`(?:(?:/System/Volumes/Data)?/Users/|/Volumes/)`
/** What ends a path that stands between quotes or brackets: the closing mark of any of them (such a path may hold spaces: « Application Support »). */
const CLOSERS = String.raw`'"\`)\]>`
/** The opening marks that are not closing ones too. One of them ends the search for the closing mark: without that, a line made of `(~/a` again and again would be read to its end once per parenthesis. */
const OPENERS = String.raw`(\[<`

// 1. A path between quotes or brackets, as Node writes one in an error (`open '/Users/jane/Library/Application Support/x.json'`) or a stack frame writes it
// (`at fn (/Users/jane/Dev/app/index.js:1:2)`).
const DELIMITED = new RegExp(String.raw`(['"\`(\[<])((?:${HOME}[^/\n${CLOSERS}${OPENERS}]*|~)(?:/[^\n${CLOSERS}${OPENERS}]*)?)(?=[${CLOSERS}])`, 'g')

// 2. An address with an authority (`https://…`, `wss://…`, `file:///…`, `chrome-extension://…`): the scheme, the authority (with its user and password), the rest.
// The rest runs to the first blank, or to a character no address holds unencoded (a double quote, a backtick, an angle bracket): an apostrophe and
// a parenthesis are written as they are in a path or a query, so they do not end it (`redactAddress` gives back the marks that close the sentence).
const ADDRESS = /(?<![\w+.-])([a-z][a-z0-9+.-]*):\/\/((?:[^\s/?#'"`<>()[\]{},;@]*@)?(?:\[[0-9a-f:.]*\](?::\d*)?|[^\s/?#'"`<>()[\]{},;@]*))([^\s"`<>]*)/gi

// 2 bis. `mailto:` and the addresses that follow it, up to the first blank: the host of the first one is kept, never the name of the mailbox.
const MAILTO = /(?<![\w+.-])mailto:([^\s"'`<>]*)/gi

// 3. A path that stands alone. A segment may hold one space when a slash follows within two words (« Application Support/Lucium »), so that a folder
// named « Clients ACME » is not left half in the line; a word that starts with ~ is another path (« from a.txt to ~/b.txt »). The last segment ends at the
// first space.
const SEGMENT_CHAR = String.raw`[^\s/'"\`()\[\]<>]`
const WORD = String.raw`[^\s/~'"\`()\[\]<>]${SEGMENT_CHAR}*`
const SPACED = String.raw`(?:${SEGMENT_CHAR}| (?=(?:${WORD} )?${WORD}/))`
const BARE = new RegExp(String.raw`(?<![\w.~/-])((?:${HOME}${SPACED}+|~(?=/))(?:/${SPACED}*)*)`, 'g')

const HOME_PREFIX = /^(?:(?:(?:\/System\/Volumes\/Data)?\/Users|\/Volumes)\/[^/]*|~)/

/** The file name of a path; a home itself (`/Users/jane`, `~`) comes out as `empty`: the name of the account is never kept. */
function fileNameOf(path: string, empty: string): string {
  return path.replace(HOME_PREFIX, '').split('/').filter(Boolean).at(-1) ?? empty
}

/**
 * Where the marks that end a sentence begin at the end of `rest`: a full stop, a comma, the quote that closes what the address was written in, and a
 * parenthesis or a bracket that closes one the address did not open (an address at the end of a remark in brackets; the one of `/wiki/Foo_(bar)` is the address's own).
 * One pass from the end, with the counts kept: the cost does not grow with the number of marks.
 */
function tailStart(rest: string): number {
  const count = (mark: string): number => rest.split(mark).length - 1
  const open = { ')': count('('), ']': count('[') }
  const closed = { ')': count(')'), ']': count(']') }
  let end = rest.length
  for (; end > 0; end--) {
    const mark = rest[end - 1]!
    if (".,;:!?'".includes(mark)) continue
    if ((mark === ')' || mark === ']') && closed[mark] > open[mark]) closed[mark]--
    else break
  }
  return end
}

/** `file:///Users/jane/a.html?x=1#y` -> `a.html`; any other address -> its host (with the port) and nothing else: no user, no path, no query, no fragment. */
function redactAddress(whole: string, scheme: string, authority: string, rest: string): string {
  // The marks that end the sentence are not the address's: they stay where they were.
  const cut = tailStart(rest)
  const tail = rest.slice(cut)
  if (scheme.toLowerCase() === 'file') {
    const path = rest.slice(0, cut).replace(/[?#].*$/s, '')
    // The line and the column of a stack frame (`a.js:3:4`) are kept with the name; a colon alone at the end is the sentence's.
    return (path.replace(/\//g, '') === '' ? 'file://' : fileNameOf(path, '~')) + tail
  }
  const host = authority.replace(/^[^@]*@/, '')
  return host === '' ? whole : host + tail
}

/** `mailto:jane@example.com?subject=…` -> `mailto:example.com`. What has no mailbox in it (already reduced, or not an address) is left as it was. */
function redactMailto(whole: string, rest: string): string {
  const cut = tailStart(rest)
  const first = rest.slice(0, cut).split(/[?,]/)[0] ?? ''
  const at = first.lastIndexOf('@')
  return at < 0 ? whole : `mailto:${first.slice(at + 1)}${rest.slice(cut)}`
}

/** One line of the log with its paths reduced to file names and its addresses to hosts. Nothing else of the line changes. */
export function redactLogLine(line: string): string {
  return line
    .replace(DELIMITED, (_whole, open: string, path: string) => `${open}${fileNameOf(path, '~')}`)
    .replace(ADDRESS, redactAddress)
    .replace(MAILTO, redactMailto)
    .replace(BARE, (_whole, path: string) => fileNameOf(path, '~'))
}
