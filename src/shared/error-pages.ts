// Pages that stand in for a page that did not load: a network failure, an untrusted certificate, a crashed tab.
// Pure: the engine (engine/error-pages.ts) decides when to show one and how; this file decides what to say and what it looks like.
// The pages are ours (built here, no file of any other browser); they are served inside the failed document, so the tab keeps the
// address the user asked for, and their buttons are links the engine intercepts (see `parseErrorAction`).

/** Scheme of the action links. The engine cancels the navigation and does the work; the scheme is never loaded. */
import { ERROR_PAGE_STYLE, errorButton, errorFrame, escapeText, type ErrorTone } from './error-page-template'
import { getLanguage, t } from './i18n'

export const ERROR_SCHEME = 'lucium-error:'
export type ErrorAction = 'retry' | 'proceed' | 'http' | 'back' | 'reload' | 'wait' | 'network-settings' | 'home' | 'copy-address' | 'open-mini-window' | 'toggle-blocker'

const ACTIONS: readonly ErrorAction[] = ['retry', 'proceed', 'http', 'back', 'reload', 'wait', 'network-settings', 'home', 'copy-address', 'open-mini-window', 'toggle-blocker']

/** The address of a button. `nonce` is drawn for each page shown and only that page contains it: a site cannot forge a click on it. */
export function errorActionUrl(action: ErrorAction, nonce: string): string {
  return `${ERROR_SCHEME}${action}?n=${nonce}`
}

export function parseErrorAction(url: string): { action: ErrorAction; nonce: string } | null {
  if (!url.startsWith(ERROR_SCHEME) || !URL.canParse(url)) return null
  const parsed = new URL(url)
  const action = parsed.pathname as ErrorAction
  const nonce = parsed.searchParams.get('n')
  return ACTIONS.includes(action) && nonce ? { action, nonce } : null
}

// ---------- Which failures get a page ----------

/**
 * The name of a net error ("ERR_NAME_NOT_RESOLVED") from what Electron reports. The description is trusted before the number:
 * the numbers are Chromium's and its list changes between versions, the names are what it documents.
 */
export function errorName(code: number, description: string): string {
  const named = /ERR_[A-Z0-9_]+/.exec(description)?.[0]
  return named ?? `ERR_UNKNOWN_${Math.abs(code)}`
}

/** ERR_ABORTED: the navigation was replaced, cancelled or turned into a download. Not a failure the user needs to hear about. */
const ERR_ABORTED = -3

/** A failed main-frame load gets a page; a subframe, a cancelled load or Chromium's own error document does not. */
export function isReportableFailure(failure: { code: number; isMainFrame: boolean; url: string }): boolean {
  return failure.isMainFrame && failure.code !== ERR_ABORTED && failure.code !== 0 && !failure.url.startsWith('chrome-error:')
}

/** Certificate problems have a page of their own (and may be bypassed for the session); every other failure gets the plain one. */
export function isCertificateError(name: string): boolean {
  return name.startsWith('ERR_CERT_') || name === 'ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN' || name === 'ERR_CERTIFICATE_TRANSPARENCY_REQUIRED'
}

/**
 * Errors the user may not click through: a revoked certificate, a pinned key that does not match, a missing certificate
 * transparency proof, a known interception. The page then offers no way on.
 */
const NOT_BYPASSABLE = new Set(['ERR_CERT_REVOKED', 'ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN', 'ERR_CERTIFICATE_TRANSPARENCY_REQUIRED', 'ERR_CERT_SYMANTEC_LEGACY', 'ERR_CERT_KNOWN_INTERCEPTION_BLOCKED'])

export function canBypassCertificateError(name: string): boolean {
  return isCertificateError(name) && !NOT_BYPASSABLE.has(name)
}

/** Whether the page of a certificate error offers « Continuer quand même »: an error one may click through, on a host that did not ask for strict transport security. */
export function mayProceed(model: { name: string; strict?: true }): boolean {
  return canBypassCertificateError(model.name) && model.strict !== true
}

// ---------- A document that answered an error status and shows nothing ----------

/** What a document answering 4xx or 5xx is asked about: its visible text, and whether it holds anything that is not text or may fill itself in later. */
export interface DocumentFacts {
  textLength: number
  /** An image, a frame, a canvas, a media element, a form field or a button. */
  hasContent: boolean
  /** A script: the page may draw itself after the load (a single-page application answers 404 with its shell). */
  hasScript: boolean
}

/** Run in the document that answered the error: what `isBlankDocument` needs. A script that is cut short answers nothing, and `documentFacts` then reads a page that says something. */
export const DOCUMENT_FACTS_SCRIPT = `(() => { const body = document.body; return { textLength: ((body && body.innerText) || '').trim().length, hasContent: !!(body && body.querySelector('img,picture,video,audio,canvas,iframe,embed,object,svg,input,button,textarea,select')), hasScript: !!document.querySelector('script') } })()`

