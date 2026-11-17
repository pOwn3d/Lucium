// Sharing Tweaks and themes without an account or a server: a file the person sends (or a link they paste), read here.
//
//   Tweak file   {"format": 1, "kind": "boost", "boost": {"name", "host", "css", "js", "zoom", "zap", "tint", "fontFamily", "textCase", "invert"}}
//   Tweak link   lucboost1_<the same JSON, minified, in base64url>   (a text to copy and paste, never an address to open)
//   Tweak file   {"format": 1, "kind": "boosts", "boosts": [{…the same fields…}, …]}   (all the Tweaks of a person in one file, "Tout exporter")
//   Theme file   {"format": 1, "kind": "theme", "name": "…", "code": "luc1_…"}   (the code of shared/theme-code.ts)
//
// Everything that comes from a file or a link is hostile: a Tweak with a script was the way into another browser's CVE-2024-45489. So the reader
//   - bounds the size before it looks at the content, and every field after it;
//   - accepts only the fields it knows, each of the kind and in the range it expects (what it does not know is not copied);
//   - refuses a stylesheet that loads anything or hides what it does (shared/boost-css.ts), and a script, a name or a selector that
//     hides characters;
//   - never copies an id, a state or a setting from the file: an imported Tweak gets a new id, is switched on, and its script, if
//     any, is stored switched off (`jsEnabled: false`) until the person reads it and turns it on.
// Pure rules, no Electron: the dialogs, the files and the clipboard are the shell's (main/shell/boost-share.ts).

import { BOOST_TEXT_CASES, ZAP_SELECTOR, fontById } from './boost'
import { controlCharacterLine, hasHiddenCharacter, hiddenCharacterLine, scanBoostCss, unreadableCode, type CssRefusal } from './boost-css'
import { BOOST_ZAP_MAX, BOOST_ZOOM_MAX, BOOST_ZOOM_MIN, NEUTRAL_TINT, type Boost, type BoostTextCase, type BoostTint } from './model'
import { printable } from './state-clean'
import { cleanTheme, type SpaceTheme } from './theme'
import { encodeThemeCode, parseThemeCode } from './theme-code'
import { t, tp, type MessageKey } from './i18n'
import { isRecord } from './record'
import { settingsPath } from './settings-path'

export const SHARE_FORMAT = 1
export const BOOST_LINK_PREFIX = 'lucboost1_'

/** The most a file or a decoded link may hold, in bytes. Honest Tweaks are a few kilobytes; this leaves room for a big site stylesheet. */
export const SHARE_FILE_MAX_BYTES = 512 * 1024
export const BOOST_CSS_MAX = 100_000
export const BOOST_JS_MAX = 100_000
export const BOOST_NAME_MAX = 60
export const BOOST_ZAP_SELECTOR_MAX = 300
/** The longest text taken for a link: the base64url form of the largest file, and the prefix. */
export const BOOST_LINK_MAX = Math.ceil((SHARE_FILE_MAX_BYTES * 4) / 3) + BOOST_LINK_PREFIX.length + 8
/** A file of all the Tweaks: at most this many Tweaks, and at most this many bytes (each Tweak is still held to the limits above). */
export const BOOST_BUNDLE_MAX = 200
export const BOOST_BUNDLE_MAX_BYTES = 8 * 1024 * 1024
/** A theme file holds a name and a code of at most 240 characters. */
export const THEME_FILE_MAX_BYTES = 4096
const THEME_NAME_MAX = 60

/** What a Tweak carries to another person: no id, no state, no setting. An absent field is the neutral value. */
export interface SharedBoost {
  name: string
  host: string
  css: string
  js: string
  zoom: number
  zap: string[]
  tint: BoostTint
  fontFamily?: string
  textCase?: BoostTextCase
  invert?: true
}

export type ShareRefusalReason =
  | 'empty'
  | 'too-large'
  /** More Tweaks than a file of all the Tweaks may hold. */
  | 'too-many'
  | 'not-json'
  /** JSON, but not what Lucium writes. */
  | 'not-a-share'
  | 'unknown-format'
  /** A Tweak where a theme is wanted, or the other way round. */
  | 'wrong-kind'
  | 'invalid-field'
  | 'hidden-characters'
  | 'host-invalid'
  | 'host-too-wide'
  | 'css-too-large'
  | 'js-too-large'
  | 'css-forbidden'
  | 'link-not-a-link'
  | 'link-unknown-version'
  | 'link-malformed'

export interface ShareRefusal {
  ok: false
  reason: ShareRefusalReason
  /** The field the reason is about (`host`, `css`, `zap`…). */
  field?: string
  /** A precise word or value for the sentence (the offending selector's number, the format found…). */
  detail?: string
  /** For `css-forbidden`: which rule, and the line where it begins. */
  rule?: CssRefusal
  line?: number
  /** In a file of several Tweaks: the place (from 1) of the Tweak the refusal is about, and its name when it has one that can be shown. */
  entry?: number
  entryName?: string
  /** For `too-large`: the limit, in bytes, that was over (the one of a Tweak, of all the Tweaks, or of a theme). */
  max?: number
}

