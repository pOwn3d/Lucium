// Turns an Adblock Plus filter list (EasyList, EasyPrivacy, uBlock filters…) into the rules WebKit's content blocker reads
// (`WKContentRuleList`, the JSON format of Safari content blockers), for the iOS application (docs/ios.md, section 6).
//
// It runs when a build is prepared (scripts/ios-filter-lists.mjs), never on the phone, and it is pure: text in, rules out. Nothing is
// downloaded here and no rule is executed. The two things this file must never do are to emit a rule WebKit refuses (WebKit refuses the
// whole list for one bad rule, so the iPhone would silently lose EasyList) and to lose a rule without saying so: every filter that is not
// converted is counted under the reason it was left out (`ListStats.dropped`), and the registry carries the counts.
//
// What WebKit accepts was measured, not assumed (docs/ios.md, section 6.2 and 6.3). Refused: alternation `a|b`, `{n}` repetitions, `\d \w \b`,
// `^` or `$` inside an expression, a non-ASCII character, an empty `url-filter`, `if-domain` together with `unless-domain`, upper-case
// domains, a selector with an extension (`:has-text(`). Loaded by Node with type stripping (scripts/ios-filter-lists.mjs): no enum, no
// parameter property.

// Types only: a module Node loads by itself cannot import a sibling without its extension, and the checker does not accept the extension.
import type { ScriptletCollector, ScriptletTable } from './scriptlets'

/** The most rules one WebKit list accepts: 150 000 pass, 150 001 are refused (measured in the iOS simulator, docs/ios.md section 6.2). */
export const WEBKIT_RULE_LIMIT = 150_000

/** The selectors joined in one `css-display-none` rule. WebKit takes a list of selectors in one rule; one rule per selector would be tens of thousands. */
export const SELECTORS_PER_RULE = 100

/** The longest address pattern kept, in characters of the converted expression: a bound against a hand-made list. */
const URL_FILTER_MAX = 2000
/** The longest selector kept, in characters. */
const SELECTOR_MAX = 1000
/** The most branches a top-level alternation of a regular expression filter may be split into (one rule each). */
const ALTERNATIVES_MAX = 6

export type ResourceType = 'document' | 'image' | 'style-sheet' | 'script' | 'font' | 'raw' | 'svg-document' | 'media' | 'popup' | 'ping' | 'fetch' | 'websocket' | 'other'

export interface Trigger {
  'url-filter': string
  'url-filter-is-case-sensitive'?: boolean
  'if-domain'?: string[]
  'unless-domain'?: string[]
  'resource-type'?: ResourceType[]
  'load-type'?: ['first-party'] | ['third-party']
  'load-context'?: ['top-frame'] | ['child-frame']
}

export interface Action {
  type: 'block' | 'ignore-previous-rules' | 'css-display-none'
  selector?: string
}

export interface Rule {
  trigger: Trigger
  action: Action
}

export interface ListStats {
  /** Lines of the source list. */
  lines: number
  /** Filters read: the lines that are neither comments nor empty. */
  filters: number
  /** Rules written, network file and cosmetic file together. */
  rules: number
  /** Rules written in the network file and in the cosmetic file. */
  networkRules: number
  cosmeticRules: number
  /** Filters that were read and not converted, by reason. A filter counts once; the rules it would have made are not counted. */
  dropped: Record<string, number>
  /** A few examples of each reason (the filter text, cut), to read what a reason stands for. */
  samples: Record<string, string[]>
}

export interface ConvertedList {
  /** Blocks, exceptions and the shield of the top-level page (the file `<id>.network.json`). */
  network: Rule[]
  /** Element hiding and its exceptions (the file `<id>.cosmetic.json`). */
  cosmetic: Rule[]
  /** The scriptlet calls the list names for sites (the file `<id>.scriptlets.json`), when the caller gave a collector; empty otherwise. */
  scriptlets: ScriptletTable
  stats: ListStats
}

// ---------- the address pattern: from the filter syntax to the expression WebKit reads ----------

/** The separator `^` of the filter syntax: any character that is not a letter, a digit, or one of `_ . % -`. */
const SEPARATOR = '[^a-zA-Z0-9_.%-]'
/** The start of an address for a rule anchored on a host (`||`): a scheme, then the host or any of its subdomains. */
const HOST_ANCHOR = '^[a-z]+://([^/]+\\.)?'

function escapeLiteral(character: string): string {
  return '.+?(){}[]|\\$^'.includes(character) ? `\\${character}` : character
}