/** The answer of the script, read as data: anything that is not what was asked for counts as a page with something in it (our page never replaces what it cannot see). */
export function documentFacts(raw: unknown): DocumentFacts {
  const facts = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    textLength: typeof facts['textLength'] === 'number' && Number.isFinite(facts['textLength']) ? facts['textLength'] : 1,
    hasContent: facts['hasContent'] === false ? false : true,
    hasScript: facts['hasScript'] === false ? false : true
  }
}

/** Whether the page of an error status shows nothing at all: only such a page is replaced by ours, never a page that says something of its own. */
export function isBlankDocument(facts: DocumentFacts): boolean {
  return facts.textLength === 0 && !facts.hasContent && !facts.hasScript
}

/** The error statuses that get a page when their document is blank: every 4xx and 5xx. */
export function isStatusFailure(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 599
}

export type StatusFamily = 'missing' | 'refused' | 'server' | 'other'

/** Not found (404, 410), refused (401, 403), a problem of the site (5xx), or any other 4xx. */
export function statusFamily(status: number): StatusFamily {
  if (status === 404 || status === 410) return 'missing'
  if (status === 401 || status === 403) return 'refused'
  return status >= 500 ? 'server' : 'other'
}

/** The reason phrases of the statuses people meet; any other is shown by its number alone. */
const STATUS_PHRASES: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 408: 'Request Timeout', 410: 'Gone', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' }

/** "404 Not Found", as the technical details give it. */
export const statusLine = (status: number): string => (STATUS_PHRASES[status] ? `${status} ${STATUS_PHRASES[status]}` : String(status))

/**
 * What the page says of a status: the site answered, so the page says what the site did, not that it cannot be reached. `site` is placed in the
 * title and the hints as given: the caller escapes the text.
 */
export function describeStatus(status: number, site: string): { family: StatusFamily; kind: string; title: string; text: string; hints: string[] } {
  const family = statusFamily(status)
  switch (family) {
    case 'missing':
      return {
        family,
        kind: t('errpage.page-introuvable'),
        title: t('errpage.site-ne-trouve-pas-cette-page', { site }),
        text: t('errpage.le-site-a-repondu-mais-il-n-a-rien-a-cette-adresse'),
        hints: [t('errpage.verifiez-que-l-adresse-est-correcte'), t('errpage.revenez-a-la-page-precedente-et-suivez-le-lien'), t('errpage.allez-a-l-accueil-de-site-et-cherchez-la-page', { site })]
      }
    case 'refused':
      return { family, kind: t('errpage.acces-refuse'), title: t('errpage.site-refuse-l-acces-a-cette-page', { site }), text: t('errpage.le-site-a-repondu-mais-il-n-autorise-pas-l-acces'), hints: [t('errpage.connectez-vous-si-le-site-le-demande-puis-reessayez')] }
    case 'server':
      return { family, kind: t('errpage.probleme-du-site'), title: t('errpage.site-rencontre-un-probleme-et-n-a-pas-pu-repondre', { site }), text: t('errpage.le-site-a-repondu-mais-il-n-a-pas-pu-traiter-la'), hints: [t('errpage.reessayez-dans-un-instant-ce-genre-de-panne-passe')] }
    default:
      return { family, kind: t('errpage.erreur-du-site'), title: t('errpage.site-n-a-pas-pu-fournir-cette-page', { site }), text: t('errpage.le-site-a-repondu-mais-il-n-a-pas-pu-fournir-cette'), hints: [t('errpage.rechargez-la-page')] }
  }
}

// ---------- What to say ----------

interface Description {
  /** `site` is placed in the sentence as given: the caller decides how it is marked up (and escaped). */
  reason: (site: string) => string
  hints?: string[]
}

const checkAddress = (): string => t('errpage.verifiez-que-l-adresse-est-correcte')
const checkNetwork = (): string => t('errpage.verifiez-votre-connexion-internet')

