// The Extensions page (chrome://extensions, arc://extensions): a tab of the window (internal-page.ts), with the look of Settings, that lists the extensions of
// each profile and gives the developer's tools an extensions page usually has (reload, errors and journal, load an unpacked folder, pack). Pure rules here:
// what the manifest says, the states and the order of the list, the messages, and the one request the page sends to the main process
// (checked again there: the page is not trusted with a path, a profile or an extension it names). The wiring is in main/shell/extensions-*.ts.

import { MANIFEST_LIST_MAX, manifestListsTooLong } from './chrome-compat'
import { DATA_APIS } from './extension-data'
import type { GrantedFacts } from './optional-permissions'
import { cleanText, describeAccess, isExtensionId, resolveMessage, DESCRIPTION_MAX, type ReviewedPermission, type ReviewedSites } from './extension-review'
import type { ExtensionInfo } from './ipc'
import { JOURNAL_MAX, journalRuns, type JournalEntry } from './extension-journal'
import { isProfileId } from './profiles'
import { INTERNAL_ORIGIN } from './internal-page'
import { t } from './i18n'
import { isRecord } from './record'
import { foldAccentsAndQuotes } from './fold'
import { settingsPath } from './settings-path'
import { mayBlockRequests } from './web-request-blocking'

// ---- what the manifest says ----

/** What a manifest says of the extension, cleaned for the page (the manifest of a folder is any text the developer wrote, or a third party's). */
export interface ExtensionFacts {
  description: string
  /** `homepage_url`, when it is an http(s) address. */
  homepage?: string
  manifestVersion: number
  permissions: ReviewedPermission[]
  sites: ReviewedSites
  optionalCount: number
  broad: boolean
  warning: string
  /** The page of options, as a path inside the extension. */
  optionsPage?: string
  /** The manifest declares a service worker (`background.service_worker`). */
  hasWorker: boolean
  sidePanel: boolean
  /** The APIs of the history, the bookmarks and the browsing data the extension asked for: Lucium gives them read-only, and only while a setting is on (extension-data.ts). */
  dataApis: string[]
  /**
   * The manifest asks to block requests from its code (see `declaresRequestBlocking`) and may not: a Manifest V3 extension. What such a listener
   * answers is not applied, and the page says so. A Manifest V2 extension's answers are applied (web-request-blocking.ts): no word for it.
   */
  requestBlocking: boolean
}

/**
 * Whether a manifest asks to block or change requests from its own code: the permission `webRequestBlocking`, which lets a listener of
 * chrome.webRequest answer "cancel" or "redirect" (Manifest V2 extensions, mostly). Only the permissions its manifest gives count: one it lists
 * as optional changes nothing here, granted or not. Lucium applies what such a listener answers for a Manifest V2 extension only, as the extension
 * platform does (`mayBlockRequests`, engine/extension-net.ts); in any other the filtering it does this way has no effect, and the page of the
 * extensions tells the person. The declarative rules of an extension (`declarativeNetRequest`) are applied, and get no warning.
 */
export function declaresRequestBlocking(manifest: unknown): boolean {
  if (!isRecord(manifest)) return false
  const permissions = Array.isArray(manifest['permissions']) ? manifest['permissions'] : []
  return permissions.includes('webRequestBlocking')
}

/** Whether a manifest is in Manifest V2, the old format: a folder in it is loaded with a warning (`legacyManifestLine`), never installed from the Web Store. */
export function isLegacyManifest(manifest: unknown): boolean {
  return isRecord(manifest) && manifest['manifest_version'] === 2
}

/** A path inside the extension: relative, with no way out of its folder and no scheme. */
export function insidePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const path = value.replace(/^\.?\//, '')
  if (path === '' || path.length > 300 || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.split(/[/\\]/).includes('..') || /\p{Cc}/u.test(path) || path.startsWith('\\')) return undefined
  return path
}