const refuse = (reason: ShareRefusalReason, extra: Partial<Omit<ShareRefusal, 'ok' | 'reason'>> = {}): ShareRefusal => ({ ok: false, reason, ...extra })

// ---------- the site a Tweak targets ----------

const IPV4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/

/**
 * The host a shared Tweak targets, spelled as Tweaks spell it (lower case, no "www."). A Tweak matches its host and every subdomain,
 * so what is accepted is a real site: a name made of letters, digits and hyphens with at least one dot, `localhost`, or a plain
 * IPv4 address. Not a bare word (`com`, `intranet`, the 32 letters of an extension), not a port or a path, not an IP written in a
 * shorthand a browser would read differently. (A name that is only a public suffix, `co.uk`, is the shell's to refuse: it needs the list.)
 */
export function parseShareHost(text: unknown): { ok: true; host: string } | ShareRefusal {
  if (typeof text !== 'string') return refuse('host-invalid', { field: 'host', detail: 'missing' })
  const host = text.trim().toLowerCase().replace(/^www\./, '')
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) return refuse('host-invalid', { field: 'host', detail: host.slice(0, 80) })
  const labels = host.split('.')
  if (labels.some((label) => label === '' || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return refuse('host-invalid', { field: 'host', detail: host })
  if (host === 'localhost') return { ok: true, host }
  if (/^\d+$/.test(labels.at(-1)!)) return IPV4.test(host) && host.split('.').every((part) => Number(part) <= 255) ? { ok: true, host } : refuse('host-invalid', { field: 'host', detail: host })
  if (labels.length < 2) return refuse('host-invalid', { field: 'host', detail: host })
  return { ok: true, host }
}

// ---------- the fields of a Tweak ----------

const TINT_RANGE: Record<keyof BoostTint, [min: number, max: number]> = { hue: [-180, 180], saturation: [0, 2], brightness: [0.5, 1.5], contrast: [0.5, 1.5] }

function readTint(raw: unknown): BoostTint | ShareRefusal {
  if (raw === undefined) return NEUTRAL_TINT
  if (!isRecord(raw)) return refuse('invalid-field', { field: 'tint', detail: 'record' })
  const tint: BoostTint = { ...NEUTRAL_TINT }
  for (const key of Object.keys(TINT_RANGE) as Array<keyof BoostTint>) {
    const value = raw[key]
    if (value === undefined) continue
    const [min, max] = TINT_RANGE[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return refuse('invalid-field', { field: `tint.${key}`, detail: `${min}..${max}` })
    tint[key] = value
  }
  return tint
}

/**
 * Checks the Tweak of a file, of a link, or of an `import` action field by field and rebuilds it from what was checked, so that nothing
 * but the known fields is ever carried over (`__proto__` and the like included). The result is the sender's Tweak as the receiver may keep it.
 */
export function checkSharedBoost(input: unknown): { ok: true; boost: SharedBoost } | ShareRefusal {
  if (!isRecord(input)) return refuse('not-a-share', { field: 'boost' })

  const host = parseShareHost(input['host'])
  if (!host.ok) return host

  const rawName = input['name']
  if (rawName !== undefined && typeof rawName !== 'string') return refuse('invalid-field', { field: 'name', detail: 'text' })
  if (typeof rawName === 'string' && hasHiddenCharacter(rawName)) return refuse('hidden-characters', { field: 'name' })
  if (typeof rawName === 'string' && rawName.length > BOOST_NAME_MAX) return refuse('invalid-field', { field: 'name', detail: `max ${BOOST_NAME_MAX}` })
  const name = (printable(rawName, BOOST_NAME_MAX) ?? '').trim() || host.host

  // `null` is not "absent": a field is missing, or it is of its kind.
  const css = input['css'] === undefined ? '' : input['css']
  if (typeof css !== 'string') return refuse('invalid-field', { field: 'css', detail: 'text' })
  if (css.length > BOOST_CSS_MAX) return refuse('css-too-large', { field: 'css', detail: String(css.length) })
  const scan = scanBoostCss(css)
  if (!scan.ok) return scan.rule === 'hidden-character' ? refuse('hidden-characters', { field: 'css', line: scan.line }) : refuse('css-forbidden', { field: 'css', rule: scan.rule, line: scan.line })

  const js = input['js'] === undefined ? '' : input['js']
  if (typeof js !== 'string') return refuse('invalid-field', { field: 'js', detail: 'text' })
  if (js.length > BOOST_JS_MAX) return refuse('js-too-large', { field: 'js', detail: String(js.length) })
  // The rule of every code a person reads before it runs (boost-css.ts): what reorders a line or ends one unseen is refused, and so is a control
  // character; another invisible character is taken, and the sheet shown before the installation names its line (`invisibleWarnings`).
  const unreadable = Math.min(unreadableCode(js)?.line ?? Infinity, controlCharacterLine(js) || Infinity)
  if (unreadable !== Infinity) return refuse('hidden-characters', { field: 'js', line: unreadable })

  const zoom = input['zoom'] === undefined ? 1 : input['zoom']
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < BOOST_ZOOM_MIN || zoom > BOOST_ZOOM_MAX) return refuse('invalid-field', { field: 'zoom', detail: `${BOOST_ZOOM_MIN}..${BOOST_ZOOM_MAX}` })

  const rawZap = input['zap'] === undefined ? [] : input['zap']
  if (!Array.isArray(rawZap) || rawZap.length > BOOST_ZAP_MAX) return refuse('invalid-field', { field: 'zap', detail: `max ${BOOST_ZAP_MAX}` })
  for (const [index, selector] of rawZap.entries()) {
    if (typeof selector !== 'string' || selector.length > BOOST_ZAP_SELECTOR_MAX || !ZAP_SELECTOR.test(selector)) return refuse('invalid-field', { field: 'zap', detail: String(index + 1) })
  }
  const zap = [...new Set(rawZap as string[])]

  const tint = readTint(input['tint'])
  if ('ok' in tint) return tint

  const fontFamily = input['fontFamily']
  if (fontFamily !== undefined && (typeof fontFamily !== 'string' || !fontById(fontFamily))) return refuse('invalid-field', { field: 'fontFamily', detail: 'unknown' })
  const textCase = input['textCase']
  if (textCase !== undefined && !BOOST_TEXT_CASES.includes(textCase as BoostTextCase)) return refuse('invalid-field', { field: 'textCase', detail: 'unknown' })
  const invert = input['invert']
  if (invert !== undefined && typeof invert !== 'boolean') return refuse('invalid-field', { field: 'invert', detail: 'flag' })

  return {
    ok: true,
    boost: {
      name,
      host: host.host,
      css,
      js,
      zoom,
      zap,
      tint,
      ...(typeof fontFamily === 'string' ? { fontFamily } : {}),
      ...(typeof textCase === 'string' ? { textCase: textCase as BoostTextCase } : {}),
      ...(invert === true ? { invert: true as const } : {})
    }
  }
}

// ---------- reading a file or a link ----------

const utf8Length = (text: string): number => new TextEncoder().encode(text).length

/** What a file holds once it is known to be a Tweak or a theme of this format. */
export type ShareParse =
  | { ok: true; kind: 'boost'; boost: SharedBoost }
  | { ok: true; kind: 'boosts'; boosts: SharedBoost[] }
  | { ok: true; kind: 'theme'; theme: SpaceTheme; name: string }
  | ShareRefusal

/** The name of an entry of a file of several Tweaks, when it is a short text that is safe to show. */
function entryNameOf(entry: unknown): { entryName?: string } {
  const name = isRecord(entry) && typeof entry['name'] === 'string' && !hasHiddenCharacter(entry['name']) ? (printable(entry['name'], 40) ?? '').trim() : ''
  return name === '' ? {} : { entryName: name }
}

/** Reads the text of a share file: JSON of the right format and kind, whatever its size, shape and content. */
export function parseShareText(input: unknown, maxBytes = SHARE_FILE_MAX_BYTES): ShareParse {
  if (typeof input !== 'string') return refuse('not-json')
  // The length in characters is a floor of the length in bytes: a text already too long is not encoded to be measured.
  if (input.length > maxBytes || utf8Length(input) > maxBytes) return refuse('too-large', { detail: String(input.length), max: maxBytes })
  // An editor may have saved the file with a byte-order mark.
  const text = input.replace(/^\uFEFF/, '')
  if (text.trim() === '') return refuse('empty')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return refuse('not-json')
  }
  if (!isRecord(value) || !Object.hasOwn(value, 'format') || !Object.hasOwn(value, 'kind')) return refuse('not-a-share')
  if (value['format'] !== SHARE_FORMAT) return refuse('unknown-format', { detail: typeof value['format'] === 'number' || typeof value['format'] === 'string' ? String(value['format']).slice(0, 20) : '?' })
  if (value['kind'] === 'boost') {
    // A caller that reads files of all the Tweaks allows a bigger file: one Tweak keeps the limit of one Tweak.
    if (maxBytes > SHARE_FILE_MAX_BYTES && utf8Length(input) > SHARE_FILE_MAX_BYTES) return refuse('too-large', { detail: String(input.length), max: SHARE_FILE_MAX_BYTES })
    const checked = checkSharedBoost(value['boost'])
    return checked.ok ? { ok: true, kind: 'boost', boost: checked.boost } : checked
  }
  if (value['kind'] === 'boosts') {
    const list = value['boosts']
    if (!Array.isArray(list)) return refuse('invalid-field', { field: 'boosts', detail: 'list' })
    if (list.length === 0) return refuse('empty')
    if (list.length > BOOST_BUNDLE_MAX) return refuse('too-many', { detail: String(list.length) })
    const boosts: SharedBoost[] = []
    // All or nothing: a file with one Tweak that is refused installs none, and the refusal says which one it is.
    for (const [index, entry] of list.entries()) {
      const checked = checkSharedBoost(entry)
      if (!checked.ok) return { ...checked, entry: index + 1, ...entryNameOf(entry) }
      boosts.push(checked.boost)
    }
    return { ok: true, kind: 'boosts', boosts }
  }
  if (value['kind'] === 'theme') {
    const code = value['code']
    if (typeof code !== 'string') return refuse('invalid-field', { field: 'code', detail: 'text' })
    const parsed = parseThemeCode(code)
    // A single colour is not a theme to share.
    if (!parsed.ok || parsed.kind !== 'theme') return refuse('invalid-field', { field: 'code', detail: 'theme-code' })
    const rawName = value['name']
    if (rawName !== undefined && typeof rawName !== 'string') return refuse('invalid-field', { field: 'name', detail: 'text' })
    if (typeof rawName === 'string' && (hasHiddenCharacter(rawName) || rawName.length > THEME_NAME_MAX)) return refuse(hasHiddenCharacter(rawName) ? 'hidden-characters' : 'invalid-field', { field: 'name' })
    return { ok: true, kind: 'theme', theme: cleanTheme(parsed.theme), name: (printable(rawName, THEME_NAME_MAX) ?? '').trim() }
  }
  return refuse('not-a-share')
}

