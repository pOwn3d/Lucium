// The user-script manager: scripts in the Tampermonkey format (`.user.js`, a `// ==UserScript==` header) that the user imports,
// reads, turns on, and that then run in the pages their `@match` names. Pure rules; src/main/userscripts.ts keeps them in a file and
// src/main/shell/browser.ts runs them where Tweaks run their JavaScript (at dom-ready).
//
// Not a second Tweak system and not a Tampermonkey clone: a script matches by patterns (several sites), arrives switched OFF and is
// switched on by the user after reading it, and gets nothing a page does not have: `@grant none` is the only grant, there is no GM_*,
// no cross-origin request, no storage of its own, and no `@require` (that would run code nobody reviewed). The sign-in, payment and
// password pages that their address gives away are not touched (a list of hosts and of words, not a proof: a page of that kind under an
// address that says nothing is run like any other), and a private window runs nothing unless the user allowed that script there.

import { hiddenCharacterLine, unreadableCode, type UnreadableCode } from './boost-css'
import { globMatch, isMatchPattern, matchPattern } from './extension-access'
import { t, type MessageKey } from './i18n'
import { isRecord } from './record'

/** The source of a script, in bytes of UTF-8: a script that big is a library, not a script the user can read before turning it on. */
export const USER_SCRIPT_MAX_BYTES = 200_000
export const USER_SCRIPTS_MAX = 100
export const USER_SCRIPT_PATTERNS_MAX = 64
const HEADER_MAX = 20_000
const LINE_MAX = 2000
const PATTERN_MAX = 1024
const NAME_MAX = 100
const TEXT_MAX = 300

export type UserScriptRunAt = 'document-start' | 'document-end' | 'document-idle'

/** What a header says. */
export interface UserScriptMeta {
  name: string
  namespace?: string
  version?: string
  description?: string
  matches: string[]
  excludes: string[]
  runAt: UserScriptRunAt
}

/** A script as it is kept: the text, which is what is read and what runs, and the user's two choices. Everything else is read again from the text. */
export interface StoredUserScript {
  id: string
  source: string
  enabled: boolean
  allowPrivate: boolean
  importedAt: number
}

export interface UserScript extends UserScriptMeta, StoredUserScript {}

/** A script as the list in Settings shows it (without its code, which is asked for on its own). */
export interface UserScriptView extends UserScriptMeta {
  id: string
  enabled: boolean
  allowPrivate: boolean
  importedAt: number
  bytes: number
  /** What the header asked for that is not done here, and what the user should know before turning the script on. */
  warnings: string[]
  /** The last time the script failed in a page, when it did. */
  lastError?: { message: string; at: number }
}

export type ParsedUserScript = { ok: true; meta: UserScriptMeta; warnings: string[] } | { ok: false; error: string }

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

// ---------- the header ----------

// A byte order mark may come first: files saved by some editors start with one.
const HEADER_START = /^\uFEFF?[ \t]*\/\/[ \t]*==UserScript==[ \t]*$/m
const HEADER_END = /^[ \t]*\/\/[ \t]*==\/UserScript==[ \t]*$/m
const DIRECTIVE = /^[ \t]*\/\/[ \t]*@([A-Za-z][\w-]*)(?::[A-Za-z-]+)?(?:[ \t]+(.*?))?[ \t]*$/

/** Keys that need nothing here (credits, links, icons, other managers' hints): silently fine. */
const HARMLESS = new Set(['author', 'homepage', 'homepageurl', 'website', 'source', 'icon', 'iconurl', 'defaulticon', 'icon64', 'icon64url', 'supporturl', 'noframes', 'connect', 'antifeature', 'copyright', 'license', 'contributionurl', 'contributionamount', 'unwrap', 'sandbox', 'compatible', 'incompatible', 'tag', 'nocompat'])
/** Keys Lucium reads but does not act on: the user is told (the sentence is looked up when the header is read, in the language of the interface). */
const NOT_DONE: Readonly<Record<string, MessageKey>> = {
  updateurl: 'userscript.mise-a-jour-automatique-non-prise-en-charge',
  downloadurl: 'userscript.mise-a-jour-automatique-non-prise-en-charge',
  resource: 'userscript.les-ressources-resource-ne-sont-pas-chargees'
}