const descriptions = (): Record<string, Description> => ({
  ERR_NAME_NOT_RESOLVED: { reason: (s) => t('errpage.l-adresse-de-site-est-introuvable', { site: s }), hints: [checkAddress(), checkNetwork(), t('errpage.verifiez-la-configuration-dns-de-votre-reseau')] },
  ERR_NAME_RESOLUTION_FAILED: { reason: (s) => t('errpage.l-adresse-de-site-n-a-pas-pu-etre-resolue', { site: s }), hints: [checkAddress(), checkNetwork()] },
  ERR_CONNECTION_REFUSED: { reason: (s) => t('errpage.site-a-refuse-la-connexion', { site: s }), hints: [t('errpage.le-serveur-est-peut-etre-arrete-ou-le-port-est'), t('errpage.verifiez-le-pare-feu-et-le-proxy')] },
  ERR_INTERNET_DISCONNECTED: { reason: () => t('errpage.vous-n-etes-pas-connecte-a-internet'), hints: [t('errpage.verifiez-le-wi-fi-ou-le-cable-reseau'), t('errpage.rechargez-la-page-une-fois-la-connexion-retablie')] },
  ERR_CONNECTION_TIMED_OUT: { reason: (s) => t('errpage.site-a-mis-trop-de-temps-a-repondre', { site: s }), hints: [checkNetwork(), t('errpage.le-serveur-est-peut-etre-surcharge-ou-bloque')] },
  ERR_TIMED_OUT: { reason: (s) => t('errpage.site-a-mis-trop-de-temps-a-repondre', { site: s }), hints: [checkNetwork()] },
  ERR_CONNECTION_RESET: { reason: (s) => t('errpage.la-connexion-avec-site-a-ete-reinitialisee', { site: s }), hints: [checkNetwork()] },
  ERR_CONNECTION_CLOSED: { reason: (s) => t('errpage.site-a-ferme-la-connexion-sans-repondre', { site: s }), hints: [checkNetwork()] },
  ERR_CONNECTION_ABORTED: { reason: (s) => t('errpage.la-connexion-avec-site-a-ete-interrompue', { site: s }), hints: [checkNetwork()] },
  ERR_CONNECTION_FAILED: { reason: (s) => t('errpage.la-connexion-a-site-a-echoue', { site: s }), hints: [checkNetwork()] },
  ERR_ADDRESS_UNREACHABLE: { reason: (s) => t('errpage.site-est-inaccessible-depuis-ce-reseau', { site: s }), hints: [checkNetwork(), t('errpage.verifiez-le-vpn-et-le-proxy')] },
  ERR_NETWORK_CHANGED: { reason: () => t('errpage.la-connexion-reseau-a-change-pendant-le'), hints: [t('errpage.rechargez-la-page')] },
  ERR_NETWORK_ACCESS_DENIED: { reason: () => t('errpage.l-acces-au-reseau-est-refuse'), hints: [t('errpage.verifiez-le-pare-feu-et-les-reglages-de')] },
  ERR_PROXY_CONNECTION_FAILED: { reason: () => t('errpage.la-connexion-au-serveur-proxy-a-echoue'), hints: [t('errpage.verifiez-les-reglages-du-proxy-de-votre-systeme')] },
  ERR_TUNNEL_CONNECTION_FAILED: { reason: () => t('errpage.la-connexion-au-serveur-proxy-a-echoue'), hints: [t('errpage.verifiez-les-reglages-du-proxy-de-votre-systeme')] },
  ERR_TOO_MANY_REDIRECTS: { reason: (s) => t('errpage.site-vous-a-redirige-trop-de-fois', { site: s }), hints: [t('errpage.supprimer-les-cookies-de-ce-site-peut-resoudre')] },
  ERR_EMPTY_RESPONSE: { reason: (s) => t('errpage.site-n-a-envoye-aucune-donnee', { site: s }), hints: [t('errpage.rechargez-la-page')] },
  ERR_INVALID_RESPONSE: { reason: (s) => t('errpage.site-a-envoye-une-reponse-non-valide', { site: s }) },
  ERR_SSL_PROTOCOL_ERROR: { reason: (s) => t('errpage.site-a-envoye-une-reponse-securisee-non-valide', { site: s }), hints: [t('errpage.le-site-ne-prend-peut-etre-pas-en-charge-le')] },
  ERR_SSL_VERSION_OR_CIPHER_MISMATCH: { reason: (s) => t('errpage.site-utilise-un-protocole-de-securite-que-ce', { site: s }) },
  ERR_BLOCKED_BY_CLIENT: { reason: (s) => t('errpage.l-acces-a-site-a-ete-bloque-par-une-extension', { site: s }), hints: [t('errpage.desactivez-la-pour-ce-site-puis-rechargez-la')] },
  ERR_BLOCKED_BY_RESPONSE: { reason: (s) => t('errpage.site-a-refuse-d-etre-affiche-ici', { site: s }) },
  ERR_UNSAFE_PORT: { reason: (s) => t('errpage.le-port-de-site-est-restreint-pour-des-raisons', { site: s }) },
  ERR_FILE_NOT_FOUND: { reason: () => t('errpage.le-fichier-est-introuvable'), hints: [t('errpage.il-a-peut-etre-ete-deplace-ou-supprime')] },
  ERR_ACCESS_DENIED: { reason: () => t('errpage.l-acces-est-refuse'), hints: [t('errpage.verifiez-les-droits-sur-ce-fichier')] },
  ERR_INVALID_URL: { reason: () => t('errpage.cette-adresse-n-est-pas-valide'), hints: [checkAddress()] },
  ERR_UNKNOWN_URL_SCHEME: { reason: () => t('errpage.cette-adresse-utilise-un-protocole-inconnu') },
  ERR_CONTENT_DECODING_FAILED: { reason: (s) => t('errpage.la-reponse-de-site-n-a-pas-pu-etre-decodee', { site: s }) },
  ERR_HTTP2_PROTOCOL_ERROR: { reason: (s) => t('errpage.site-a-envoye-une-reponse-http-2-non-valide', { site: s }), hints: [t('errpage.rechargez-la-page')] },
  ERR_QUIC_PROTOCOL_ERROR: { reason: (s) => t('errpage.la-connexion-quic-avec-site-a-echoue', { site: s }), hints: [t('errpage.rechargez-la-page')] }
})

