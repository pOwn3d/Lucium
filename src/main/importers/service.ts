// "Import from Another Browser…": finds what the other browsers on this Mac hold, and brings the chosen parts in (bookmarks as a new
// space, history merged into the history, a sidebar of spaces). Everything the renderer sends is checked against what this file found:
// it never names a path, only a browser, one of that browser's profiles and the categories. Each browser is shown by the name its
// application gives itself on this Mac (app-names.ts), never by a name written here.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { addImported, NOTHING_IMPORTED, type ArcImported } from '@shared/arc-guide'
import { arcSummary, type ArcCounts } from '@shared/arc-report'
import { importedFavorites } from '@shared/favorite-scope'
import type { Favorite, Folder, HistoryEntry, SidebarState, SplitView, Space, TabItem } from '@shared/model'
import {
  IMPORT_SOURCES,
  diskAccessMessage,
  importSource,
  importSummary,
  noReport,
  previewSummary,
  type ImportCategory,
  type ImportKind,
  type ImportProfile,
  type ImportReport,
  type ImportRequest,
  type ImportSourceDef,
  type ImportSourceInfo
} from '@shared/import-sources'
import { parsePlist } from '@shared/plist'
import type { Action, Ctx } from '@shared/sidebar'
import type { PlatformId } from '@shared/platform'
import { browserDataDir, importAvailable, type PathEnv } from '../platform/paths'
import { installedAppNames, type AppName } from './app-names'
import { convertArcSidebar } from './arc'
import { convertChromeBookmarks } from './chrome'
import { convertFirefoxBookmarks } from './firefox'
import { convertNetscapeBookmarks } from './netscape'
import type { BookmarkImport } from './bookmark-tree'
import { toHistoryEntries } from './history'
import { ImportReadError, readFailureMessage } from './read-error'
import { decodeFileText } from './text-encoding'
import { convertSafariBookmarks } from './safari'
import { readChromiumHistory, readFirefoxBookmarks, readFirefoxHistory, readSafariHistory } from './sqlite'
import { NAME_MAX, printable } from '@shared/state-clean'
import { getLanguage, t, tp, type PluralBase } from '@shared/i18n'

/** A count in a sentence of the report: written with the grouping of the interface's language (plural forms come from the catalogue). */
const counted = (key: PluralBase, n: number): string => tp(key, n, { count: n.toLocaleString(getLanguage() === 'en' ? 'en-US' : 'fr-FR') })

/** What a browser's bookmarks (or a sidebar of spaces) turn into, ready for `import/merge`. */
interface Imported {
  spaces: Space[]
  tabs: TabItem[]
  folders: Folder[]
  favorites: Favorite[]
  skipped: number
  /** Valid entries the import limit kept out. */
  overLimit: number
  /** Links met twice in a folder, kept once. */
  duplicates: number
  /** The file is readable but is not a bookmarks file of that browser. */
  unrecognized: boolean
}

/**
 * Biggest bookmarks file (JSON or property list) the import reads. Real ones weigh a few megabytes (the sidebar file of a heavy user: tens);
 * a file this size is damaged, and parsing it would hold the main process for as long as it takes.
 */
export const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024

/** Biggest `Local State` read for the names of a Chromium browser's profiles: the real one weighs a few kilobytes, and the sheet reads it each time it opens. */
export const MAX_LOCAL_STATE_BYTES = 16 * 1024 * 1024

/** Longest profile name listed in the sheet: the real ones are a few words. */
const PROFILE_NAME_MAX = 80

// Not shell/bounded-file.ts on purpose: the list of a browser's profiles reads `Local State` synchronously, and the import sheet says its own sentences.
/** The file's contents, unless it is too big to be what it claims to be. */
function readBounded(path: string, max = MAX_IMPORT_FILE_BYTES): Buffer {
  const info = statSync(path)
  // A pipe or a device reports a size of zero, and reading it never ends.
  if (!info.isFile()) throw new ImportReadError(t('import.ce-n-est-pas-un-fichier-ordinaire'))
  const size = info.size
  if (size > max) throw new ImportReadError(t('import.fichier-trop-volumineux', { size: Math.round(size / 1024 / 1024), max: max / 1024 / 1024 }))
  return readFileSync(path)
}

export interface ImportDeps {
  home: string
  /** The system whose folders are looked in (macOS when not given). The Windows and Linux ones are untested guesses (docs/plateformes.md). */
  platform?: PlatformId
  /** The variables the Windows and Linux folders are built from (LOCALAPPDATA, APPDATA, XDG_CONFIG_HOME). */
  paths?: Omit<PathEnv, 'home'>
  ctx: () => Ctx
  dispatch: (action: Action) => void
  /** Why the latest import may not be taken back now (a space is locked: lock.ts `importUndoRefusal`), or null. Without it nothing refuses. */
  undoRefusal?: () => string | null
  /** Adds pages to the visit history; answers how many it now holds that it did not before, or were updated. */
  mergeHistory: (entries: HistoryEntry[]) => number
  /** The file chooser, for data macOS keeps from the application: resolves to the path the user picked, or null. */
  chooseFile: (source: ImportSourceDef, expected: string) => Promise<string | null>
  /** XML text of a property list given its bytes (binary or XML). */
  plistToXml?: (bytes: Buffer) => Promise<string>
  /** The state the sidebar holds now: an import of a sidebar tells what an earlier one already brought from it. */
  state: () => SidebarState
  /**
   * The folders of applications whose bundles name the browsers (`/Applications`, `~/Applications`). Without them every browser keeps
   * its generic label (the tests, and a system that has no such folders).
   */
  applications?: readonly string[]
  /** How many of these pages the history would add or change, without touching it: the preview's count. Without it the preview counts the pages it read. */
  countHistory?: (entries: HistoryEntry[]) => number
  /** Like `mergeHistory`, and gives the way back: what lets the import be taken back. Without it the pages stay when the rest is undone. */
  mergeHistoryTracked?: (entries: HistoryEntry[]) => { touched: number; undo: () => number }
}

