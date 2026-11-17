// The browsers Lucium can import from, what each one can give, and the sentences the import sheet shows (a sheet that asks which
// browser, which profile, and what to bring along). Lucium writes no other browser's name: the sheet shows the name each application's
// bundle gives itself on this Mac (main/importers/app-names.ts), and the generic label below when the application is not there.

import { getLanguage, t, tp, type MessageKey, type PluralBase, type Vars } from './i18n'

export type ImportKind = 'arc' | 'chromium' | 'safari' | 'firefox' | 'html' | 'other'
/** A sidebar of spaces (spaces, tabs, folders, favourites, split views), bookmarks, the pages visited, and Tweaks. Passwords and cookies are not imported (see docs). */
export type ImportCategory = 'sidebar' | 'bookmarks' | 'history'

export interface ImportSourceDef {
  id: string
  /** The generic label: what the sheet shows when the application cannot be found on this Mac (it was removed and left its data). */
  name: string
  kind: ImportKind
  /**
   * The bundle identifiers of the application, in order of preference: how its name is read on this Mac. Several channels of one
   * browser can share a data folder (the release and the developer edition of a Gecko-based browser), so the first one installed names it.
   */
  bundleIds?: readonly string[]
  /** The folder of its data under ~/Library/Application Support. The browser of macOS lives in ~/Library/Safari. */
  support?: string
  categories: ImportCategory[]
  /** The sentence under the name, which quotes the name the sheet shows. */
  blurb: (browser: string) => string
  /** The data has no known place: the user always chooses the file (a bookmarks file, or the file of an unlisted browser). */
  pickOnly?: boolean
}

/** The generic label of a browser, by the format of its data. */
const GENERIC_NAMES: Record<Exclude<ImportKind, 'html' | 'other'>, MessageKey> = {
  arc: 'import-sources.navigateur-a-barre-laterale',
  chromium: 'import-sources.navigateur-chromium',
  safari: 'import-sources.navigateur-de-macos',
  firefox: 'import-sources.navigateur-gecko'
}

/** A browser the sheet can read where its data is: the generic label, the sentence, and how it is found. */
const browser = (id: string, kind: keyof typeof GENERIC_NAMES, bundleIds: readonly string[], support: string | undefined, categories: ImportCategory[], blurb: MessageKey): ImportSourceDef => ({
  id,
  get name() {
    return t(GENERIC_NAMES[kind])
  },
  kind,
  bundleIds,
  ...(support !== undefined ? { support } : {}),
  categories,
  blurb: (name) => t(blurb, { browser: name })
})

const BOTH: ImportCategory[] = ['bookmarks', 'history']

