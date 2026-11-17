// The review sheet that comes before an extension is installed: what its manifest asks for, in plain French, with the wide
// permissions put first. The manifest of a package is hostile input (it is written by a third party and read before anything of
// it runs), so every field is checked for its kind, bounded and stripped of control characters before it is shown. Pure rules: the
// engine reads the manifest of the package it downloaded (never the one the store page claims) and the sheet only draws the result.

import { MANIFEST_LIST_MAX, hostPatternsOf, manifestListsTooLong } from './chrome-compat'
import { parseMatchPattern, type ParsedPattern } from './extension-access'
import { t } from './i18n'
import { isRecord } from './record'

/** `broad`: reaches data on every site or the whole browser. `sensitive`: reads personal information or acts on sites. `normal`: the rest. */
export type PermissionLevel = 'broad' | 'sensitive' | 'normal'

export interface ReviewedPermission {
  /** The name in the manifest (`tabs`, `webRequest`…), shown small next to the sentence. */
  id: string
  label: string
  level: PermissionLevel
  /** Not in the table below: shown with a generic sentence and treated with caution. */
  unknown?: boolean
}

export interface ReviewedSites {
  /** `all`: every web address. `specific`: the listed domains and addresses. `none`: no access to any site. */
  scope: 'none' | 'specific' | 'all'
  /** A sentence for the sheet. */
  line: string
  /** The patterns as written in the manifest, cleaned, at most `SITE_PATTERNS_SHOWN` of them. */
  patterns: string[]
  /** How many patterns there are in all (the sheet says "et N autres" when more are listed than shown). */
  count: number
  /** Access to the files of the computer (`file://`) is asked for. */
  files: boolean
}

export interface ExtensionReview {
  name: string
  version: string
  description: string
  permissions: ReviewedPermission[]
  sites: ReviewedSites
  /** Facultative permissions: nothing is granted for them until the extension asks and the person agrees; the sheet only says how many there are. */
  optionalCount: number
  /** True when the extension asks for a wide permission or for every site: the sheet leads with a warning. */
  broad: boolean
  /** The sentence of the warning ("Peut lire et modifier vos données sur tous les sites web."), or '' when `broad` is false. */
  warning: string
}

export type ReviewOutcome = { ok: true; review: ExtensionReview } | { ok: false; reason: string }

export const NAME_MAX = 80
export const DESCRIPTION_MAX = 400
export const VERSION_MAX = 40
export const SITE_PATTERNS_SHOWN = 8
const PATTERN_MAX = 120

const CONTROL = /\p{Cc}|\p{Cf}/gu

/** A line of text from a manifest: control and invisible format characters (bidi overrides included) become spaces, then it stops at `max`. */
export function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim() : ''
}

