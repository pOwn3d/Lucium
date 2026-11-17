// The user's own filter lists: a file chosen on disk, or rules pasted in. What is written there is hostile input (a list found on a forum,
// a file a friend sent), so nothing reaches the filter engine as it came: each line is read, and only the rules this application can apply
// safely are kept. A script rule (`##+js(...)`) is never run, a regular expression is refused (a crafted one freezes the browser on one
// request: measured, 24 characters take 1.6 s), a rule with more than two wildcards is refused for the same reason, and a selector that could
// close the style rule it sits in is refused. The rest is counted and told to the user. Pure: the engine's own parser comes in as `parses`.
// Nothing here downloads anything: a list comes from a file or from the clipboard, never from an address.
//
// The extended rules (`##+js(...)`, `$removeparam`, `$csp`) are kept only in the shapes shared/extended-rules.ts accepts: a scriptlet that names
// one of Lucium's own with arguments of the right form, a parameter named by a plain word, a policy made of restricting directives. They do
// nothing unless the user also switches on "Scriptlets et règles étendues du bloqueur".

/** Lists the user can have at once: a bound for a hand-edited file as much as for the interface. */
export const CUSTOM_LISTS_MAX = 20
/** A pasted text, in characters. The interface sends it through IPC, so it is bounded there too. */
export const CUSTOM_PASTE_MAX_CHARS = 1_000_000
/** A file on disk, in bytes (EasyList, the largest public list, weighs about 2.5 MB). */
export const CUSTOM_FILE_MAX_BYTES = 8_000_000
/** Rules kept per list. */
export const CUSTOM_RULES_MAX = 150_000
/** A rule longer than this is not a rule. */
export const CUSTOM_RULE_MAX_CHARS = 2000
/** More wildcards make the matching grow with the cube of the address length (measured: 3 take 89 s on an address of 8,000 characters, 2 take 32 ms). */
export const CUSTOM_WILDCARDS_MAX = 2
export const CUSTOM_TITLE_MAX = 80
const SAMPLES_MAX = 8
const SAMPLE_CHARS = 120

import { cleanCspPolicy, isRemoveParamName, judgeScriptletSelector } from './extended-rules'
import { t, tp } from './i18n'
import { countText, counted } from './import-sources'

export type CustomListSource = 'file' | 'paste'

/** What the settings keep about a list: the rules themselves are in a file of the filters folder, under this id. */
export interface CustomFilterList {
  /** `custom-` and 8 hexadecimal digits: also the name of the file, and the key of the compiled engine. */
  id: string
  title: string
  source: CustomListSource
  /** The name of the file it came from, or a mention that it was pasted. */
  sourceName: string
  enabled: boolean
  addedAt: number
}

const CUSTOM_ID = /^custom-[0-9a-f]{8}$/
export const isCustomListId = (id: unknown): id is string => typeof id === 'string' && CUSTOM_ID.test(id)

const CONTROL = /\p{Cc}/gu
const text = (value: unknown, max: number): string | null => (typeof value === 'string' ? value.replace(CONTROL, ' ').trim().slice(0, max) : null)

/** The lists of a saved or imported file: well-formed entries only, an id once, no more than `CUSTOM_LISTS_MAX`. */
export function cleanCustomFilterLists(raw: unknown): CustomFilterList[] {
  if (!Array.isArray(raw)) return []
  const out: CustomFilterList[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (out.length >= CUSTOM_LISTS_MAX) break
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const id = e['id']
    const title = text(e['title'], CUSTOM_TITLE_MAX)
    const sourceName = text(e['sourceName'], 120)
    const source = e['source']
    if (!isCustomListId(id) || seen.has(id) || !title || !sourceName || (source !== 'file' && source !== 'paste')) continue
    seen.add(id)
    const addedAt = e['addedAt']
    out.push({ id, title, source, sourceName, enabled: e['enabled'] !== false, addedAt: typeof addedAt === 'number' && Number.isFinite(addedAt) ? addedAt : 0 })
  }
  return out
}

/** The list with one switched on or off; the same array when nothing changes. */
export function withCustomListEnabled(lists: readonly CustomFilterList[], id: unknown, enabled: unknown): readonly CustomFilterList[] {
  if (typeof enabled !== 'boolean' || !lists.some((l) => l.id === id && l.enabled !== enabled)) return lists
  return lists.map((l) => (l.id === id ? { ...l, enabled } : l))
}

// ---------- reading the text of a list ----------

export interface ReviewSample {
  /** The line, counted from 1, in the text the user gave. */
  line: number
  text: string
  reason: string
}

