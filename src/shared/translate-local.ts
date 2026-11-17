// Local page translation (File › Traduire cette page…): the rules that do not depend on Electron. The text of the page is translated on this computer, by
// an engine that reads models the user placed or chose to download; no page text ever leaves it. What is here: the settings, detecting the language of a page,
// which text of a page is translated and in what batches, the files of a model ("pack") and their checks, what a download is (the plan the user reads before
// clicking), and the route from one language to another. The page scripts are in translate-page-script.ts, the files and the engines in main/translate/.
//
// Nothing here fetches anything. The only requests the function ever makes go to two servers, always after a click: the lists of the models of a pair of
// languages and of the engine's binary (CATALOGUE_HOST, on "Chercher les modèles"), then the files themselves (ATTACHMENTS_HOST, on "Télécharger");
// `parseCatalogue` and `parseRuntimeCatalogue` make the plan whose addresses and size the user reads before the second click.

import { getLanguage, t, type Language, type MessageKey } from './i18n'
import type { Settings } from './model'

// ---------- settings ----------

/** A language code as the models name them: two or three lower-case letters ("fr", "en", "fil"). */
export const isLanguageCode = (value: unknown): value is string => typeof value === 'string' && /^[a-z]{2,3}$/.test(value)

/** The primary language of a BCP 47 tag ("fr-CA" and "FR_ca" are "fr"); null for a tag that names none ("", "und", "x-klingon", "zxx"). */
export function primaryLanguage(tag: unknown): string | null {
  if (typeof tag !== 'string' || tag.length > 35) return null
  const first = tag.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return isLanguageCode(first) && first !== 'und' && first !== 'zxx' && first !== 'mis' && first !== 'mul' ? first : null
}

const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/])/

export type TranslateSettings = Pick<Settings, 'translateLocal' | 'translateTarget' | 'translateModelsDir'>

/** What the file of settings holds, read back: the switch is on only for `true`; the target is "auto" or a language code; the folder is empty or an absolute path. */
export function cleanTranslateSettings(settings: Pick<Settings, 'translateLocal' | 'translateTarget' | 'translateModelsDir'>): TranslateSettings {
  const dir = settings.translateModelsDir
  return {
    translateLocal: settings.translateLocal === true,
    translateTarget: settings.translateTarget === 'auto' || isLanguageCode(settings.translateTarget) ? settings.translateTarget : 'auto',
    translateModelsDir: typeof dir === 'string' && dir.length <= 1024 && ABSOLUTE_PATH.test(dir) && !/\p{Cc}/u.test(dir) ? dir : ''
  }
}

/** The language pages are translated into: the one chosen, else the language of the interface. */
export const targetLanguage = (settings: Pick<Settings, 'translateTarget'>, interfaceLanguage: Language): string => (isLanguageCode(settings.translateTarget) ? settings.translateTarget : interfaceLanguage)

// ---------- the language of a page ----------

export interface Detection {
  language: string | null
  /** `declared`: the page's `lang` attribute (and the text does not say otherwise); `text`: what the words say; `none`: neither. */
  source: 'declared' | 'text' | 'none'
  /** 0 to 1. */
  confidence: number
  /** What the page's `lang` attribute names, when the words say another language (`source` is then `text`): the page claims one language and is written in another. */
  declared?: string
}

export const NO_DETECTION: Detection = { language: null, source: 'none', confidence: 0 }

/**
 * Most frequent words of some languages written in the Latin alphabet. This is a small detector, not a trained one (the engine's own is not here): it names
 * a page written in one of these languages, in a few sentences, and says nothing for the others rather than a wrong name.
 */
const STOP_WORDS: Readonly<Record<string, string>> = {
  fr: 'le la les un une des du de et est en que qui dans pour pas sur au aux avec ce cette ces il elle nous vous ils sont être plus mais ou où par se son sa ses l d qu n j ne y a',
  en: 'the and of to in is that it for was on with as are at be this by from or have not you he she they we his her but an will can all their there has had were been i',
  es: 'el la los las un una de y en que es por con para se su al lo como más pero sus le ha me si ya muy también esta este son del no',
  de: 'der die das und ist nicht ein eine zu den dem mit sich auf für von es auch im dass sie wir ich er als wie bei oder noch nur aber wird sind',
  it: 'il lo la le gli un una di e che è per con non si del della dei delle nel nella sono come più anche ma al alla',
  pt: 'o os as um uma de e que é em para com não se do da dos das no na por mais como mas foi são ao',
  nl: 'de het een en van in is dat op te voor met zijn niet aan er maar om ook als bij of dit door naar',
  sv: 'och att det som en är på för med av inte den till har ett de om',
  pl: 'w nie na się z do to że jest jak ale po co tak za od przez dla'
}
const PROFILES: ReadonlyArray<[string, ReadonlySet<string>]> = Object.entries(STOP_WORDS).map(([lang, words]) => [lang, new Set(words.split(' '))])

/** The share of the letters of a text in a script. */
function scriptShare(text: string, script: RegExp): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  return letters === 0 ? 0 : (text.match(script)?.length ?? 0) / letters
}