/**
 * Whether an expression is inside the subset WebKit reads: literals and escaped punctuation, `.`, classes `[…]`, groups `( … )` that hold no
 * alternation, the quantifiers `* + ?` after an atom, `^` first and `$` last. This is the last gate before a rule is written, whatever
 * produced the text: a rule WebKit would refuse must not leave the converter.
 */
export function isWebKitExpression(source: string): boolean {
  if (source.length === 0 || source.length > URL_FILTER_MAX) return false
  let depth = 0
  // The previous token can take a quantifier; a `?` right after `*` or `+` makes it lazy (WebKit reads that), nothing else may follow a quantifier.
  let atom = false
  let lazyAllowed = false
  for (let at = 0; at < source.length; at++) {
    const c = source.charCodeAt(at)
    if (c < 0x20 || c > 0x7e) return false
    const character = source[at]!
    if (character === '*' || character === '+' || character === '?') {
      if (atom) {
        atom = false
        lazyAllowed = character !== '?'
      } else if (character === '?' && lazyAllowed) {
        lazyAllowed = false
      } else {
        return false
      }
      continue
    }
    lazyAllowed = false
    if (character === '\\') {
      const next = source[at + 1]
      // Only an escaped punctuation mark: `\d`, `\w`, `\b`, `\1` are refused by WebKit.
      if (next === undefined || /[a-zA-Z0-9]/.test(next)) return false
      at++
      atom = true
    } else if (character === '[') {
      let end = at + 1
      if (source[end] === '^') end++
      // A `]` right after the opening is a literal in some engines and a syntax error in others: refuse it.
      if (source[end] === ']') return false
      while (end < source.length && source[end] !== ']') {
        if (source[end] === '\\') {
          const next = source[end + 1]
          if (next === undefined || /[a-zA-Z0-9]/.test(next)) return false
          end++
        }
        end++
      }
      if (end >= source.length) return false
      at = end
      atom = true
    } else if (character === '(') {
      if (source[at + 1] === '?') return false
      depth++
      atom = false
    } else if (character === ')') {
      if (--depth < 0) return false
      atom = true
    } else if (character === '|' || character === '{' || character === '}') {
      return false
    } else if (character === '^') {
      if (at !== 0) return false
      atom = false
    } else if (character === '$') {
      if (at !== source.length - 1) return false
      atom = false
    } else {
      atom = true
    }
  }
  return depth === 0
}

export type PatternResult = { filters: string[] } | { drop: string }

/** A pattern of the filter syntax (`||example.com^`, `/ads/*.gif`, `|https://x/`) as expressions WebKit reads. One expression for a pattern, more for a split regular expression. */
export function patternToUrlFilters(pattern: string): PatternResult {
  if (pattern.length >= 3 && pattern.startsWith('/') && pattern.endsWith('/')) return regexToUrlFilters(pattern.slice(1, -1))
  let rest = pattern
  let prefix = ''
  if (rest.startsWith('||')) {
    prefix = HOST_ANCHOR
    rest = rest.slice(2)
  } else if (rest.startsWith('|')) {
    prefix = '^'
    rest = rest.slice(1)
  }
  let suffix = ''
  if (rest.endsWith('|')) {
    suffix = '$'
    rest = rest.slice(0, -1)
  }
  let body = ''
  for (const character of rest) {
    const code = character.codePointAt(0)!
    if (code <= 0x20 || code > 0x7e) return { drop: code > 0x7e ? 'pattern:non-ascii' : 'pattern:whitespace' }
    if (character === '*') {
      if (!body.endsWith('.*')) body += '.*'
    } else if (character === '^') {
      body += SEPARATOR
    } else {
      body += escapeLiteral(character.toLowerCase())
    }
  }
  // An unanchored expression is searched anywhere in the address: a leading or trailing `.*` says nothing more.
  if (prefix === '') body = body.replace(/^(\.\*)+/, '')
  if (suffix === '') body = body.replace(/(\.\*)+$/, '')
  let source = `${prefix}${body}${suffix}`
  if (source === '') source = '.*'
  return isWebKitExpression(source) ? { filters: [source] } : { drop: 'pattern:unsupported' }
}