/** The sentence of a refusal by `unreadableCode`, for a user script and for the script of a Tweak. */
export const unreadableCodeMessage = (found: UnreadableCode): string =>
  t(found.kind === 'reorders' ? 'userscript.la-ligne-line-change-le-sens-de-lecture' : 'userscript.la-ligne-line-contient-une-fin-de-ligne-invisible', { line: found.line })

const clean = (value: string | undefined, max: number): string | undefined => {
  const text = (value ?? '').replace(/\p{Cc}/gu, ' ').trim().slice(0, max)
  return text === '' ? undefined : text
}

/**
 * Reads the header of a user script and checks everything Lucium needs to run it safely. What it cannot run, it refuses with the
 * reason, in the language of the interface, for the person who is about to import it; what it can run but not faithfully, it runs and says
 * so (`warnings`).
 *
 * Reading the code is the only guard of this feature, so a text that does not show what it runs is refused (`unreadableCode` of
 * boost-css.ts, the rule a Tweak follows too): a character that reorders a line, or a line end that is not drawn, at the import and for a
 * script already kept. Any other character that cannot be seen is found in honest scripts: the script is taken, and a warning names the
 * first line to read again, before the import and in the list. A byte order mark at the very start of a file is what an editor writes,
 * and hides nothing.
 */
