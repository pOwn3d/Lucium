// The scriptlets Lucium can run: a small library of OUR OWN code (src/preload/guard-world.ts) that neutralises a tracking or anti-blocker
// script in a page. A filter list can only NAME one of them, with arguments; it never brings code. This file is the whole contract between
// the two: which names exist (with the spellings uBlock Origin lists use), and what each argument may look like. Anything else is refused
// before it reaches a page, whether it came from a list we download, a list the user pasted, or a damaged cache.
//
// Pure: no Electron, no DOM. The page-side code (guard-world.ts) re-reads the same shapes, since it is the last line of defence.

// Types only: this file is bundled into the page guard, which runs in every page and must not carry the catalogues of i18n.
import type { MessageKey, Vars } from './i18n'

export type ScriptletId =
  | 'set-constant'
  | 'abort-on-property-read'
  | 'abort-on-property-write'
  | 'abort-current-script'
  | 'no-setTimeout-if'
  | 'no-setInterval-if'
  | 'no-fetch-if'
  | 'json-prune'
  | 'prune-response'
  | 'remove-attr'
  | 'remove-class'
  | 'prevent-addEventListener'
  | 'no-window-open-if'

export interface ScriptletCall {
  id: ScriptletId
  /** Already checked against the grammar of the scriptlet; strings only. */
  args: string[]
}

/** Scriptlets one page may run: lists name a handful per site, and a hostile one must not fill a page with them. */
export const SCRIPTLET_CALLS_MAX = 24

/** The names a list may use (uBlock Origin's long names and short aliases, with or without ".js"). */
const NAMES: Readonly<Record<string, ScriptletId>> = {
  'set-constant': 'set-constant',
  set: 'set-constant',
  'abort-on-property-read': 'abort-on-property-read',
  aopr: 'abort-on-property-read',
  'abort-on-property-write': 'abort-on-property-write',
  aopw: 'abort-on-property-write',
  'abort-current-script': 'abort-current-script',
  acs: 'abort-current-script',
  'abort-current-inline-script': 'abort-current-script',
  acis: 'abort-current-script',
  'no-setTimeout-if': 'no-setTimeout-if',
  nostif: 'no-setTimeout-if',
  'setTimeout-defuser': 'no-setTimeout-if',
  'no-setInterval-if': 'no-setInterval-if',
  nosiif: 'no-setInterval-if',
  'setInterval-defuser': 'no-setInterval-if',
  'no-fetch-if': 'no-fetch-if',
  'json-prune': 'json-prune',
  // Lucium's own name (no uBlock Origin scriptlet has this one): the response of a request whose absolute address matches the first argument.
  'prune-response': 'prune-response',
  'remove-attr': 'remove-attr',
  ra: 'remove-attr',
  'remove-class': 'remove-class',
  rc: 'remove-class',
  'prevent-addEventListener': 'prevent-addEventListener',
  aeld: 'prevent-addEventListener',
  'addEventListener-defuser': 'prevent-addEventListener',
  'no-window-open-if': 'no-window-open-if',
  nowoif: 'no-window-open-if',
  'window.open-defuser': 'no-window-open-if'
}

/** The scriptlet a list's name stands for, or null. */
export function scriptletIdOf(name: string): ScriptletId | null {
  const bare = name.trim().replace(/\.js$/, '')
  return Object.hasOwn(NAMES, bare) ? NAMES[bare]! : null
}

/** Every spelling of every scriptlet, for the documentation and the tests. */
export function scriptletNames(): string[] {
  return Object.keys(NAMES)
}

// ---------- arguments ----------

const CHAIN_SEGMENT = '[A-Za-z_$][\\w$]*'
const CHAIN = new RegExp(`^${CHAIN_SEGMENT}(?:\\.${CHAIN_SEGMENT}){0,7}$`)
const CONTROL = /\p{Cc}/u

/**
 * The ways from an object to the prototype it shares with every other object of its kind: `document.__proto__.cookie` and
 * `document.constructor.prototype.cookie` would redefine `cookie` for every document of the page. A prototype a list names on purpose
 * (`Object.prototype.x`, `HTMLDocument.prototype.cookie`) is written as such, and stays allowed.
 */
const BACK_DOORS: ReadonlySet<string> = new Set(['__proto__', 'constructor'])