export const IMPORT_SOURCES: readonly ImportSourceDef[] = [
  browser('chrome', 'chromium', ['com.google.Chrome'], 'Google/Chrome', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('safari', 'safari', ['com.apple.Safari'], undefined, [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre-2'),
  browser('firefox', 'firefox', ['org.mozilla.firefox', 'org.mozilla.firefoxdeveloperedition', 'org.mozilla.nightly'], 'Firefox/Profiles', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('arc', 'arc', ['company.thebrowser.Browser'], 'Arc', ['sidebar', 'history'], 'import-sources.nous-pouvons-importer-vos-espaces-onglets'),
  browser('brave', 'chromium', ['com.brave.Browser'], 'BraveSoftware/Brave-Browser', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('edge', 'chromium', ['com.microsoft.edgemac'], 'Microsoft Edge', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('vivaldi', 'chromium', ['com.vivaldi.Vivaldi'], 'Vivaldi', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('chromium', 'chromium', ['org.chromium.Chromium'], 'Chromium', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  // Pre-release channels and forks keep their data in a folder of their own, in the same format as the browser they come from.
  browser('chrome-beta', 'chromium', ['com.google.Chrome.beta'], 'Google/Chrome Beta', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('chrome-canary', 'chromium', ['com.google.Chrome.canary'], 'Google/Chrome Canary', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('brave-beta', 'chromium', ['com.brave.Browser.beta'], 'BraveSoftware/Brave-Browser-Beta', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('brave-nightly', 'chromium', ['com.brave.Browser.nightly'], 'BraveSoftware/Brave-Browser-Nightly', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('edge-beta', 'chromium', ['com.microsoft.edgemac.Beta'], 'Microsoft Edge Beta', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('edge-dev', 'chromium', ['com.microsoft.edgemac.Dev'], 'Microsoft Edge Dev', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('edge-canary', 'chromium', ['com.microsoft.edgemac.Canary'], 'Microsoft Edge Canary', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('zen', 'firefox', ['app.zen-browser.zen'], 'zen/Profiles', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('librewolf', 'firefox', ['org.mozilla.librewolf', 'io.gitlab.librewolf-community'], 'LibreWolf/Profiles', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('waterfox', 'firefox', ['net.waterfox.waterfox'], 'Waterfox/Profiles', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  browser('floorp', 'firefox', ['one.ablaze.floorp'], 'Floorp/Profiles', [...BOTH], 'import-sources.nous-pouvons-importer-vos-signets-et-votre'),
  { id: 'html', get name() { return t('import-sources.fichier-de-signets-html') }, kind: 'html', pickOnly: true, categories: ['bookmarks'], blurb: () => t('import-sources.le-fichier-que-tout-navigateur-sait-exporter') },
  // Any other browser: the user points at the file in its profile folder, and its name tells the format.
  { id: 'other', get name() { return t('import-sources.autre-navigateur') }, kind: 'other', pickOnly: true, categories: ['bookmarks', 'history'], blurb: () => t('import-sources.autre-navigateur-blurb') }
]

export const CATEGORY_LABELS: Record<ImportCategory, string> = {
  get sidebar() { return t('import-sources.espaces-onglets-dossiers-favoris-et-vues') },
  get bookmarks() { return t('import-sources.signets') },
  get history() { return t('import-sources.historique') }
}

export const importSource = (id: unknown): ImportSourceDef | undefined => IMPORT_SOURCES.find((s) => s.id === id)

export interface ImportProfile {
  id: string
  name: string
}

/** What the sheet lists for each browser. */
export interface ImportSourceInfo {
  id: string
  name: string
  blurb: string
  categories: ImportCategory[]
  /** The profiles found on this Mac (empty for browsers that have none, or when none was found). */
  profiles: ImportProfile[]
  /** Its data was found. Safari is always offered: macOS hides its folder from an application without full disk access. */
  found: boolean
  /** Categories whose file was not found where the browser keeps it: not ticked by default, and the user can point at the file. */
  missing?: ImportCategory[]
}

/** What the sheet sends. The renderer never names a file: `pick` asks the main process to show the file chooser. */
export interface ImportRequest {
  source: string
  profile?: string
  categories: ImportCategory[]
  pick?: boolean
}

export interface ImportReport {
  ok: boolean
  /** The sentence the sheet shows: what was imported, or why nothing was. */
  message: string
  bookmarks: number
  folders: number
  history: number
  /** Left out because they are not web pages (or not something the import can carry over). */
  skipped: number
  /** Left out because the import is limited (`MAX_IMPORTED_LINKS`): valid, but more than a sidebar can hold. */
  overLimit?: number
  /** macOS refused to open the data: the sheet offers the System Settings pane and the file chooser. */
  needsDiskAccess?: boolean
  /** What the import of a sidebar of spaces brought beyond tabs and folders. */
  spaces?: number
  favorites?: number
  splits?: number
  /** One sentence per thing worth telling after the headline: what was left out and why, what an earlier import already brought, what was not found. */
  details?: string[]
  /** A file asked for was not found where the browser keeps it: the sheet offers the file chooser. */
  canPick?: boolean
  /** Links met twice in the same folder: kept once. */
  duplicates?: number
  /** On a preview that has something to import: the key that `importCommit` needs to carry it out. Nothing has been written yet. */
  token?: string
  /** On the report of an import: the key that `importUndo` needs to take it back. Only the latest import can be undone, for a short while. */
  undoToken?: string
}

/** Most links (pinned tabs) one import brings in: tens of thousands of entries is not a sidebar anyone can use. */
export const MAX_IMPORTED_LINKS = 2000
/** Most folders one import creates. */
export const MAX_IMPORTED_FOLDERS = 2000
/** Most spaces one import of a sidebar brings in (a person has a handful; a file with thousands is damaged or made to exhaust the application). */
export const MAX_IMPORTED_SPACES = 100
/** Deepest nesting of lists and tab groups an import of a sidebar follows: the sidebar's folders stop at four levels, the rest is a loop or a file made to overflow the stack. */
export const MAX_IMPORTED_DEPTH = 32
/** Most favorites one import brings in (the favorites grid of a sidebar holds a handful, not hundreds). */
export const MAX_IMPORTED_FAVORITES = 48

export const noReport = (message: string, extra: Partial<ImportReport> = {}): ImportReport => ({ ok: false, message, bookmarks: 0, folders: 0, history: 0, skipped: 0, ...extra })

/** A count the way the language of the interface writes it: "2 000" in French, "2,000" in English. */
export const countText = (n: number): string => n.toLocaleString(getLanguage() === 'en' ? 'en-US' : 'fr-FR')

/** A count in a sentence of the catalogue: the plural form comes from the rules of the language (French counts zero as singular), the number is written as above. */
export const counted = (key: PluralBase, n: number, vars?: Vars): string => tp(key, n, { ...vars, count: countText(n) })

/** The sentence after a successful import. */
export function importSummary(source: string, report: Pick<ImportReport, 'bookmarks' | 'folders' | 'history' | 'skipped' | 'overLimit'>, categories: readonly ImportCategory[]): string {
  const parts: string[] = []
  if (categories.includes('sidebar') || categories.includes('bookmarks')) {
    parts.push(t('import-summary.pinned-and-folders', { pinned: counted('import-summary.pinned', report.bookmarks), folders: counted('import-summary.folder', report.folders) }))
  }
  if (categories.includes('history')) parts.push(counted('import-summary.history', report.history))
  const skipped = report.skipped > 0 ? ` ${counted('import-summary.skipped', report.skipped)}` : ''
  const over = report.overLimit ? ` ${counted('import-summary.over-limit', report.overLimit, { limit: countText(MAX_IMPORTED_LINKS) })}` : ''
  return `${t('import-summary.headline', { source, parts: parts.join(', ') })}${skipped}${over}`
}

/**
 * The sentence of a preview: what the import would bring, before anything is written. Same counts as `importSummary`, in the future tense of a
 * question the user answers with the Confirm button. `history` is the number of pages the history would gain or update.
 */
export function previewSummary(source: string, report: Pick<ImportReport, 'bookmarks' | 'folders' | 'history' | 'skipped' | 'overLimit'>, categories: readonly ImportCategory[]): string {
  const parts: string[] = []
  if (categories.includes('sidebar') || categories.includes('bookmarks')) {
    parts.push(t('preview-summary.bookmarks-in-folders', { bookmarks: counted('preview-summary.bookmark', report.bookmarks), folders: counted('import-summary.folder', report.folders) }))
  }
  if (categories.includes('history')) parts.push(counted('import-summary.history', report.history))
  const skipped = report.skipped > 0 ? ` ${counted('import-summary.skipped', report.skipped)}` : ''
  const over = report.overLimit ? ` ${counted('preview-summary.over-limit', report.overLimit, { limit: countText(MAX_IMPORTED_LINKS) })}` : ''
  return `${t('preview-summary.headline', { source, parts: parts.join(', ') })}${skipped}${over}`
}

/** The report is a preview waiting for the user's answer: something to bring in, nothing written yet. */
export const isImportPreview = (report: Pick<ImportReport, 'ok' | 'token'> | null): boolean => report !== null && report.ok && report.token !== undefined

/** The report is of an import that can still be taken back. */
export const canUndoImport = (report: Pick<ImportReport, 'ok' | 'token' | 'undoToken'> | null): boolean => report !== null && report.ok && report.token === undefined && report.undoToken !== undefined

/** What the sheet sends back to carry out a preview or to undo an import: the key the main process made (a UUID), nothing else. */
export function parseImportToken(raw: unknown): string | null {
  return typeof raw === 'string' && /^[0-9a-f-]{8,64}$/.test(raw) ? raw : null
}

/** Opens the "Full Disk Access" pane of System Settings. */
export const DISK_ACCESS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'

/** The sentence shown when macOS refuses the data. A function: the language is read when it is asked for, not when the module loads. */
export const diskAccessMessage = (): string => t('import-sources.disk-access')

const CATEGORIES: readonly ImportCategory[] = ['sidebar', 'bookmarks', 'history']

/** What the sheet sent, checked: a browser id, an optional profile folder name, known categories, a flag. Null when anything is off. */
export function parseImportRequest(raw: unknown): ImportRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['source'] !== 'string' || r['source'].length > 40) return null
  if (!Array.isArray(r['categories']) || r['categories'].length > CATEGORIES.length || !r['categories'].every((c) => CATEGORIES.includes(c as ImportCategory))) return null
  if (r['profile'] !== undefined && (typeof r['profile'] !== 'string' || r['profile'].length > 100)) return null
  return {
    source: r['source'],
    categories: r['categories'] as ImportCategory[],
    ...(typeof r['profile'] === 'string' ? { profile: r['profile'] } : {}),
    ...(r['pick'] === true ? { pick: true } : {})
  }
}

/** Whether the sheet's Import button can be pressed: a browser is chosen, at least one thing it can give is ticked, nothing is running. */
export function canRunImport(source: Pick<ImportSourceInfo, 'categories'> | undefined, ticked: readonly ImportCategory[], busy: boolean): boolean {
  return !busy && source !== undefined && ticked.some((category) => source.categories.includes(category))
}

/** The categories to tick when a browser is chosen: everything it can give that was found (the rest needs the user to point at the file). */
export const defaultCategories = (source: Pick<ImportSourceInfo, 'categories' | 'missing'>): ImportCategory[] => source.categories.filter((category) => !source.missing?.includes(category))