/** A regular expression filter (`/…/`). WebKit reads a small subset: the rest is left out, counted. A top-level alternation is split into one rule per branch. */
function regexToUrlFilters(source: string): PatternResult {
  for (const character of source) if (character.codePointAt(0)! > 0x7e) return { drop: 'regex:non-ascii' }
  const branches: string[] = []
  let branch = ''
  let depth = 0
  let inClass = false
  for (let at = 0; at < source.length; at++) {
    const character = source[at]!
    if (character === '\\') {
      const next = source[at + 1]
      if (next === undefined) return { drop: 'regex:unsupported' }
      at++
      // `\d`, `\w` and their negations become classes; every other letter escape (`\b`, `\s`, `\1`…) has no equivalent.
      const replacement = inClass ? CLASS_ESCAPES_IN_CLASS[next] : CLASS_ESCAPES[next]
      if (replacement !== undefined) branch += replacement
      else if (/[a-zA-Z0-9]/.test(next)) return { drop: 'regex:unsupported' }
      else branch += next === '/' ? '/' : `\\${next}`
      continue
    }
    if (inClass) {
      if (character === ']') inClass = false
      branch += character
      continue
    }
    if (character === '[') inClass = true
    else if (character === '(') depth++
    else if (character === ')') depth--
    if (character === '|' && depth === 0) {
      branches.push(branch)
      branch = ''
      continue
    }
    branch += character
  }
  branches.push(branch)
  if (branches.length > ALTERNATIVES_MAX) return { drop: 'regex:too-many-alternatives' }
  const filters = branches.map((text) => text.replace(/^\^?(\.\*)+/, (start) => (start.startsWith('^') ? '^' : '')))
  return filters.every((text) => text !== '' && isWebKitExpression(text)) ? { filters } : { drop: 'regex:unsupported' }
}

const CLASS_ESCAPES: Record<string, string> = { d: '[0-9]', D: '[^0-9]', w: '[a-zA-Z0-9_]', W: '[^a-zA-Z0-9_]' }
const CLASS_ESCAPES_IN_CLASS: Record<string, string> = { d: '0-9', w: 'a-zA-Z0-9_' }

// ---------- options ----------

const SUBRESOURCE_TYPES: readonly ResourceType[] = ['image', 'style-sheet', 'script', 'font', 'raw', 'svg-document', 'media', 'ping', 'fetch', 'websocket', 'other']

/** The request types of the filter syntax (and the short names of uBlock Origin) → what WebKit calls them. `subdocument` and `document` are told apart by `load-context`. */
const TYPE_OPTIONS: Record<string, readonly ResourceType[] | 'subdocument' | 'document' | 'obsolete'> = {
  script: ['script'],
  image: ['image', 'svg-document'],
  stylesheet: ['style-sheet'],
  css: ['style-sheet'],
  xmlhttprequest: ['raw', 'fetch'],
  xhr: ['raw', 'fetch'],
  font: ['font'],
  media: ['media'],
  ping: ['ping'],
  websocket: ['websocket'],
  other: ['other'],
  popup: ['popup'],
  popunder: ['popup'],
  subdocument: 'subdocument',
  frame: 'subdocument',
  document: 'document',
  doc: 'document',
  object: 'obsolete',
  'object-subrequest': 'obsolete'
}

/** What the options of a filter say once read. */
interface Options {
  /** Positive type options, as WebKit types; `child` is true when the sub-frame documents are named, `top` when the top-level page is. */
  types: Set<ResourceType>
  child: boolean
  top: boolean
  negatedTypes: Set<ResourceType>
  negatedChild: boolean
  all: boolean
  thirdParty: boolean | null
  matchCase: boolean
  important: boolean
  includeDomains: string[]
  excludeDomains: string[]
  /** `$elemhide`, `$generichide`: a page where the element hiding stops (exceptions only). */
  elemhide: boolean
  generichide: boolean
}

type OptionsResult = { options: Options } | { drop: string }

/** The domains of `domain=a.com|~b.com`: lower case and ASCII (punycode), or a reason to leave the filter out. */
function parseDomains(text: string): { include: string[]; exclude: string[] } | { drop: string } {
  const include: string[] = []
  const exclude: string[] = []
  for (const raw of text.split('|')) {
    if (raw === '') continue
    const negated = raw.startsWith('~')
    const name = (negated ? raw.slice(1) : raw).toLowerCase()
    if (name.includes('*') || name.startsWith('/')) return { drop: 'domain:wildcard-or-regex' }
    const ascii = toAsciiDomain(name)
    if (ascii === null) return { drop: 'domain:invalid' }
    ;(negated ? exclude : include).push(ascii)
  }
  return { include, exclude }
}

/** A host name in the form WebKit wants (lower case ASCII, punycode for the rest), or null: the caller counts the filter as left out. */
export function toAsciiDomain(name: string): string | null {
  // Letters, digits, dots and hyphens only, before anything reads it as an address: a name with `:`, `/`, `@` or `%` is not a host name.
  if (!/^[\p{L}\p{Nd}.-]+$/u.test(name)) return null
  const ascii = /^[a-z0-9.-]+$/.test(name) ? name : new URL(`http://${name}/`).hostname
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(ascii) && !ascii.includes('..') ? ascii : null
}