export function parseUserScript(source: unknown): ParsedUserScript {
  if (typeof source !== 'string') return { ok: false, error: t('userscript.ce-n-est-pas-un-texte') }
  if (source.includes('\0')) return { ok: false, error: t('userscript.le-fichier-contient-des-octets-nuls') }
  if (utf8Bytes(source) > USER_SCRIPT_MAX_BYTES) return { ok: false, error: t('userscript.script-trop-gros-plus-de-max-ko', { max: Math.round(USER_SCRIPT_MAX_BYTES / 1000) }) }
  const unreadable = unreadableCode(source)
  if (unreadable) return { ok: false, error: unreadableCodeMessage(unreadable) }
  const hiddenLine = hiddenCharacterLine(source.replace(/^\uFEFF/, ' '))
  const start = HEADER_START.exec(source)
  if (!start) return { ok: false, error: t('userscript.en-tete-userscript-introuvable') }
  const after = source.slice(start.index + start[0].length)
  const end = HEADER_END.exec(after)
  if (!end) return { ok: false, error: t('userscript.en-tete-non-ferme-userscript-manque') }
  if (end.index > HEADER_MAX) return { ok: false, error: t('userscript.en-tete-trop-long') }

  const warnings: string[] = hiddenLine > 0 ? [t('userscript.caracteres-invisibles-a-la-ligne-line', { line: hiddenLine })] : []
  const matches: string[] = []
  const excludes: string[] = []
  let name: string | undefined
  let namespace: string | undefined
  let version: string | undefined
  let description: string | undefined
  let runAt: UserScriptRunAt = 'document-idle'
  let sawGrant = false

  for (const line of after.slice(0, end.index).split(/\r?\n/)) {
    // A line this long is not a header line, and the pattern below would take long over it.
    if (line.length > LINE_MAX) return { ok: false, error: t('userscript.ligne-d-en-tete-trop-longue') }
    const directive = DIRECTIVE.exec(line)
    if (!directive) continue
    const key = (directive[1] ?? '').toLowerCase()
    const value = directive[2]
    // `@name:fr` is a translation of the name: the plain one is used.
    const translated = /^[ \t]*\/\/[ \t]*@[A-Za-z][\w-]*:[A-Za-z-]+/.test(line)
    switch (key) {
      case 'name':
        if (!translated) name = clean(value, NAME_MAX)
        break
      case 'namespace':
        namespace = clean(value, TEXT_MAX)
        break
      case 'version':
        version = clean(value, 40)
        break
      case 'description':
        if (!translated) description = clean(value, 500)
        break
      case 'match':
      case 'include': {
        const pattern = clean(value, PATTERN_MAX)
        if (!pattern) return { ok: false, error: t('userscript.key-sans-motif', { key }) }
        if (!isMatchPattern(pattern)) {
          // `@include` takes globs and regular expressions, which are not match patterns: they are not guessed at.
          if (key === 'include') {
            warnings.push(t('userscript.include-pattern-n-est-pas-un-motif-match-ignore', { pattern: pattern.slice(0, 80) }))
            break
          }
          return { ok: false, error: t('userscript.motif-match-invalide-pattern', { pattern: pattern.slice(0, 80) }) }
        }
        if (!/^(\*|https?):\/\//.test(pattern) && pattern !== '<all_urls>') return { ok: false, error: t('userscript.seules-les-pages-web-http-https-sont-visees-pattern', { pattern: pattern.slice(0, 80) }) }
        if (!matches.includes(pattern)) matches.push(pattern)
        break
      }
      case 'exclude':
      case 'exclude-match': {
        const pattern = clean(value, PATTERN_MAX)
        if (pattern && !excludes.includes(pattern)) excludes.push(pattern)
        break
      }
      case 'run-at': {
        const when = (value ?? '').trim().toLowerCase()
        if (when === 'document-start' || when === 'document-end' || when === 'document-idle') runAt = when
        else if (when === 'document-body') runAt = 'document-end'
        else return { ok: false, error: t('userscript.run-at-when-n-est-pas-pris-en-charge', { when: when.slice(0, 40) }) }
        break
      }
      case 'grant': {
        sawGrant = true
        const grant = (value ?? '').trim()
        if (grant !== 'none') return { ok: false, error: t('userscript.ce-script-demande-grant-grant', { grant: grant.slice(0, 60) || t('userscript.vide') }) }
        break
      }
      case 'require':
        return { ok: false, error: t('userscript.ce-script-charge-du-code-exterieur-require') }
      default:
        if (Object.hasOwn(NOT_DONE, key)) {
          const warning = t(NOT_DONE[key]!)
          if (!warnings.includes(warning)) warnings.push(warning)
        } else if (!HARMLESS.has(key)) warnings.push(t('userscript.key-n-est-pas-pris-en-charge-ignore', { key }))
    }
  }

  if (!name) return { ok: false, error: t('userscript.le-script-n-a-pas-de-nom-name') }
  if (matches.length === 0) return { ok: false, error: t('userscript.aucun-match-le-script-ne-s-appliquerait-a-aucune-page') }
  if (matches.length > USER_SCRIPT_PATTERNS_MAX || excludes.length > USER_SCRIPT_PATTERNS_MAX) return { ok: false, error: t('userscript.trop-de-motifs-user-script-patterns-max-au-plus', { USER_SCRIPT_PATTERNS_MAX }) }
  if (!sawGrant) warnings.push(t('userscript.aucun-grant-traite-comme-grant-none'))
  if (runAt === 'document-start') warnings.push(t('userscript.run-at-document-start-le-script-s-execute-des-que'))
  if (matches.some((pattern) => pattern === '<all_urls>' || /^\*:\/\/\*\/\*$/.test(pattern) || /^https?:\/\/\*\/\*$/.test(pattern))) warnings.push(t('userscript.ce-script-s-applique-a-tous-les-sites-sauf-les'))

  return { ok: true, meta: { name, ...(namespace ? { namespace } : {}), ...(version ? { version } : {}), ...(description ? { description } : {}), matches, excludes, runAt }, warnings }
}

/** The identity of a script, for the same one imported again: its namespace and its name. */
export const sameScript = (a: Pick<UserScriptMeta, 'name' | 'namespace'>, b: Pick<UserScriptMeta, 'name' | 'namespace'>): boolean => a.name === b.name && (a.namespace ?? '') === (b.namespace ?? '')

// ---------- where a script may run ----------

/** Sites a script never runs on, whatever it asks: a host and its subdomains. Sign-in, payment, passwords, and the browsers' extension stores. */
export const SENSITIVE_HOSTS: readonly string[] = [
  'accounts.google.com',
  'myaccount.google.com',
  'chromewebstore.google.com',
  'appleid.apple.com',
  'idmsa.apple.com',
  'login.live.com',
  'login.microsoftonline.com',
  'account.microsoft.com',
  'paypal.com',
  'checkout.stripe.com',
  'addons.mozilla.org',
  'accounts.firefox.com',
  '1password.com',
  'bitwarden.com',
  'lastpass.com',
  'dashlane.com',
  'keepersecurity.com',
  'nordpass.com',
  'proton.me'
]

/** First labels that name a sign-in, payment or bank page whatever the site (login.example.com, secure.example.com…). */
const SENSITIVE_LABELS = new Set(['login', 'signin', 'sign-in', 'sso', 'auth', 'accounts', 'account', 'secure', 'pay', 'payment', 'payments', 'checkout', 'bank', 'banking', 'ebanking', 'wallet', 'vault', 'passwords', 'password', 'mfa', 'otp'])

/** Path segments that name a sign-in, sign-up, password or payment page on any site (`/login`, `/ap/signin`, `/users/sign_in`, `/o/oauth2/auth`, `/billing`), without a file extension. */
const SENSITIVE_SEGMENTS = new Set([
  'login', 'log-in', 'log_in', 'signin', 'sign-in', 'sign_in', 'signup', 'sign-up', 'sign_up', 'auth', 'oauth', 'oauth2', 'connexion', 'password', 'passwords',
  'checkout', 'pay', 'payment', 'payments', 'paiement', 'billing'
])

/**
 * A segment as the site reads it: its letters written as `%6c` are letters, and what follows a `;` is a parameter of the segment
 * (`/login;jsessionid=…`), not part of its name.
 */
function segmentName(segment: string): string {
  const decoded = segment.replace(/%([0-9a-f]{2})/gi, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  return (decoded.split(';')[0] ?? '').toLowerCase().replace(/\.(?:php|html?|aspx?|jsp)$/, '')
}

/** Whether a segment of the path (or of a `#/route`) names such a page: the whole segment, so that `/authors` or `/loginfo` stay free. */
function sensitivePath(path: string): boolean {
  return path.split('/').some((segment) => SENSITIVE_SEGMENTS.has(segmentName(segment)))
}

/** Whether a page is one a script is never run on. Anything that is not an http(s) address is one too. */
export function isSensitiveUrl(url: string): boolean {
  if (!URL.canParse(url)) return true
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (host === '') return true
  if (SENSITIVE_HOSTS.some((sensitive) => host === sensitive || host.endsWith(`.${sensitive}`))) return true
  if (host.endsWith('.bank')) return true
  // `www.login.example.com` is `login.example.com` with the label every site may put in front.
  const labels = host.replace(/^www\./, '').split('.')
  // Two labels count as well (login.gov): a host that is only a name and a suffix can be a sign-in site as much as a subdomain can.
  if (labels.length >= 2 && SENSITIVE_LABELS.has(labels[0]!)) return true
  // The page asks for a password whatever the site: the path says so (github.com/login), a single-page app's route too (example.com/#/login).
  return sensitivePath(parsed.pathname) || (/^#!?\//.test(parsed.hash) && sensitivePath(parsed.hash.replace(/^#!?/, '').split('?')[0]!))
}

/** A pattern can be a match pattern or, for `@exclude`, a glob over the whole address. */
const patternHits = (pattern: string, url: string): boolean => (isMatchPattern(pattern) ? matchPattern(pattern, url) : globMatch(pattern, url))

/** Whether the script runs on this page: switched on, allowed in this kind of window, a page it matches and none it excludes, not a sensitive one. */
export function userScriptMatches(script: Pick<UserScript, 'enabled' | 'allowPrivate' | 'matches' | 'excludes'>, url: string, inPrivateWindow: boolean): boolean {
  if (!script.enabled) return false
  if (inPrivateWindow && !script.allowPrivate) return false
  if (isSensitiveUrl(url)) return false
  if (!script.matches.some((pattern) => matchPattern(pattern, url))) return false
  return !script.excludes.some((pattern) => patternHits(pattern, url))
}

// ---------- running ----------

/**
 * The text handed to the page: the script in a function of its own (its variables stay out of the page's), run in the page's own world as
 * Tampermonkey's "@grant none" does, and never able to take the page's loading down with it: a failure is written to the page's console
 * with the script's name. A syntax error is the other kind of failure: the whole text is refused by the page, and the caller logs that.
 * `document-start` is run like `document-end` (see the warning in the header's reading).
 */
export function wrapUserScript(script: Pick<UserScript, 'id' | 'name' | 'source' | 'runAt'>): string {
  const label = JSON.stringify(script.name)
  const timing = script.runAt === 'document-idle' ? `if (document.readyState === 'complete') setTimeout(run, 0); else addEventListener('load', () => setTimeout(run, 0), { once: true })` : 'run()'
  return `(() => {
  const run = () => {
    try {
      (function () {
${script.source}
      }).call(window)
    } catch (error) {
      console.error('[user script]', ${label}, 'failed:', error)
    }
  }
  ${timing}
})()
//# sourceURL=userscript-${script.id.replace(/[^\w-]/g, '')}.user.js`
}

// ---------- what is kept ----------

const ID = /^us-[a-z0-9]{6,40}$/

export const isUserScriptId = (value: unknown): value is string => typeof value === 'string' && ID.test(value)

/** A new id: a random one, so that nothing is guessed from the order scripts were added. */
export function newUserScriptId(random: () => number = Math.random): string {
  let id = 'us-'
  for (let i = 0; i < 12; i++) id += Math.floor(random() * 36).toString(36)
  return id
}

/**
 * The scripts of a file. A file is edited by hand, damaged or written by another version: every entry is checked again as if it had just
 * been imported (its text must still be a script Lucium accepts), and an entry that is not is left out. `dropped` counts them so the
 * caller can say so. Two entries of one id: the first wins. At most USER_SCRIPTS_MAX.
 */
export function cleanUserScripts(raw: unknown): { scripts: UserScript[]; dropped: number } {
  const entries = isRecord(raw) && Array.isArray(raw['scripts']) ? raw['scripts'] : []
  const scripts: UserScript[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of entries) {
    const parsed = isRecord(entry) ? parseUserScript(entry['source']) : null
    if (!isRecord(entry) || !parsed?.ok || !isUserScriptId(entry['id']) || seen.has(entry['id']) || scripts.length >= USER_SCRIPTS_MAX) {
      dropped++
      continue
    }
    seen.add(entry['id'])
    scripts.push({
      ...parsed.meta,
      id: entry['id'],
      source: entry['source'] as string,
      enabled: entry['enabled'] === true,
      allowPrivate: entry['allowPrivate'] === true,
      importedAt: typeof entry['importedAt'] === 'number' && Number.isFinite(entry['importedAt']) ? entry['importedAt'] : 0
    })
  }
  return { scripts, dropped }
}

/** What goes into the file. */
export const storedForm = (script: UserScript): StoredUserScript => ({ id: script.id, source: script.source, enabled: script.enabled, allowPrivate: script.allowPrivate, importedAt: script.importedAt })

// ---------- the requests of the settings panel ----------

export type UserScriptRequest =
  /** The scripts, without their code. */
  | { kind: 'list' }
  /** The code of one script, to read it. */
  | { kind: 'source'; id: string }
  /** Asks for a file (the main process opens the dialog); answers its text, to be read before it is added. */
  | { kind: 'pick-file' }
  /** Adds a script, switched off. */
  | { kind: 'add'; text: string }
  | { kind: 'set-enabled'; id: string; enabled: boolean }
  | { kind: 'set-private'; id: string; allow: boolean }
  | { kind: 'remove'; id: string }

export interface UserScriptReply {
  ok: boolean
  /** A sentence for the person: what happened, or why not. */
  message?: string
  scripts: UserScriptView[]
  /** For `source` and `pick-file`: the text. */
  text?: string
  /** For `pick-file`: the name of the file. */
  fileName?: string
  /** For `add`: the id of the script that was added (or replaced). */
  id?: string
}

/** Revalidates a request that crossed from the interface. Null on any doubt. */
export function parseUserScriptRequest(raw: unknown): UserScriptRequest | null {
  if (!isRecord(raw) || typeof raw['kind'] !== 'string') return null
  switch (raw['kind']) {
    case 'list':
    case 'pick-file':
      return { kind: raw['kind'] }
    case 'source':
    case 'remove':
      return isUserScriptId(raw['id']) ? { kind: raw['kind'], id: raw['id'] } : null
    case 'add':
      // The text is bounded again by `parseUserScript`; this keeps an absurd message from being copied around first.
      return typeof raw['text'] === 'string' && raw['text'].length <= USER_SCRIPT_MAX_BYTES + 1 ? { kind: 'add', text: raw['text'] } : null
    case 'set-enabled':
      return isUserScriptId(raw['id']) && typeof raw['enabled'] === 'boolean' ? { kind: 'set-enabled', id: raw['id'], enabled: raw['enabled'] } : null
    case 'set-private':
      return isUserScriptId(raw['id']) && typeof raw['allow'] === 'boolean' ? { kind: 'set-private', id: raw['id'], allow: raw['allow'] } : null
    default:
      return null
  }
}