export function describeManifest(manifest: unknown, catalogue?: unknown): ExtensionFacts {
  const m = isRecord(manifest) ? manifest : {}
  const access = describeAccess(m)
  const homepage = typeof m['homepage_url'] === 'string' && /^https?:\/\//i.test(m['homepage_url']) && URL.canParse(m['homepage_url']) ? cleanText(m['homepage_url'], 300) : undefined
  const optionsUi = isRecord(m['options_ui']) ? m['options_ui']['page'] : undefined
  const optionsPage = insidePath(optionsUi ?? m['options_page'])
  const background = isRecord(m['background']) ? m['background'] : {}
  const sidePanel = isRecord(m['side_panel']) && insidePath(m['side_panel']['default_path']) !== undefined
  const asked = new Set(Array.isArray(m['permissions']) ? m['permissions'].filter((p): p is string => typeof p === 'string') : [])
  return {
    description: cleanText(resolveMessage(m['description'], catalogue), DESCRIPTION_MAX),
    ...(homepage ? { homepage } : {}),
    manifestVersion: typeof m['manifest_version'] === 'number' ? m['manifest_version'] : 0,
    permissions: access.permissions,
    sites: access.sites,
    optionalCount: access.optionalCount,
    broad: access.broad,
    warning: access.warning,
    ...(optionsPage ? { optionsPage } : {}),
    hasWorker: typeof background['service_worker'] === 'string',
    sidePanel,
    dataApis: DATA_APIS.filter((api) => asked.has(api)),
    requestBlocking: declaresRequestBlocking(m) && !mayBlockRequests(m)
  }
}

/** What the page knows of one copy of an extension (one profile) beyond what the snapshot carries; built by the engine on request. */
export interface ExtensionDetail {
  profileId: string
  id: string
  /** The folder: shown for an extension loaded from a folder (the developer wants to know which one). */
  path: string
  /** Null when the manifest could not be read: the page then says so. */
  facts: ExtensionFacts | null
  /** The service worker is running now (it stops when idle: "arrêté" is not a fault). */
  workerRunning: boolean
  /** The extension's own picture (`data:image/png`), when it has one. */
  icon?: string
  /** Why the extension is not loaded in this profile although it is not switched off: its last failed load. */
  failure?: string
  /** What the person granted it in this profile, on its request, of the permissions its manifest lists as facultative; absent when nothing is. */
  granted?: GrantedFacts
}

// ---- the request ----

export type ExtensionsRequest =
  /** The facts of every extension of every profile (read when the page opens and when the list changes). */
  | { op: 'details' }
  /** The journal entries after `since` (the consoles are listened to for as long as the page is open). */
  | { op: 'journal'; since: number }
  | { op: 'clear-journal'; extensionId?: string; profileId?: string; ids?: number[] }
  | { op: 'set-enabled'; profileId: string; extensionId: string; enabled: boolean }
  /** « Peut capter le son d'un onglet » (shared/tab-capture.ts): the person lets an extension capture the sound of a tab in this profile, or takes it back. */
  | { op: 'set-tab-capture'; profileId: string; extensionId: string; allowed: boolean }
  | { op: 'reload'; profileId: string; extensionId: string }
  /**
   * An extension of the Web Store: asks, then removes it from the profile with its files and its data. `asked`: the interface asked the same
   * question in place and the person answered it (the panel of the site), so the box of the system does not ask it a second time.
   */
  | { op: 'uninstall'; profileId: string; extensionId: string; asked?: true }
  /** An extension loaded from a folder: takes it out of every profile and forgets the folder (the files are not touched). */
  | { op: 'remove-folder'; extensionId: string }
  /** Puts back the folder `remove-folder` took out last. */
  | { op: 'undo-remove' }
  /** Opens the system's box to choose a folder, checks the manifest, loads it. */
  | { op: 'load-unpacked' }
  /** Packs a loaded folder into a `.crx`, with a private key made on this Mac (kept next to the file, never sent anywhere). */
  | { op: 'pack'; extensionId: string }
  /** The page of options, in a tab of the extension's profile. */
  | { op: 'open-options'; profileId: string; extensionId: string }
  /** Takes back one permission or one site the person granted the extension in the profile on its request (`name`: the permission, or the pattern of the site). */
  | { op: 'revoke-granted'; profileId: string; extensionId: string; name: string }
  /** Puts the id of the extension on the clipboard: the main process writes it, so that it works whether or not the window has the keyboard focus. */
  | { op: 'copy-id'; extensionId: string }

export interface ExtensionsReply {
  ok: boolean
  /** A sentence for the person: what happened, or why not. Absent when the list shows it by itself. */
  message?: string
  details?: ExtensionDetail[]
  journal?: JournalEntry[]
  /** For `journal`: the number of the last entry made, what to ask `since` with next time. */
  lastId?: number
  /** For `remove-folder`: the folder can be put back (`undo-remove`). */
  undo?: boolean
}