/** What the words of a sample say about its language: a code and how sure, or nothing. Needs a few sentences (`DETECT_MIN_LETTERS`). */
export function detectFromText(sample: string): { language: string | null; confidence: number } {
  const text = sample.slice(0, 4000).toLowerCase()
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  // A sentence of Chinese, Japanese or Korean is short in letters: those scripts need fewer to say something.
  if (letters < DETECT_MIN_LETTERS_DENSE) return { language: null, confidence: 0 }
  // Scripts that name a language by themselves (or nearly so).
  if (scriptShare(text, /[぀-ヿ]/gu) > 0.1) return { language: 'ja', confidence: 0.9 }
  if (scriptShare(text, /[가-힯]/gu) > 0.3) return { language: 'ko', confidence: 0.9 }
  if (scriptShare(text, /[一-鿿]/gu) > 0.3) return { language: 'zh', confidence: 0.8 }
  if (scriptShare(text, /[Ѐ-ӿ]/gu) > 0.5) return { language: /[іїєґ]/u.test(text) ? 'uk' : 'ru', confidence: 0.7 }
  if (scriptShare(text, /[؀-ۿ]/gu) > 0.5) return { language: /[پچژگ]/u.test(text) ? 'fa' : 'ar', confidence: 0.7 }
  if (scriptShare(text, /[֐-׿]/gu) > 0.5) return { language: 'he', confidence: 0.8 }
  if (scriptShare(text, /[Ͱ-Ͽ]/gu) > 0.5) return { language: 'el', confidence: 0.8 }
  if (letters < DETECT_MIN_LETTERS) return { language: null, confidence: 0 }
  const words = text.split(/[^\p{L}]+/u).filter(Boolean)
  if (words.length < 8) return { language: null, confidence: 0 }
  const scored = PROFILES.map(([language, set]) => ({ language, share: words.filter((word) => set.has(word)).length / words.length })).sort((a, b) => b.share - a.share)
  const [best, second] = [scored[0]!, scored[1]!]
  // Common words must make up a real part of the text, and clearly more of it for one language than for the next.
  if (best.share < 0.12 || best.share < second.share * 1.25) return { language: null, confidence: 0 }
  return { language: best.language, confidence: Math.min(1, (best.share - second.share) / best.share + 0.2) }
}

/** The fewest letters a sample needs for the words to say anything (Latin alphabets), and for a script that names its language by itself. */
export const DETECT_MIN_LETTERS = 60
export const DETECT_MIN_LETTERS_DENSE = 12

/**
 * The language of a page from its `lang` attribute and a sample of its text. Pages say "en" about French text more often than one would hope, so the
 * words win when they are clear; the attribute decides when they are not.
 */
export function detectLanguage(sample: string, declared: unknown): Detection {
  const attribute = primaryLanguage(declared)
  const text = detectFromText(sample)
  if (text.language !== null && text.confidence >= 0.5) {
    if (text.language === attribute) return { language: attribute, source: 'declared', confidence: 1 }
    return { language: text.language, source: 'text', confidence: text.confidence, ...(attribute !== null ? { declared: attribute } : {}) }
  }
  return attribute !== null ? { language: attribute, source: 'declared', confidence: 0.6 } : NO_DETECTION
}

/**
 * The pair the panel proposes for a page, which the person can change: what the page is written in, into `target` (the language chosen in the settings, else the
 * language of the interface). A pair that goes nowhere is never proposed (a page already in the target language has nothing to translate), because the
 * panel is opened from « Traduire cette page… », and a button that cannot be pressed is a dead end:
 *  - the words say the page is in the target language while its `lang` attribute names another one (the menu offers the translation because of it): the
 *    attribute's language, which the person can correct;
 *  - the page is in the target language: the language of the interface, else English (else French, for an interface in English), as the target.
 */
export function proposedPair(detection: Detection, target: string, interfaceLanguage: string): { from: string; to: string } {
  const detected = detection.language ?? ''
  if (detected !== target) return { from: detected, to: target }
  if (detection.declared !== undefined && detection.declared !== target) return { from: detection.declared, to: target }
  const other = interfaceLanguage !== detected ? interfaceLanguage : detected === 'en' ? 'fr' : 'en'
  return { from: detected, to: other }
}

// ---------- which text of a page is translated ----------

/** Elements whose text is not prose for a reader (code, fields, scripts) or is not text at all. */
export const SKIP_TAGS: readonly string[] = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'AUDIO', 'VIDEO', 'HEAD', 'TITLE']
/**
 * The most text nodes, characters in one node, and characters in all that a page gives to the engine. A page beyond them is translated as far as they
 * allow, nearest the viewport first: the script reads up to `scanNodes` nodes and `scanChars` characters of it to choose them.
 */
export const TRANSLATE_LIMITS = { nodes: 4000, nodeChars: 1500, totalChars: 300_000, scanNodes: 8000, scanChars: 600_000, batchChars: 3000, batchItems: 48, replyFactor: 4, replySlack: 200 } as const