const TABLE: Record<string, readonly [PermissionLevel, () => string]> = {
  activeTab: ['normal', () => t('extrev.acceder-a-la-page-de-l-onglet-actif-quand-vous')],
  alarms: ['normal', () => t('extrev.programmer-des-taches-en-arriere-plan')],
  background: ['normal', () => t('extrev.rester-actif-en-arriere-plan')],
  clipboardWrite: ['normal', () => t('extrev.ecrire-dans-le-presse-papiers')],
  contextMenus: ['normal', () => t('extrev.ajouter-des-entrees-au-menu-contextuel')],
  declarativeContent: ['normal', () => t('extrev.agir-selon-le-contenu-des-pages-sans-le-lire')],
  fontSettings: ['normal', () => t('extrev.lire-et-modifier-les-reglages-de-polices')],
  idle: ['normal', () => t('extrev.savoir-si-vous-etes-inactif')],
  notifications: ['normal', () => t('extrev.afficher-des-notifications')],
  offscreen: ['normal', () => t('extrev.ouvrir-des-documents-caches-en-arriere-plan')],
  power: ['normal', () => t('extrev.empecher-la-mise-en-veille-de-l-ordinateur')],
  search: ['normal', () => t('extrev.lancer-des-recherches-avec-le-moteur-de')],
  sidePanel: ['normal', () => t('extrev.utiliser-le-panneau-lateral')],
  storage: ['normal', () => t('extrev.enregistrer-ses-propres-donnees')],
  tabGroups: ['normal', () => t('extrev.voir-et-gerer-les-groupes-d-onglets')],
  tts: ['normal', () => t('extrev.lire-du-texte-a-voix-haute')],
  unlimitedStorage: ['normal', () => t('extrev.stocker-une-grande-quantite-de-donnees')],
  'system.cpu': ['normal', () => t('extrev.lire-des-informations-sur-le-processeur')],
  'system.display': ['normal', () => t('extrev.lire-des-informations-sur-les-ecrans')],
  'system.memory': ['normal', () => t('extrev.lire-des-informations-sur-la-memoire')],

  bookmarks: ['sensitive', () => t('extrev.lire-vos-favoris-et-vos-onglets-epingles')],
  clipboardRead: ['sensitive', () => t('extrev.lire-le-contenu-du-presse-papiers')],
  cookies: ['sensitive', () => t('extrev.lire-et-modifier-vos-cookies-sur-les-sites')],
  declarativeNetRequest: ['sensitive', () => t('extrev.bloquer-des-contenus-sur-n-importe-quelle-page')],
  declarativeNetRequestFeedback: ['sensitive', () => t('extrev.voir-quelles-regles-de-blocage-ont-agi-sur-vos')],
  declarativeNetRequestWithHostAccess: ['sensitive', () => t('extrev.bloquer-ou-modifier-des-requetes-sur-les-sites')],
  dns: ['sensitive', () => t('extrev.resoudre-des-noms-de-domaine')],
  downloads: ['sensitive', () => t('extrev.gerer-vos-telechargements')],
  'downloads.open': ['sensitive', () => t('extrev.ouvrir-les-fichiers-telecharges')],
  'downloads.shelf': ['sensitive', () => t('extrev.gerer-l-affichage-des-telechargements')],
  favicon: ['sensitive', () => t('extrev.lire-les-icones-des-sites-que-vous-visitez')],
  gcm: ['sensitive', () => t('extrev.recevoir-des-messages-pousses-par-un-serveur')],
  geolocation: ['sensitive', () => t('extrev.connaitre-votre-position')],
  identity: ['sensitive', () => t('extrev.vous-connecter-a-des-services-avec-vos-comptes')],
  'identity.email': ['sensitive', () => t('extrev.connaitre-votre-adresse-e-mail')],
  loginState: ['sensitive', () => t('extrev.savoir-si-vous-etes-connecte')],
  printing: ['sensitive', () => t('extrev.envoyer-des-documents-a-vos-imprimantes')],
  readingList: ['sensitive', () => t('extrev.lire-et-modifier-votre-liste-de-lecture')],
  scripting: ['sensitive', () => t('extrev.executer-du-code-dans-les-pages-des-sites')],
  sessions: ['sensitive', () => t('extrev.acceder-a-vos-onglets-et-fenetres-recemment')],
  tabs: ['sensitive', () => t('extrev.voir-l-adresse-et-le-titre-de-tous-vos-onglets')],
  topSites: ['sensitive', () => t('extrev.lire-la-liste-des-sites-que-vous-visitez-le-plus')],
  webNavigation: ['sensitive', () => t('extrev.suivre-les-pages-que-vous-visitez')],
  webRequest: ['sensitive', () => t('extrev.observer-les-requetes-reseau-de-vos-pages')],
  'system.storage': ['sensitive', () => t('extrev.lire-des-informations-sur-vos-disques')],

  browsingData: ['broad', () => t('extrev.effacer-votre-historique-vos-cookies-et-d')],
  contentSettings: ['broad', () => t('extrev.modifier-les-reglages-des-sites-javascript')],
  debugger: ['broad', () => t('extrev.piloter-le-debogueur-des-pages-lire-et-modifier')],
  desktopCapture: ['broad', () => t('extrev.capturer-le-contenu-de-votre-ecran')],
  history: ['broad', () => t('extrev.lire-et-modifier-votre-historique-de-navigation')],
  management: ['broad', () => t('extrev.gerer-vos-autres-extensions')],
  nativeMessaging: ['broad', () => t('extrev.communiquer-avec-des-programmes-installes-sur')],
  pageCapture: ['broad', () => t('extrev.enregistrer-le-contenu-complet-des-pages')],
  privacy: ['broad', () => t('extrev.modifier-vos-reglages-de-confidentialite')],
  proxy: ['broad', () => t('extrev.controler-le-proxy-du-navigateur')],
  tabCapture: ['broad', () => t('extrev.capturer-le-contenu-de-vos-onglets')],
  webRequestAuthProvider: ['broad', () => t('extrev.repondre-aux-demandes-d-identifiants-des-sites')],
  webRequestBlocking: ['broad', () => t('extrev.bloquer-ou-modifier-vos-requetes-reseau-a-la')]
}