const generic = (): Description => ({ reason: (s) => t('errpage.site-n-a-pas-pu-etre-charge', { site: s }), hints: [t('errpage.rechargez-la-page'), checkNetwork()] })

const CERTIFICATE_REASONS: Record<string, string> = {
  get ERR_CERT_AUTHORITY_INVALID() { return t('errpage.le-certificat-de-securite-n-a-pas-ete-emis-par') },
  get ERR_CERT_COMMON_NAME_INVALID() { return t('errpage.le-certificat-de-securite-a-ete-emis-pour-un') },
  get ERR_CERT_DATE_INVALID() { return t('errpage.le-certificat-de-securite-est-expire-ou-pas') },
  get ERR_CERT_REVOKED() { return t('errpage.le-certificat-de-securite-de-ce-site-a-ete') },
  get ERR_CERT_WEAK_SIGNATURE_ALGORITHM() { return t('errpage.le-certificat-de-securite-est-signe-avec-un') },
  get ERR_CERT_WEAK_KEY() { return t('errpage.le-certificat-de-securite-utilise-une-cle-trop') },
  get ERR_CERT_NON_UNIQUE_NAME() { return t('errpage.le-certificat-de-securite-porte-un-nom-qui-n') },
  get ERR_CERT_VALIDITY_TOO_LONG() { return t('errpage.le-certificat-de-securite-est-valable-plus') },
  get ERR_CERT_NAME_CONSTRAINT_VIOLATION() { return t('errpage.le-certificat-de-securite-ne-respecte-pas-les') },
  get ERR_CERT_SYMANTEC_LEGACY() { return t('errpage.le-certificat-de-securite-vient-d-une-autorite') },
  get ERR_CERT_KNOWN_INTERCEPTION_BLOCKED() { return t('errpage.la-connexion-a-ce-site-est-interceptee-par-un') },
  get ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN() { return t('errpage.le-certificat-de-securite-ne-correspond-pas-a') },
  get ERR_CERTIFICATE_TRANSPARENCY_REQUIRED() { return t('errpage.le-certificat-de-securite-n-a-pas-la-preuve-de') }
}

const certificateReasonDefault = (): string => t('errpage.le-certificat-de-securite-de-ce-site-n-est-pas')

const localNetworkHint = (): string => t('errpage.sur-macos-lucium-doit-etre-autorise-a')

/** The errors a device of the local network gives when macOS does not let the application reach it (the page is there, for the other applications). */
const LOCAL_NETWORK_ERRORS: ReadonlySet<string> = new Set(['ERR_ADDRESS_UNREACHABLE', 'ERR_NETWORK_ACCESS_DENIED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_CONNECTION_FAILED'])

/**
 * Whether a host name is one of the local network: a name of that network (`.local`, `.lan`, `.home.arpa`), a private or link-local IPv4 address, or a
 * private or link-local IPv6 address. `localhost` and the loopback addresses are the machine itself, not its network.
 */
export function isLocalNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (/\.(local|lan|home\.arpa)$/.test(host)) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return /^(fe80|fc[0-9a-f]{2}|fd[0-9a-f]{2}):/.test(host)
}

/** A web address of this machine (`localhost`, a loopback address) or of the local network (`isLocalNetworkHost`). */
export function isOwnNetworkUrl(url: string): boolean {
  if (!URL.canParse(url)) return false
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || isLocalNetworkHost(host)
}

/** The pane « Réseau local » of the System Settings of macOS: a constant, never built from a page. */
export const LOCAL_NETWORK_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'

/** Whether a failed load is what macOS gives for a device of the local network the application is not allowed to reach (the page then offers the pane of the setting). */
export function isLocalNetworkFailure(name: string, url: string): boolean {
  return LOCAL_NETWORK_ERRORS.has(name) && URL.canParse(url) && isLocalNetworkHost(new URL(url).hostname)
}