/** A text node's text split into its leading space, its words and its trailing space: only the words are translated, the spacing stays the page's. */
export function splitPadding(text: string): { lead: string; core: string; trail: string } {
  const lead = /^\s*/.exec(text)![0]
  const rest = text.slice(lead.length)
  const core = rest.replace(/\s+$/, '')
  return { lead, core, trail: rest.slice(core.length) }
}

/** Whether a piece of text is worth translating: at least two letters, and not an address, a number or a row of symbols. */
export function isTranslatable(core: string): boolean {
  if (core.length === 0 || core.length > TRANSLATE_LIMITS.nodeChars) return false
  if ((core.match(/\p{L}/gu)?.length ?? 0) < 2) return false
  if (/^(https?:\/\/|www\.)\S+$/i.test(core) || /^\S+@\S+\.\S+$/.test(core)) return false
  return true
}

/** The size of a batch: at most `chars` characters and `items` texts (a text longer than `chars` goes alone, whole). */
export interface BatchSize {
  chars: number
  items: number
}

/**
 * How the texts of a page go to an engine: the first batch (what is on screen, so that it shows soon), the next ones, and how many batches the engine
 * is given at once (`inFlight`: the next ones are sent while one is translated; they are put in the page in their order all the same).
 */
export interface BatchPace {
  inFlight: number
  first: BatchSize
  next: BatchSize
}

/** The pace of an engine that names none (Bergamot, the glossary): one batch at a time, of the sizes the models engine was made for. */
export const DEFAULT_PACE: BatchPace = {
  inFlight: 1,
  first: { chars: TRANSLATE_LIMITS.batchChars, items: TRANSLATE_LIMITS.batchItems },
  next: { chars: TRANSLATE_LIMITS.batchChars, items: TRANSLATE_LIMITS.batchItems }
}
/** THE BOUND of the batches in flight, whatever an engine asks: a page never has more than this many batches waiting for an engine. */
export const MAX_IN_FLIGHT = 4

/** The texts, in groups within `pace` (the first group within `pace.first`, the others within `pace.next`), as lists of positions, in order, none lost. */
export function planBatches(lengths: readonly number[], pace: BatchPace = DEFAULT_PACE): number[][] {
  const batches: number[][] = []
  let current: number[] = []
  let chars = 0
  let size = pace.first
  lengths.forEach((length, index) => {
    if (current.length > 0 && (current.length >= size.items || chars + length > size.chars)) {
      batches.push(current)
      current = []
      chars = 0
      size = pace.next
    }
    current.push(index)
    chars += length
  })
  if (current.length > 0) batches.push(current)
  return batches
}

/** The texts, in groups of at most `batchChars` characters and `batchItems` texts, as lists of positions: an engine answers one group at a time. */
export function batchIndices(lengths: readonly number[], maxChars: number = TRANSLATE_LIMITS.batchChars, maxItems: number = TRANSLATE_LIMITS.batchItems): number[][] {
  const size = { chars: maxChars, items: maxItems }
  return planBatches(lengths, { inFlight: 1, first: size, next: size })
}

/**
 * Where each text of a page is from the viewport, as the page script says it (`ExtractReply.offsets`, CSS pixels: 0 on screen, positive below,
 * negative above, null without a box). Anything else (missing, another length, a value that is not a finite number or null) counts as not known.
 */
export function usableOffsets(raw: unknown, count: number): Array<number | null> {
  const unknown = (): Array<number | null> => Array.from({ length: count }, () => null)
  if (!Array.isArray(raw) || raw.length !== count) return unknown()
  const out: Array<number | null> = []
  for (const value of raw as unknown[]) {
    if (value === null) out.push(null)
    else if (typeof value === 'number' && Number.isFinite(value)) out.push(value)
    else return unknown()
  }
  return out
}

/**
 * The order the texts are translated in: those on screen first (in the page's order), then the others by their distance to the viewport (below before
 * above at the same distance: one reads down), then those that have no box (hidden), in the page's order. Every position once.
 */
export function readingOrder(offsets: ReadonlyArray<number | null>): number[] {
  const far = (offset: number | null): number => (offset === null ? Number.POSITIVE_INFINITY : Math.abs(offset))
  return offsets
    .map((_, index) => index)
    .sort((a, b) => {
      const [x, y] = [offsets[a] ?? null, offsets[b] ?? null]
      if (far(x) !== far(y)) return far(x) < far(y) ? -1 : 1
      if (x !== null && y !== null && x !== y) return x > y ? -1 : 1
      return a - b
    })
}

/**
 * What an engine answered, checked before it goes into a page: one text for each one sent, each a string of reasonable length and without control
 * characters but the line break and the tab. Null when it is not that. (The text goes into the page as text, never as markup; this is about a
 * broken engine, or a pack made to misbehave, not about injection.)
 */