function parseOptions(text: string, exception: boolean): OptionsResult {
  const options: Options = {
    types: new Set(),
    child: false,
    top: false,
    negatedTypes: new Set(),
    negatedChild: false,
    all: false,
    thirdParty: null,
    matchCase: false,
    important: false,
    includeDomains: [],
    excludeDomains: [],
    elemhide: false,
    generichide: false
  }
  for (const token of text.split(',')) {
    if (token === '') continue
    const negated = token.startsWith('~')
    const [rawName, ...valueParts] = (negated ? token.slice(1) : token).split('=')
    const name = rawName!.toLowerCase()
    const value = valueParts.join('=')
    if (name === 'third-party' || name === '3p') options.thirdParty = !negated
    else if (name === 'first-party' || name === '1p') options.thirdParty = negated
    else if (name === 'match-case') options.matchCase = true
    else if (name === 'important') options.important = true
    else if (name === 'all') options.all = true
    else if (name === 'domain' || name === 'from') {
      const domains = parseDomains(value)
      if ('drop' in domains) return domains
      options.includeDomains.push(...domains.include)
      options.excludeDomains.push(...domains.exclude)
    } else if (name === 'elemhide' || name === 'ehide') {
      if (!exception) return { drop: 'option:elemhide' }
      options.elemhide = true
    } else if (name === 'generichide' || name === 'ghide') {
      if (!exception) return { drop: 'option:generichide' }
      options.generichide = true
    } else if (name in TYPE_OPTIONS) {
      const mapped = TYPE_OPTIONS[name]!
      // A plugin type (flash) has no equivalent: a rule that needs it is left out, a rule that only says "not that" loses nothing.
      if (mapped === 'obsolete') {
        if (negated) continue
        return { drop: `type:${name}` }
      }
      if (mapped === 'subdocument') (negated ? (options.negatedChild = true) : (options.child = true))
      else if (mapped === 'document') {
        if (negated) return { drop: 'type:negated-document' }
        options.top = true
      } else for (const type of mapped) (negated ? options.negatedTypes : options.types).add(type)
    } else {
      // redirect, removeparam, csp, replace, header, denyallow, to, method, badfilter (handled before), cname, … : WebKit has no equivalent, and a
      // rule written without its option would block more than the list means.
      return { drop: `option:${name}` }
    }
  }
  return { options }
}

// ---------- one filter → rules ----------

type Segment = 'block' | 'exception' | 'important' | 'top-block' | 'popup-block' | 'page-exception'

interface Tagged {
  segment: Segment
  rule: Rule
}

function domainConditions(options: Options): { 'if-domain'?: string[]; 'unless-domain'?: string[] } | { drop: string } {
  if (options.includeDomains.length > 0 && options.excludeDomains.length > 0) return { drop: 'domain:mixed' }
  if (options.includeDomains.length > 0) return { 'if-domain': options.includeDomains.map((domain) => `*${domain}`) }
  if (options.excludeDomains.length > 0) return { 'unless-domain': options.excludeDomains.map((domain) => `*${domain}`) }
  return {}
}

/** The types a filter applies to, as groups of rules: subresources, sub-frame documents, the top-level page, popups. A group of types a rule must carry together. */
interface TypeGroups {
  /** WebKit types of subresources, empty when the filter names none (and not all). */
  resources: ResourceType[]
  /** Everything but the types left out, or `null` when the filter says nothing about types. */
  unrestricted: boolean
  child: boolean
  top: boolean
  popup: boolean
}

function typeGroups(options: Options): TypeGroups {
  const named = options.types.size > 0 || options.child || options.top
  if (options.all) return { resources: [...SUBRESOURCE_TYPES], unrestricted: false, child: true, top: true, popup: true }
  if (named) {
    const popup = options.types.has('popup')
    return { resources: [...options.types].filter((type) => type !== 'popup'), unrestricted: false, child: options.child, top: options.top, popup }
  }
  if (options.negatedTypes.size > 0 || options.negatedChild) {
    return { resources: SUBRESOURCE_TYPES.filter((type) => !options.negatedTypes.has(type)), unrestricted: false, child: !options.negatedChild, top: false, popup: false }
  }
  // No type: every subresource and the sub-frames, never the top-level page nor a popup (the filter syntax's default).
  return { resources: [], unrestricted: true, child: false, top: false, popup: false }
}

function triggerOf(url: string, options: Options, conditions: { 'if-domain'?: string[]; 'unless-domain'?: string[] }, extra: Partial<Trigger>): Trigger {
  const trigger: Trigger = { 'url-filter': url }
  if (options.matchCase) trigger['url-filter-is-case-sensitive'] = true
  Object.assign(trigger, conditions)
  if (options.thirdParty !== null) trigger['load-type'] = [options.thirdParty ? 'third-party' : 'first-party']
  return Object.assign(trigger, extra)
}