/** Permissions that reach the data of every site when the extension also has access to every site. */
const WIDENED_BY_ALL_SITES = new Set(['cookies', 'scripting', 'webRequest', 'declarativeNetRequestWithHostAccess', 'tabs', 'webNavigation'])

type SiteKind = { kind: 'all' } | { kind: 'files' } | { kind: 'domain'; host: string } | { kind: 'other' }

const SCHEME_WIDE = new Set(['*', 'http', 'https', 'ws', 'wss'])

/** Whether a host name is a suffix under which anyone registers a site (`com`, `co.uk`): every name below it is another site. */
export type SuffixTest = (host: string) => boolean

// Without the public suffix list (the interface does not carry it, see party.ts): a name of one label (`com`, `fr`). The engine hands the real list over.
const oneLabel: SuffixTest = (host) => !host.includes('.') && host !== 'localhost'

// What a match pattern gives access to: `<all_urls>`, a wildcard host with a wildcard or web scheme: every site; `*.example.org`: a domain.
// Every name under a public suffix (`*://*.com/*`) is every site of that suffix: said as every site, not as a domain called « com ».
export function siteKindOf(pattern: string, isSuffix: SuffixTest = oneLabel): SiteKind {
  if (pattern === '<all_urls>') return { kind: 'all' }
  const match = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)?$/.exec(pattern)
  if (!match) return { kind: 'other' }
  const [, scheme = '', host = ''] = match
  if (scheme === 'file') return { kind: 'files' }
  if (host === '*' && SCHEME_WIDE.has(scheme)) return { kind: 'all' }
  if (host === '' || host === '*') return { kind: 'other' }
  const name = host.replace(/^\*\./, '').toLowerCase()
  if (host.startsWith('*.') && SCHEME_WIDE.has(scheme) && isSuffix(name.replace(/:(?:\d+|\*)$/, '').replace(/\.$/, ''))) return { kind: 'all' }
  return { kind: 'domain', host: name }
}

// Every list is read up to the bound the rules that grant read to (`MANIFEST_LIST_MAX`); a manifest that goes past it is refused before this.
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, MANIFEST_LIST_MAX) : [])
const strings = (value: unknown): string[] => asList(value).filter((entry): entry is string => typeof entry === 'string')

/** The match patterns an extension can act on: its host permissions and the pages its content scripts are injected into. */
export function sitePatternsOf(manifest: Record<string, unknown>): string[] {
  const fromScripts = asList(manifest['content_scripts']).flatMap((script) => (isRecord(script) ? strings(script['matches']) : []))
  // The same patterns the engine grants (`hostPatternsOf`): a Manifest V3 pattern written among `permissions` grants nothing, so it is not a site here either.
  return [...new Set([...hostPatternsOf(manifest), ...fromScripts].map((p) => p.trim()).filter((p) => p !== ''))]
}

function reviewSites(patterns: readonly string[], isSuffix?: SuffixTest): ReviewedSites {
  const kinds = patterns.map((pattern) => ({ pattern, site: siteKindOf(pattern, isSuffix) }))
  const files = kinds.some((k) => k.site.kind === 'files')
  const shown = patterns.slice(0, SITE_PATTERNS_SHOWN).map((p) => cleanText(p, PATTERN_MAX))
  if (kinds.some((k) => k.site.kind === 'all')) {
    return { scope: 'all', line: t('extension-review.lire-et-modifier-vos-donnees-sur-tous-les-sites'), patterns: shown, count: patterns.length, files }
  }
  if (patterns.length === 0) return { scope: 'none', line: t('extension-review.aucun-acces-aux-pages-des-sites-web'), patterns: [], count: 0, files: false }
  const domains = [...new Set(kinds.flatMap((k) => (k.site.kind === 'domain' ? [k.site.host] : [])))]
  const many = domains.length > SITE_PATTERNS_SHOWN
  const line = domains.length === 0 ? t('extension-review.lire-et-modifier-vos-donnees-sur-certaines') : many ? t('extension-review.lire-et-modifier-vos-donnees-sur-length-domaines', { length: domains.length }) : t('extension-review.lire-et-modifier-vos-donnees-sur-domains', { domains: domains.map((d) => cleanText(d, PATTERN_MAX)).join(', ') })
  return { scope: 'specific', line: files ? t('extension-review.line-acceder-aux-fichiers-de-votre-ordinateur', { line }) : line, patterns: shown, count: patterns.length, files }
}