export function checkReply(sent: readonly string[], reply: unknown): string[] | null {
  if (!Array.isArray(reply) || reply.length !== sent.length) return null
  const out: string[] = []
  for (let i = 0; i < sent.length; i++) {
    const item: unknown = reply[i]
    if (typeof item !== 'string' || item.length > sent[i]!.length * TRANSLATE_LIMITS.replyFactor + TRANSLATE_LIMITS.replySlack || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item)) return null
    out.push(item)
  }
  return out
}

// ---------- the files of a model ----------

export type PackEngine = 'bergamot' | 'glossary'
export type PackRole = 'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab' | 'glossary'
export const PACK_ENGINES: readonly PackEngine[] = ['bergamot', 'glossary']
export const PACK_ROLES: readonly PackRole[] = ['model', 'lex', 'vocab', 'srcvocab', 'trgvocab', 'glossary']
/** A file of a pack, and the whole pack, are bounded: a bigger one is refused before it is read, downloaded or kept. */
export const PACK_LIMITS = { fileBytes: 200 * 1024 * 1024, totalBytes: 400 * 1024 * 1024, files: 8, manifestBytes: 64 * 1024 } as const

export interface PackFile {
  role: PackRole
  /** The file's name inside the pack folder: letters, digits, dots, dashes and underscores. */
  name: string
  size: number
  /** SHA-256, 64 lower-case hexadecimal digits. */
  sha256: string
}

export interface PackManifest {
  schema: 1
  engine: PackEngine
  from: string
  to: string
  version: string
  files: PackFile[]
}

export const SAFE_FILE_NAME = /^(?!\.)[A-Za-z0-9._-]{1,128}$/
const SHA256 = /^[0-9a-f]{64}$/
const VERSION = /^\d{1,4}(\.\d{1,4}){0,2}$/

/** The folder of a pack in the models folder. */
export const packFolder = (from: string, to: string): string => `${from}-${to}`

/** Which files a pack of an engine needs, as a reason when one is missing (null: complete). */
export function missingRole(engine: PackEngine, files: readonly Pick<PackFile, 'role'>[]): string | null {
  const roles = new Set(files.map((file) => file.role))
  if (engine === 'glossary') return roles.has('glossary') ? null : 'glossary'
  if (!roles.has('model')) return 'model'
  if (!roles.has('vocab') && !(roles.has('srcvocab') && roles.has('trgvocab'))) return 'vocab'
  return null
}

/** A manifest read from a folder the user filled, or downloaded: strict, every field checked, nothing beyond the schema kept. Null when it is anything else. */
export function parseManifest(raw: unknown): PackManifest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  if (Object.keys(m).sort().join() !== 'engine,files,from,schema,to,version') return null
  if (m['schema'] !== 1 || !(PACK_ENGINES as readonly unknown[]).includes(m['engine']) || !isLanguageCode(m['from']) || !isLanguageCode(m['to']) || m['from'] === m['to']) return null
  if (typeof m['version'] !== 'string' || !VERSION.test(m['version'])) return null
  const list = m['files']
  if (!Array.isArray(list) || list.length === 0 || list.length > PACK_LIMITS.files) return null
  const files: PackFile[] = []
  const names = new Set<string>()
  const roles = new Set<string>()
  let total = 0
  for (const entry of list as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const f = entry as Record<string, unknown>
    if (Object.keys(f).sort().join() !== 'name,role,sha256,size') return null
    const { role, name, size, sha256 } = f
    if (!(PACK_ROLES as readonly unknown[]).includes(role) || typeof name !== 'string' || !SAFE_FILE_NAME.test(name) || name === 'manifest.json') return null
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > PACK_LIMITS.fileBytes || typeof sha256 !== 'string' || !SHA256.test(sha256)) return null
    if (names.has(name) || roles.has(role as string)) return null
    names.add(name)
    roles.add(role as string)
    total += size
    files.push({ role: role as PackRole, name, size, sha256 })
  }
  if (total > PACK_LIMITS.totalBytes) return null
  const manifest: PackManifest = { schema: 1, engine: m['engine'] as PackEngine, from: m['from'] as string, to: m['to'] as string, version: m['version'], files }
  return missingRole(manifest.engine, files) === null ? manifest : null
}

/** The role of a file by its name, for a folder the user filled with the files of a model: `model.enfr.intgemm.alphas.bin` is a model, `vocab.enfr.spm` a vocabulary. */
export function roleOfFileName(name: string): PackRole | null {
  if (!SAFE_FILE_NAME.test(name) || name === 'manifest.json') return null
  if (/\.glossary\.json$/i.test(name)) return 'glossary'
  const head = name.split('.')[0]!.toLowerCase()
  return head === 'model' || head === 'lex' || head === 'vocab' || head === 'srcvocab' || head === 'trgvocab' ? head : null
}

// ---------- a download, as the user reads it ----------

/** The list of the models, and the files themselves: the only two servers the function ever speaks to, and only after a click. */
export const CATALOGUE_HOST = 'firefox.settings.services.mozilla.com'
export const ATTACHMENTS_HOST = 'firefox-settings-attachments.cdn.mozilla.net'
const ATTACHMENTS_BASE = `https://${ATTACHMENTS_HOST}/`
/** The most records and the largest answer read from the list of models. */
export const CATALOGUE_LIMITS = { records: 500, bytes: 4 * 1024 * 1024 } as const