/**
 * The text of the failure page for a net error: what happened (a sentence naming `site`, inserted as given) and what the user can try.
 * `localNetwork` says the address is one of the local network: for the errors macOS gives when it does not let the application there, the
 * permission is named.
 */
export function describeLoadError(name: string, site: string, localNetwork = false): { reason: string; hints: string[] } {
  const description = descriptions()[name] ?? generic()
  const hints = description.hints ?? []
  return { reason: description.reason(site), hints: localNetwork && LOCAL_NETWORK_ERRORS.has(name) ? [localNetworkHint(), ...hints] : hints }
}

export function describeCertificateError(name: string): string {
  return CERTIFICATE_REASONS[name] ?? certificateReasonDefault()
}

/** Why a renderer process went away (Electron's `render-process-gone` reasons). */
const CRASH_REASONS: Record<string, string> = {
  get crashed() { return t('errpage.le-processus-de-l-onglet-s-est-arrete-de-facon') },
  get oom() { return t('errpage.le-processus-de-l-onglet-a-manque-de-memoire') },
  get killed() { return t('errpage.le-processus-de-l-onglet-a-ete-arrete') },
  get 'launch-failed'() { return t('errpage.le-processus-de-l-onglet-n-a-pas-pu-demarrer') },
  get 'integrity-failure'() { return t('errpage.le-processus-de-l-onglet-a-ete-arrete-par-un') },
  get 'abnormal-exit'() { return t('errpage.le-processus-de-l-onglet-s-est-termine') },
  get 'memory-eviction'() { return t('errpage.le-processus-de-l-onglet-a-ete-arrete-pour') }
}

/** A renderer that exited cleanly (the page closed itself) is not a crash. */
export function isCrash(reason: string): boolean {
  return reason !== 'clean-exit'
}

export function describeCrash(reason: string): string {
  return CRASH_REASONS[reason] ?? CRASH_REASONS['crashed']!
}

// ---------- The address ----------

/** What the page calls the site: `host[:port]` of a web address, else the address itself (a file path, for instance). */
export function displaySite(url: string): string {
  if (!URL.canParse(url)) return url
  const parsed = new URL(url)
  if (parsed.protocol === 'file:') {
    try {
      return decodeURIComponent(parsed.pathname)
    } catch {
      // A malformed escape ("%E0%A4%A"): the path is shown as it was written. Throwing here would fail the error page itself.
      return parsed.pathname
    }
  }
  return parsed.host || url
}

/** The host name of a web address (no port), lower case: what a certificate exception is keyed by. '' when there is none. */
export function exceptionHost(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname.toLowerCase() : ''
}

// ---------- Certificate exceptions ----------

/**
 * The certificates the user chose to trust anyway: for one session, one host name and one certificate (its fingerprint) — the
 * usual scope of a "Proceed" button. A different certificate for the same host asks again, and so does another session (a
 * private window has its own, which goes with it). Nothing is written to disk.
 */
export class CertificateExceptions {
  private readonly bySession = new WeakMap<object, Map<string, Set<string>>>()
  /**
   * The hosts of the pages an invalid certificate was let through for in a session: the page itself, or something it loaded. Chromium keeps the
   * connection that carried it and serves the next pages of the host over it without asking again, so the host stays « Non sécurisé » for the
   * rest of the session, never a padlock.
   */
  private readonly untrustedBySession = new WeakMap<object, Set<string>>()
  /**
   * The hosts whose own certificate was let through although it was not valid (the host of the request, where `untrustedBySession` holds the host
   * of the page that made it). What such a host answers afterwards is not proof of anything: the one who intercepts the connection writes it.
   */
  private readonly letThroughBySession = new WeakMap<object, Set<string>>()

  allow(session: object, host: string, fingerprint: string): void {
    if (!host || !fingerprint) return
    let hosts = this.bySession.get(session)
    if (!hosts) this.bySession.set(session, (hosts = new Map()))
    const key = host.toLowerCase()
    let prints = hosts.get(key)
    if (!prints) hosts.set(key, (prints = new Set()))
    prints.add(fingerprint)
  }

  isAllowed(session: object, host: string, fingerprint: string): boolean {
    return !!host && !!fingerprint && this.bySession.get(session)?.get(host.toLowerCase())?.has(fingerprint) === true
  }

  /** An invalid certificate was let through for a page of `host` (its own, or one of something it loaded). */
  markUntrusted(session: object, host: string): void {
    if (!host) return
    let hosts = this.untrustedBySession.get(session)
    if (!hosts) this.untrustedBySession.set(session, (hosts = new Set()))
    hosts.add(host.toLowerCase())
  }