/** A property path on the window (`navigator.userAgent`, `adsbygoogle.loaded`): names joined by dots, never the prototype chain's back door. */
export function isPropertyChain(text: string): boolean {
  return text.length <= 120 && CHAIN.test(text) && !text.split('.').some((segment) => BACK_DOORS.has(segment))
}

/** The values `set-constant` may put: the ones lists use, nothing evaluated. */
const CONSTANT_VALUES = new Set(['undefined', 'false', 'true', 'null', 'noopFunc', 'trueFunc', 'falseFunc', 'emptyObj', 'emptyArr', 'yes', 'no', "''", ''])
export const isConstantValue = (text: string): boolean => CONSTANT_VALUES.has(text) || /^-?\d{1,5}$/.test(text)

export const NEEDLE_MAX = 200
/** The longest text a regular expression from a list is run on: its cost grows with it. */
export const REGEX_INPUT_MAX = 10_000

/** In how many ways the bounded choices of an expression may be read (`a?`, `a{2,4}`, `a{0,99}`, `a|b`): each one multiplies the work. */
const WAYS_MAX = 1000
/** The same beside a run: the text is already read once per character, about fifty million places on REGEX_INPUT_MAX characters. */
const WAYS_MAX_WITH_A_RUN = 2

/**
 * Whether the body of a regular expression written in a list is cheap to run. A crafted pattern freezes a page (measured: `(a+)+$` takes
 * seconds on 30 characters, `a*a*b` eight seconds on 4 000, five `a{0,99}` one second on 80), so only a small subset is accepted:
 * literals, escapes, classes, `.`, anchors, alternation, groups that are not repeated, and repeats whose work is counted. A run (`.*`,
 * `a+`, `a{2,}`) makes the engine try every place of the text again, on a text of up to REGEX_INPUT_MAX characters, for each place it
 * started from: one is accepted, two are the cube of the length and are not. A run that ends the expression costs nothing (nothing after
 * it can fail). A bounded repeat and an alternative are counted as ways to read the text (`a{0,99}` is a hundred): two beside a run, a
 * thousand without one.
 * No look-around, no back-reference, no repeated group. This file imports nothing (it is part of the page guard): the count is its own,
 * coarser than the guard of the expressions of extensions (regex-guard.ts) and on the safe side of it.
 */
export function isCheapRegexBody(body: string): boolean {
  if (body.length === 0 || body.length > 120 || CONTROL.test(body)) return false
  let runs = 0
  let ways = 1
  /** Where the last run ends in the body, to know whether anything follows it. */
  let runEnd = -1
  let depth = 0
  // What the last token allows after it: an atom may be repeated, a quantifier may be made lazy once.
  let last: 'start' | 'atom' | 'quantifier' | 'lazy' | 'open' | 'close' | 'alt' | 'anchor' = 'start'
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c === '\\') {
      const next = body[i + 1]
      // Back-references (\1), unicode and hexadecimal escapes, and named groups are out.
      if (next === undefined || !/[.\\/\-+*?()[\]{}|^$dDwWsSbBnt"'`:;,!@#%&=<>~ _]/.test(next)) return false
      i++
      last = 'atom'
    } else if (c === '[') {
      let j = i + 1
      if (body[j] === '^') j++
      let closed = false
      for (; j < body.length; j++) {
        if (body[j] === '\\') j++
        else if (body[j] === '[') return false
        else if (body[j] === ']') {
          closed = true
          break
        }
      }
      if (!closed || j === i + 1) return false
      i = j
      last = 'atom'
    } else if (c === '(') {
      if (body[i + 1] === '?') {
        if (body[i + 2] !== ':') return false
        i += 2
      }
      depth++
      if (depth > 2) return false
      last = 'open'
    } else if (c === ')') {
      if (depth === 0) return false
      depth--
      // `last` is no atom after a group: a quantifier cannot follow it, and a repeated group is the classic way to an exponential cost.
      last = 'close'
    } else if (c === '|') {
      ways *= 2
      last = 'alt'
    } else if (c === '^' || c === '$') {
      last = 'anchor'
    } else if (c === '*' || c === '+' || c === '?' || c === '{') {
      if (c === '?' && last === 'quantifier') {
        if (runEnd === i - 1) runEnd = i
        last = 'lazy'
        continue
      }
      if (last !== 'atom') return false
      // How many lengths the repeat leaves open: all of them (a run), or a counted number (as many ways to read the text).
      let span = Infinity
      if (c === '{') {
        const end = body.indexOf('}', i)
        const found = end < 0 ? null : /^\{(\d{1,2})(?:(,)(\d{0,2}))?\}$/.exec(body.slice(i, end + 1))
        if (!found) return false
        span = found[2] !== ',' ? 0 : found[3] === '' ? Infinity : Number(found[3]) - Number(found[1])
        if (span < 0) return false
        i = end
      } else if (c === '?') {
        span = 1
      }
      if (span === Infinity) {
        runs++
        runEnd = i
      } else {
        ways *= span + 1
      }
      last = 'quantifier'
    } else {
      last = 'atom'
    }
    if (ways > WAYS_MAX) return false
  }
  if (depth !== 0) return false
  // The run that ends the expression is not one the engine comes back to.
  if (runs > 0 && runEnd === body.length - 1) runs--
  return runs === 0 || (runs === 1 && ways <= WAYS_MAX_WITH_A_RUN)
}