/**
 * Mozilla's public Remote Settings collections that Firefox reads since version 145: the models (major version 3, files compressed with zstd) and the
 * engine's WebAssembly binary (major version 4, zstd as well). The engine's JavaScript glue that Lucium ships (main/translate/vendor/) is the one of a
 * Firefox that reads exactly these: a binary of another major version would not fit it.
 */
export const MODELS_COLLECTION = 'translations-models-v2'
export const RUNTIME_COLLECTION = 'translations-wasm-v2'
export const MODEL_MAJORS: readonly number[] = [3]
export const RUNTIME_MAJOR = 4
/** The engine's binary, decompressed and compressed, is bounded too (Mozilla's is about 5 MB). */
export const RUNTIME_LIMITS = { bytes: 32 * 1024 * 1024 } as const

/** The address that lists the records of the models of one pair of languages. */
export const catalogueUrl = (from: string, to: string): string => `https://${CATALOGUE_HOST}/v1/buckets/main/collections/${MODELS_COLLECTION}/records?fromLang=${from}&toLang=${to}`
/** The address that lists the records of the engine's binary. */
export const RUNTIME_CATALOGUE_URL = `https://${CATALOGUE_HOST}/v1/buckets/main/collections/${RUNTIME_COLLECTION}/records?name=bergamot-translator`

/** A file to fetch: what is kept (name, size and SHA-256 of the file on disk) and where it comes from. */
export interface TransferFile {
  name: string
  size: number
  sha256: string
  url: string
  /** The file travels compressed: its own size and SHA-256, checked before it is decompressed into the file above (also checked). */
  transfer?: { encoding: 'zstd'; size: number; sha256: string }
}

export interface PlannedFile extends PackFile, TransferFile {}

export interface DownloadPlan {
  engine: 'bergamot'
  from: string
  to: string
  version: string
  files: PlannedFile[]
  /** What goes over the network. */
  totalBytes: number
  /** What is kept on disk, once decompressed. */
  diskBytes: number
}

/** The engine's binary to download: one file, the same for every pair of languages. */
export interface RuntimePlan {
  version: string
  release: string
  file: TransferFile
}

/** The bytes a file costs on the network: the compressed file when it travels compressed. */
export const wireBytes = (file: TransferFile): number => file.transfer?.size ?? file.size