const SINCE_MAX = Number.MAX_SAFE_INTEGER
/** The longest permission name or site pattern a grant holds (shared/optional-permissions.ts). */
const REVOKED_NAME_MAX = 300

/** Exactly the keys that go with the operation, of the right kind: anything else is not a request of the page. */
export function parseExtensionsRequest(raw: unknown): ExtensionsRequest | null {
  if (!isRecord(raw) || typeof raw['op'] !== 'string') return null
  const keys = Object.keys(raw).filter((key) => key !== 'op').sort().join(',')
  const id = (key: string): string | null => (isExtensionId(raw[key]) ? (raw[key] as string) : null)
  const profile = (): string | null => (isProfileId(raw['profileId']) ? (raw['profileId'] as string) : null)
  switch (raw['op']) {
    case 'details':
    case 'undo-remove':
    case 'load-unpacked':
      return keys === '' ? ({ op: raw['op'] } as ExtensionsRequest) : null
    case 'journal':
      return keys === 'since' && Number.isSafeInteger(raw['since']) && (raw['since'] as number) >= 0 && (raw['since'] as number) <= SINCE_MAX ? { op: 'journal', since: raw['since'] as number } : null
    case 'clear-journal': {
      // By their numbers: the lines the page shows at the foot of the list, which belong to no card, and no other (never the journal of another profile).
      if (keys === 'ids') {
        const ids = raw['ids']
        return Array.isArray(ids) && ids.length > 0 && ids.length <= JOURNAL_MAX && ids.every((entry) => Number.isSafeInteger(entry) && entry > 0) ? { op: 'clear-journal', ids: ids as number[] } : null
      }
      if (!['', 'extensionId', 'extensionId,profileId', 'profileId'].includes(keys)) return null
      const request: ExtensionsRequest = { op: 'clear-journal' }
      if ('extensionId' in raw) {
        const extensionId = id('extensionId')
        if (extensionId === null) return null
        request.extensionId = extensionId
      }
      if ('profileId' in raw) {
        const profileId = profile()
        if (profileId === null) return null
        request.profileId = profileId
      }
      return request
    }
    case 'set-enabled': {
      const profileId = profile()
      const extensionId = id('extensionId')
      return keys === 'enabled,extensionId,profileId' && profileId !== null && extensionId !== null && typeof raw['enabled'] === 'boolean' ? { op: 'set-enabled', profileId, extensionId, enabled: raw['enabled'] } : null
    }
    case 'uninstall': {
      const profileId = profile()
      const extensionId = id('extensionId')
      if (profileId === null || extensionId === null) return null
      if (keys === 'extensionId,profileId') return { op: 'uninstall', profileId, extensionId }
      // Only a plain `true` says that the question was answered: any other value is not a request of the page.
      return keys === 'asked,extensionId,profileId' && raw['asked'] === true ? { op: 'uninstall', profileId, extensionId, asked: true } : null
    }
    case 'set-tab-capture': {
      const profileId = profile()
      const extensionId = id('extensionId')
      return keys === 'allowed,extensionId,profileId' && profileId !== null && extensionId !== null && typeof raw['allowed'] === 'boolean' ? { op: 'set-tab-capture', profileId, extensionId, allowed: raw['allowed'] } : null
    }
    case 'reload':
    case 'open-options': {
      const profileId = profile()
      const extensionId = id('extensionId')
      return keys === 'extensionId,profileId' && profileId !== null && extensionId !== null ? ({ op: raw['op'], profileId, extensionId } as ExtensionsRequest) : null
    }
    case 'revoke-granted': {
      const profileId = profile()
      const extensionId = id('extensionId')
      const name = raw['name']
      // A name of a permission or a match pattern, as the page was given it: short, and with nothing invisible in it.
      const named = typeof name === 'string' && name !== '' && name.length <= REVOKED_NAME_MAX && !/\p{Cc}|\p{Cf}/u.test(name)
      return keys === 'extensionId,name,profileId' && profileId !== null && extensionId !== null && named ? { op: 'revoke-granted', profileId, extensionId, name: name as string } : null
    }
    case 'remove-folder':
    case 'copy-id':
    case 'pack': {
      const extensionId = id('extensionId')
      return keys === 'extensionId' && extensionId !== null ? ({ op: raw['op'], extensionId } as ExtensionsRequest) : null
    }
    default:
      return null
  }
}