  /** The certificate of `host` itself was not valid and was let through, in this session. */
  markLetThrough(session: object, host: string): void {
    if (!host) return
    let hosts = this.letThroughBySession.get(session)
    if (!hosts) this.letThroughBySession.set(session, (hosts = new Set()))
    hosts.add(host.toLowerCase())
  }

  /**
   * Forgets everything that was let through in a session: the data of the session is erased on the user's word, and « tout est effacé » holds
   * for a decision about a certificate too. The next invalid certificate is asked about again.
   */
  forget(session: object): void {
    this.bySession.delete(session)
    this.untrustedBySession.delete(session)
    this.letThroughBySession.delete(session)
  }

  /** Whether an answer of `host` may have come over a certificate that was not valid, in this session. */
  wasLetThrough(session: object, host: string): boolean {
    return !!host && this.letThroughBySession.get(session)?.has(host.toLowerCase()) === true
  }

  /** Whether a page of `host` may be shown with a certificate that was not valid, in this session. */
  isUntrusted(session: object, host: string): boolean {
    return !!host && this.untrustedBySession.get(session)?.has(host.toLowerCase()) === true
  }
}

// ---------- The pages ----------

export interface CertificateFacts {
  fingerprint: string
  subject: string
  issuer: string
  /** Seconds since the epoch, as Electron reports them. */
  validFrom: number
  validUntil: number
}

export type ErrorPageModel =
  | { kind: 'load'; url: string; name: string; nonce: string }
  /** `http`: the address was asked for in http and HTTPS first tried it over https; the page offers to go back to it (never by itself). */
  /** `strict`: the host asked for strict transport security (HSTS), so the page offers no « Continuer quand même », as in the other browsers. */
  | { kind: 'certificate'; url: string; name: string; nonce: string; canGoBack: boolean; certificate: CertificateFacts | null; http?: string; strict?: true }
  | { kind: 'crash'; url: string; reason: string; nonce: string }
  /** A page whose renderer no longer answers (`unresponsive`): laid over it until it answers again, reloaded or waited for. */
  | { kind: 'hung'; url: string; nonce: string }
  /** A document that answered with an error status (404, 503…) and has nothing to show: Chromium would show its own page, Electron leaves a blank one. */
  | { kind: 'status'; url: string; status: number; nonce: string; canGoBack: boolean; /** When the page was shown (ms since the epoch): the technical details give the time. */ at: number }

export interface ErrorPage {
  /** What the tab is called: the site, as the browser names a tab that failed. */
  title: string
  /** The contents of `<head>` and of `<body>`, for a document that already exists (the failed one). */
  head: string
  body: string
}

export const escapeHtml = escapeText

const ICON_OFFLINE = `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6h20l8 8v28H10z"/><path d="M30 6v8h8"/><path d="M19 24l10 10M29 24L19 34"/></svg>`
const ICON_LOCK = `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="10" y="21" width="28" height="20" rx="4"/><path d="M16 21v-5a8 8 0 0 1 16 0v5"/><path d="M24 28v6"/></svg>`
const ICON_CRASH = `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="9" width="34" height="30" rx="5"/><path d="M17 20v2M31 20v2"/><path d="M17 33c2-4 12-4 14 0"/></svg>`

const ICON_HUNG = `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 7h20M14 41h20"/><path d="M16 7v6a8 8 0 0 0 3.2 6.4L24 24l4.8-4.6A8 8 0 0 0 32 13V7"/><path d="M16 41v-6a8 8 0 0 1 3.2-6.4L24 24l4.8 4.6A8 8 0 0 1 32 35v6"/></svg>`

const glyph = (inner: string): string => `<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`

/** The family of a failed load: a colour, an icon and a title that say at first sight a site that does not answer, a wrong address, no network, or a block. */
export function loadFamily(name: string): { tone: ErrorTone; icon: string; title: string } {
  if (['ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED', 'ERR_INVALID_URL', 'ERR_UNKNOWN_URL_SCHEME', 'ERR_FILE_NOT_FOUND'].includes(name)) {
    return { tone: 'warn', icon: glyph('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M8.5 11h5M11 8.5v5" transform="rotate(45 11 11)"/>'), title: t('errpage.ce-site-est-introuvable') }
  }
  if (['ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED'].includes(name)) {
    return { tone: 'neutral', icon: glyph('<path d="M3 9a14 14 0 0 1 18 0M6.5 12.5a9 9 0 0 1 11 0M10 16a4 4 0 0 1 4 0"/><circle cx="12" cy="19" r="0.6"/><path d="m4 4 16 16"/>'), title: t('errpage.vous-etes-hors-ligne') }
  }
  if (['ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_RESPONSE'].includes(name)) {
    return { tone: 'accent', icon: glyph('<path d="M12 3 4.5 6v6c0 4.5 3.2 7.6 7.5 9 4.3-1.4 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>'), title: t('errpage.page-bloquee') }
  }
  if (['ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_ABORTED', 'ERR_CONNECTION_FAILED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_EMPTY_RESPONSE'].includes(name)) {
    return { tone: 'danger', icon: glyph('<path d="M4 7h16v10H4z"/><path d="M8 20h8M12 17v3"/><path d="m9.5 10 5 4m0-4-5 4"/>'), title: t('errpage.ce-site-ne-repond-pas') }
  }
  return { tone: 'neutral', icon: ICON_OFFLINE, title: t('errpage.impossible-d-acceder-a-ce-site') }
}