const versionParts = (version: string): number[] => version.split('.').map(Number)
const newer = (a: string, b: string): boolean => {
  const [x, y] = [versionParts(a), versionParts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** The system a record's filter is read for, as Firefox names it (`env.appinfo.OS`), and the channel: Lucium takes the records of Firefox's release channel. */
export interface FilterEnv {
  channel: string
  os: string
}
export const RELEASE_ENV: FilterEnv = { channel: 'release', os: 'Darwin' }

/**
 * Whether the `filter_expression` of a record holds for a release build on this system. Mozilla uses a few of them on these collections, to keep a model
 * on Nightly or off Android (`env.channel == 'nightly'`, `env.appinfo.OS != 'Android' || env.channel != 'release'`). Only comparisons of `env.channel` and
 * `env.appinfo.OS` with a quoted word, joined by `||` and `&&`, are read; anything else (brackets, a negation, another field) counts as false, so that a
 * record meant for someone else is skipped rather than taken.
 */
export function filterHolds(expression: unknown, env: FilterEnv = RELEASE_ENV): boolean {
  if (expression === undefined || expression === null) return true
  if (typeof expression !== 'string' || expression.length > 500) return false
  if (expression.trim() === '') return true
  if (/[()!]/.test(expression.replace(/!=/g, ''))) return false
  return expression.split('||').some((alternative) =>
    alternative.split('&&').every((term) => {
      const m = /^\s*env\.(channel|appinfo\.OS)\s*(==|!=)\s*(['"])([A-Za-z0-9_-]{1,40})\3\s*$/.exec(term)
      if (!m) return false
      const value = m[1] === 'channel' ? env.channel : env.os
      return m[2] === '==' ? value === m[4] : value !== m[4]
    })
  )
}

/** The checked address of a file on the attachments server, or null. */
function attachmentUrl(location: unknown): string | null {
  if (typeof location !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,300}$/.test(location) || location.includes('..') || location.includes('//')) return null
  const url = ATTACHMENTS_BASE + location
  // The address must stay on the attachments server once the browser has parsed it.
  return URL.canParse(url) && new URL(url).hostname === ATTACHMENTS_HOST && new URL(url).protocol === 'https:' ? url : null
}

const isSize = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max
const isHash = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value)

/**
 * The file of a record of the v2 collections: the attachment is the file compressed with zstd (`attachment.hash`, `attachment.size`), and the record says
 * what it gives once decompressed (`decompressedHash`, `decompressedSize`). Both are checked when it is downloaded. Null when anything is missing or wrong.
 */
function recordFile(r: Record<string, unknown>, max: number, fallbackName: string): TransferFile | null {
  const a = typeof r['attachment'] === 'object' && r['attachment'] !== null ? (r['attachment'] as Record<string, unknown>) : null
  if (!a || !isHash(a['hash']) || !isSize(a['size'], max) || !isHash(r['decompressedHash']) || !isSize(r['decompressedSize'], max)) return null
  const url = attachmentUrl(a['location'])
  if (!url) return null
  // The name kept is the decompressed file's: the record's name, else the attachment's without its ".zst".
  const filename = typeof a['filename'] === 'string' ? a['filename'].replace(/\.zst$/i, '') : ''
  const name = [r['name'], filename].find((candidate): candidate is string => typeof candidate === 'string' && SAFE_FILE_NAME.test(candidate) && candidate !== 'manifest.json') ?? fallbackName
  return { name, size: r['decompressedSize'], sha256: r['decompressedHash'], url, transfer: { encoding: 'zstd', size: a['size'], sha256: a['hash'] } }
}

const recordsOf = (raw: unknown): unknown[] | 'invalid' | 'too-big' => {
  const data = typeof raw === 'object' && raw !== null ? (raw as { data?: unknown }).data : undefined
  if (!Array.isArray(data)) return 'invalid'
  return data.length > CATALOGUE_LIMITS.records ? 'too-big' : data
}

/**
 * What to download for a pair of languages, from the records the catalogue answered. The answer is data from a server: every field is checked, a file
 * must live on the attachments server, a record whose filter is not for a release build is skipped, and the pack is the newest version (of the supported
 * major versions) that has every file the engine needs, all of that one version: files of two versions are never mixed. Fails with a sentence.
 */
export function parseCatalogue(raw: unknown, from: string, to: string, options: { majors?: readonly number[]; env?: FilterEnv } = {}): { ok: true; plan: DownloadPlan } | { ok: false; reason: string } {
  const majors = options.majors ?? MODEL_MAJORS
  const data = recordsOf(raw)
  if (data === 'invalid') return { ok: false, reason: t('translate.catalogue-invalid') }
  if (data === 'too-big') return { ok: false, reason: t('translate.catalogue-too-big') }
  const byVersion = new Map<string, Map<PackRole, PlannedFile>>()
  for (const record of data) {
    if (typeof record !== 'object' || record === null) continue
    const r = record as Record<string, unknown>
    const role = r['fileType']
    const version = r['version']
    if (r['fromLang'] !== from || r['toLang'] !== to || typeof version !== 'string' || !VERSION.test(version) || !majors.includes(Number(version.split('.')[0]))) continue
    if (role !== 'model' && role !== 'lex' && role !== 'vocab' && role !== 'srcvocab' && role !== 'trgvocab') continue
    if (!filterHolds(r['filter_expression'], options.env)) continue
    const file = recordFile(r, PACK_LIMITS.fileBytes, `${role}.bin`)
    if (!file) continue
    const files = byVersion.get(version) ?? new Map<PackRole, PlannedFile>()
    // Two records of one kind in one version: the catalogue contradicts itself, the version is not taken.
    files.set(role, files.has(role) ? { ...file, role, name: '' } : { ...file, role })
    byVersion.set(version, files)
  }
  if (byVersion.size === 0) return { ok: false, reason: t('translate.catalogue-none', { from, to }) }
  const versions = [...byVersion.keys()].sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0))
  let invalid = false
  for (const version of versions) {
    const files = [...byVersion.get(version)!.values()]
    if (missingRole('bergamot', files) !== null) continue
    // Two files of one pack cannot share a name.
    if (files.some((file) => file.name === '') || new Set(files.map((file) => file.name)).size !== files.length) {
      invalid = true
      continue
    }
    const totalBytes = files.reduce((sum, file) => sum + wireBytes(file), 0)
    const diskBytes = files.reduce((sum, file) => sum + file.size, 0)
    if (diskBytes > PACK_LIMITS.totalBytes || totalBytes > PACK_LIMITS.totalBytes) return { ok: false, reason: t('translate.catalogue-too-big') }
    return { ok: true, plan: { engine: 'bergamot', from, to, version, totalBytes, diskBytes, files } }
  }
  return { ok: false, reason: invalid ? t('translate.catalogue-invalid') : t('translate.catalogue-incomplete', { from, to }) }
}