/** A file that must be a Tweak. */
export function parseBoostFile(input: unknown): { ok: true; boost: SharedBoost } | ShareRefusal {
  const parsed = parseShareText(input)
  if (!parsed.ok) return parsed
  return parsed.kind === 'boost' ? { ok: true, boost: parsed.boost } : refuse('wrong-kind', { detail: parsed.kind })
}

/** A file that is one Tweak or all the Tweaks of someone ("Importer une Retouche…" reads both): the Tweaks it holds, one or many. */
export function parseBoostFiles(input: unknown): { ok: true; boosts: SharedBoost[]; bundle: boolean } | ShareRefusal {
  const parsed = parseShareText(input, BOOST_BUNDLE_MAX_BYTES)
  if (!parsed.ok) return parsed
  if (parsed.kind === 'boost') return { ok: true, boosts: [parsed.boost], bundle: false }
  return parsed.kind === 'boosts' ? { ok: true, boosts: parsed.boosts, bundle: true } : refuse('wrong-kind', { detail: 'theme' })
}

/** A file that must be a theme. Themes are tiny: a bigger file is not one. */
export function parseThemeFile(input: unknown): { ok: true; theme: SpaceTheme; name: string } | ShareRefusal {
  const parsed = parseShareText(input, THEME_FILE_MAX_BYTES)
  if (!parsed.ok) return parsed
  return parsed.kind === 'theme' ? { ok: true, theme: parsed.theme, name: parsed.name } : refuse('wrong-kind', { detail: 'boost' })
}