// ---- where the page opens ----

/** What the page is told to show: the list, or the page of one extension (`?id=` of the address), or the shortcuts of all of them. */
export type ExtensionsTarget = { view: 'list' } | { view: 'detail'; extensionId: string; profileId?: string } | { view: 'shortcuts' }

/** A target the interface sent, checked: exactly the keys of one of the three views, an id and a profile that are really ones. Null for anything else. */
export function cleanExtensionsTarget(raw: unknown): ExtensionsTarget | null {
  if (!isRecord(raw)) return null
  const keys = Object.keys(raw).sort().join(',')
  if (raw['view'] === 'list' || raw['view'] === 'shortcuts') return keys === 'view' ? ({ view: raw['view'] } as ExtensionsTarget) : null
  if (raw['view'] !== 'detail' || !isExtensionId(raw['extensionId'])) return null
  if (keys === 'extensionId,view') return { view: 'detail', extensionId: raw['extensionId'] }
  return keys === 'extensionId,profileId,view' && isProfileId(raw['profileId']) ? { view: 'detail', extensionId: raw['extensionId'], profileId: raw['profileId'] } : null
}

/**
 * The path and query the page keeps its place in: `/` for the list, `/shortcuts`, `/?id=<extension>&profile=<profile>` for one extension. The page writes them to
 * its own address as it goes (history.pushState, so that nothing reloads), and the tab shows them after `chrome://extensions`, as Chrome does.
 */
export function extensionsPath(target: ExtensionsTarget): string {
  if (target.view === 'shortcuts') return '/shortcuts'
  if (target.view === 'detail') return `/?id=${target.extensionId}${target.profileId !== undefined ? `&profile=${encodeURIComponent(target.profileId)}` : ''}`
  return '/'
}

/** What a location asks for. An id or a profile that is not one is left out: the list is shown. */
export function parseExtensionsLocation(pathname: string, search: string): ExtensionsTarget {
  if (pathname === '/shortcuts') return { view: 'shortcuts' }
  const params = new URLSearchParams(search)
  const extensionId = params.get('id')
  if (!isExtensionId(extensionId)) return { view: 'list' }
  const profileId = params.get('profile')
  return { view: 'detail', extensionId, ...(isProfileId(profileId) ? { profileId } : {}) }
}

/** The address of the page in a tab (the real one, `lucium-ui://extensions/…`: what the shell loads and the state keeps). */
export function internalPageUrl(target: ExtensionsTarget = { view: 'list' }): string {
  return `${INTERNAL_ORIGIN}${extensionsPath(target)}`
}

// ---- the list ----

export type ExtensionState = 'enabled' | 'disabled' | 'failed'

/** On: it runs. Failed: it is not switched off but is not loaded (its last load failed). Off: the user switched it off in this profile. */
export function extensionState(info: Pick<ExtensionInfo, 'enabled'>, detail?: Pick<ExtensionDetail, 'failure'>): ExtensionState {
  if (info.enabled) return 'enabled'
  return detail?.failure !== undefined ? 'failed' : 'disabled'
}

export interface ExtensionRow {
  info: ExtensionInfo
  detail?: ExtensionDetail
  state: ExtensionState
  /** The errors in the journal for this copy of the extension. */
  errors: number
  warnings: number
}

const fold = foldAccentsAndQuotes

/** The rows of one profile, with what the page needs to draw each one. */
export function extensionRows(infos: readonly ExtensionInfo[], details: readonly ExtensionDetail[], journal: readonly JournalEntry[], profileId: string): ExtensionRow[] {
  const known = new Map(details.map((d) => [`${d.profileId}:${d.id}`, d]))
  return infos
    .filter((info) => info.profileId === profileId)
    .map((info) => {
      const detail = known.get(`${info.profileId}:${info.id}`)
      // The counts are the lines the page shows: a message said twelve times is one error (journalRuns).
      const own = journalRuns(journal.filter((e) => e.extensionId === info.id && e.profileId === info.profileId))
      return { info, ...(detail ? { detail } : {}), state: extensionState(info, detail), errors: own.filter((r) => r.entry.level === 'error').length, warnings: own.filter((r) => r.entry.level === 'warning').length }
    })
}

