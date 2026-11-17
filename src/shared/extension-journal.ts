// The journal of the Extensions page: what the service workers and the pages of the extensions print, and the extensions that failed to
// load. A bounded list kept by the engine (main/engine/extension-dev.ts) and read by the page while it is open. Pure rules here.
// What an extension prints is hostile input (any text, any length): it is cut and stripped of control characters before it is kept.

/** `info` is `console.log` and `console.info`; the level of `console.debug` and of the verbose messages is not kept. */
export type JournalLevel = 'info' | 'warning' | 'error'
/** `worker`: the service worker's console. `page`: a popup, an options page or any other page of the extension. `load`: the extension could not be loaded or reloaded. */
export type JournalSource = 'worker' | 'page' | 'load' | 'browser'

export interface JournalEntry {
  /** Increases with each entry: the page asks for what came after the last one it holds. */
  id: number
  /** Milliseconds since the epoch. */
  at: number
  level: JournalLevel
  source: JournalSource
  /** The extension the message comes from, when its address says so; a load failure names a folder instead. */
  extensionId?: string
  profileId?: string
  message: string
  /** Where: `file.js:12` for a message of the console, the folder for a failed load. */
  where?: string
}

/** The whole journal is kept to this many entries, the oldest ones going first… */
export const JOURNAL_MAX = 500
/** …and one extension (or one folder that does not load) may hold this many of them: a chatty one must not push the errors of the others out. */
export const JOURNAL_PER_KEY_MAX = 200
export const JOURNAL_MESSAGE_MAX = 2000
const WHERE_MAX = 300

const CONTROL_KEPT = /[\p{Cc}\p{Cf}]/gu

/** A message as it is kept: line breaks and tabs stay (a stack trace is read line by line), every other control or invisible format character goes, and it stops at `JOURNAL_MESSAGE_MAX`. */
export function cleanJournalText(value: unknown, max = JOURNAL_MESSAGE_MAX): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(CONTROL_KEPT, (char) => (char === '\n' || char === '\t' ? char : char === '\r' ? '' : ' '))
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** The id of the extension an address belongs to (`chrome-extension://<id>/background.js`), or undefined for any other address. */
export function extensionIdOfUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  const match = /^chrome-extension:\/\/([a-p]{32})(?:[/?#]|$)/.exec(url)
  return match?.[1]
}

/** The file and line a message of the console says it comes from, shortened to the path inside the extension: `background.js:12`. */
export function whereOf(sourceUrl: unknown, line: unknown): string | undefined {
  if (typeof sourceUrl !== 'string' || sourceUrl === '') return undefined
  const path = sourceUrl.replace(/^chrome-extension:\/\/[a-p]{32}\/?/, '')
  const where = Number.isInteger(line) && (line as number) > 0 ? `${path}:${line as number}` : path
  return cleanJournalText(where, WHERE_MAX) || undefined
}

/** The level of a message of a service worker's console (Electron gives a number: 0 verbose, 1 info, 2 warning, 3 error); null for the ones that are not kept. */
export function workerLevel(level: unknown): JournalLevel | null {
  return level === 1 ? 'info' : level === 2 ? 'warning' : level === 3 ? 'error' : null
}

/** The level of a message of a page's console (Electron gives a word); null for the ones that are not kept. */
export function pageLevel(level: unknown): JournalLevel | null {
  return level === 'info' ? 'info' : level === 'warning' ? 'warning' : level === 'error' ? 'error' : null
}

/** One line of the journal as the page shows it: the newest entry of a message said `count` times. */
export interface JournalRun {
  entry: JournalEntry
  count: number
}

const runKey = (e: JournalEntry): string => JSON.stringify([e.profileId, e.extensionId, e.source, e.level, e.message, e.where])

/**
 * The lines the page shows: an extension that fails the same way for each of its tabs (« Receiving end does not exist » to twelve of them in one second)
 * fills the journal with one message twelve times. The same message from the same place is one line, with how many times it came, at the place and the
 * time of its last occurrence. Nothing is dropped: the count says how many entries it stands for.
 */
export function journalRuns(entries: readonly JournalEntry[]): JournalRun[] {
  const runs = new Map<string, JournalRun>()
  for (const entry of entries) {
    const key = runKey(entry)
    const before = runs.get(key)
    runs.delete(key)
    runs.set(key, { entry, count: (before?.count ?? 0) + 1 })
  }
  return [...runs.values()]
}

export interface JournalFilter {
  extensionId?: string
  profileId?: string
}

const keyOf = (entry: Pick<JournalEntry, 'extensionId' | 'profileId' | 'where' | 'source'>): string => (entry.source === 'load' ? `load:${entry.where ?? ''}` : `${entry.profileId ?? ''}:${entry.extensionId ?? ''}`)

/** The bounded list. Nothing in it is a timer or a listener: it is only filled by whoever listens, and the engine listens only while the page is open. */
export class ExtensionJournal {
  private entries: JournalEntry[] = []
  private counter = 0

  /** Keeps the entry (cleaned, with its number) and returns it. */
  add(entry: Omit<JournalEntry, 'id'>): JournalEntry {
    const kept: JournalEntry = { ...entry, id: ++this.counter, message: cleanJournalText(entry.message) }
    if (entry.where !== undefined) kept.where = cleanJournalText(entry.where, WHERE_MAX)
    // The same failure of the same folder, said again (each profile loads the folder, a second try fails as the first): one line, the newest.
    if (kept.source === 'load') this.entries = this.entries.filter((e) => !(e.source === 'load' && e.where === kept.where && e.message === kept.message))
    this.entries.push(kept)
    const key = keyOf(kept)
    const same = this.entries.filter((e) => keyOf(e) === key)
    if (same.length > JOURNAL_PER_KEY_MAX) this.entries = this.entries.filter((e) => e !== same[0])
    if (this.entries.length > JOURNAL_MAX) this.entries.splice(0, this.entries.length - JOURNAL_MAX)
    return kept
  }

  /** The entries after `since` (all of them when omitted), oldest first, for one extension and profile when asked. */
  list(filter: JournalFilter & { since?: number } = {}): JournalEntry[] {
    const since = filter.since ?? 0
    return this.entries.filter((e) => e.id > since && (filter.extensionId === undefined || e.extensionId === filter.extensionId) && (filter.profileId === undefined || e.profileId === filter.profileId))
  }

  /** Takes entries out by their number. */
  remove(ids: readonly number[]): void {
    this.entries = this.entries.filter((entry) => !ids.includes(entry.id))
  }

  /** The number of the last entry made (0 before any): what a reader that has seen everything passes as `since`. */
  lastId(): number {
    return this.counter
  }

  /** Forgets the entries of an extension (and a profile), or all of them; answers how many went. A failed load names a folder, not an extension: it goes with "all" and with the extension it was loaded for, when known. */
  clear(filter: JournalFilter = {}): number {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => !((filter.extensionId === undefined || e.extensionId === filter.extensionId) && (filter.profileId === undefined || e.profileId === filter.profileId)))
    return before - this.entries.length
  }
}