// ---------- writing a file or a link ----------

/** A Tweak of the state as it is shared: without its id, its state and the setting of its script; the script only when `withScript`. */
export function shareableBoost(boost: Boost, withScript: boolean): { ok: true; boost: SharedBoost } | ShareRefusal {
  return checkSharedBoost({
    name: boost.name,
    host: boost.host,
    css: boost.css,
    js: withScript ? boost.js : '',
    zoom: boost.zoom,
    zap: boost.zap,
    tint: boost.tint,
    ...(boost.fontFamily ? { fontFamily: boost.fontFamily } : {}),
    ...(boost.textCase ? { textCase: boost.textCase } : {}),
    ...(boost.invert ? { invert: true } : {})
  })
}

/**
 * The Tweaks of the state as "Tout exporter" shares them: each as `shareableBoost` makes it, in the order of the state. A Tweak that cannot be
 * shared (a stylesheet that loads something, a site that is not one…) is left out and named in `left` with its refusal, so that one old Tweak
 * does not stop the others from going out; more than a file may hold is refused as a whole, nothing is cut off silently.
 */
export function shareableBoosts(boosts: readonly Boost[], withScript: boolean): { ok: true; boosts: SharedBoost[]; left: Array<{ name: string; refusal: ShareRefusal }> } | ShareRefusal {
  const shared: SharedBoost[] = []
  const left: Array<{ name: string; refusal: ShareRefusal }> = []
  for (const boost of boosts) {
    const one = shareableBoost(boost, withScript)
    if (one.ok) shared.push(one.boost)
    else left.push({ name: boost.name, refusal: one })
  }
  if (shared.length > BOOST_BUNDLE_MAX) return refuse('too-many', { detail: String(shared.length) })
  return { ok: true, boosts: shared, left }
}

const fileOf = (boost: SharedBoost) => ({ format: SHARE_FORMAT, kind: 'boost', boost })

/** The text of a Tweak file: readable JSON, two spaces, a final line break. */
export function boostFileText(boost: SharedBoost): string {
  return `${JSON.stringify(fileOf(boost), null, 2)}\n`
}