/** What was found in a list: the rules kept, those left out on purpose (valid, but not applied), and those that are not rules. */
export interface CustomListReview {
  /** The text to install: the accepted rules, one per line, nothing else. */
  text: string
  rules: number
  /** The list's own name (`! Title:`), when it says one. */
  title?: string
  ignored: number
  invalid: number
  /** The first few lines left out, with the reason; the counts above are complete. */
  samples: ReviewSample[]
}

/** Rules left out and counted, kept in the index to be shown beside the list. */
export interface ReviewSummary {
  ignored: number
  invalid: number
  samples: ReviewSample[]
}

export type CustomListVerdict = { ok: true; review: CustomListReview } | { ok: false; reason: string }

/** What the interface learns when it asks for a list to be added: the list and what was left out of it, or the sentence that says why not. */
export type AddFilterListResult =
  | { ok: true; list: CustomFilterList; rules: number; ignored: number; invalid: number; samples: ReviewSample[] }
  | { ok: false; reason: string; canceled?: boolean }

// Modifiers of network rules this application does not apply. Such a rule would match nothing here, so it is counted instead of kept.
const UNSUPPORTED_MODIFIERS = new Set([
  'queryprune', 'replace', 'rewrite', 'permissions', 'header', 'cname', 'jsonprune', 'xmlprune', 'urltransform', 'uritransform', 'hls', 'all', 'popup', 'popunder', 'generichide', 'genericblock', 'elemhide', 'specifichide', 'ehide', 'shide', 'ghide', 'content', 'inline-script', 'inline-font'
])