/** How long a preview can be confirmed: the files it read may have changed since. */
export const PREVIEW_VALID_MS = 15 * 60_000
/** How long the latest import can be taken back. */
export const UNDO_WINDOW_MS = 15 * 60_000

/** What an import has put in the sidebar and the history: the ids to take away, and how to take the pages back. */
interface Brought {
  spaces: string[]
  tabs: string[]
  folders: string[]
  favorites: string[]
  splits: string[]
  history: Array<() => number>
}

const nothingBrought = (): Brought => ({ spaces: [], tabs: [], folders: [], favorites: [], splits: [], history: [] })
const wasBrought = (b: Brought): boolean => b.history.length > 0 || b.spaces.length + b.tabs.length + b.folders.length + b.favorites.length + b.splits.length > 0

/** Everything an import will do, read and checked, but not yet done. */
interface Plan {
  /** The preview: what would come in, or why nothing can. */
  report: ImportReport
  /** Does it and answers the report of the import. Absent when there is nothing to do. */
  apply?: () => ImportReport
}

/** The format of a file the user picked for "Autre navigateur", from its name. */
function kindOfFile(path: string): ImportKind | null {
  const name = basename(path)
  if (name === 'Bookmarks' || name === 'History') return 'chromium'
  if (name === 'places.sqlite') return 'firefox'
  if (name === 'Bookmarks.plist' || name === 'History.db') return 'safari'
  return /\.html?$/i.test(name) ? 'html' : null
}

const isDenied = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'EACCES'
}

/** The most XML `plutil` may print: a binary plist of a few megabytes can expand a great deal, and the output is held in memory. */
export const MAX_PLIST_XML_BYTES = 200 * 1024 * 1024

/** macOS converts a binary plist to XML itself (`plutil`): a second parser here would have to be kept right. */
export function plutilToXml(bytes: Buffer, maxOutputBytes = MAX_PLIST_XML_BYTES): Promise<string> {
  const head = bytes.subarray(0, 64).toString('utf8')
  if (head.includes('<?xml') || head.includes('<plist')) return Promise.resolve(bytes.toString('utf8'))
  return new Promise((resolve, reject) => {
    // Its messages are not read, so its error output goes nowhere: a tool that fills a pipe nobody empties would wait for ever.
    const child = spawn('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const out: Buffer[] = []
    let size = 0
    let tooBig = false
    const timer = setTimeout(() => child.kill(), 20_000)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxOutputBytes) {
        // Stop at once and keep nothing more: the answer is a refusal, not a partial document.
        if (!tooBig) child.kill()
        tooBig = true
        out.length = 0
        return
      }
      out.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (tooBig) reject(new Error(`plutil printed more than ${maxOutputBytes} bytes`))
      else if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new Error(`plutil exited with ${String(code)}`))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(bytes)
  })
}

export class ImportService {
  /** The preview the sheet shows now, waiting for the user's answer. One at a time: a new preview replaces it. */
  private pending: { token: string; at: number; apply: () => ImportReport } | null = null
  /** The latest import, which can be taken back. */
  private last: (Brought & { token: string; at: number }) | null = null
  /** The name the sheet shows for each browser, by id, as the latest list gave it: the sentences of an import say the same name. */
  private shown = new Map<string, string>()
  /**
   * The imports from Arc that brought something and were not taken back, until the guide « Vous venez d’Arc ? » has taken them (`takeArcGuide`). Only the import
   * of the browser the person chose as Arc is here: a file picked for another browser, a bookmarks file or any other browser never is.
   */
  private arcImports: Array<{ token: string; imported: ArcImported }> = []

  constructor(private readonly deps: ImportDeps) {}

  /** The folder of the profiles of a browser, or null when this system has none known for it. */
  private supportDir(def: ImportSourceDef): string | null {
    return browserDataDir(def, this.deps.platform ?? 'darwin', { ...this.deps.paths, home: this.deps.home })
  }