/** `/body/i` or `/body/`: the body and its flags, when the text is written as a regular expression. */
export function regexParts(text: string): { body: string; flags: string } | null {
  const found = /^\/(.+)\/(i?)$/s.exec(text)
  return found ? { body: found[1]!, flags: found[2]! } : null
}

/** A needle: some text to look for (a regular expression when written between slashes), short, printable, and cheap if it is an expression. */
export function isNeedle(text: string): boolean {
  if (text.length > NEEDLE_MAX || CONTROL.test(text)) return false
  const re = regexParts(text)
  return re === null ? true : isCheapRegexBody(re.body)
}

const NAME = /^[A-Za-z_][\w:.-]{0,60}$/
const SELECTOR = /^[\w\s.#[\]="'~^$*|>+,:()-]{1,200}$/
/** A CSS selector for `querySelectorAll`: the characters of ordinary selectors, none that closes a rule or a string. */
export const isSelector = (text: string): boolean => SELECTOR.test(text) && !/\\|\/\*/.test(text)
const PATH = /^[\w$*[\].-]{1,80}$/
const DELAY = /^!?-?\d{1,6}$/
/** A list of paths for json-prune and prune-response: up to ten, separated by spaces, each a path (`a.b`, `a.*.b`, `a.[].b`). */
const isPathList = (text: string): boolean => {
  const paths = text.split(/\s+/).filter(Boolean)
  return paths.length <= 10 && paths.every((p) => PATH.test(p))
}

/**
 * Attributes that protect the page or the user: the sandbox of a frame, the checksum a script must match, the nonce and the policy that say
 * which scripts may run, what is said of the page to the sites it calls. Hiding or stopping is all a rule of a list may do: `remove-attr`
 * never takes one of these away, whatever the case it is written in.
 */
const PROTECTIVE_ATTRIBUTES = new Set(['sandbox', 'integrity', 'nonce', 'csp', 'referrerpolicy'])
/** The names `remove-attr` may be given, separated by `|`. */
const isRemovableAttributeList = (text: string): boolean => text.split('|').every((name) => NAME.test(name) && !PROTECTIVE_ATTRIBUTES.has(name.toLowerCase()))

const none = (args: readonly string[]): boolean => args.length === 0
const between = (args: readonly string[], min: number, max: number): boolean => args.length >= min && args.length <= max

/** The grammar of each scriptlet's arguments: true when they are acceptable. */
const GRAMMAR: Readonly<Record<ScriptletId, (args: readonly string[]) => boolean>> = {
  'set-constant': (a) => between(a, 2, 2) && isPropertyChain(a[0]!) && isConstantValue(a[1]!),
  'abort-on-property-read': (a) => between(a, 1, 1) && isPropertyChain(a[0]!),
  'abort-on-property-write': (a) => between(a, 1, 1) && isPropertyChain(a[0]!),
  'abort-current-script': (a) => between(a, 1, 2) && isPropertyChain(a[0]!) && (a[1] === undefined || isNeedle(a[1])),
  // An empty needle would match every timer of the page: the needle is required.
  'no-setTimeout-if': (a) => between(a, 1, 2) && a[0] !== '' && isNeedle(a[0]!) && (a[1] === undefined || DELAY.test(a[1])),
  'no-setInterval-if': (a) => between(a, 1, 2) && a[0] !== '' && isNeedle(a[0]!) && (a[1] === undefined || DELAY.test(a[1])),
  'no-fetch-if': (a) => between(a, 1, 1) && isNeedle(a[0]!.replace(/^url:/, '')) && !/^[a-z]+:/i.test(a[0]!.replace(/^url:/, '')),
  'json-prune': (a) => between(a, 1, 2) && [a[0]!, a[1] ?? ''].every(isPathList) && a[0]!.trim() !== '',
  // The first argument is the address (a regular expression on the whole absolute address, or a needle); the second, the paths removed from the JSON.
  'prune-response': (a) => between(a, 2, 2) && a[0] !== '' && isNeedle(a[0]!) && isPathList(a[1]!) && a[1]!.trim() !== '',
  'remove-attr': (a) => between(a, 1, 3) && isRemovableAttributeList(a[0]!) && (a[1] === undefined || a[1] === '' || isSelector(a[1])) && (a[2] === undefined || /^(?:stay|asap|complete)(?:\s+(?:stay|asap|complete))*$/.test(a[2])),
  'remove-class': (a) => between(a, 1, 3) && a[0]!.split('|').every((n) => NAME.test(n)) && (a[1] === undefined || a[1] === '' || isSelector(a[1])) && (a[2] === undefined || /^(?:stay|asap|complete)(?:\s+(?:stay|asap|complete))*$/.test(a[2])),
  // …and the same for listeners: at least one of the two needles must say something.
  'prevent-addEventListener': (a) => between(a, 1, 2) && a.every(isNeedle) && a.some((needle) => needle !== ''),
  'no-window-open-if': (a) => (none(a) || (between(a, 1, 1) && isNeedle(a[0]!.replace(/^!/, ''))))
}

/** Why a scriptlet is refused: the message to say it (translated where it is shown) and what goes in it. */
export interface Refusal {
  key: MessageKey
  vars?: Vars
}

export type ScriptletVerdict = { ok: true; call: ScriptletCall } | { ok: false; reason: Refusal }

/** Whether a rule of a list (`name`, `args`) is a scriptlet of the library with acceptable arguments; the call to give the page if so. */
export function parseScriptletCall(name: unknown, args: unknown): ScriptletVerdict {
  if (typeof name !== 'string') return { ok: false, reason: { key: 'scriptlets.nom-de-scriptlet-absent' } }
  const id = scriptletIdOf(name)
  if (id === null) return { ok: false, reason: { key: 'scriptlets.scriptlet-name-inconnu', vars: { name: name.slice(0, 40) } } }
  if (!Array.isArray(args) || args.length > 4 || !args.every((a): a is string => typeof a === 'string')) return { ok: false, reason: { key: 'scriptlets.arguments-du-scriptlet-non-valides' } }
  const clean = args.map((a) => a.trim())
  if (!GRAMMAR[id](clean)) return { ok: false, reason: { key: 'scriptlets.arguments-refuses-pour-id', vars: { id } } }
  return { ok: true, call: { id, args: clean } }
}

/**
 * The calls of a page as they arrive from a cache, a message or another process: only the well-formed ones, each scriptlet with the same
 * arguments once, no more than SCRIPTLET_CALLS_MAX.
 */
export function cleanScriptletCalls(raw: unknown): ScriptletCall[] {
  if (!Array.isArray(raw)) return []
  const out: ScriptletCall[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (out.length >= SCRIPTLET_CALLS_MAX) break
    if (typeof entry !== 'object' || entry === null) continue
    const { id, args } = entry as { id?: unknown; args?: unknown }
    if (typeof id !== 'string' || !Object.values(NAMES).includes(id as ScriptletId)) continue
    const verdict = parseScriptletCall(id, args)
    if (!verdict.ok) continue
    const key = JSON.stringify([verdict.call.id, verdict.call.args])
    if (seen.has(key)) continue
    seen.add(key)
    out.push(verdict.call)
  }
  return out
}