/** The rules of one network filter, tagged with the part of the file they go to, or a reason it was left out. */
function networkRules(urlFilters: string[], options: Options, exception: boolean): Tagged[] | { drop: string } {
  const conditions = domainConditions(options)
  if ('drop' in conditions) return conditions
  const groups = typeGroups(options)
  const tagged: Tagged[] = []
  const action: Action = { type: exception ? 'ignore-previous-rules' : 'block' }
  const segment = (kind: 'main' | 'top' | 'popup'): Segment => (kind === 'top' ? (exception ? 'exception' : 'top-block') : kind === 'popup' ? (exception ? 'exception' : 'popup-block') : exception ? 'exception' : options.important ? 'important' : 'block')
  for (const url of urlFilters) {
    if (groups.unrestricted) tagged.push({ segment: segment('main'), rule: { trigger: triggerOf(url, options, conditions, {}), action } })
    else if (groups.resources.length > 0) tagged.push({ segment: segment('main'), rule: { trigger: triggerOf(url, options, conditions, { 'resource-type': groups.resources }), action } })
    if (groups.child) tagged.push({ segment: segment('main'), rule: { trigger: triggerOf(url, options, conditions, { 'resource-type': ['document'], 'load-context': ['child-frame'] }), action } })
    if (groups.top) tagged.push({ segment: segment('top'), rule: { trigger: triggerOf(url, options, conditions, { 'resource-type': ['document'], 'load-context': ['top-frame'] }), action } })
    if (groups.popup) tagged.push({ segment: segment('popup'), rule: { trigger: triggerOf(url, options, conditions, { 'resource-type': ['popup'] }), action } })
  }
  return tagged.length > 0 ? tagged : { drop: 'type:none' }
}

/** The domain a page-level exception (`@@||example.com^$document`) names: from the host of its pattern, or from `domain=` when the pattern says nothing. */
function pageExceptionDomains(pattern: string, options: Options): string[] | null {
  if (pattern === '' || pattern === '*') return options.includeDomains.length > 0 && options.excludeDomains.length === 0 ? options.includeDomains : null
  const match = /^\|\|([^/^*?:|]+)(?:\^|\/)?$/.exec(pattern)
  if (!match) return null
  const host = toAsciiDomain(match[1]!.toLowerCase())
  return host === null ? null : [host]
}

// ---------- cosmetic filters ----------

/** The pseudo-classes kept in a selector: the standard ones. Every other name is an extension of a blocker (`:has-text`, `:-abp-contains`, `:xpath`…) that WebKit refuses. */
const PSEUDO_CLASSES = new Set([
  'not', 'is', 'where', 'has', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'first-child', 'last-child', 'only-child',
  'first-of-type', 'last-of-type', 'only-of-type', 'empty', 'root', 'checked', 'disabled', 'enabled', 'link', 'target', 'lang', 'dir'
])

/** Why a selector is not kept, or null. A selector kept must be one WebKit parses (one bad selector refuses the whole list), and nothing that could close the rule it sits in. */
export function selectorProblem(selector: string): string | null {
  if (selector.length === 0 || selector.length > SELECTOR_MAX) return 'cosmetic:length'
  for (const character of selector) {
    const code = character.codePointAt(0)!
    if (code < 0x20 || code > 0x7e) return 'cosmetic:non-ascii'
  }
  // The text between quotes is data: set it aside, then what is left must have no quote and nothing that could close the rule the selector sits in.
  const bare = selector.replace(/\\./g, '').replace(/"[^"]*"|'[^']*'/g, '_')
  if (/["']/.test(bare)) return 'cosmetic:quotes'
  if (/[{};<]/.test(bare) || bare.includes('/*')) return 'cosmetic:unsafe'
  let parens = 0
  let brackets = 0
  for (const character of bare) {
    if (character === '(') parens++
    else if (character === ')') parens--
    else if (character === '[') brackets++
    else if (character === ']') brackets--
    if (parens < 0 || brackets < 0) return 'cosmetic:brackets'
  }
  if (parens !== 0 || brackets !== 0) return 'cosmetic:brackets'
  // A pseudo-class is read outside attribute selectors.
  const outside = bare.replace(/\[[^\]]*\]/g, '[]')
  if (outside.includes('::')) return 'cosmetic:pseudo-element'
  for (const match of outside.matchAll(/:([a-zA-Z-]+)/g)) {
    if (!PSEUDO_CLASSES.has(match[1]!.toLowerCase())) return 'cosmetic:procedural'
  }
  if (/^\s*[>+~]/.test(selector) || /[>+~,]\s*$/.test(selector) || /,\s*,/.test(selector)) return 'cosmetic:shape'
  return null
}

/** The selectors of a comma list, each one checked on its own. */
function splitSelectors(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let at = 0; at < text.length; at++) {
    const character = text[at]!
    if (character === '\\') at++
    else if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") quote = character
    else if (character === '(' || character === '[') depth++
    else if (character === ')' || character === ']') depth--
    else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, at).trim())
      start = at + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts
}

