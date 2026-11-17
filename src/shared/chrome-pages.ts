// The internal pages of other browsers (`chrome://history`, `arc://settings`) that people type, and where each one leads here.
// The engine loads none of them (it refuses every `chrome:` address, see isNavigableUrl): the address is read by the command bar, by
// `Browser.submitUrl` and by chrome.tabs.create of an extension, and each of them opens the page of Lucium that stands for it (a panel, a
// pane of Settings), or says why there is none. `chrome://extensions` has its own entry (settings-target.ts) and is only joined here for an extension:
// it is the one of these addresses whose page is a tab, which the shell opens at an address of its own and shows as `chrome://extensions` (internal-page.ts).
// This is a reading of typed text, never a way for a web page to reach these targets: a page can open http(s) and about:blank only (isPageOpenUrl).

import type { OverlayRequest, SettingsAnchor, SettingsPane } from './ipc'
import type { Settings } from './model'
import { settingsAnchorLabel, settingsPaneLabel } from './settings-catalog'
import { extensionsPageOf } from './settings-target'
import { normalizeTabUrl } from './chrome-compat'
import { t } from './i18n'

/** What the page of Lucium that stands for an address depends on: a private window keeps no history, bookmark or password, and three of them are switches. */
export interface ChromePageContext {
  private: boolean
  settings: Pick<Settings, 'bookmarkManager' | 'passwordManager' | 'cookieManager'>
}

/** What a `chrome://` address leads to: a row of the command bar, and what Enter opens. */
export interface ChromePage {
  /** Where the address leads, or the address itself when it leads nowhere (the detail then says why). */
  label: string
  /** How it relates to the internal page of that address (an equivalent), or why there is none. */
  detail: string
  /** What opens: a panel, or a pane of Settings. Absent when nothing stands for the address. */
  request?: OverlayRequest
  /**
   * The sentence to say when the address was submitted as typed (nothing was picked in the list, so the row was not read): set when the address leads nowhere
   * or leads to something that is not that internal page. Null for a plain equivalent.
   */
  notice: string | null
}

export interface ChromeAddress {
  scheme: 'chrome' | 'arc'
  /** Lower case. */
  host: string
  /** The path segments, lower case. */
  path: string[]
  /** What was typed, trimmed, cut at 80 characters: what the messages quote. */
  text: string
}