function document_(title: string, content: string): ErrorPage {
  return {
    title,
    head: `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">${ERROR_PAGE_POLICY}<title>${escapeHtml(title)}</title><style>${ERROR_PAGE_STYLE}</style>`,
    body: `<main>${content}</main>`
  }
}

/** The home of the site a web address belongs to (its origin), or null for an address that is not a web one. */
export function homeOf(url: string): string | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? `${parsed.origin}/` : null
}

function button(action: ErrorAction, nonce: string, label: string, className: 'button' | 'proceed' | 'quiet' = 'button'): string {
  return errorButton(errorActionUrl(action, nonce), label, className)
}

function formatDate(seconds: number): string {
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toLocaleDateString(getLanguage() === 'fr' ? 'fr-FR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'
}

/**
 * The policy of an error page: its own style, and nothing else. No script, no picture, no frame, nothing loaded: every value put into the
 * markup is escaped, and should one ever not be, it would still run nothing. The buttons are links (`lucium-error:`) the engine stops.
 */
export const ERROR_PAGE_POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`

/** The page for a model: the same text in the tab, whatever the engine. */
export function renderErrorPage(model: ErrorPageModel): ErrorPage {
  const site = displaySite(model.url)
  const host = `<strong>${escapeHtml(site)}</strong>`
  if (model.kind === 'load') {
    const local = isLocalNetworkFailure(model.name, model.url)
    const { reason, hints } = describeLoadError(model.name, host, local)
    const family = loadFamily(model.name)
    return document_(
      site,
      errorFrame({
        tone: family.tone,
        icon: family.icon,
        title: family.title,
        // The address that was asked for, in monospace; two or three hints; the name of the error is folded away.
        content: `<p class="addr">${escapeHtml(model.url)}</p><p>${reason}</p>${hints.length > 0 ? `<ul>${hints.slice(0, 3).map((hint) => `<li>${escapeHtml(hint)}</li>`).join('')}</ul>` : ''}`,
        actions: `${button('retry', model.nonce, t('errpage.reessayer'))}${local ? button('network-settings', model.nonce, t('errpage.ouvrir-les-reglages-reseau-local')) : ''}${button('copy-address', model.nonce, t('errpage.copier-l-adresse'), 'quiet')}${button('open-mini-window', model.nonce, t('errpage.ouvrir-dans-une-mini-fenetre'), 'quiet')}${button('toggle-blocker', model.nonce, t('errpage.desactiver-le-bloqueur-pour-ce-site'), 'quiet')}`,
        after: `<details><summary>${escapeHtml(t('errpage.details-techniques'))}</summary><p class="code">${escapeHtml(model.name)}</p></details>`
      })
    )
  }
  if (model.kind === 'status') {
    const { family, kind, title, text, hints } = describeStatus(model.status, site)
    // Ambre for what the address got wrong (4xx), red for the site (5xx); the code is read first, then the sentence.
    const tone = family === 'server' ? 'danger' : 'warn'
    const home = homeOf(model.url)
    const when = new Date(model.at).toLocaleString(getLanguage() === 'fr' ? 'fr-FR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
    return document_(
      site,
      `<div class="ep-pill ${tone}"><span>${model.status}</span><small>${escapeHtml(kind)}</small></div><h1>${escapeHtml(title)}</h1>` +
        `<p class="ep-addr"><span class="ep-fav" aria-hidden="true">${escapeHtml(site.charAt(0).toUpperCase())}</span><span>${escapeHtml(model.url)}</span></p>` +
        `<p>${escapeHtml(text)}</p><ul>${hints.map((hint) => `<li>${escapeHtml(hint)}</li>`).join('')}</ul>` +
        `<div class="actions">${button('retry', model.nonce, t('errpage.reessayer'))}${model.canGoBack ? button('back', model.nonce, t('errpage.page-precedente'), 'quiet') : ''}${home && home !== model.url ? button('home', model.nonce, t('errpage.accueil-du-site'), 'quiet') : ''}${button('copy-address', model.nonce, t('errpage.copier-l-adresse'), 'quiet')}${button('open-mini-window', model.nonce, t('errpage.ouvrir-dans-une-mini-fenetre'), 'quiet')}${button('toggle-blocker', model.nonce, t('errpage.desactiver-le-bloqueur-pour-ce-site'), 'quiet')}</div>` +
        `<details><summary>${t('errpage.details-techniques')}</summary><dl><dt>${t('errpage.statut')}</dt><dd>${escapeHtml(statusLine(model.status))}</dd><dt>${t('errpage.adresse')}</dt><dd>${escapeHtml(model.url)}</dd><dt>${t('errpage.heure')}</dt><dd>${escapeHtml(when)}</dd></dl></details>`
    )
  }
  if (model.kind === 'crash') {
    return document_(
      site,
      errorFrame({
        tone: 'neutral',
        icon: ICON_CRASH,
        title: t('errpage.l-onglet-a-plante'),
        content:
          `<p>${t('errpage.site-ne-s-affiche-plus-reason', { site: host, reason: escapeHtml(describeCrash(model.reason)) })}</p>` +
          `<ul><li>${t('errpage.rechargez-la-page-pour-la-retrouver')}</li><li>${t('errpage.ce-qui-etait-saisi-dans-un-formulaire-et-n')}</li></ul><p class="code">${escapeHtml(model.reason)}</p>`,
        actions: button('reload', model.nonce, t('sidebar.recharger'))
      })
    )
  }
  if (model.kind === 'hung') {
    return document_(
      site,
      errorFrame({
        tone: 'warn',
        icon: ICON_HUNG,
        title: t('errpage.cette-page-ne-repond-plus'),
        content: `<p>${t('errpage.site-ne-repond-plus-elle-est-peut-etre-occupee', { site: host })}</p><ul><li>${t('errpage.attendez-un-instant-si-elle-se-remet-a-repondre')}</li><li>${t('errpage.recharger-la-page-fait-perdre-ce-qui-etait-saisi')}</li></ul>`,
        actions: `${button('reload', model.nonce, t('sidebar.recharger'))}${button('wait', model.nonce, t('errpage.attendre'), 'quiet')}`
      })
    )
  }
  const bypass = mayProceed(model) && model.certificate !== null
  const strictNote = model.strict === true ? `<p>${escapeHtml(t('errpage.site-exige-une-connexion-securisee'))}</p>` : ''
  // A device of the local network or this machine (a preproduction on `.local`, `localhost`, a private address): the way to open it without this
  // page is said, for the developer who listed it. Never for a site of the internet, where this page is the one to heed.
  const developerHint = bypass && isOwnNetworkUrl(model.url) ? `<p>${escapeHtml(t('errpage.mode-developpeur-pour-un-site-local'))}</p>` : ''
  const facts = model.certificate
  const details = facts
    ? `<details><summary>${t('errpage.details-du-certificat')}</summary><dl><dt>${t('errpage.emis-pour')}</dt><dd>${escapeHtml(facts.subject || '—')}</dd><dt>${t('errpage.emis-par')}</dt><dd>${escapeHtml(facts.issuer || '—')}</dd>` +
      `<dt>${t('errpage.valable-du')}</dt><dd>${t('errpage.from-au-until', { from: escapeHtml(formatDate(facts.validFrom)), until: escapeHtml(formatDate(facts.validUntil)) })}</dd><dt>${t('errpage.empreinte')}</dt><dd>${escapeHtml(facts.fingerprint)}</dd></dl></details>`
    : ''
  return document_(
    site,
    errorFrame({
      tone: 'danger',
      icon: ICON_LOCK,
      title: t('errpage.votre-connexion-n-est-pas-privee'),
      content: `<p>${t('errpage.des-pirates-pourraient-tenter-de-derober-vos', { site: host })}</p><p>${escapeHtml(describeCertificateError(model.name))}</p><p class="code">${escapeHtml(model.name)}</p>${strictNote}${developerHint}${details}`,
      actions: `${model.canGoBack ? button('back', model.nonce, t('errpage.retour')) : button('retry', model.nonce, t('errpage.reessayer'))}${bypass ? button('proceed', model.nonce, t('errpage.continuer-quand-meme-non-securise'), 'proceed') : ''}${model.http !== undefined ? button('http', model.nonce, t('errpage.ouvrir-en-http-non-securise'), 'quiet') : ''}`
    })
  )
}

/** A complete HTML document, for a view that is not a failed page (the cover of a crashed tab). */
export function errorPageDocument(model: ErrorPageModel): string {
  const page = renderErrorPage(model)
  return `<!doctype html><html lang="${getLanguage()}"><head>${page.head}</head><body>${page.body}</body></html>`
}