const COSMETIC_FILTER = /^([^/\s#$]*)#(@?)([?$%]?)#(.+)$/

// ---------- a list ----------

const SAMPLES_PER_REASON = 3
const SAMPLE_CHARS = 120

/** What `convertList` needs to know besides the text. */
export interface ConvertOptions {
  /** Rules a file may hold; the default is WebKit's limit. */
  limit?: number
  /**
   * Where the scriptlet filters (`site##+js(…)`) go. WebKit has no such rule: without a collector they are left out and counted
   * (`cosmetic:scriptlet`); with one they are kept in a table apart from the rules (scriptlets.ts), and the ones it refuses are counted under its reason.
   */
  scriptlets?: Pick<ScriptletCollector, 'read' | 'table'>
}

export function convertList(text: string, convertOptions: ConvertOptions = {}): ConvertedList {
  const limit = convertOptions.limit ?? WEBKIT_RULE_LIMIT
  const lines = text.split(/\r?\n/)
  const stats: ListStats = { lines: lines.length, filters: 0, rules: 0, networkRules: 0, cosmeticRules: 0, dropped: {}, samples: {} }
  const drop = (reason: string, line: string): void => {
    stats.dropped[reason] = (stats.dropped[reason] ?? 0) + 1
    const samples = (stats.samples[reason] ??= [])
    if (samples.length < SAMPLES_PER_REASON) samples.push(line.length > SAMPLE_CHARS ? `${line.slice(0, SAMPLE_CHARS)}…` : line)
  }

  // `$badfilter` names another filter of the list to take out: the filter written as it, without the option.
  const badFilters = new Set<string>()
  for (const raw of lines) {
    const line = raw.trim()
    if (!/\$[^$]*\bbadfilter\b/.test(line)) continue
    badFilters.add(canonicalWithoutBadfilter(line))
  }

  const network: Record<Segment, Rule[]> = { block: [], exception: [], important: [], 'top-block': [], 'popup-block': [], 'page-exception': [] }
  const genericHides = new Map<string, Set<string>>()
  const domainHides = new Map<string, Set<string>>()
  const hideExceptions = new Map<string, Set<string>>()
  const pageExceptions: Rule[] = []
  const elemhideExceptions: Rule[] = []
  const generichideExceptions: Rule[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('!') || line.startsWith('[') || line.startsWith('# ')) continue
    stats.filters++

    const cosmetic = COSMETIC_FILTER.exec(line)
    if (cosmetic) {
      readCosmetic(line, cosmetic, { genericHides, domainHides, hideExceptions }, drop, convertOptions.scriptlets)
      continue
    }

    const exception = line.startsWith('@@')
    const body = exception ? line.slice(2) : line
    let pattern = body
    let optionText = ''
    const dollar = body.lastIndexOf('$')
    if (dollar >= 0 && /^[~a-z0-9_-]/i.test(body.slice(dollar + 1))) {
      // What follows the last `$` is the options. One that is not a list of options (a regular expression in a value, a stray `$`) is not guessed at.
      if (!/^~?[a-z0-9_-]+(=[^,]*)?(,~?[a-z0-9_-]+(=[^,]*)?)*$/i.test(body.slice(dollar + 1))) {
        drop('option:unparsed', line)
        continue
      }
      pattern = body.slice(0, dollar)
      optionText = body.slice(dollar + 1)
    }
    if (/\bbadfilter\b/.test(optionText)) continue
    if (badFilters.has(canonicalWithoutBadfilter(line))) {
      drop('badfilter', line)
      continue
    }
    const parsed = parseOptions(optionText, exception)
    if ('drop' in parsed) {
      drop(parsed.drop, line)
      continue
    }
    const options = parsed.options

    if (exception && (options.elemhide || options.generichide || options.top || options.all)) {
      // A page where filtering stops. Needs the page's own domain: nothing else can be said in WebKit.
      const domains = pageExceptionDomains(pattern, options)
      if (domains === null) {
        drop('exception:page-pattern', line)
        continue
      }
      const rule = (extra: Partial<Trigger>): Rule => ({ trigger: { 'url-filter': '.*', 'if-domain': domains.map((domain) => `*${domain}`), ...extra }, action: { type: 'ignore-previous-rules' } })
      if (options.top || options.all) pageExceptions.push(rule({}))
      else if (options.elemhide) elemhideExceptions.push(rule({ 'resource-type': ['document'] }))
      else generichideExceptions.push(rule({ 'resource-type': ['document'] }))
      continue
    }

    const urls = patternToUrlFilters(pattern)
    if ('drop' in urls) {
      drop(urls.drop, line)
      continue
    }
    const made = networkRules(urls.filters, options, exception)
    if ('drop' in made) {
      drop(made.drop, line)
      continue
    }
    for (const { segment, rule } of made) network[segment].push(rule)
  }

  // Order is the meaning in WebKit: a rule that ignores the previous ones only reaches the rules above it.
  //   blocks → exceptions → `$important` blocks (they win over the exceptions) → the shield of the top-level page → the blocks that name the
  //   page itself or popups (they come after the shield, which would cancel them) → the pages where filtering is switched off.
  // The shield: a rule without a type must not stop the person from opening the address of a tracker (the filter syntax's default leaves the
  // top-level page out; WebKit's does not).
  const shield: Rule = { trigger: { 'url-filter': '.*', 'resource-type': ['document'], 'load-context': ['top-frame'] }, action: { type: 'ignore-previous-rules' } }
  const networkHead = [...network.block, ...network.exception, ...network.important]
  // With nothing above it the shield has nothing to cancel.
  const networkTail = [...(networkHead.length > 0 ? [shield] : []), ...network['top-block'], ...network['popup-block'], ...pageExceptions]
  const cosmetic = buildCosmetic({ genericHides, domainHides, hideExceptions, generichideExceptions, elemhideExceptions, pageExceptions }, drop)

  const networkFile = capRules(networkHead, networkTail, limit, 'network', stats)
  const cosmeticFile = capRules(cosmetic.body, cosmetic.tail, limit, 'cosmetic', stats)
  stats.networkRules = networkFile.length
  stats.cosmeticRules = cosmeticFile.length
  stats.rules = networkFile.length + cosmeticFile.length
  return { network: networkFile, cosmetic: cosmeticFile, scriptlets: convertOptions.scriptlets?.table() ?? { domains: {}, calls: 0 }, stats }
}

/** The filter without its `badfilter` option, to find the filter it takes out. */
function canonicalWithoutBadfilter(line: string): string {
  const dollar = line.lastIndexOf('$')
  if (dollar < 0) return line
  const kept = line.slice(dollar + 1).split(',').filter((token) => token !== 'badfilter' && token !== '')
  return kept.length > 0 ? `${line.slice(0, dollar)}$${kept.join(',')}` : line.slice(0, dollar)
}

/**
 * The rules of a file, under the limit. What goes after the head (the shield, the page exceptions) is small and keeps its meaning; when the
 * file is too long it is the end of the head that is left out, and the count is kept (`over-limit:<file>`).
 */
function capRules(head: Rule[], tail: Rule[], limit: number, name: string, stats: ListStats): Rule[] {
  if (head.length + tail.length <= limit) return [...head, ...tail]
  const kept = Math.max(0, limit - tail.length)
  const left = head.length - kept
  stats.dropped[`over-limit:${name}`] = left
  stats.samples[`over-limit:${name}`] = [`${head.length + tail.length} rules, ${limit} allowed: the last ${left} rules of the first part are left out`]
  return [...head.slice(0, kept), ...tail].slice(0, limit)
}

interface CosmeticState {
  genericHides: Map<string, Set<string>>
  domainHides: Map<string, Set<string>>
  hideExceptions: Map<string, Set<string>>
}

function readCosmetic(line: string, match: RegExpExecArray, state: CosmeticState, drop: (reason: string, line: string) => void, scriptlets: ConvertOptions['scriptlets']): void {
  const [, domainText, exceptionMark, kind, selectorText] = match as unknown as [string, string, string, string, string]
  if (kind !== '') return drop('cosmetic:procedural', line)
  if (selectorText.startsWith('+js(')) {
    if (scriptlets === undefined) return drop('cosmetic:scriptlet', line)
    const reason = scriptlets.read(domainText, exceptionMark === '@', selectorText)
    if (reason !== null) drop(reason, line)
    return
  }
  if (selectorText.startsWith('^')) return drop('cosmetic:html-filter', line)
  const include: string[] = []
  const exclude: string[] = []
  for (const raw of domainText.split(',')) {
    if (raw === '') continue
    const negated = raw.startsWith('~')
    const name = (negated ? raw.slice(1) : raw).toLowerCase()
    if (name.includes('*')) return drop('cosmetic:domain-wildcard', line)
    const ascii = toAsciiDomain(name)
    if (ascii === null) return drop('cosmetic:domain-invalid', line)
    ;(negated ? exclude : include).push(ascii)
  }
  const selectors = splitSelectors(selectorText)
  for (const selector of selectors) {
    const problem = selectorProblem(selector)
    if (problem !== null) return drop(problem, line)
  }
  if (exceptionMark === '@') {
    // An exception is kept for the selectors it names; with no domain it switches the selector off everywhere.
    if (exclude.length > 0) return drop('cosmetic:negated-exception', line)
    for (const selector of selectors) {
      const domains = state.hideExceptions.get(selector) ?? new Set<string>()
      if (include.length === 0) domains.add('')
      for (const domain of include) domains.add(domain)
      state.hideExceptions.set(selector, domains)
    }
    return
  }
  if (include.length > 0 && exclude.length > 0) return drop('cosmetic:mixed-domains', line)
  for (const selector of selectors) {
    if (include.length === 0) {
      const excluded = state.genericHides.get(selector) ?? new Set<string>()
      for (const domain of exclude) excluded.add(domain)
      state.genericHides.set(selector, excluded)
    } else {
      for (const domain of include) {
        const own = state.domainHides.get(domain) ?? new Set<string>()
        own.add(selector)
        state.domainHides.set(domain, own)
      }
    }
  }
}

function related(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

function hideRule(selectors: string[], conditions: { 'if-domain'?: string[]; 'unless-domain'?: string[] }): Rule {
  return { trigger: { 'url-filter': '.*', ...conditions }, action: { type: 'css-display-none', selector: selectors.join(', ') } }
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size))
  return chunks
}