const ADDRESS = /^(chrome|arc):\/\/([a-z0-9][a-z0-9.-]*)((?:\/[^/?#\s]*)*)(?:[?#]\S*)?$/i
const TEXT_MAX = 80

/** `chrome://settings/privacy?x#y` as parts; null for any other text (a web address, words to search for, another scheme such as chrome-extension:). */
export function parseChromeAddress(input: string): ChromeAddress | null {
  const typed = input.trim()
  const match = ADDRESS.exec(typed)
  if (!match) return null
  const text = typed.length > TEXT_MAX ? `${typed.slice(0, TEXT_MAX - 1)}…` : typed
  return { scheme: match[1]!.toLowerCase() as ChromeAddress['scheme'], host: match[2]!.toLowerCase(), path: match[3]!.split('/').filter(Boolean).map((p) => p.toLowerCase()), text }
}

// ---- the pages ----

const settingsRequest = (pane: SettingsPane, anchor?: SettingsAnchor): OverlayRequest => ({ panel: 'settings', pane, ...(anchor ? { anchor } : {}) })

/** "Réglages › <category>", or "Réglages › <group>" for an address that stands for a place inside a category. */
const settingsLabel = (pane: SettingsPane, anchor?: SettingsAnchor): string => t('cmd.settings-pane', { pane: anchor ? settingsAnchorLabel(anchor) : settingsPaneLabel(pane) })

/** An address that has an equivalent in Lucium: what it opens, and nothing to explain. */
function equivalent(address: ChromeAddress, label: string, request: OverlayRequest): ChromePage {
  return { label, detail: t('chrome-pages.equivalent-de-address', { address: address.text }), request, notice: null }
}

/** An address that leads nowhere, or somewhere else than its internal page does: `detail` says what Lucium does instead. */
function explained(address: ChromeAddress, detail: string, request?: OverlayRequest, label?: string): ChromePage {
  // An address that leads nowhere says so first; one that leads somewhere else has opened it, and the notice only says what.
  const notice = request
    ? t('chrome-pages.address-detail', { address: address.text, detail })
    : t('chrome-pages.address-sans-page', { address: address.text, detail })
  return { label: label ?? address.text, detail, ...(request ? { request } : {}), notice }
}

const toSettings = (address: ChromeAddress, pane: SettingsPane, anchor?: SettingsAnchor): ChromePage => equivalent(address, settingsLabel(pane, anchor), settingsRequest(pane, anchor))

/** `chrome://settings/<sub>`: what each part of those settings stands for here. Anything not listed opens Settings at its first pane. */
function settingsPage(address: ChromeAddress, ctx: ChromePageContext): ChromePage {
  const [sub, deeper] = address.path
  // The view of the cookies is a feature to add: switched off, the address leads to « Fonctions en option », where its switch is; a private window has
  // none, and is led to the protection of its data.
  const cookies = (): ChromePage => (ctx.private ? toSettings(address, 'protection') : !ctx.settings.cookieManager ? toSettings(address, 'features') : equivalent(address, t('cmd.cookies-par-site'), { panel: 'cookies' }))
  switch (sub) {
    case 'privacy':
    case 'security':
    case 'safetycheck':
    case 'privacysandbox':
    case 'adprivacy':
      return toSettings(address, 'protection')
    case 'clearbrowserdata':
      return toSettings(address, 'protection')
    case 'content':
      return deeper === 'cookies' || deeper === 'all' || deeper === 'sitedata' ? cookies() : toSettings(address, 'protection', 'permissions')
    case 'cookies':
    case 'sitedata':
      return cookies()
    case 'passwords':
    case 'autofill':
      return passwordsPage(address, ctx)
    case 'downloads':
      return toSettings(address, 'files', 'downloads')
    case 'help':
    case 'about':
      return toSettings(address, 'about', 'about')
    case 'searchengines':
    case 'search':
      return toSettings(address, 'navigation', 'engine')
    case 'people':
    case 'manageprofile':
      return toSettings(address, 'profiles')
    case 'syncsetup':
    case 'sync':
      return explained(address, t('chrome-pages.pas-de-synchronisation'), settingsRequest('profiles'), settingsLabel('profiles'))
    case 'onstartup':
      return toSettings(address, 'tabs')
    case 'appearance':
      return toSettings(address, 'appearance')
    case 'languages':
    case 'language':
    case 'system':
    case 'reset':
      return toSettings(address, 'home')
    case 'accessibility':
      return toSettings(address, 'appearance')
    case 'extensions':
      return equivalent(address, t('cmd.page-extensions'), { panel: 'extensions' })
    default:
      return toSettings(address, 'home')
  }
}

function passwordsPage(address: ChromeAddress, ctx: ChromePageContext): ChromePage {
  if (ctx.private) return explained(address, t('chrome-pages.prive-sans-mots-de-passe'))
  if (!ctx.settings.passwordManager) return explained(address, t('chrome-pages.mots-de-passe-desactives'), settingsRequest('protection', 'lock'), settingsLabel('protection', 'lock'))
  return equivalent(address, t('chrome-pages.mots-de-passe'), { panel: 'passwords' })
}

/** The pages of diagnostics of Chromium: none is opened in a tab (it would give a web-facing tab the privileges of an internal page; the Extensions page is the one page of Lucium that is, and only at the address of its own); the developer tools do the same work. */
const IN_DEVELOPER_TOOLS: Record<string, string> = {
  'net-internals': 'Network',
  'net-export': 'Network',
  'network-errors': 'Network',
  'view-http-cache': 'Network',
  'serviceworker-internals': 'Application',
  'indexeddb-internals': 'Application',
  'quota-internals': 'Application',
  'blob-internals': 'Application',
  'appcache-internals': 'Application',
  'media-internals': 'Media',
  tracing: 'Performance',
  accessibility: 'Elements › Accessibility'
}
const NO_STATISTICS = new Set(['histograms', 'ukm', 'metrics-internals', 'user-actions', 'usage-stats'])
const NO_SYNC = new Set(['sync-internals', 'signin-internals', 'sync'])

/**
 * What a `chrome://` or `arc://` address leads to here, or null for any other text. Null as well for `chrome://extensions`, which is
 * `extensionsPageOf` (settings-target.ts): the one entry another part of the application owns. A `chrome://` address that has nothing here is
 * answered by a page that says so (never by nothing, a web search or an invalid address).
 */
export function chromePageOf(input: string, ctx: ChromePageContext): ChromePage | null {
  const address = parseChromeAddress(input)
  if (!address || address.host === 'extensions') return null
  const { host } = address
  switch (host) {
    case 'settings':
      return settingsPage(address, ctx)
    case 'history':
      return ctx.private ? explained(address, t('chrome-pages.prive-sans-historique')) : equivalent(address, t('chrome-pages.historique'), { panel: 'history' })
    case 'downloads':
      return equivalent(address, t('chrome-pages.telechargements'), { panel: 'downloads' })
    case 'bookmarks':
      if (ctx.private) return explained(address, t('chrome-pages.prive-sans-signets'))
      return ctx.settings.bookmarkManager ? equivalent(address, t('chrome-pages.signets'), { panel: 'bookmarks' }) : explained(address, t('chrome-pages.signets-desactives'), settingsRequest('features'), settingsLabel('features'))
    case 'password-manager':
      return passwordsPage(address, ctx)
    case 'version':
    case 'about':
    case 'help':
    case 'chrome-urls':
    case 'credits':
    case 'licenses':
      return toSettings(address, 'about', 'about')
    case 'flags':
      // The switches a flag would be are « Fonctions en option »: the page that lists the features to add, which the address opens.
      return explained(address, t('chrome-pages.pas-de-drapeaux', { page: settingsPaneLabel('features') }), settingsRequest('features'), settingsLabel('features'))
    case 'newtab':
    case 'new-tab-page':
      return equivalent(address, t('chrome-pages.nouvel-onglet'), { panel: 'commandbar', mode: 'new', initial: '' })
    case 'inspect':
      return explained(address, t('chrome-pages.inspecter-une-page'))
    case 'gpu':
    case 'webrtc-internals':
    case 'process-internals':
      return explained(address, t('chrome-pages.pas-d-equivalent'))
    default:
      if (IN_DEVELOPER_TOOLS[host]) return explained(address, t('chrome-pages.dans-les-outils', { panel: IN_DEVELOPER_TOOLS[host]! }))
      if (NO_STATISTICS.has(host)) return explained(address, t('chrome-pages.pas-de-statistiques'))
      if (NO_SYNC.has(host)) return explained(address, t('chrome-pages.pas-de-synchronisation'))
      return explained(address, t('chrome-pages.inconnue'))
  }
}

/**
 * What `chrome.tabs.create({ url })` / `chrome.tabs.update(id, { url })` of an extension asks for when the address is one of the browser's own pages:
 * `chrome://extensions` included, which the library refuses like the others. Null for any other address, and for `chrome://newtab`, which is a blank
 * tab there (normalizeTabUrl: an agent opens its working tabs with it).
 */
export function extensionTabPage(url: unknown, ctx: ChromePageContext): ChromePage | null {
  if (typeof url !== 'string' || normalizeTabUrl(url) !== url) return null
  const extensions = extensionsPageOf(url)
  if (extensions) {
    const address = parseChromeAddress(url)
    return address ? equivalent(address, t('cmd.page-extensions'), { panel: 'extensions', target: extensions }) : null
  }
  return chromePageOf(url, ctx)
}