const LEVEL_ORDER: Record<PermissionLevel, number> = { broad: 0, sensitive: 1, normal: 2 }

function reviewPermission(id: string, allSites: boolean): ReviewedPermission {
  const row = TABLE[id]
  if (!row) return { id, label: t('extrev.autorisation-id-inconnue-d-lucium', { id }), level: 'sensitive', unknown: true }
  const [level, text] = row
  return { id, label: text(), level: allSites && WIDENED_BY_ALL_SITES.has(id) && level !== 'broad' ? 'broad' : level }
}

/** `__MSG_name__` → the text of the default locale's catalogue (`_locales/<locale>/messages.json`), else the key is dropped. */
export function resolveMessage(text: unknown, catalogue: unknown): string {
  if (typeof text !== 'string') return ''
  const match = /^__MSG_([A-Za-z0-9_@]{1,100})__$/.exec(text.trim())
  if (!match) return text
  if (!isRecord(catalogue)) return ''
  const wanted = match[1]!.toLowerCase()
  for (const [key, entry] of Object.entries(catalogue)) {
    if (key.toLowerCase() === wanted && isRecord(entry) && typeof entry['message'] === 'string') return entry['message']
  }
  return ''
}

type Access = Pick<ExtensionReview, 'permissions' | 'sites' | 'optionalCount' | 'broad' | 'warning'>

/** What a manifest gives access to, whatever it is called: this never fails, so a package whose name cannot be read still has its permissions counted. */
export function describeAccess(manifest: Record<string, unknown>, isSuffix?: SuffixTest): Access {
  const sites = reviewSites(sitePatternsOf(manifest), isSuffix)
  const allSites = sites.scope === 'all'
  const names = [...new Set(strings(manifest['permissions']).map((p) => cleanText(p, 60)).filter((p) => p !== ''))]
  const permissions = names.map((id) => reviewPermission(id, allSites)).sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.id.localeCompare(b.id))
  const optionalCount = new Set([...strings(manifest['optional_permissions']), ...strings(manifest['optional_host_permissions'])]).size
  const broadPermissions = permissions.filter((p) => p.level === 'broad')
  const warning = allSites
    ? t('extension-review.cette-extension-peut-lire-et-modifier-vos')
    : broadPermissions.length > 0
      ? t('extension-review.cette-extension-demande-des-acces-etendus-a')
      : ''
  return { permissions, sites, optionalCount, broad: allSites || broadPermissions.length > 0, warning }
}

/**
 * The review of a manifest. Only Manifest V3 is installed (Chromium 156 no longer runs V2), and a package without a name or version
 * is refused: the sheet would have nothing honest to say about it. So is one whose lists are longer than what is read of them: what it
 * asks for past the bound would be granted by the engine without ever being shown. `catalogue` is the default locale's `messages.json`,
 * when there is one; `isSuffix` is the public suffix list, when the caller has it.
 */
export function reviewManifest(manifest: unknown, catalogue?: unknown, isSuffix?: SuffixTest): ReviewOutcome {
  if (!isRecord(manifest)) return { ok: false, reason: t('extension-review.le-manifeste-de-l-extension-est-illisible') }
  if (manifest['manifest_version'] !== 3) return { ok: false, reason: t('extension-review.cette-extension-utilise-un-format-ancien') }
  if (manifestListsTooLong(manifest)) return { ok: false, reason: tooLongReason() }
  const name = cleanText(resolveMessage(manifest['name'], catalogue), NAME_MAX)
  const version = cleanText(manifest['version'], VERSION_MAX)
  if (name === '') return { ok: false, reason: t('extension-review.l-extension-n-a-pas-de-nom-lisible') }
  if (version === '') return { ok: false, reason: t('extension-review.l-extension-n-a-pas-de-numero-de-version') }
  return { ok: true, review: { name, version, description: cleanText(resolveMessage(manifest['description'], catalogue), DESCRIPTION_MAX), ...describeAccess(manifest, isSuffix) } }
}