// Cosmetic syntaxes that run code or change more than visibility: `:style()` can load an address, `:remove()` edits the page, the
// extended selectors need a script to be evaluated.
const EXTENDED_SELECTOR = /:(?:style|remove|has-text|contains|-abp-[a-z-]+|xpath|matches-[a-z-]+|min-text-length|upward|watch-attr|others|nth-ancestor|if|if-not|not-if|is-visible)\(/i

const HOSTS_LINE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+\S/

/** Splits `domains##selector` (or `#@#`) into its parts, or null when the line has no cosmetic separator. */
function cosmeticParts(line: string): { domains: string; exception: boolean; selector: string } | null {
  const at = line.search(/#@?#/)
  if (at < 0) return null
  const exception = line.startsWith('#@#', at)
  return { domains: line.slice(0, at), exception, selector: line.slice(at + (exception ? 3 : 2)) }
}

/**
 * The pattern and the options of a network rule, cut where the filter engine cuts them: at the last `$` that no backslash escapes, unless
 * a `/` follows it. Guessing from the look of what follows would let the engine read as options (`3p`, `1p`, a `domain=` with an odd
 * character) what this file took for the end of the pattern, and its checks would then be made on a rule the engine does not see.
 */
function networkParts(rule: string): { pattern: string; options: string[] } {
  let at = rule.lastIndexOf('$')
  while (at > 0 && rule[at - 1] === '\\') at = rule.lastIndexOf('$', at - 1)
  if (at < 0 || rule[at + 1] === '/') return { pattern: rule, options: [] }
  const tail = rule.slice(at + 1)
  return { pattern: rule.slice(0, at), options: tail === '' ? [] : tail.split(',') }
}

type Left = { kind: 'ignore'; reason: string } | { kind: 'invalid'; reason: string }
type Judgement = { kind: 'keep' } | Left
const keep: Judgement = { kind: 'keep' }
const ignore = (reason: string): Left => ({ kind: 'ignore', reason })
const invalid = (reason: string): Left => ({ kind: 'invalid', reason })

function judgeScriptlet(parts: { domains: string; exception: boolean; selector: string }): Judgement {
  const { domains, exception, selector } = parts
  if (!/^[~a-z0-9.*,_-]+$/i.test(domains)) return invalid(t('custom-filter-lists.un-scriptlet-doit-nommer-au-moins-un-site'))
  // `#@#+js()` cancels the scriptlets of a site: nothing to run, nothing to check.
  if (exception && /^\+js\(\s*\)$/.test(selector)) return keep
  const verdict = judgeScriptletSelector(selector)
  return verdict.ok ? keep : ignore(t('custom-filter-lists.scriptlet-refuse-reason', { reason: t(verdict.reason.key, verdict.reason.vars) }))
}

function judgeCosmetic(parts: { domains: string; exception: boolean; selector: string }): Judgement {
  const { domains, selector } = parts
  if (selector.startsWith('+js(')) return judgeScriptlet(parts)
  if (selector.startsWith('^')) return ignore(t('custom-filter-lists.filtrage-du-code-html-non-pris-en-charge'))
  if (EXTENDED_SELECTOR.test(selector)) return ignore(t('custom-filter-lists.selecteur-etendu-ou-modifiant-la-page-non-pris'))
  if (selector === '' || selector.length > 1000) return invalid(t('custom-filter-lists.selecteur-vide-ou-trop-long'))
  // A brace would close the rule the selector is written into; a comment would swallow the rest of the style sheet.
  if (/[{}]|\/\*|\*\/|\\0|[;\u0000]/.test(selector)) return invalid(t('custom-filter-lists.selecteur-contenant-des-caracteres-interdits'))
  if (!/^[~a-z0-9.*,_-]*$/i.test(domains)) return invalid(t('custom-filter-lists.domaines-non-reconnus'))
  return keep
}

/** `$csp` and `$removeparam`, the options that change a document or an address: kept in the shapes the blocker applies, left out with the reason otherwise. */
function judgeExtendedOptions(options: readonly string[], exception: boolean): Left | null {
  for (const option of options) {
    const at = option.indexOf('=')
    const name = (at < 0 ? option : option.slice(0, at)).replace(/^~/, '').toLowerCase()
    const value = at < 0 ? '' : option.slice(at + 1)
    if (name === 'csp') {
      // `@@...$csp` with no value lifts the policies of the site.
      if (value === '' && exception) continue
      if (cleanCspPolicy(value) === null) return ignore(t('custom-filter-lists.politique-de-securite-csp-refusee'))
    } else if (name === 'removeparam') {
      if (value === '' && exception) continue
      if (value === '') return ignore(t('custom-filter-lists.retirer-tous-les-parametres-refuse'))
      if (!isRemoveParamName(value)) return ignore(t('custom-filter-lists.parametre-a-retirer-un-nom-simple-seulement'))
    }
  }
  return null
}

function judgeNetwork(rule: string): Judgement {
  if (HOSTS_LINE.test(rule)) return invalid(t('custom-filter-lists.format-hosts-ecrivez-nom-de-domaine'))
  const body = rule.startsWith('@@') ? rule.slice(2) : rule
  const { pattern, options } = networkParts(body)
  if (/\s/.test(pattern)) return invalid(t('custom-filter-lists.espace-dans-le-motif'))
  if (pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/')) return ignore(t('custom-filter-lists.expression-reguliere-refusee-peut-figer-le-navigateur'))
  // Read off the text after the last "$" too: an expression such as `removeparam=/^utm_/` has characters that make the tail look like part of the pattern.
  if (options.some((option) => option.includes('=/')) || body.slice(body.lastIndexOf('$') + 1).includes('=/')) return ignore(t('custom-filter-lists.expression-reguliere-dans-une-option-refusee'))
  const unsupported = options.map((o) => o.replace(/^~/, '').split('=')[0]!.toLowerCase()).find((name) => UNSUPPORTED_MODIFIERS.has(name))
  if (unsupported !== undefined) return ignore(t('custom-filter-lists.option-unsupported-non-prise-en-charge', { unsupported }))
  const extended = judgeExtendedOptions(options, rule.startsWith('@@'))
  if (extended !== null) return extended
  if ((pattern.match(/\*/g) ?? []).length > CUSTOM_WILDCARDS_MAX) return ignore(t('custom-filter-lists.plus-de-custom-wildcards-max-jokers-refuse-cela', { CUSTOM_WILDCARDS_MAX }))
  if (!/[a-z0-9]/i.test(pattern)) return invalid(t('custom-filter-lists.motif-trop-general-aucune-lettre-ni-chiffre'))
  return keep
}

/**
 * Reads the text of a list the user gave and keeps what can be applied safely. `parses` is the engine's own parser: it says whether the
 * engine understands a line that passed our checks, so a rule the engine would drop silently is told to the user instead.
 * Never throws; a text that is not a list at all (binary, a web page, empty, too large, no rule left) is refused with a sentence.
 */
export function reviewCustomList(input: string, parses: (line: string) => boolean, maxChars = CUSTOM_PASTE_MAX_CHARS): CustomListVerdict {
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, reason: t('custom-filter-lists.le-texte-est-vide') }
  if (input.length > maxChars) return { ok: false, reason: t('custom-filter-lists.la-liste-est-trop-volumineuse') }
  if (input.includes('\u0000')) return { ok: false, reason: t('custom-filter-lists.le-contenu-est-binaire') }
  const body = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  if (/^\s*<(?:!doctype|html|head|body|\?xml)/i.test(body)) return { ok: false, reason: t('custom-filter-lists.ce-texte-est-une-page-web-pas-une-liste-de') }

  const kept: string[] = []
  const samples: ReviewSample[] = []
  let ignored = 0
  let invalidCount = 0
  let title: string | undefined
  let tooMany = false
  const lines = body.split(/\r\n|\n|\r/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim()
    if (line === '') continue
    const note = (judgement: Left) => {
      if (judgement.kind === 'ignore') ignored++
      else invalidCount++
      if (samples.length < SAMPLES_MAX) samples.push({ line: index + 1, text: line.slice(0, SAMPLE_CHARS), reason: judgement.reason })
    }
    if (line.startsWith('!')) {
      // The directives of uBlock Origin are read by it, not by this engine: the rules around them would be taken out of their condition.
      if (/^!#/.test(line)) note(ignore(t('custom-filter-lists.directive-de-liste-non-prise-en-charge')))
      else {
        const found = /^!\s*Title:\s*(.+)$/i.exec(line)
        if (found && title === undefined) title = text(found[1], CUSTOM_TITLE_MAX) ?? undefined
      }
      continue
    }
    // The header of a list, and the comments of a hosts file.
    if (line.startsWith('[') || line.startsWith('# ') || line === '#') continue
    if (line.length > CUSTOM_RULE_MAX_CHARS) {
      note(invalid(t('custom-filter-lists.regle-trop-longue')))
      continue
    }
    const cosmetic = cosmeticParts(line)
    const judgement = cosmetic ? judgeCosmetic(cosmetic) : /#[?$%]|#@[?$%]|\$\$/.test(line) ? ignore(t('custom-filter-lists.syntaxe-d-adguard-non-prise-en-charge')) : judgeNetwork(line)
    if (judgement.kind !== 'keep') {
      note(judgement)
      continue
    }
    if (!parses(line)) {
      note(invalid(t('custom-filter-lists.regle-non-reconnue-par-le-moteur-de-filtres')))
      continue
    }
    if (kept.length >= CUSTOM_RULES_MAX) {
      tooMany = true
      break
    }
    kept.push(line)
  }
  if (tooMany) return { ok: false, reason: t('custom-filter-lists.la-liste-depasse-max-regles', { max: countText(CUSTOM_RULES_MAX) }) }
  if (kept.length === 0) {
    const detail = invalidCount + ignored > 0 ? ` ${t('custom-filter-lists.regles-invalides-et-ignorees', { invalid: tp('custom-filter-lists.regles-invalides', invalidCount), ignored: tp('custom-filter-lists.regles-ignorees', ignored) })}` : ''
    return { ok: false, reason: t('custom-filter-lists.aucune-regle-utilisable-detail', { detail }) }
  }
  return { ok: true, review: { text: `${kept.join('\n')}\n`, rules: kept.length, ...(title ? { title } : {}), ignored, invalid: invalidCount, samples } }
}

/** The summary of an index that was written by an older build or edited by hand: counts that are whole numbers, a few short samples. */
export function cleanReviewSummary(raw: unknown): ReviewSummary | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0)
  const samples: ReviewSample[] = []
  for (const entry of Array.isArray(r['samples']) ? r['samples'] : []) {
    if (samples.length >= SAMPLES_MAX || typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const line = e['line']
    const sample = text(e['text'], SAMPLE_CHARS)
    const reason = text(e['reason'], 200)
    if (typeof line === 'number' && Number.isInteger(line) && line > 0 && sample !== null && reason) samples.push({ line, text: sample, reason })
  }
  return { ignored: count(r['ignored']), invalid: count(r['invalid']), samples }
}

/** What the settings show beside a list: "12 règles · 2 ignorées · 1 invalide", each count by the plural rules of the language. */
export function describeReview(rules: number | null, review: ReviewSummary | undefined): string {
  const parts: string[] = []
  if (rules !== null) parts.push(counted('blocking-settings.rules-count', rules))
  if (review && review.ignored > 0) parts.push(tp('blocking-settings.rules-ignored', review.ignored))
  if (review && review.invalid > 0) parts.push(tp('blocking-settings.rules-invalid', review.invalid))
  return parts.join(' · ')
}

/** The name given to a list that came without one: the file's name without its extension, else the date. */
export function listTitleFor(wanted: unknown, listed: unknown, fallback: string): string {
  return text(wanted, CUSTOM_TITLE_MAX) || text(listed, CUSTOM_TITLE_MAX) || text(fallback, CUSTOM_TITLE_MAX) || t('custom-filter-lists.liste-personnalisee')
}