/** By name (accents and case ignored), then by id: an order that does not move when something is switched off. */
export function sortRows<T extends { info: Pick<ExtensionInfo, 'name' | 'id'> }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => fold(a.info.name).localeCompare(fold(b.info.name), 'fr') || a.info.id.localeCompare(b.info.id))
}

/** The rows whose name, id or description holds what was typed (every word of it); all of them for an empty search. */
export function filterRows<T extends { info: Pick<ExtensionInfo, 'name' | 'id'>; detail?: { facts: Pick<ExtensionFacts, 'description'> | null } }>(rows: readonly T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter((row) => {
    const text = fold(`${row.info.name} ${row.info.id} ${row.detail?.facts?.description ?? ''}`)
    return words.every((word) => text.includes(word))
  })
}

/** The profiles the list can show: those with an extension, the one asked for first when it is there (the address names it), else the default one. */
export function listedProfiles(infos: readonly ExtensionInfo[], preferred?: string): string[] {
  const ids = [...new Set(infos.map((info) => info.profileId))].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
  return preferred !== undefined && ids.includes(preferred) ? [preferred, ...ids.filter((id) => id !== preferred)] : ids
}

/** The profile to show: the one chosen if it still has extensions, the one the address names, else the first. */
export function profileToShow(infos: readonly ExtensionInfo[], chosen: string | undefined, fromAddress?: string): string | undefined {
  const ids = listedProfiles(infos)
  if (chosen !== undefined && ids.includes(chosen)) return chosen
  if (fromAddress !== undefined && ids.includes(fromAddress)) return fromAddress
  return ids[0]
}

/** The copy an address names (`?id=`): in the profile asked for when it has it, else in the first profile that has it. */
export function copyToShow(infos: readonly ExtensionInfo[], extensionId: string, profileId?: string): ExtensionInfo | undefined {
  const copies = infos.filter((info) => info.id === extensionId)
  return copies.find((info) => info.profileId === profileId) ?? copies.find((info) => info.profileId === 'default') ?? copies[0]
}

// ---- the journal in the cards ----

/** The entries a card shows: those of its own extension, in its own profile (an entry that names no profile is the extension's, whichever copy it is). */
export function journalOf(journal: readonly JournalEntry[], info: Pick<ExtensionInfo, 'id' | 'profileId'>): JournalEntry[] {
  return journal.filter((e) => e.extensionId === info.id && (e.profileId === undefined || e.profileId === info.profileId))
}

/**
 * The entries of the journal at the foot of the list: those of the profile that no card shows (a folder that would not load, a message of an
 * extension that is not listed). `listed` is every extension of the profile, not only those the search lets through: hiding a card must not move its
 * messages down here.
 */
export function unlistedJournal(journal: readonly JournalEntry[], listed: readonly Pick<ExtensionInfo, 'id'>[], profileId: string): JournalEntry[] {
  const ids = new Set(listed.map((info) => info.id))
  const ofProfile = (e: JournalEntry): boolean => e.profileId === undefined || e.profileId === profileId
  return journal.filter((e) => (ofProfile(e) || e.source === 'load') && !(e.extensionId !== undefined && ids.has(e.extensionId) && ofProfile(e)))
}

/** The journal the page holds once the entries with these numbers were forgotten. */
export function keptAfterClear(journal: readonly JournalEntry[], ids: readonly number[]): JournalEntry[] {
  const gone = new Set(ids)
  return journal.filter((entry) => !gone.has(entry.id))
}

// ---- developer mode of the page ----

/** Where the page remembers its switch "Mode développeur" (the storage of the page itself: it is a convenience of this page, not a setting). */
export const DEVELOPER_MODE_KEY = 'lucium.extensions.developerMode'

export type DeveloperModeStorage = Pick<Storage, 'getItem' | 'setItem'>

/** The page used to show every tool: developer mode is on until the person switches it off, and so it is whenever the storage cannot say. */
export function readDeveloperMode(storage: () => DeveloperModeStorage = () => globalThis.localStorage): boolean {
  try {
    return storage().getItem(DEVELOPER_MODE_KEY) !== 'off'
  } catch (error) {
    console.debug('[extensions] developer mode cannot be read, the tools are shown:', error)
    return true
  }
}