/** The engine's binary from the records of its collection: `bergamot-translator`, of the major version the glue fits, for a release build, the newest. */
export function parseRuntimeCatalogue(raw: unknown, env: FilterEnv = RELEASE_ENV): { ok: true; plan: RuntimePlan } | { ok: false; reason: string } {
  const data = recordsOf(raw)
  if (data === 'invalid') return { ok: false, reason: t('translate.catalogue-invalid') }
  if (data === 'too-big') return { ok: false, reason: t('translate.catalogue-too-big') }
  let best: RuntimePlan | null = null
  for (const record of data) {
    if (typeof record !== 'object' || record === null) continue
    const r = record as Record<string, unknown>
    const version = r['version']
    if (r['name'] !== 'bergamot-translator' || typeof version !== 'string' || !VERSION.test(version) || Number(version.split('.')[0]) !== RUNTIME_MAJOR || !filterHolds(r['filter_expression'], env)) continue
    const file = recordFile(r, RUNTIME_LIMITS.bytes, RUNTIME_FILE_NAME)
    if (!file) continue
    const release = typeof r['release'] === 'string' && /^[A-Za-z0-9.+_-]{1,40}$/.test(r['release']) ? r['release'] : ''
    if (!best || newer(version, best.version)) best = { version, release, file: { ...file, name: RUNTIME_FILE_NAME } }
  }
  return best ? { ok: true, plan: best } : { ok: false, reason: t('translate.catalogue-no-runtime') }
}

/** The name the engine's binary is kept under. */
export const RUNTIME_FILE_NAME = 'bergamot-translator.wasm'

// ---------- the route from one language to another ----------

export interface PackRef {
  from: string
  to: string
  engine: PackEngine
}

/** The engines in the order they are preferred for a pair that has packs of both: the machine translation, then the glossary. */
export const ENGINE_PREFERENCE: readonly PackEngine[] = ['bergamot', 'glossary']

/**
 * The packs a translation may use: those whose engine can run now (the Bergamot one needs its binary), the preferred engine first for a pair that has
 * two. A pair with a Bergamot pack whose engine is not there yet falls back on a glossary of that pair if there is one; without one, the pair is missing.
 */
export function usablePacks<T extends PackRef>(packs: readonly T[], ready: readonly PackEngine[]): T[] {
  const rank = (pack: T): number => ENGINE_PREFERENCE.indexOf(pack.engine)
  return packs.filter((pack) => ready.includes(pack.engine)).sort((a, b) => rank(a) - rank(b))
}

/**
 * The packs to chain to go from a language to another: the direct one, else through English (Firefox's models pivot through English only, and never more
 * than once). When no route exists, the pairs that would make one. Of two packs of one pair, the first in the list is taken (`usablePacks` orders them).
 */
export function planRoute<T extends PackRef>(available: readonly T[], from: string, to: string): { ok: true; steps: T[] } | { ok: false; missing: Array<[string, string]> } {
  const find = (a: string, b: string): T | undefined => available.find((pack) => pack.from === a && pack.to === b)
  if (from === to) return { ok: true, steps: [] }
  const direct = find(from, to)
  if (direct) return { ok: true, steps: [direct] }
  const [first, second] = [find(from, 'en'), find('en', to)]
  // Both halves exist only when neither language is English: `find(a, 'en')` and `find('en', b)` cannot both be there for a pair that has English in it.
  if (first && second) return { ok: true, steps: [first, second] }
  if (from === 'en' || to === 'en') return { ok: false, missing: [[from, to]] }
  const missing: Array<[string, string]> = []
  if (!first) missing.push([from, 'en'])
  if (!second) missing.push(['en', to])
  return { ok: false, missing }
}

// ---------- the system's own translation ----------

/**
 * The engines in the order they are tried for a pair: the system's own translation (macOS's, when the pair is installed in the system: no pack,
 * no download), then the packs (`ENGINE_PREFERENCE`). Windows and Linux have no system engine in this build: there, Bergamot comes first.
 */
export type EngineId = 'system' | PackEngine
/** Which system's translation the `system` engine is (each system has its own, or none): the panel names it. */
export type SystemEngineKind = 'macos'
/**
 * What the system's translation says of a pair: `installed` (it translates now), `supported` (it could, once the person installs the language in the
 * system's settings: Lucium never downloads it), `unsupported`, `unavailable` (a system too old, or no helper in this build). The view adds
 * `unknown`: not asked (no pair, or a view that reads no page).
 */
export type SystemAvailability = 'installed' | 'supported' | 'unsupported' | 'unavailable'

// ---------- what the panel shows, and what it may ask ----------

export type TranslateState = 'idle' | 'working' | 'translated' | 'error'

export interface InstalledPack extends PackRef {
  version: string
  bytes: number
  /** The files were checked against their fingerprints since the pack was last written or the application started. */
  verified: boolean
  /** The folder of the pack in the models folder: `fr-en`, or `fr-en.glossary` for a glossary kept beside a downloaded model of the same pair. */
  folder: string
}