const tooLongReason = (): string => t('extension-review.le-manifeste-liste-trop-d-entrees', { max: MANIFEST_LIST_MAX })

const WEB_SCHEMES = ['http', 'https', 'ws', 'wss']
const schemesOf = (pattern: ParsedPattern): readonly string[] => (pattern.scheme === '*' ? WEB_SCHEMES : [pattern.scheme])

/**
 * Whether everything `next` matches was already matched by `old`: the schemes, the host (an exact host does not cover its subdomains, a
 * wildcard one covers them and the domains below), the port and the path (any path, or the very same one). `<all_urls>` covers everything.
 */
export function covers(old: ParsedPattern, next: ParsedPattern): boolean {
  if (old.all) return true
  const schemes = schemesOf(old)
  if (!schemesOf(next).every((scheme) => schemes.includes(scheme))) return false
  if (old.host !== '*') {
    if (next.host === '*') return false
    if (old.host.startsWith('*.')) {
      const base = old.host.slice(2)
      const name = next.host.replace(/^\*\./, '')
      if (name !== base && !name.endsWith(`.${base}`)) return false
    } else if (next.host !== old.host) return false
  }
  if (old.port !== undefined && old.port !== next.port) return false
  return old.path === '/*' || old.path === next.path
}

/**
 * What a new version asks for that the installed one did not: the permissions that are new, and the sites that are not covered (a
 * wider pattern is new: more schemes, the subdomains of a host that was exact, a wider path; a narrower one is not). Null when nothing
 * is wider; an update that widens is never applied without the sheet. A new version whose lists are longer than what is read of them
 * is never "nothing wider": it comes back as a warning, and `reviewManifest` refuses the package.
 * It looks at the access only, so a name that is a message key (`__MSG_name__`) does not hide a wider permission.
 */
export function addedAccess(previous: unknown, next: unknown, catalogue?: unknown, isSuffix?: SuffixTest): ExtensionReview | null {
  if (!isRecord(next)) return null
  const before = isRecord(previous) ? previous : {}
  const name = cleanText(resolveMessage(next['name'], catalogue), NAME_MAX) || t('extension-review.extension')
  const version = cleanText(next['version'], VERSION_MAX)
  const description = cleanText(resolveMessage(next['description'], catalogue), DESCRIPTION_MAX)
  if (manifestListsTooLong(next)) return { name, version, description, permissions: [], sites: reviewSites([]), optionalCount: 0, broad: true, warning: tooLongReason() }
  const known = new Set(strings(before['permissions']))
  const added = describeAccess(next, isSuffix).permissions.filter((p) => !known.has(p.id))
  const oldPatterns = sitePatternsOf(before)
  const oldWritten = new Set(oldPatterns)
  const oldParsed = oldPatterns.flatMap((p) => parseMatchPattern(p) ?? [])
  const newPatterns = sitePatternsOf(next).filter((pattern) => {
    if (oldWritten.has(pattern)) return false
    const parsed = parseMatchPattern(pattern)
    // A pattern that is not a match pattern is only known when it was written the same before.
    return parsed === null || !oldParsed.some((old) => covers(old, parsed))
  })
  if (added.length === 0 && newPatterns.length === 0) return null
  const sites = reviewSites(newPatterns, isSuffix)
  const broad = sites.scope === 'all' || added.some((p) => p.level === 'broad')
  return {
    name,
    version,
    description,
    permissions: added,
    sites,
    optionalCount: 0,
    broad,
    warning: broad ? t('extension-review.cette-nouvelle-version-demande-des-acces-plus') : ''
  }
}

/** Whether `id` has the shape of an extension id: 32 letters from a to p (the alphabet Chromium gives the hash of a key). */
export const isExtensionId = (value: unknown): value is string => typeof value === 'string' && /^[a-p]{32}$/.test(value)

/** What the sheet is asked for. */
export interface ExtensionReviewRequest {
  id: string
  /** `optional`: an installed extension asks for a permission its manifest lists as facultative (`chrome.permissions.request`). */
  mode: 'install' | 'update' | 'optional'
  extensionId: string
  review: ExtensionReview
  /** The name of the profile the extension goes to (it is installed there only). */
  profile: string
  /** The extension's own icon as a small `data:image/png` URL, when the package has a usable one. */
  icon?: string
}