/** Remembers the switch. False when it could not be written: the page keeps working, the next page opens with what was remembered before. */
export function writeDeveloperMode(on: boolean, storage: () => DeveloperModeStorage = () => globalThis.localStorage): boolean {
  try {
    storage().setItem(DEVELOPER_MODE_KEY, on ? 'on' : 'off')
    return true
  } catch (error) {
    console.debug('[extensions] developer mode cannot be remembered:', error)
    return false
  }
}

// ---- messages ----

/** The sentence under the title of the state of a row. */
export function stateLabel(state: ExtensionState): string {
  return state === 'enabled' ? t('extpage.activee') : state === 'failed' ? t('extpage.non-chargee') : t('extpage.desactivee')
}

/** Why the link "Inspecter" of the service worker cannot be used: Electron has no way to open the developer tools of a worker. */
export const inspectDisabledReason = (): string => t('extpage.electron-ne-permet-pas-d-ouvrir-les-outils-de-developpement')

/** A folder Lucium itself refuses to load, with the sentence for the person as its message. */
export class ManifestRefusal extends Error {}

/** Why a folder whose manifest lists more than the review reads is not loaded (the same bound as a package of the Web Store: `MANIFEST_LIST_MAX`). */
export const manifestTooLongMessage = (): string => t('extpage.manifest-json-liste-trop-d-autorisations-ou-de-sites', { max: MANIFEST_LIST_MAX })

/**
 * What the engine said when a folder would not load, in a sentence a developer can act on. The text is Chromium's or ours: it is cleaned, and the
 * folder (already named next to it) is taken out of it.
 */
export function describeLoadError(error: unknown, folder?: string): string {
  // A sentence of ours already: said as it is.
  if (error instanceof ManifestRefusal) return error.message
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  // Chromium says "Loading extension at <folder> failed with: <reason>": the folder is named next to the sentence already, only the reason is kept.
  let text = cleanText(raw, 600).replace(/^Loading extension at .*?\bfailed with:\s*/i, '')
  if (folder !== undefined && folder !== '') text = text.split(folder).join('').replace(/\s+/g, ' ').trim()
  const notJson = /^Manifest is not valid JSON\.?\s*(.*)$/i.exec(text)
  if (notJson) return t('extpage.manifest-json-n-est-pas-du-json-valide-text', { text: notJson[1] ?? '' })
  // The folder was moved or deleted since it was chosen (its row in Settings, a load at launch): said in words, not as the engine's English.
  if (/extension directory not found/i.test(text)) return t('extpage.le-dossier-n-existe-plus-a-cet-endroit')
  if (/manifest file is missing or unreadable|could not load manifest/i.test(text)) return t('extpage.le-dossier-ne-contient-pas-de-manifest-json-lisible')
  if (/manifest version 2|manifest_version.*(2|deprecated)/i.test(text)) return t('extpage.cette-extension-est-au-format-manifest-v2-que-le-moteur')
  if (/already loaded|duplicate/i.test(text)) return t('extpage.cette-extension-est-deja-chargee')
  return text === '' ? t('extpage.le-moteur-a-refuse-l-extension-sans-dire-pourquoi') : t('extpage.le-moteur-a-refuse-l-extension-text', { text })
}

export type ManifestCheck = { ok: true; manifest: Record<string, unknown> } | { ok: false; message: string }

/**
 * The first check of a folder, before anything is unloaded or loaded: the manifest is JSON, an object, in Manifest V3 or in Manifest V2, with a name
 * and a version. A Manifest V2 folder is loaded, as Settings › Extensions loads one (the engine accepts it: engine check `mv2-blocking`); the page
 * says that the format is old (`legacyManifestLine`). Only the review of a package of the Web Store stays on Manifest V3 (extension-review.ts).
 */
export function checkManifestText(text: string): ManifestCheck {
  let parsed: unknown
  try {
    // A byte order mark is skipped by its code point, written out so that no editor can drop it.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    return { ok: false, message: t('extpage.manifest-json-n-est-pas-du-json-valide-text', { text: cleanText((error as Error).message, 160) }) }
  }
  if (!isRecord(parsed)) return { ok: false, message: t('extpage.manifest-json-doit-contenir-un-objet') }
  if (parsed['manifest_version'] !== 3 && !isLegacyManifest(parsed)) return { ok: false, message: t('extpage.manifest-json-manifest-version-doit-valoir-2-ou-3') }
  if (typeof parsed['name'] !== 'string' || parsed['name'].trim() === '') return { ok: false, message: t('extpage.manifest-json-n-a-pas-de-name') }
  if (typeof parsed['version'] !== 'string' || !/^\d+(\.\d+){0,3}$/.test(parsed['version'].trim())) return { ok: false, message: t('extpage.manifest-json-n-a-pas-de-version-valide') }
  // Past the bound of the review, the engine would apply what no sheet and no rule reads: refused like a package of the Web Store.
  if (manifestListsTooLong(parsed)) return { ok: false, message: manifestTooLongMessage() }
  return { ok: true, manifest: parsed }
}