export interface TranslateView {
  /** The function is on and this window may use it. */
  enabled: boolean
  /** Private windows translate with the packs they have, and neither download nor remove any (they write nothing to disk). */
  readOnly: boolean
  page: { host: string; detection: Detection } | null
  /** The language pages are translated into: the one chosen in the settings, else the language of the interface. */
  target: string
  /** The pair the panel starts from for the page on screen (`proposedPair`), null without a page. */
  proposed: { from: string; to: string } | null
  packs: InstalledPack[]
  /** The engines this build has, by the id a pack names. */
  engines: PackEngine[]
  /** The engines that can translate now: the Bergamot one once its binary is downloaded. */
  ready: PackEngine[]
  route: { ok: true; steps: Array<[string, string]> } | { ok: false; missing: Array<[string, string]> } | null
  state: TranslateState
  /** A sentence for the panel: what happened, or what went wrong. */
  message: string
  /** After a lookup the user asked for: the files that would be downloaded, and from where. `engine`: the engine's binary (once for every language). */
  offer: { from: string; to: string; catalogue: string; files: Array<{ name: string; url: string; size: number; kind: 'model' | 'engine' }>; totalBytes: number; diskBytes: number } | null
  folder: { path: string; isDefault: boolean }
  /** The address that a lookup would contact, shown before the click. */
  lookupUrl: string | null
  /**
   * The system's own translation, when this build on this system has one (null elsewhere): what it says of the pair shown, and whether the panel can
   * open the pane of the system's settings where its languages are installed.
   */
  system: { kind: SystemEngineKind; status: SystemAvailability | 'unknown'; settingsLink: boolean } | null
  /** The engines the pair shown is translated with, in order (the system's, or the packs of the route); empty when there is no way yet. */
  using: EngineId[]
}

export type TranslateRequest =
  | { action: 'run'; from: string; to: string }
  | { action: 'restore' }
  | { action: 'lookup'; from: string; to: string }
  | { action: 'download'; from: string; to: string }
  | { action: 'adopt'; from: string; to: string }
  /** `engine`: which of the two packs a pair may have (a downloaded model and a glossary kept beside it); without it, the pair's folder. */
  | { action: 'remove'; from: string; to: string; engine?: PackEngine }
  | { action: 'folder' }
  | { action: 'folder-default' }
  | { action: 'refresh' }
  /** The packs and the folder only: nothing is read from the page (the Settings window asks this way). */
  | { action: 'packs' }
  /** Opens the pane of the system's settings where its translation languages are installed (the address is the main process', never the panel's). */
  | { action: 'system-settings' }
  /**
   * The translation in one click of the page on screen (the toolbar button's popover): the pair the panel would propose (`proposedPair`), or into `to`
   * (« Autre langue… »). Never opens the panel.
   */
  | { action: 'quick'; to?: string }
  /** « Toujours traduire <langue> », switched on or off. Refused for a private window or tab (nothing of it is written). */
  | { action: 'always'; language: string; on: boolean }
  /** « Ne jamais traduire ce site », for the site of the page on screen: the main process reads it from the page, the interface never names a site. */
  | { action: 'never-site'; on: boolean }

/** A request from the interface, checked: anything that is not exactly one of the above is refused. */
export function parseTranslateRequest(raw: unknown): TranslateRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const only = (...keys: string[]): boolean => Object.keys(r).sort().join() === ['action', ...keys].sort().join()
  switch (r['action']) {
    case 'run':
      return only('from', 'to') && isLanguageCode(r['from']) && isLanguageCode(r['to']) && r['from'] !== r['to'] ? { action: 'run', from: r['from'], to: r['to'] } : null
    case 'restore':
    case 'folder':
    case 'folder-default':
    case 'refresh':
    case 'packs':
    case 'system-settings':
      return only() ? ({ action: r['action'] } as TranslateRequest) : null
    case 'remove':
      if (only('from', 'to', 'engine') && (PACK_ENGINES as readonly unknown[]).includes(r['engine']) && isLanguageCode(r['from']) && isLanguageCode(r['to']) && r['from'] !== r['to']) {
        return { action: 'remove', from: r['from'], to: r['to'], engine: r['engine'] as PackEngine }
      }
      return only('from', 'to') && isLanguageCode(r['from']) && isLanguageCode(r['to']) && r['from'] !== r['to'] ? { action: 'remove', from: r['from'], to: r['to'] } : null
    case 'quick':
      if (only()) return { action: 'quick' }
      return only('to') && isLanguageCode(r['to']) ? { action: 'quick', to: r['to'] } : null
    case 'always':
      return only('language', 'on') && primaryLanguage(r['language']) === r['language'] && typeof r['on'] === 'boolean' ? { action: 'always', language: r['language'] as string, on: r['on'] } : null
    case 'never-site':
      return only('on') && typeof r['on'] === 'boolean' ? { action: 'never-site', on: r['on'] } : null
    case 'lookup':
    case 'download':
    case 'adopt':
      return only('from', 'to') && isLanguageCode(r['from']) && isLanguageCode(r['to']) && r['from'] !== r['to'] ? ({ action: r['action'], from: r['from'], to: r['to'] } as TranslateRequest) : null
    default:
      return null
  }
}

/** A size as the panel writes it: "31,6 Mo" in French, "31.6 MB" in English. */
export function formatSize(bytes: number): string {
  const [value, unit, digits]: [number, MessageKey, number] = bytes >= 1024 * 1024 ? [bytes / (1024 * 1024), 'translate.unit-mb', 1] : bytes >= 1024 ? [bytes / 1024, 'translate.unit-kb', 1] : [bytes, 'translate.unit-b', 0]
  return `${new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: digits }).format(value)}\u00a0${t(unit)}`
}