  profilesOf(def: ImportSourceDef): ImportProfile[] {
    try {
      if (def.kind === 'chromium') {
        const dir = this.supportDir(def)
        if (dir === null) return []
        let names: Record<string, { name?: unknown }> = {}
        try {
          const state = JSON.parse(decodeFileText(readBounded(join(dir, 'Local State'), MAX_LOCAL_STATE_BYTES))) as { profile?: { info_cache?: Record<string, { name?: unknown }> } }
          names = state.profile?.info_cache ?? {}
        } catch {
          // Without the list of names the folder names are shown.
        }
        return readdirSync(dir)
          .filter((entry) => /^(Default|Profile \d+)$/.test(entry) && (existsSync(join(dir, entry, 'Bookmarks')) || existsSync(join(dir, entry, 'History'))))
          .sort((a, b) => (a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, 'en', { numeric: true })))
          // The name comes from a file another program writes: one line, bounded, since the sheet lists it in a menu.
          .map((id) => ({ id, name: printable(names[id]?.name, PROFILE_NAME_MAX)?.trim() || id }))
      }
      if (def.kind === 'firefox') {
        const dir = this.supportDir(def)
        if (dir === null) return []
        // The folder names start with a random prefix, so the folder order says nothing about which profile is the one in use: the one
        // a Gecko-based browser makes for itself in recent versions ("default-release") comes first, then the older "default", then the others by name.
        const rank = (id: string): number => (/\.default-release$/.test(id) ? 0 : /\.default$/.test(id) ? 1 : 2)
        return readdirSync(dir)
          .filter((entry) => existsSync(join(dir, entry, 'places.sqlite')))
          .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'en', { numeric: true }))
          .map((id) => ({ id, name: id.replace(/^[^.]+\./, '') || id }))
      }
    } catch {
      // The browser is not installed (no folder), or its folder is unreadable: no profile.
    }
    return []
  }

  /**
   * Lets go of what is only kept for a later answer once its time has passed (no timer: it is checked whenever the service is asked
   * something). Opening the sheet again abandons the preview of the last one, which nobody can confirm any more.
   */
  private release(sheetOpened = false): void {
    const now = this.deps.ctx().now
    if (sheetOpened || (this.pending && now - this.pending.at > PREVIEW_VALID_MS)) this.pending = null
    if (this.last && now - this.last.at > UNDO_WINDOW_MS) this.last = null
  }

  /** Whether a preview or an import is still held, for the answer that confirms or undoes it. */
  holdsAnswer(): boolean {
    return this.pending !== null || this.last !== null
  }

  listSources(): ImportSourceInfo[] {
    this.release(true)
    const listed = IMPORT_SOURCES.filter((def) => importAvailable(def.id, this.deps.platform)).flatMap((def) => {
      const profiles = def.pickOnly ? [] : this.profilesOf(def)
      const found = def.kind === 'safari' || def.pickOnly ? true : def.kind === 'arc' ? existsSync(this.arcFile()) : profiles.length > 0
      const missing = def.kind === 'arc' ? def.categories.filter((category) => this.arcFiles(category).length === 0) : []
      return found ? [{ def, profiles, missing }] : []
    })
    const names = this.appNames(listed.map(({ def }) => def))
    // Two browsers whose applications were removed show the same generic label: a number tells them apart.
    const seen = new Map<string, number>()
    this.shown = new Map()
    return listed.map(({ def, profiles, missing }): ImportSourceInfo => {
      const base = names.get(def.id)?.display ?? def.name
      const rank = (seen.get(base) ?? 0) + 1
      seen.set(base, rank)
      const name = rank === 1 ? base : `${base} (${rank})`
      this.shown.set(def.id, name)
      return { id: def.id, name, blurb: def.blurb(name), categories: [...def.categories], profiles, found: true, ...(missing.length > 0 ? { missing } : {}) }
    })
  }

  /** The names of each of these browsers' applications on this Mac, by browser id: only those whose application was found. */
  private appNames(defs: readonly ImportSourceDef[]): Map<string, AppName> {
    const folders = this.deps.applications ?? []
    const wanted = new Set(defs.flatMap((def) => def.bundleIds ?? []))
    const byBundle = folders.length > 0 ? installedAppNames(folders, wanted) : new Map<string, AppName>()
    const names = new Map<string, AppName>()
    for (const def of defs) {
      const name = def.bundleIds?.map((id) => byBundle.get(id)).find((found) => found !== undefined)
      if (name !== undefined) names.set(def.id, name)
    }
    return names
  }

  /** The name an import of this browser speaks of: the one the sheet showed, else its application's, else the generic label. */
  private nameOf(def: ImportSourceDef): string {
    return this.shown.get(def.id) ?? this.appNames([def]).get(def.id)?.display ?? def.name
  }

  /** The name of the space its bookmarks land in: the application's short name ("Chrome" for "Google Chrome"), else what the sheet showed. */
  private spaceNameOf(def: ImportSourceDef): string {
    return this.appNames([def]).get(def.id)?.short ?? this.nameOf(def)
  }

  private arcDir(): string {
    return join(this.deps.home, 'Library/Application Support/Arc')
  }

  private arcFile(): string {
    return join(this.arcDir(), 'StorableSidebar.json')
  }

  /**
   * The files of one part of the sidebar browser's data that exist. The history is the `History` file of each Chromium profile it keeps
   * (the usual Chromium database). Its site customisations are not imported: that browser does not keep them in a file on the Mac.
   */
  private arcFiles(category: ImportCategory): string[] {
    if (category === 'sidebar') return existsSync(this.arcFile()) ? [this.arcFile()] : []
    if (category !== 'history') return []
    const dir = join(this.arcDir(), 'User Data')
    try {
      return readdirSync(dir)
        .filter((entry) => /^(Default|Profile \d+)$/.test(entry) && existsSync(join(dir, entry, 'History')))
        .sort((a, b) => (a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b, 'en', { numeric: true })))
        .map((entry) => join(dir, entry, 'History'))
    } catch {
      // No "User Data" folder: no history of that browser on this Mac.
      return []
    }
  }

  /** Where one category of a browser is. `profile` has been checked against `profilesOf`. */
  private fileFor(def: ImportSourceDef, profile: string | undefined, category: ImportCategory): string {
    switch (def.kind) {
      case 'arc':
        return this.arcFile()
      case 'html':
      case 'other':
        // A bookmarks file, or the file of a browser we do not know, lives anywhere: it is always chosen (see `prepare`).
        return ''
      case 'safari':
        return join(this.deps.home, 'Library/Safari', category === 'bookmarks' ? 'Bookmarks.plist' : 'History.db')
      case 'firefox':
        return join(this.supportDir(def) ?? '', profile ?? '', 'places.sqlite')
      case 'chromium':
        return join(this.supportDir(def) ?? '', profile ?? '', category === 'bookmarks' ? 'Bookmarks' : 'History')
    }
  }

  /** Imports at once, without a preview: what the sheet's Importer button did before it showed one, and what the tests and the engine checks drive. */
  async run(request: ImportRequest): Promise<ImportReport> {
    const plan = await this.prepare(request)
    return plan.apply ? plan.apply() : plan.report
  }

  /**
   * Reads what the import would bring and writes nothing: the report is the preview, and carries a `token` when there is something to
   * import. `commit` with that token does it, with what was read here (the user confirms what they saw, not what the files say a minute later).
   */
  async preview(request: ImportRequest): Promise<ImportReport> {
    this.release()
    const plan = await this.prepare(request)
    this.pending = null
    if (!plan.apply) return plan.report
    const token = randomUUID()
    this.pending = { token, at: this.deps.ctx().now, apply: plan.apply }
    return { ...plan.report, token }
  }

  /** Carries out the preview that has this token. */
  commit(token: string): ImportReport {
    const pending = this.pending
    if (!pending || pending.token !== token) return noReport(t('import.cet-apercu-n-est-plus-valable-relancez-l-import'))
    this.pending = null
    if (this.deps.ctx().now - pending.at > PREVIEW_VALID_MS) return noReport(t('import.apercu-trop-ancien'))
    return pending.apply()
  }

  /** Takes the latest import back: the spaces, tabs, folders, favourites, split views and Tweaks it added, and the history it brought. */
  undo(token: string): ImportReport {
    const last = this.last
    if (!last || last.token !== token) return noReport(t('import.annulation-plus-possible'))
    if (this.deps.ctx().now - last.at > UNDO_WINDOW_MS) {
      this.last = null
      return noReport(t('import.annulation-delai-passe', { minutes: UNDO_WINDOW_MS / 60_000 }))
    }
    // Taking an import back removes the spaces it brought with their tabs: one of them may be locked by now. The import is kept, to be taken back once unlocked.
    const refusal = this.deps.undoRefusal?.() ?? null
    if (refusal !== null) return noReport(refusal)
    const state = this.deps.state()
    const still = (list: ReadonlyArray<{ id: string }>, ids: readonly string[]): number => {
      const present = new Set(list.map((entry) => entry.id))
      return ids.filter((id) => present.has(id)).length
    }
    const mineTabs = new Set(last.tabs)
    const mineSpaces = new Set(last.spaces)
    const tabs = state.tabs.filter((t) => mineTabs.has(t.id) || mineSpaces.has(t.spaceId)).length
    const folders = still(state.folders, last.folders)
    try {
      this.deps.dispatch({ type: 'import/revert', spaces: last.spaces, tabs: last.tabs, folders: last.folders, favorites: last.favorites, splits: last.splits, boosts: [] })
    } catch (error) {
      console.error('[import] cannot take the import back:', error)
      return noReport(t('import.annulation-echouee', { error: String((error as Error).message ?? error) }))
    }
    this.last = null
    // An import that is taken back brought nothing the guide could speak of.
    this.arcImports = this.arcImports.filter((entry) => entry.token !== token)
    let history = 0
    for (const take of last.history) history += take()
    const parts: string[] = []
    if (tabs > 0 || folders > 0) parts.push(t('import.tabs-et-dossiers', { tabs: counted('import.tabs-epingles', tabs), folders: counted('import.dossiers-annules', folders) }))
    if (history > 0) parts.push(counted('import.pages-historique', history))
    return { ...noReport(''), ok: true, message: parts.length > 0 ? t('import.import-annule-retires', { parts: parts.join(', ') }) : t('import.import-annule-rien'), bookmarks: tabs, folders, history }
  }

  /**
   * Dispatches what an import found and notes the ids, so that the import can be taken back. Only what the state does not hold yet is
   * noted (the reducer leaves the rest alone): "Annuler l'import" must never take away an entry that was there before, or that
   * another import brought between the preview and its confirmation.
   */
  private bring(brought: Brought, batch: { spaces: Space[]; tabs: TabItem[]; folders: Folder[]; favorites: Favorite[]; splits?: SplitView[] }): void {
    const state = this.deps.state()
    const fresh = <T extends { id: string }>(list: readonly T[] | undefined, held: ReadonlyArray<{ id: string }>): string[] => {
      const ids = new Set(held.map((entry) => entry.id))
      return (list ?? []).filter((entry) => !ids.has(entry.id)).map((entry) => entry.id)
    }
    brought.spaces.push(...fresh(batch.spaces, state.spaces))
    brought.tabs.push(...fresh(batch.tabs, state.tabs))
    brought.folders.push(...fresh(batch.folders, state.folders))
    brought.splits.push(...fresh(batch.splits, state.splits))
    // A favourite is kept once per address in its profile: one whose address is there already is not added, so not taken away either (the reducer reads the same rule).
    brought.favorites.push(...importedFavorites(state, batch.favorites, batch.spaces).map((f) => f.id))
    this.deps.dispatch({ type: 'import/merge', ...batch })
  }

  /** Adds pages to the history; answers how many were added or changed. */
  private bringHistory(brought: Brought, entries: HistoryEntry[]): number {
    const tracked = this.deps.mergeHistoryTracked?.(entries)
    if (!tracked) return this.deps.mergeHistory(entries)
    brought.history.push(tracked.undo)
    return tracked.touched
  }

  /** How many pages the history would gain or change. */
  private historyGain(entries: HistoryEntry[]): number {
    return this.deps.countHistory ? this.deps.countHistory(entries) : entries.length
  }

  /** Makes the import the latest one, the one "Annuler" takes back; answers the token for the report (none when nothing was added). */
  private remember(brought: Brought): string | undefined {
    if (!wasBrought(brought)) return undefined
    const token = randomUUID()
    this.last = { ...brought, token, at: this.deps.ctx().now }
    return token
  }

  /**
   * What the imports from Arc brought since the guide was last offered, or null when none did (or all were taken back); asking forgets it, so that the
   * guide is offered once for them. The caller decides whether to open it (it already was seen: shared/arc-guide.ts `arcGuideRequest`).
   */
  takeArcGuide(): ArcImported | null {
    const taken = this.arcImports
    this.arcImports = []
    return taken.length === 0 ? null : taken.reduce((total, entry) => addImported(total, entry.imported), NOTHING_IMPORTED)
  }

  /** Reads everything the request asks for and checks it. Nothing is written; `apply` of the plan does it. */
  private async prepare(request: ImportRequest): Promise<Plan> {
    const entry = importSource(request.source)
    if (!entry || !importAvailable(entry.id, this.deps.platform)) return { report: noReport(t('import.ce-navigateur-n-est-pas-pris-en-charge')) }
    // Every sentence of the import, and the file chooser, say the name the sheet showed.
    const listed: ImportSourceDef = { ...entry, name: this.nameOf(entry) }
    const categories = [...new Set(request.categories)].filter((c) => listed.categories.includes(c))
    if (categories.length === 0) return { report: noReport(t('import.choisissez-ce-qu-il-faut-importer')) }

    let profile: string | undefined
    /** The profile's name when the browser has several: two imports of two profiles must not leave two spaces with one name. */
    let profileName: string | undefined
    if (listed.kind === 'chromium' || listed.kind === 'firefox') {
      const profiles = this.profilesOf(listed)
      const found = request.profile === undefined ? profiles[0] : profiles.find((p) => p.id === request.profile)
      profile = found?.id
      if (profiles.length > 1) profileName = found?.name
      if (!profile && !request.pick) return { report: noReport(t('import.aucun-profil-de-name-n-a-ete-trouve-sur-ce-mac', { name: listed.name })) }
    }

    // A file the user picked stands for whatever kind of data it is (bookmarks or history); the other categories are dropped.
    // A bookmarks file is never in a known place: the file chooser is the way in.
    let picked: string | null = null
    if (request.pick || listed.pickOnly) {
      const expected =
        listed.kind === 'safari' ? t('import.expected-safari')
        : listed.kind === 'firefox' ? 'places.sqlite'
        : listed.kind === 'html' ? t('import.expected-html')
        : listed.kind === 'other' ? t('import.expected-other')
        : listed.kind === 'arc' ? t('import.expected-arc')
        : t('import.bookmarks-ou-history')
      picked = await this.deps.chooseFile(listed, expected)
      if (!picked) return { report: noReport(t('import.import-annule')) }
    }

    // "Autre navigateur": the name of the file tells which browser's format it is.
    let def = listed
    if (listed.kind === 'other') {
      const kind = kindOfFile(picked!)
      if (!kind) return { report: noReport(t('import.fichier-non-lisible', { name: basename(picked!), formats: t('import.formats-lisibles') })) }
      def = { ...listed, kind }
    }
    if (def.kind === 'arc') return this.prepareArc(def, categories, picked)

    // A file the user picked holds one kind of data: the sentences speak of that, not of what else was ticked.
    const shown = picked ? categories.filter((category) => this.matches(def, category, picked!)) : categories
    const sets: Imported[] = []
    let entries: HistoryEntry[] = []
    const problems: string[] = []
    let denied = false
    const skipped = { skipped: 0, overLimit: 0, duplicates: 0 }
    for (const category of categories) {
      const path = picked ?? this.fileFor(def, profile, category)
      if (picked && !this.matches(def, category, picked)) continue
      try {
        if (category === 'history') entries = toHistoryEntries(this.historyRows(def, path))
        else {
          // A file the person picked is not "the profile": it may be a copy, or another profile's, so it is told apart by its place.
          const imported = await this.bookmarksOf(def, this.spaceNameOf(entry), path, picked ? undefined : profile, picked ? undefined : profileName)
          skipped.skipped += imported.skipped
          skipped.overLimit += imported.overLimit
          skipped.duplicates += imported.duplicates
          if (imported.unrecognized) problems.push(`${basename(path)} ${listed.kind === 'chromium' || listed.kind === 'firefox' || listed.kind === 'safari' ? t('import.format-inattendu-name', { name: listed.name }) : t('import.format-de-signets-non-reconnu')}`)
          if (imported.spaces.length > 0) sets.push(imported)
        }
      } catch (error) {
        if (isDenied(error)) denied = true
        else if ((error as NodeJS.ErrnoException).code === 'ENOENT') problems.push(t('import.fichier-introuvable', { name: basename(path) }))
        else problems.push(readFailureMessage(error, basename(path)))
      }
    }

    // What an earlier import of the same bookmarks brought has the same ids (the ids come from what the bookmarks are and where each one
    // sits): it stays as the person has it, and only what is new comes in. Bookmarks the person pinned themselves are another matter (below).
    const known = this.deps.state()
    const knownIds = { spaces: new Set(known.spaces.map((e) => e.id)), tabs: new Set(known.tabs.map((e) => e.id)), folders: new Set(known.folders.map((e) => e.id)) }
    const spaceKnown = sets.length > 0 && knownIds.spaces.has(sets[0]!.spaces[0]!.id)
    const spaceName = sets[0]?.spaces[0]?.name ?? ''
    let present = 0
    const news = sets.map((set): Imported => {
      const tabs = set.tabs.filter((tab) => !knownIds.tabs.has(tab.id))
      present += set.tabs.length - tabs.length
      return { ...set, tabs, spaces: set.spaces.filter((space) => !knownIds.spaces.has(space.id)), folders: set.folders.filter((folder) => !knownIds.folders.has(folder.id)) }
    })

    const links = news.reduce((n, set) => n + set.tabs.length, 0)
    const folders = news.reduce((n, set) => n + set.folders.length, 0)
    const gain = entries.length > 0 ? this.historyGain(entries) : 0
    const extra = { skipped: skipped.skipped, overLimit: skipped.overLimit, ...(skipped.duplicates > 0 ? { duplicates: skipped.duplicates } : {}) }
    const nothing = links === 0 && gain === 0
    if (denied && nothing) return { report: noReport(diskAccessMessage(), { needsDiskAccess: true }) }
    // Everything the file holds is there already: not a failure, and nothing to confirm.
    if (nothing && present > 0 && problems.length === 0) return { report: { ...noReport(t('import.rien-de-nouveau-depuis-name-ces-signets-sont-deja', { name: def.name }), extra), ok: true, details: [tp('import.deja-importes', present)] } }
    if (nothing && categories.includes('bookmarks') && problems.length === 0 && !(categories.includes('history') && entries.length > 0)) return { report: noReport(t('import.aucun-signet-web-a-importer-depuis-name', { name: def.name }), extra) }
    if (nothing) return { report: noReport(problems.join(' ') || (entries.length > 0 ? t('import.rien-de-nouveau-depuis-name-ces-pages-sont-deja', { name: def.name }) : t('import.rien-a-importer')), extra) }

    const pinned = new Set(known.tabs.filter((t) => t.pinned).map((t) => t.url))
    const already = spaceKnown ? 0 : news.reduce((n, set) => n + set.tabs.filter((t) => pinned.has(t.url)).length, 0)
    const details: string[] = []
    if (links > 0) details.push(spaceKnown ? t('import.les-nouveaux-signets-rejoignent-l-espace-name', { name: spaceName }) : t('import.nouvel-espace-signets', { name: spaceName }))
    if (present > 0) details.push(tp('import.deja-importes', present))
    if (entries.length > 0) details.push(t('import.historique-phrase', { entries: counted('import.historique-adresses', entries.length), gain: counted('import.historique-nouveautes', gain) }))
    if (already > 0) details.push(counted('import.deja-epingles', already))
    if (skipped.duplicates > 0) details.push(counted('import.doublons', skipped.duplicates))
    details.push(...problems)
    if (denied) details.push(t('import.protege-par-macos'))

    const preview: ImportReport = { ...noReport(''), ...extra, ok: true, bookmarks: links, folders, history: gain, details, message: previewSummary(def.name, { bookmarks: links, folders, history: gain, ...extra }, shown) }

    const apply = (): ImportReport => {
      const brought = nothingBrought()
      const done = noReport('')
      for (const set of news) {
        this.bring(brought, { spaces: set.spaces, tabs: set.tabs, folders: set.folders, favorites: set.favorites })
        done.bookmarks += set.tabs.length
        done.folders += set.folders.length
      }
      if (entries.length > 0) done.history = this.bringHistory(brought, entries)
      Object.assign(done, extra)
      if (done.bookmarks === 0 && done.history === 0) return noReport(problems.join(' ') || t('import.rien-a-importer'), extra)
      const undoToken = this.remember(brought)
      return { ...done, ok: true, ...(undoToken ? { undoToken } : {}), message: `${importSummary(def.name, done, shown)}${problems.length > 0 ? ` ${problems.join(' ')}` : ''}${denied ? ` ${t('import.protege-par-macos')}` : ''}` }
    }
    return { report: preview, apply }
  }

  /**
   * A sidebar of spaces (`StorableSidebar.json`: spaces, tabs, folders, favourites, split views) and the history of its profiles, each read
   * whole and checked before anything is written (a file that cannot be read or has nothing usable changes nothing). The
   * things the sidebar brings carry ids made from the file's own, so a second run finds them already there and leaves them alone: the report says how many.
   */
  private async prepareArc(def: ImportSourceDef, categories: ImportCategory[], picked: string | null): Promise<Plan> {
    if (picked && !categories.some((category) => this.arcKindOf(picked) === category)) {
      return { report: noReport(t('import.arc-fichier-non-lisible', { name: basename(picked) })) }
    }
    const known = this.deps.state()
    // A file the user picked is one part of the data; the others that were ticked are neither looked for nor reported.
    const asked = picked ? categories.filter((category) => this.arcKindOf(picked) === category) : categories
    const counts: ArcCounts = { asked, spaces: 0, tabs: 0, folders: 0, favorites: 0, splits: 0, present: 0, tabGroups: 0, skipped: 0, overLimit: 0, history: null, missing: [] }
    const missing: ImportCategory[] = []
    const problems: string[] = []
    let denied = false
    /** What is written when the import is confirmed, in the order it was read. */
    const writes: Array<(brought: Brought) => void> = []
    // The history files of the profiles all are called "History": the sentence about one names its profile folder ("Profile 1/History").
    const nameOf = (path: string): string => (basename(path) === 'History' ? `${basename(dirname(path))}/History` : basename(path))
    const attempt = async <T,>(path: string, work: () => T | Promise<T>): Promise<T | undefined> => {
      try {
        return await work()
      } catch (error) {
        if (isDenied(error)) denied = true
        else if ((error as NodeJS.ErrnoException).code === 'ENOENT') problems.push(t('import.fichier-introuvable', { name: nameOf(path) }))
        else problems.push(readFailureMessage(error, nameOf(path)))
        return undefined
      }
    }
    const idsOf = (list: ReadonlyArray<{ id: string }>) => new Set(list.map((entry) => entry.id))
    const newOnes = <T extends { id: string }>(found: readonly T[], have: ReadonlySet<string>): T[] => found.filter((entry) => !have.has(entry.id))
    const historyFiles: HistoryEntry[][] = []

    for (const category of asked) {
      const files = picked ? [picked] : this.arcFiles(category)
      if (files.length === 0) {
        missing.push(category)
        continue
      }
      if (category === 'sidebar') {
        const converted = await attempt(files[0]!, () => convertArcSidebar(JSON.parse(decodeFileText(readBounded(files[0]!))), this.deps.ctx()))
        if (!converted) continue
        if (converted.spaces.length === 0) {
          problems.push(t('import.arc-aucun-espace', { name: basename(files[0]!) }))
          continue
        }
        const spaces = newOnes(converted.spaces, idsOf(known.spaces))
        const tabs = newOnes(converted.tabs, idsOf(known.tabs))
        const folders = newOnes(converted.folders, idsOf(known.folders))
        const splits = newOnes(converted.splits, idsOf(known.splits))
        const favorites = importedFavorites(known, converted.favorites, spaces)
        counts.present += converted.spaces.length - spaces.length + (converted.tabs.length - tabs.length) + (converted.folders.length - folders.length) + (converted.splits.length - splits.length) + (converted.favorites.length - favorites.length)
        Object.assign(counts, { spaces: spaces.length, tabs: tabs.length, folders: folders.length, favorites: favorites.length, splits: splits.length, tabGroups: converted.report.tabGroups, skipped: converted.report.skipped, overLimit: converted.report.overLimit })
        if (spaces.length + tabs.length + folders.length + favorites.length + splits.length > 0) writes.push((brought) => this.bring(brought, { spaces, tabs, folders, favorites, splits }))
      } else {
        let read = 0
        let readable = 0
        for (const file of files) {
          const rows = await attempt(file, () => this.historyRows({ ...def, kind: 'chromium' }, file))
          if (!rows) continue
          readable++
          read += rows.length
          historyFiles.push(toHistoryEntries(rows))
        }
        // Not one history file could be read: that is a failure (already in the problems), not an import of nothing.
        if (readable > 0) {
          // The preview counts over the pages of all the profiles at once (the same address in two is one page).
          const union = new Map<string, HistoryEntry>()
          for (const entry of historyFiles.flat()) if ((union.get(entry.url)?.lastVisitAt ?? -1) < entry.lastVisitAt) union.set(entry.url, entry)
          counts.history = { read, added: this.historyGain([...union.values()]) }
          const perFile = historyFiles
          writes.push((brought) => {
            let added = 0
            for (const pages of perFile) added += this.bringHistory(brought, pages)
            counts.history = { read, added }
          })
        }
      }
    }
    counts.missing = missing

    const total = () => counts.spaces + counts.tabs + counts.folders + counts.favorites + counts.splits + (counts.history?.added ?? 0)
    const extra = (details: string[]) => ({ skipped: counts.skipped, overLimit: counts.overLimit, details, ...(missing.length > 0 ? { canPick: true } : {}) })
    // The question of a preview is only asked when something will be written.
    const preview = arcSummary(counts, total() > 0, def.name)
    if (total() === 0 && counts.present === 0 && !counts.history) {
      if (denied) return { report: noReport(diskAccessMessage(), { needsDiskAccess: true }) }
      return { report: noReport(problems.join(' ') || t('import.rien-a-importer-depuis-name', { name: def.name }), extra(preview.details)) }
    }
    const figures = () => ({ bookmarks: counts.tabs, folders: counts.folders, history: counts.history?.added ?? 0, spaces: counts.spaces, favorites: counts.favorites, splits: counts.splits })
    const note = `${problems.length > 0 ? ` ${problems.join(' ')}` : ''}${denied ? ` ${t('import.protege-par-macos')}` : ''}`
    const report: ImportReport = { ...noReport(''), ...extra(preview.details), ok: true, message: `${preview.message}${note}`, ...figures() }
    // Nothing new in the files: there is nothing to confirm, and the preview says so as the import would.
    if (total() === 0) return { report }

    const apply = (): ImportReport => {
      const brought = nothingBrought()
      for (const write of writes) write(brought)
      // What the preview counted as new may have been brought in the meantime by another import: then it is there already, and the report says so.
      if (brought.spaces.length + brought.tabs.length + brought.folders.length + brought.favorites.length + brought.splits.length === 0) {
        counts.present += counts.spaces + counts.tabs + counts.folders + counts.favorites + counts.splits
        Object.assign(counts, { spaces: 0, tabs: 0, folders: 0, favorites: 0, splits: 0 })
      }
      const summary = arcSummary(counts, false, def.name)
      const undoToken = this.remember(brought)
      // Only an import that brought something: one that found everything there already has nothing to take back, nor to explain.
      if (undoToken) this.arcImports.push({ token: undoToken, imported: { spaces: counts.spaces, tabs: counts.tabs, folders: counts.folders, favorites: counts.favorites, splits: counts.splits } })
      return { ...noReport(''), ...extra(summary.details), ok: true, ...(undoToken ? { undoToken } : {}), message: `${summary.message}${note}`, ...figures() }
    }
    return { report, apply }
  }

  /** Which part of the sidebar browser's data a file the user picked is, from its name. */
  private arcKindOf(path: string): ImportCategory | null {
    const name = basename(path)
    if (/^StorableSidebar.*\.json$/i.test(name)) return 'sidebar'
    return name === 'History' ? 'history' : null
  }

  private matches(def: ImportSourceDef, category: ImportCategory, path: string): boolean {
    const name = basename(path)
    switch (def.kind) {
      case 'arc':
        return this.arcKindOf(path) === category
      case 'firefox':
        return name === 'places.sqlite'
      case 'html':
        return category === 'bookmarks' && /\.html?$/i.test(name)
      case 'safari':
        return category === 'bookmarks' ? name === 'Bookmarks.plist' : name === 'History.db'
      case 'chromium':
      case 'other':
        return category === 'bookmarks' ? name === 'Bookmarks' : name === 'History'
    }
  }

  /**
   * `profile` is the browser's profile folder when the data is one of its profiles' (it goes into the identity of what comes in, so that
   * two profiles stay two spaces and the same profile imported again is the same space); `spaceName` names the space, and `profileName` is added
   * to it when the browser has several.
   */
  private async bookmarksOf(def: ImportSourceDef, spaceName: string, path: string, profile?: string, profileName?: string): Promise<Imported> {
    const ctx = this.deps.ctx()
    const fromTree = (imported: BookmarkImport): Imported => ({
      ...imported,
      favorites: [],
      skipped: imported.report.skipped,
      overLimit: imported.report.overLimit,
      duplicates: imported.report.duplicates ?? 0,
      unrecognized: imported.unrecognized === true
    })
    // What these bookmarks are, for the ids: a profile of a browser; any bookmarks file (a new export of the same bookmarks has another name
    // each time: a dated "bookmarks_10_26_26.html", so the place says nothing); or the file of an unlisted browser, by its place.
    const identity = profile !== undefined ? `${def.id}:${profile}` : def.kind === 'html' ? 'html' : `${def.id}:${def.kind}:${path}`
    const named = (base: string): string => (profileName ? `${base} (${profileName})`.slice(0, NAME_MAX) : base)
    switch (def.kind) {
      case 'arc':
      case 'other':
        throw new Error(`${def.kind} is not imported here`)
      case 'chromium':
        return fromTree(convertChromeBookmarks(JSON.parse(decodeFileText(readBounded(path))), ctx, named(spaceName), identity))
      case 'safari': {
        const toXml = this.deps.plistToXml ?? plutilToXml
        return fromTree(convertSafariBookmarks(parsePlist(await toXml(readBounded(path))), ctx, identity, spaceName))
      }
      case 'firefox':
        return fromTree(convertFirefoxBookmarks(readFirefoxBookmarks(path), ctx, named(spaceName), identity))
      case 'html':
        return fromTree(convertNetscapeBookmarks(decodeFileText(readBounded(path)), ctx, undefined, identity))
    }
  }

  /** The pages of a browser's history file, as rows (see sqlite.ts). */
  private historyRows(def: ImportSourceDef, path: string) {
    return def.kind === 'safari' ? readSafariHistory(path) : def.kind === 'firefox' ? readFirefoxHistory(path) : readChromiumHistory(path)
  }
}

let current: ImportService | null = null

/** The import service of the running application (the sheet reaches it through IPC). */
export function setImportService(service: ImportService): void {
  current = service
}

export function getImportService(): ImportService | null {
  return current
}