/** The files the manifest names that must exist for the extension to work: the main process looks for each one, and the first that is missing is named. */
export function filesNamedBy(manifest: Record<string, unknown>): string[] {
  const out: unknown[] = []
  const background = isRecord(manifest['background']) ? manifest['background'] : {}
  out.push(background['service_worker'])
  for (const script of Array.isArray(manifest['content_scripts']) ? manifest['content_scripts'] : []) {
    if (!isRecord(script)) continue
    for (const key of ['js', 'css']) if (Array.isArray(script[key])) out.push(...(script[key] as unknown[]))
  }
  const action = isRecord(manifest['action']) ? manifest['action'] : {}
  out.push(action['default_popup'])
  const optionsUi = isRecord(manifest['options_ui']) ? manifest['options_ui'] : {}
  out.push(optionsUi['page'], manifest['options_page'])
  const sidePanel = isRecord(manifest['side_panel']) ? manifest['side_panel'] : {}
  out.push(sidePanel['default_path'])
  // A Manifest V2 names its entry points elsewhere: the scripts or the page of its background, the popup of its browser action or page action.
  // Only for that format: a Manifest V3 may carry a `background.scripts` for another browser that the engine never reads.
  if (isLegacyManifest(manifest)) {
    if (Array.isArray(background['scripts'])) out.push(...background['scripts'])
    out.push(background['page'])
    for (const key of ['browser_action', 'page_action']) out.push(isRecord(manifest[key]) ? manifest[key]['default_popup'] : undefined)
  }
  return [...new Set(out.filter((value): value is string => typeof value === 'string').flatMap((value) => insidePath(value) ?? []))]
}

/** What an extension's data access comes to, for a line of the page: the APIs it asked for and whether the setting lets them through. */
export function dataAccessLine(dataApis: readonly string[], settingOn: boolean): string | null {
  if (dataApis.length === 0) return null
  const names = dataApis.join(', ')
  return settingOn ? t('extpage.acces-a-names-en-lecture-seule', { names, settingsPath: settingsPath('extensionDataApis') }) : t('extpage.names-demandes-mais-refuses-la-fonction-est-coupee', { names, settingsPath: settingsPath('extensionDataApis') })
}

/** The warning under an extension that asks to block requests from its code, whose answers are not applied; null for the others. */
export function requestBlockingLine(facts: Pick<ExtensionFacts, 'requestBlocking'> | null | undefined): string | null {
  return facts?.requestBlocking ? t('extpage.blocage-par-ecouteur-non-applique') : null
}

/** The warning under an extension in Manifest V2, the old format, which Lucium loads from a folder: some of its features may be missing. Null for the others. */
export function legacyManifestLine(facts: Pick<ExtensionFacts, 'manifestVersion'> | null | undefined): string | null {
  return facts?.manifestVersion === 2 ? t('extpage.manifest-v2-format-ancien') : null
}

/** The sentence for a reload, a switch, a removal or a packing that was done. */
export const doneMessages = {
  reloaded: (name: string): string => t('extpage.name-est-rechargee', { name }),
  removedFolder: (name: string): string => t('extpage.name-est-retiree-le-dossier-n-est-pas-touche', { name }),
  restoredFolder: (name: string): string => t('extpage.name-est-remise', { name }),
  /** `legacy`: the folder is in Manifest V2: the warning its row carries is said once more, at the moment it is loaded. */
  loaded: (name: string, legacy = false): string => (legacy ? `${t('extpage.name-est-chargee', { name })} ${t('extpage.manifest-v2-format-ancien')}` : t('extpage.name-est-chargee', { name })),
  uninstalled: (name: string): string => t('extpage.name-est-desinstallee', { name }),
  revoked: (extension: string, name: string): string => t('extpage.extension-n-a-plus-l-autorisation-name', { extension, name })
}