interface CosmeticParts extends CosmeticState {
  generichideExceptions: Rule[]
  elemhideExceptions: Rule[]
  pageExceptions: Rule[]
}

/**
 * The cosmetic file: the selectors that apply everywhere (grouped; those with an exception for some site carry `unless-domain`), the
 * generic-hide exceptions, the selectors of one site (one rule per site), the element-hide exceptions, the pages where filtering stops.
 * An exception that names one selector on one site is applied by taking that selector out of that site's rule: WebKit's
 * `ignore-previous-rules` cannot name a selector.
 */
function buildCosmetic(parts: CosmeticParts, drop: (reason: string, line: string) => void): { body: Rule[]; tail: Rule[] } {
  const rules: Rule[] = []
  // Selectors by the set of sites they exclude, so that one rule holds many.
  // The selectors that exclude nothing come first: they are the bulk.
  const groups = new Map<string, { excluded: string[]; selectors: string[] }>([['', { excluded: [], selectors: [] }]])
  for (const [selector, ownExclusions] of parts.genericHides) {
    const exceptions = parts.hideExceptions.get(selector)
    if (exceptions?.has('')) {
      drop('cosmetic:switched-off-by-exception', selector)
      continue
    }
    const excluded = [...new Set([...ownExclusions, ...(exceptions ?? [])])].sort()
    const key = excluded.join(',')
    const group = groups.get(key) ?? { excluded, selectors: [] }
    group.selectors.push(selector)
    groups.set(key, group)
  }
  for (const { excluded, selectors } of groups.values()) {
    const conditions = excluded.length > 0 ? { 'unless-domain': excluded.map((domain) => `*${domain}`) } : {}
    for (const chunk of chunked(selectors, SELECTORS_PER_RULE)) rules.push(hideRule(chunk, conditions))
  }
  rules.push(...parts.generichideExceptions)
  for (const [domain, selectors] of parts.domainHides) {
    const kept: string[] = []
    for (const selector of selectors) {
      if (parts.genericHides.has(selector)) continue
      const exceptions = parts.hideExceptions.get(selector)
      if (exceptions && (exceptions.has('') || [...exceptions].some((other) => related(other, domain)))) {
        drop('cosmetic:switched-off-by-exception', `${domain}##${selector}`)
        continue
      }
      kept.push(selector)
    }
    for (const chunk of chunked(kept, SELECTORS_PER_RULE)) rules.push(hideRule(chunk, { 'if-domain': [`*${domain}`] }))
  }
  return { body: rules, tail: [...parts.elemhideExceptions, ...parts.pageExceptions] }
}

/** Writes rules as WebKit reads them: a JSON array, compact. */
export function serializeRules(rules: readonly Rule[]): string {
  return JSON.stringify(rules)
}