/** The text of a file of several Tweaks, read back by `parseBoostFiles`; refused, and not written, when it is more than a file may hold. */
export function boostsFileText(boosts: readonly SharedBoost[]): { ok: true; text: string } | ShareRefusal {
  if (boosts.length === 0) return refuse('empty')
  if (boosts.length > BOOST_BUNDLE_MAX) return refuse('too-many', { detail: String(boosts.length) })
  const text = `${JSON.stringify({ format: SHARE_FORMAT, kind: 'boosts', boosts }, null, 2)}\n`
  const bytes = utf8Length(text)
  return bytes > BOOST_BUNDLE_MAX_BYTES ? refuse('too-large', { detail: String(bytes), max: BOOST_BUNDLE_MAX_BYTES }) : { ok: true, text }
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The link of a Tweak: the prefix and the minified file in base64url, a text that survives a chat message (no `+`, `/` or `=`). */
export function boostLink(boost: SharedBoost): string {
  return `${BOOST_LINK_PREFIX}${toBase64Url(new TextEncoder().encode(JSON.stringify(fileOf(boost))))}`
}

/** What a person copies around a link: quotes, backticks or angle brackets, spaces, and the line breaks a mail client adds. */
function unwrapLink(text: string): string {
  const trimmed = text.trim()
  const first = trimmed[0]
  const unquoted = trimmed.length >= 2 && ((first === '"' || first === "'" || first === '`') && trimmed.endsWith(first) ? true : first === '<' && trimmed.endsWith('>')) ? trimmed.slice(1, -1) : trimmed
  return unquoted.replace(/\s+/g, '')
}

/** Reads a pasted link: the text is bounded and strictly base64url before it is decoded, and what it decodes to is read like a file. */
export function parseBoostLink(input: unknown): { ok: true; boost: SharedBoost } | ShareRefusal {
  if (typeof input !== 'string') return refuse('link-not-a-link')
  // Bounded before anything is done to it: a huge text is not trimmed or searched.
  if (input.length > BOOST_LINK_MAX * 2) return refuse('too-large')
  const text = unwrapLink(input)
  if (text === '') return refuse('empty')
  if (text.length > BOOST_LINK_MAX) return refuse('too-large')
  const match = /^lucboost(\d{1,3})_/.exec(text)
  if (!match) return refuse('link-not-a-link')
  if (`lucboost${match[1]}_` !== BOOST_LINK_PREFIX) return refuse('link-unknown-version', { detail: match[1] })
  const payload = text.slice(BOOST_LINK_PREFIX.length)
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return refuse('link-malformed')
  let json: string
  try {
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return refuse('link-malformed')
  }
  return parseBoostFile(json)
}

/** The text of a theme file: the name the person sees, and the code that holds the theme. */
export function themeFileText(theme: SpaceTheme, name: string): string {
  const label = (printable(name, THEME_NAME_MAX) ?? '').trim()
  return `${JSON.stringify({ format: SHARE_FORMAT, kind: 'theme', ...(label ? { name: label } : {}), code: encodeThemeCode(theme) }, null, 2)}\n`
}

/** A file name from a name: lower case, no accents, letters and digits joined by hyphens. */
export function shareFileName(name: string, extension: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  return `${slug || 'sans-nom'}.${extension}`
}

// ---------- what the person is shown before anything is installed ----------

/** Things in a script worth saying out loud. A simple search, not an analysis: a script can do all of these without a word in the list. */
const SCRIPT_SIGNALS: Array<[pattern: RegExp, label: MessageKey]> = [
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b|\bnavigator\s*\.\s*sendBeacon\b/, 'boostshare.des-requetes-reseau'],
  [/\bdocument\s*\.\s*cookie\b|\b(?:localStorage|sessionStorage|indexedDB)\b|\bcookieStore\b/, 'boostshare.les-cookies-ou-le-stockage-du-site'],
  [/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(|\bimport\s*\(|\bsetTimeout\s*\(\s*['"`]/, 'boostshare.l-evaluation-de-code-ou-le-chargement-d-un-autre-script'],
  [/\bcreateElement\s*\(\s*['"`](?:script|iframe|link)['"`]|\.\s*(?:src|href)\s*=|\binnerHTML\b|\binsertAdjacentHTML\b|\bdocument\s*\.\s*write\b/, 'boostshare.l-ajout-d-elements-ou-de-contenu-html-dans-la-page'],
  [/\bclipboard\b|\bnavigator\s*\.\s*(?:credentials|geolocation|mediaDevices)\b|\bindexedDB\b/, 'boostshare.le-presse-papiers-la-position-ou-les-identifiants'],
  [/\b(?:password|passwd|mot_?de_?passe|token|secret|apikey|api_key)\b/i, 'boostshare.des-mots-qui-evoquent-un-mot-de-passe-ou-un-jeton']
]

/** What a script mentions, as short phrases for the preview, in the language of the interface; empty for a script that mentions none of them. */
export function scriptSignals(js: string): string[] {
  return SCRIPT_SIGNALS.filter(([pattern]) => pattern.test(js)).map(([, label]) => t(label))
}

const TEXT_CASE_LABEL: Record<BoostTextCase, string> = {
  get upper() { return t('boostshare.majuscules') },
  get lower() { return t('boostshare.minuscules') },
  get capitalize() { return t('boostshare.premiere-lettre-en-majuscule') }
}

const lineCount = (text: string): number => (text.trim() === '' ? 0 : text.replace(/\n$/, '').split('\n').length)

/** The size of a stylesheet or a script, "12 lignes, 340 octets": two counts, each by the plural rules of the language. */
const sizeOf = (text: string): string => `${tp('extpage.count-lignes', lineCount(text))}, ${tp('boostshare.count-octets', utf8Length(text))}`

/** What a Tweak changes in a page, one line per thing, for the preview and for the tests. */
export function describeSharedBoost(boost: SharedBoost, scriptImport: 'ask' | 'never'): string[] {
  const lines: string[] = []
  if (boost.css.trim() !== '') lines.push(t('boostshare.feuille-de-style-size', { size: sizeOf(boost.css) }))
  if (boost.zap.length > 0) lines.push(tp('boostshare.count-elements-masques-gomme', boost.zap.length))
  if (boost.zoom !== 1) lines.push(t('boostshare.texte-a-percent', { percent: Math.round(boost.zoom * 100) }))
  const font = fontById(boost.fontFamily)
  if (font) lines.push(t('boostshare.police-font', { font: font.label }))
  if (boost.textCase) lines.push(t('boostshare.casse-text-case', { textCase: TEXT_CASE_LABEL[boost.textCase] }))
  if (JSON.stringify(boost.tint) !== JSON.stringify(NEUTRAL_TINT)) lines.push(t('boostshare.couleurs-modifiees-teinte-saturation-luminosite'))
  if (boost.invert) lines.push(t('boostshare.luminosite-inversee-mode-sombre'))
  if (boost.js.trim() !== '') {
    const size = sizeOf(boost.js)
    lines.push(scriptImport === 'never' ? t('boostshare.javascript-size-ne-sera-pas-importe-reglages', { size, settingsPath: settingsPath('boostScriptImport') }) : t('boostshare.javascript-size-desactive-a-l-installation', { size }))
  }
  if (lines.length === 0) lines.push(t('boostshare.aucune-modification-de-la-page'))
  return lines
}

const EXCERPT_LINES = 8
const EXCERPT_WIDTH = 100

/** The first lines of a text, each cut to fit a dialog, with a mark when there is more. */
export function excerptOf(text: string): string {
  const all = text.replace(/\r\n?/g, '\n').split('\n').filter((line, index, lines) => line.trim() !== '' || index < lines.length - 1)
  const shown = all.slice(0, EXCERPT_LINES).map((line) => (line.length > EXCERPT_WIDTH ? `${line.slice(0, EXCERPT_WIDTH)}…` : line))
  return `${shown.map((line) => `  ${line}`).join('\n')}${all.length > EXCERPT_LINES ? `\n  ${tp('boostshare.count-lignes-de-plus', all.length - EXCERPT_LINES)}` : ''}`
}

/**
 * What the person is told about the invisible characters a Tweak was taken with (a zero-width space, a soft hyphen, the joiner of an emoji):
 * one sentence for the stylesheet and one for the script, each with the first line to read again. `withScript`: the script comes in.
 */
export function invisibleWarnings(boost: Pick<SharedBoost, 'css' | 'js'>, withScript: boolean): string[] {
  const css = hiddenCharacterLine(boost.css)
  const js = withScript ? hiddenCharacterLine(boost.js) : 0
  return [
    ...(css > 0 ? [t('boostshare.le-css-contient-des-caracteres-invisibles-ligne-line', { line: css })] : []),
    ...(js > 0 ? [t('boostshare.le-javascript-contient-des-caracteres-invisibles-ligne-line', { line: js })] : [])
  ]
}

export interface ImportPreview {
  message: string
  detail: string
  /** The Tweak has a script and the setting lets it in: the sheet then offers to leave it out. */
  hasScript: boolean
  /** The Tweak has a script that the setting keeps out. */
  scriptDropped: boolean
}

/** The sheet shown before a Tweak is installed: its name, its site, what it holds, and what is done with its script. */
export function importPreview(boost: SharedBoost, scriptImport: 'ask' | 'never'): ImportPreview {
  const hasJs = boost.js.trim() !== ''
  const parts = [t('boostshare.site-host-et-ses-sous-domaines', { host: boost.host }), '', t('boostshare.ce-que-contient-cette-retouche'), ...describeSharedBoost(boost, scriptImport).map((line) => `• ${line}`)]
  if (hasJs && scriptImport === 'ask') {
    const signals = scriptSignals(boost.js)
    parts.push('', signals.length > 0 ? t('boostshare.le-script-mentionne-signals', { signals: signals.join(t('boostshare.point-virgule')) }) : t('boostshare.le-script-ne-mentionne-rien-de-ce-que-le-reperage'))
    parts.push('', t('boostshare.debut-du-javascript'), excerptOf(boost.js))
  }
  if (boost.css.trim() !== '') parts.push('', t('boostshare.debut-du-css'), excerptOf(boost.css))
  const warnings = invisibleWarnings(boost, hasJs && scriptImport === 'ask')
  if (warnings.length > 0) parts.push('', ...warnings)
  parts.push('', t('boostshare.ce-fichier-ne-declenche-aucune-requete-le-css-est'))
  if (hasJs && scriptImport === 'ask') parts.push(t('boostshare.le-javascript-n-est-jamais-execute-tant-que'))
  return { message: t('boostshare.installer-la-retouche-name', { name: boost.name }), detail: parts.join('\n'), hasScript: hasJs && scriptImport === 'ask', scriptDropped: hasJs && scriptImport === 'never' }
}

/** Part of the sheet that asks before a script goes into a file or a link. */
export const scriptExportWarning = (): string => t('boostshare.le-fichier-ou-le-lien-contiendra-le-code-du-script')

// ---------- the sentences of a refusal ----------

/** How a refusal names a field of the file; `css` and `js` are the names of the languages, the same everywhere. */
const FIELD_LABEL: Readonly<Record<string, () => string>> = {
  name: () => t('boostshare.nom'),
  host: () => t('boostshare.site'),
  css: () => 'CSS',
  js: () => 'JavaScript',
  zoom: () => t('boostshare.taille-du-texte'),
  zap: () => t('boostshare.elements-masques'),
  tint: () => t('boostshare.couleurs'),
  'tint.hue': () => t('boostshare.teinte'),
  'tint.saturation': () => t('boostshare.saturation'),
  'tint.brightness': () => t('boostshare.luminosite'),
  'tint.contrast': () => t('boostshare.contraste'),
  fontFamily: () => t('boostshare.police'),
  textCase: () => t('boostshare.casse'),
  invert: () => t('boostshare.inversion'),
  code: () => t('boostshare.code-du-theme'),
  boost: () => t('boost-editor.retouche')
}

/** The sentence of each rule a shared stylesheet breaks; its `{line}` says where the rule begins, when that is known. */
const CSS_RULE_SENTENCE: Record<CssRefusal, MessageKey> = {
  'hidden-character': 'boostshare.le-css-contient-un-caractere-invisible',
  import: 'boostshare.le-css-contient-import',
  url: 'boostshare.le-css-contient-une-adresse-url',
  'image-function': 'boostshare.le-css-contient-image-set-src-image-ou-cross-fade',
  'attr-url': 'boostshare.le-css-lit-une-adresse-dans-les-attributs-de-la-page',
  expression: 'boostshare.le-css-contient-expression',
  behavior: 'boostshare.le-css-contient-behavior',
  binding: 'boostshare.le-css-contient-moz-binding'
}

/** " (ligne 4)" for a sentence that says where, or nothing when the line is not known. */
const lineOf = (line: number | undefined): string => (line ? t('boostshare.ligne-line', { line }) : '')

/** The sentence the person reads when a file or a link is refused: what is wrong, and where when that helps (which Tweak, in a file of several). */
export function shareRefusalMessage(refusal: ShareRefusal): string {
  const sentence = refusalSentence(refusal)
  if (refusal.entry === undefined) return sentence
  return t('boostshare.retouche-n-entry-name-sentence', { entry: refusal.entry, name: refusal.entryName ? t('boostshare.nom-entre-guillemets', { name: refusal.entryName }) : '', sentence })
}

function refusalSentence(refusal: ShareRefusal): string {
  const field = refusal.field ? (Object.hasOwn(FIELD_LABEL, refusal.field) ? FIELD_LABEL[refusal.field]!() : refusal.field) : ''
  switch (refusal.reason) {
    case 'empty':
      return t('boostshare.il-n-y-a-rien-a-lire-le-fichier-ou-le-texte-est-vide')
    case 'too-large':
      return t('boostshare.c-est-trop-volumineux-pour-une-retouche-ou-un-theme', {
        size: refusal.detail ? t('boostshare.size-ko', { size: Math.ceil(Number(refusal.detail) / 1024) }) : '',
        max: Math.round((refusal.max ?? SHARE_FILE_MAX_BYTES) / 1024)
      })
    case 'too-many':
      return t('boostshare.il-y-a-trop-de-retouches-pour-un-seul-fichier', { count: refusal.detail ?? '?', max: BOOST_BUNDLE_MAX })
    case 'not-json':
      return t('boostshare.ce-n-est-pas-un-fichier-de-retouche-son-contenu-n-est-pas-du-json')
    case 'not-a-share':
      return t('boostshare.ce-n-est-pas-un-fichier-de-retouche-il-n-en-a-pas-la-forme')
    case 'unknown-format':
      return t('boostshare.ce-fichier-suit-le-format-format', { format: refusal.detail ?? '?', known: SHARE_FORMAT })
    case 'wrong-kind':
      if (refusal.detail === 'boosts') return t('boostshare.ce-lien-contient-plusieurs-retouches-un-lien-n-en')
      return refusal.detail === 'theme' ? t('boostshare.ce-fichier-contient-un-theme-d-espace-pas-une-retouche') : t('boostshare.ce-fichier-contient-une-retouche-pas-un-theme-d-espace')
    case 'invalid-field':
      // The detail is the technical form of what was expected (`text`, `max 60`, `0.5..1.5`): shown as it is, in every language.
      return refusal.field === 'zap' && refusal.detail && /^\d+$/.test(refusal.detail)
        ? t('boostshare.l-element-masque-n-detail-n-a-pas-la-forme-d-un', { detail: refusal.detail })
        : t('boostshare.le-champ-field-n-a-pas-une-valeur-acceptable', { field, detail: refusal.detail ? ` (${refusal.detail})` : '' })
    case 'hidden-characters':
      return t('boostshare.le-champ-field-line-contient-des-caracteres-invisibles', { field, line: lineOf(refusal.line) })
    case 'host-invalid':
      return t('boostshare.le-site-vise-host-n-est-pas-un-nom-de-site-valide', { host: refusal.detail && refusal.detail !== 'missing' ? t('boostshare.host-entre-parentheses', { host: refusal.detail }) : '' })
    case 'host-too-wide':
      return t('boostshare.le-site-vise-host-est-trop-large', { host: refusal.detail ?? '' })
    case 'css-too-large':
      return t('boostshare.le-css-est-trop-long-length-caracteres', { length: refusal.detail ?? '?', max: BOOST_CSS_MAX })
    case 'js-too-large':
      return t('boostshare.le-javascript-est-trop-long-length-caracteres', { length: refusal.detail ?? '?', max: BOOST_JS_MAX })
    case 'css-forbidden':
      return t(CSS_RULE_SENTENCE[refusal.rule ?? 'url'], { line: lineOf(refusal.line) })
    case 'link-not-a-link':
      return t('boostshare.ce-texte-n-est-pas-un-lien-de-boost-il-devrait', { BOOST_LINK_PREFIX })
    case 'link-unknown-version':
      return t('boostshare.ce-lien-vient-d-une-autre-version-de-lucium')
    case 'link-malformed':
      return t('boostshare.ce-lien-de-retouche-est-incomplet-ou-abime')
  }
}

// ---------- what the interface asks of the shell ----------

/**
 * The buttons that share a Tweak. `import-file` and `import-link` bring one in (a file chosen in a dialog, or the clipboard), `export-file`
 * and `copy-link` send one out, `export-all` sends all the Tweaks out in one file (`import-file` reads that file too). The interface never sends the text to read: the shell reads the file or the clipboard itself.
 */
export type BoostShareRequest = { kind: 'import-file' } | { kind: 'import-link' } | { kind: 'export-file'; boostId: string } | { kind: 'copy-link'; boostId: string } | { kind: 'export-all' }

/** What the shell answers: the sentence to show, whether it worked, and the Tweak that was installed (the editor then opens it). A person who closed a dialog is not an error: `cancelled`, no sentence. */
export interface ShareReply {
  ok: boolean
  message: string
  boostId?: string
  cancelled?: boolean
  /** A dialog has already told the person (a refusal with its reason): the caller does not say it twice. */
  shown?: boolean
}

/** Reads a request from the interface; anything that is not exactly one of the five is refused. */
export function parseBoostShareRequest(raw: unknown): BoostShareRequest | null {
  if (!isRecord(raw)) return null
  const keys = Object.keys(raw)
  if (raw['kind'] === 'import-file' || raw['kind'] === 'import-link' || raw['kind'] === 'export-all') return keys.length === 1 ? { kind: raw['kind'] } : null
  if (raw['kind'] === 'export-file' || raw['kind'] === 'copy-link') {
    const id = raw['boostId']
    if (keys.length !== 2 || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
    return { kind: raw['kind'], boostId: id }
  }
  return null
}

const BUNDLE_PREVIEW_LINES = 12

/**
 * The sheet shown before the Tweaks of a file of several are installed: how many, which, and what is done with the scripts. The scripts are not
 * excerpted here (a file may hold two hundred Tweaks): they arrive switched off, and the sheet says where to read them.
 */
export function importBundlePreview(boosts: readonly SharedBoost[], scriptImport: 'ask' | 'never'): ImportPreview {
  const scripted = boosts.filter((b) => b.js.trim() !== '')
  const listed = boosts.slice(0, BUNDLE_PREVIEW_LINES).map((b) => `• ${b.name} (${b.host})${b.js.trim() !== '' ? t('boostshare.avec-javascript') : ''}`)
  const parts = [t('boostshare.ce-que-contient-ce-fichier'), ...listed]
  if (boosts.length > BUNDLE_PREVIEW_LINES) parts.push(tp('boostshare.et-count-autres-retouches', boosts.length - BUNDLE_PREVIEW_LINES))
  if (scripted.length > 0) {
    parts.push('', scriptImport === 'never' ? tp('boostshare.count-retouches-ont-du-javascript-qui-ne-sera-pas-importe', scripted.length, { settingsPath: settingsPath('boostScriptImport') }) : tp('boostshare.count-retouches-ont-du-javascript-installe-desactive', scripted.length))
  }
  if (boosts.some((b) => invisibleWarnings(b, scriptImport === 'ask').length > 0)) parts.push('', t('boostshare.une-retouche-de-ce-fichier-contient-des-caracteres-invisibles'))
  parts.push('', t('boostshare.ce-fichier-ne-declenche-aucune-requete-le-css-est'))
  return { message: tp('boostshare.installer-count-retouches', boosts.length), detail: parts.join('\n'), hasScript: scripted.length > 0 && scriptImport === 'ask', scriptDropped: scripted.length > 0 && scriptImport === 'never' }
}
