import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { defaultSettings, type SidebarState } from '@shared/model'
import { createInitialState, NewerStateError, persistableState, reduce, type Action, type Ctx } from '@shared/sidebar'
import { parseStateText, savedStateOf } from '@shared/sidebar-state'
import { foreignFieldsOf, withForeignFields, type ForeignFields } from '@shared/state-clean'
import { layoutOf, project, release, sameLayout, selectionOf, visibleTabIds, type Selection } from '@shared/window-selection'
import { MAIN_WINDOW_KEY, EVERY_TAB_ACTIONS, REPLACING_ACTIONS, handOverTabs, putBackOwnTabs, windowsAreIndependent, withEveryTab } from '@shared/window-tabs'
import { reportPersistenceNotice } from './persistence-notices'
import { compareVersions } from '@shared/versions'
import { DATA_FILE_MAX_BYTES, HeldFileError, copyOnVersionChange, copyToResume, readTextBounded, refuseWrites, setAsideOrHold, writeFileAtomic, writeFileAtomicAsync, writerVersionOf } from './persist'

const SAVE_DELAY_MS = 300
/** The write waits for a quiet moment, but never longer than this from the first change: a title that changes faster than the delay would otherwise hold it back for good. */
export const SAVE_MAX_WAIT_MS = 3000
/** After a failed save the state is written again this long afterwards, without waiting for another change. */
const RETRY_DELAY_MS = 5000

export const liveCtx = (): Ctx => ({ now: Date.now(), newId: () => randomUUID() })

/** How many failures of listeners of the state are written; the next ones are counted in one last line, so that a listener failing at every change cannot fill the log. */
export const LISTENER_FAILURES_LOGGED_MAX = 20
let listenerFailures = 0

/** A listener of the state threw: the log says so (the change itself is made, and the other listeners are told). */
function noteListenerFailure(error: unknown, log: (...args: unknown[]) => void = console.error): void {
  listenerFailures++
  if (listenerFailures <= LISTENER_FAILURES_LOGGED_MAX) log(`[store] a listener of the state failed (n° ${listenerFailures}); the change is made and the other listeners are told:`, error)
  else if (listenerFailures === LISTENER_FAILURES_LOGGED_MAX + 1) log(`[store] more than ${LISTENER_FAILURES_LOGGED_MAX} failures of listeners of the state: the next ones are not written`)
}

/** The state read at start-up. `readable` is false when no state was read: the file was absent, set aside, or held. */
export interface LoadedState {
  state: SidebarState
  readable: boolean
  /**
   * No state file existed: a new profile, the one launch that may open the first-launch guide by itself (launch-sheets.ts). A file that was read,
   * or that was damaged and set aside, is an existing profile: false.
   */
  fresh: boolean
  /**
   * The file was written by a later version of the application than this one (same format: it was read). This version may not know everything it
   * holds, so nothing the state no longer names is deleted at this launch (main/index.ts, `stateTrusted`).
   */
  fromNewerVersion: boolean
}

/**
 * The field of the file that names the version of the application that wrote it (`app.getVersion()`): not part of the model, written by the store
 * and read at the next launch, so that a launch of another version is known before anything is written.
 */
export const WRITER_FIELD = 'writtenBy'

/**
 * The fields of the file a state was read from that this version does not know, kept with that state: the store made from it writes them
 * back (see `StateStore`), so that a newer build's settings survive a run of this one. Keyed by the state object `readState` handed out.
 */
const foreignOfState = new WeakMap<SidebarState, ForeignFields>()

let knownTopLevel: ReadonlySet<string> | null = null
/** The top-level fields of the model, and its settings: what is not one of them in a file is a later version's. */
function knownFields(): { top: ReadonlySet<string>; settings: ReadonlySet<string> } {
  // The writer of the file is the store's own field: kept as a foreign one, the version of a previous run would be written back.
  knownTopLevel ??= new Set([...Object.keys(createInitialState({ now: 0, newId: () => 'known' })), WRITER_FIELD])
  return { top: knownTopLevel, settings: new Set(Object.keys(defaultSettings())) }
}

/**
 * Reads the state file. A corrupt file is moved aside (never silently discarded) and replaced by a fresh state; the user is told
 * (persistence-notices.ts). When even the move fails, the fresh state is used all the same and nothing is written over the file.
 * `readable` tells the caller that the state in memory is not the one the user had: what the state no longer names must not be deleted then.
 * The file is parsed once; what it holds that this version does not know is kept for the store made from the state (`foreignOfState`).
 */
export function readState(path: string, appVersion?: string): LoadedState {
  if (!existsSync(path)) return { state: freshState(), readable: false, fresh: true, fromNewerVersion: false }
  let parsed: unknown
  let state: SidebarState
  try {
    parsed = parseStateText(readTextBounded(path, DATA_FILE_MAX_BYTES))
    state = savedStateOf(parsed)
    const { top, settings } = knownFields()
    const foreign = foreignFieldsOf(parsed, top, settings)
    if (foreign) foreignOfState.set(state, foreign)
  } catch (error) {
    // A file of a more recent version is not damaged: it is kept under its own name, which the pruning of damaged ones never touches.
    setAsideOrHold(path, error, 'store', error instanceof NewerStateError ? 'future' : 'corrupt')
    return { state: createInitialState(liveCtx()), readable: false, fresh: false, fromNewerVersion: false }
  }
  const fromNewerVersion = appVersion === undefined ? false : keepStateOfOtherVersion(path, writerVersionOf((parsed as Record<string, unknown>)[WRITER_FIELD]), appVersion)
  return { state, readable: true, fresh: false, fromNewerVersion }
}

/**
 * The state file was read, and `writer` wrote it (null: the file does not say). When that is not the running version, a copy of the file is kept
 * before this run writes anything (`copyOnVersionChange`): this is the first launch of another version, older or newer, over that state.
 * - The running version is the OLDER one: it reads the file, but does not keep what it does not know inside a tab, a space or a folder. The user is
 *   told where the copy is. If the copy cannot be made, nothing is written over the file in this run (`refuseWrites`), and the user is told that.
 * - The running version is the newer one: the copy is the way back if its migrations go wrong. A copy that cannot be made is logged; the launch goes
 *   on and the file is written as usual. When the user comes back from an older version, the copy made on the way down is offered.
 * Answers whether the file is a later version's.
 */
function keepStateOfOtherVersion(path: string, writer: string | null, running: string): boolean {
  if (writer === running) return false
  const newer = writer !== null && compareVersions(writer, running) > 0
  // Looked for before this launch adds its own copy.
  let resume: string | null = null
  try {
    resume = copyToResume(path, writer, running)
  } catch (error) {
    console.error(`[store] cannot look for a copy of ${path} left by a newer version; none is offered:`, error)
  }
  try {
    const copy = copyOnVersionChange(path, writer)
    console.warn(`[store] ${path} was written by Lucium ${writer ?? '(a version that does not say)'} and this is ${running}: a copy is kept in ${copy}`)
    if (newer) reportPersistenceNotice({ kind: 'older-version', file: basename(path), copy, writer, running })
  } catch (error) {
    const reason = String((error as Error).message ?? error)
    if (newer) {
      refuseWrites(path, `it was written by Lucium ${writer}, newer than this ${running}, and no copy of it could be made`)
      console.error(`[store] ${path} was written by Lucium ${writer}, newer than this ${running}, and could not be copied (${reason}): nothing is written over it in this run`)
      reportPersistenceNotice({ kind: 'older-version-kept', file: basename(path), writer, running, reason })
    } else console.error(`[store] ${path} was written by Lucium ${writer ?? '(a version that does not say)'} and could not be copied before this ${running} writes it (${reason}); the launch goes on`)
  }
  if (resume) reportPersistenceNotice({ kind: 'copy-to-resume', file: basename(path), copy: resume })
  return newer
}

export function loadState(path: string): SidebarState {
  return readState(path).state
}

/**
 * The state of the very first launch: no file existed. `welcomeDone` is false here, as in the defaults: a state read from a file written before the flag existed
 * has it false too, so the flag alone cannot tell a new profile. What does is `fresh` of `readState` (no file at the launch), which the launch sheets are given
 * (shell/launch-sheets.ts `newProfile`): an existing profile, or a state that replaces a damaged one, never sees the welcome nor the first-launch guide.
 */
export function freshState(): SidebarState {
  const state = createInitialState(liveCtx())
  return { ...state, settings: { ...state.settings, welcomeDone: false } }
}

export interface StateStoreOptions {
  /**
   * The timed writes do not hold the process: the text is made at once, written aside while the application goes on, and put in place unless a
   * flush has written something newer meanwhile. True by default for a store with a file; a flush (the quit, a restoration, the engine test) is always
   * synchronous. False keeps the timed writes synchronous too (the tests of the delay's arithmetic).
   */
  asyncWrites?: boolean
  /** The most the file may hold: what the next launch reads (`DATA_FILE_MAX_BYTES`, persist.ts). The tests give a small one. */
  maxBytes?: number
  /** The version of the application (`app.getVersion()`): written in the file as `WRITER_FIELD`, so that the next launch knows which version wrote it. */
  appVersion?: string
}

/** The state would not fit in what the next launch reads, even without its pictures of icons: the file on disk is left as it is. */
export class StateTooLargeError extends Error {}

/** The state as it is written when it would not fit otherwise: the icons kept as `data:` pictures (up to 64 Ko each) go, the pages give theirs again. */
function withoutDataIcons(state: SidebarState): SidebarState {
  const light = <T extends { faviconUrl?: string }>(items: readonly T[]): T[] =>
    items.map((item) => {
      if (!item.faviconUrl?.startsWith('data:')) return item
      const { faviconUrl: _picture, ...rest } = item
      return rest as T
    })
  return { ...state, tabs: light(state.tabs), favorites: light(state.favorites), readLater: light(state.readLater), ...(state.bookmarks ? { bookmarks: light(state.bookmarks) } : {}) }
}

export class StateStore {
  private timer: NodeJS.Timeout | null = null
  /** When the oldest change that is not on disk was made (null: nothing waits). */
  private dirtySince: number | null = null
  /** The last write failed (the notice was given once, not at each retry). */
  private failing = false
  /** Counts the changes; `onDisk` is the count the file holds. Together they tell a write in flight whether what it carries is still wanted. */
  private version = 0
  private onDisk = 0
  /** A write that does not hold the process is in flight: one at a time. */
  private writing = false
  private readonly asyncWrites: boolean
  /** What the file held that this version does not know: written back with every save. */
  private readonly foreign: ForeignFields | null
  private readonly maxBytes: number
  private readonly appVersion: string | null
  private readonly listeners = new Set<(state: SidebarState) => void>()

  /**
   * `path` null keeps the state in memory only (the private window): nothing is ever written. `scrub` runs on every
   * new state before anyone sees it, and must hand back the same object when it changes nothing.
   */
  constructor(
    private state: SidebarState,
    private readonly path: string | null,
    private readonly scrub?: (state: SidebarState) => SidebarState,
    options: StateStoreOptions = {}
  ) {
    this.asyncWrites = path !== null && options.asyncWrites !== false
    this.maxBytes = options.maxBytes ?? DATA_FILE_MAX_BYTES
    this.appVersion = options.appVersion ?? null
    this.foreign = path === null ? null : (foreignOfState.get(state) ?? null)
  }

  get(): SidebarState {
    return this.state
  }

  /** The store that holds the tabs every normal window lists: this one, except for a window's view of it (see `WindowView`). */
  root(): StateStore {
    return this
  }

  subscribe(listener: (state: SidebarState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispatch(action: Action, ctx: Ctx = liveCtx()): void {
    const reduced = reduce(this.state, action, ctx)
    const next = this.scrub ? this.scrub(reduced) : reduced
    if (next === this.state) return
    this.state = next
    this.scheduleSave()
    this.tell()
  }

  /** Takes a state computed elsewhere (a window's view of it) as the new one. */
  replace(next: SidebarState): void {
    if (next === this.state) return
    this.state = next
    this.scheduleSave()
    this.tell()
  }

  /**
   * Tells every listener of the change, each on its own: one that throws (a window's sync, the menu, a gate) is written to the log and does not keep
   * the ones after it from hearing, nor the caller (a timer, an IPC handler) from going on; the state is the new one whatever a listener does. Each is
   * handed the state as it is when its turn comes: a listener that dispatches again tells everyone the newer state, and the ones after it in this
   * round must not get the older one afterwards.
   */
  private tell(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state)
      } catch (error) {
        noteListenerFailure(error)
      }
    }
  }

  /**
   * Writes the state now, synchronously. Answers whether it is on disk: a full disk or a folder without permission does not throw (this runs at quit
   * and from a timer, where nothing could catch it). The state stays in memory, the failure is logged and reported once, and the write
   * is tried again after a while and at the next change or flush. A timed write in flight when this runs is not put in place after it.
   */
  flush(): boolean {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dirtySince = null
    if (this.path === null) return true
    const version = this.version
    try {
      writeFileAtomic(this.path, this.text())
    } catch (error) {
      this.failed(error, () => this.flush())
      return false
    }
    this.onDisk = version
    this.succeeded()
    return true
  }

  /**
   * The text of the file. The private tabs of a normal window live in memory only: the file never hears of them. A text bigger than the next launch
   * reads (it would set the file aside as damaged and start afresh) is made again without the `data:` pictures of the icons; one still too big throws
   * `StateTooLargeError`, which the write reports (a notice, a new try) while the last good file stays in place.
   */
  private text(): string {
    // The writer goes last: it is this version, whatever the file said before.
    const written = (state: SidebarState): unknown => (this.appVersion === null ? withForeignFields(state, this.foreign) : { ...withForeignFields(state, this.foreign), [WRITER_FIELD]: this.appVersion })
    const full = JSON.stringify(written(persistableState(this.state)))
    // A character is three bytes at most: most states are far below the bound and need no count of their bytes.
    if (full.length * 3 <= this.maxBytes || Buffer.byteLength(full) <= this.maxBytes) return full
    const light = JSON.stringify(written(withoutDataIcons(persistableState(this.state))))
    if (Buffer.byteLength(light) > this.maxBytes) throw new StateTooLargeError(`the state is ${Buffer.byteLength(light)} bytes without its pictures of icons, more than the ${this.maxBytes} the next launch reads; the file on disk is kept`)
    console.warn(`[store] the state is ${Buffer.byteLength(full)} bytes, more than the ${this.maxBytes} the next launch reads: it is written without the pictures of its icons`)
    return light
  }

  /**
   * The write the timer makes. With `asyncWrites` the process is not held while the disk takes the file (a state is megabytes with the icons of its
   * tabs, and a title that changes asks for a write): the text is made at once (that much stays on the main thread), written aside, and put in place
   * unless a flush has written something newer meanwhile. Without, it is a flush.
   */
  private async save(): Promise<void> {
    this.timer = null
    if (!this.asyncWrites || this.path === null) {
      this.flush()
      return
    }
    // A write is already in flight: when it ends it arms a new one if the state changed meanwhile.
    if (this.writing) return
    this.writing = true
    this.dirtySince = null
    const version = this.version
    try {
      // THE GUARD of "an older text never replaces a newer one": a flush made while this write was in flight wrote a later state.
      const replaced = await writeFileAtomicAsync(this.path, this.text(), () => this.onDisk < version)
      if (replaced) {
        this.onDisk = version
        this.succeeded()
      }
    } catch (error) {
      this.failed(error, () => void this.save())
    } finally {
      this.writing = false
    }
    if (this.version !== this.onDisk && !this.timer) this.arm()
  }

  private succeeded(): void {
    if (this.failing) {
      this.failing = false
      console.error(`[store] ${this.path} can be written again`)
    }
  }

  private failed(error: unknown, retry: () => void): void {
    if (!this.failing) {
      this.failing = true
      console.error(`[store] cannot write ${this.path}; the state is kept in memory and the write is tried again:`, error)
      if (!(error instanceof HeldFileError)) reportPersistenceNotice({ kind: 'save-failed', file: basename(this.path!), reason: String((error as Error).message ?? error) })
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(retry, RETRY_DELAY_MS)
  }

  private scheduleSave(): void {
    this.version++
    this.dirtySince ??= Date.now()
    this.arm()
  }

  /** The timer of the next write: a quiet moment of SAVE_DELAY_MS, but never later than SAVE_MAX_WAIT_MS after the oldest change not on disk. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    const now = Date.now()
    this.dirtySince ??= now
    const room = Math.max(0, this.dirtySince + SAVE_MAX_WAIT_MS - now)
    this.timer = setTimeout(() => void this.save(), Math.min(SAVE_DELAY_MS, room))
  }
}

/**
 * One window's view of the shared state. The tabs, spaces and settings are the shared store's; the current space, the selected tab
 * and the sidebar layout are the window's own (see window-selection.ts). It stands wherever a `StateStore` is expected, so a
 * window's browser, menu and IPC need not know whether other windows exist. With a single window it behaves exactly as the store.
 */
export class WindowView extends StateStore {
  private cache: { shared: SidebarState; selection: Selection; view: SidebarState } | null = null

  constructor(
    private readonly shared: StateStore,
    private selection: Selection,
    /** Every window view of the shared store: a tab shown in one of them is taken away from the others. */
    private readonly siblings: Set<WindowView>,
    /** The first window: its layout (sidebar, toolbar) is the one saved with the state. The others keep theirs for as long as they are open. */
    private readonly primary = false,
    /** The window's key (`window-1`…; the first window's is `main`): with the setting `independentWindows`, it lists the tabs that carry it (window-tabs.ts). */
    private readonly key: string = MAIN_WINDOW_KEY
  ) {
    super(shared.get(), null)
    siblings.add(this)
  }

  override root(): StateStore {
    return this.shared
  }

  /** A state computed elsewhere becomes the shared one: a window's view has no state of its own to replace (the copy the base class keeps is never read). */
  override replace(next: SidebarState): void {
    this.shared.replace(next)
  }

  override get(): SidebarState {
    const shared = this.shared.get()
    if (this.cache?.shared === shared && this.cache.selection === this.selection) return this.cache.view
    let view = project(shared, this.selection, this.key)
    // With windows of their own, a change to another window's tabs leaves this window's view as it was: the same object, so that nothing here is drawn again.
    if (this.cache && windowsAreIndependent(shared) && sameView(this.cache.view, view)) view = this.cache.view
    this.cache = { shared, selection: this.selection, view }
    return view
  }

  override subscribe(listener: (state: SidebarState) => void): () => void {
    return this.shared.subscribe(() => listener(this.get()))
  }

  override dispatch(action: Action, ctx: Ctx = liveCtx()): void {
    const current = this.shared.get()
    const independent = windowsAreIndependent(current)
    // With windows of their own, an action about every tab of the state (a space put aside, a container deleted, an import merged) is reduced on every tab.
    const whole = independent && EVERY_TAB_ACTIONS.has(action.type)
    const base = whole ? withEveryTab(this.get(), current) : this.get()
    const next = reduce(base, action, ctx)
    if (next === base) return
    this.selection = selectionOf(next)
    // With windows of their own, what the window did not see (the other windows' tabs) is put back around what it changed.
    const merged = independent && !whole ? putBackOwnTabs(current, base, next, this.key, REPLACING_ACTIONS.has(action.type)) : next
    // What this window now shows is no longer shown by the others (they would hold a second, stale copy of the page).
    const taken = new Set(visibleTabIds(next))
    for (const sibling of this.siblings) if (sibling !== this) sibling.release(merged, taken)
    // Only the first window's layout is shared (and saved): the sidebar hidden in a second window stays hidden there.
    const sharedLayout = layoutOf(current.settings)
    const keep = this.primary || sameLayout(layoutOf(merged.settings), sharedLayout)
    this.shared.replace(keep ? merged : { ...merged, settings: { ...merged.settings, ...sharedLayout } })
  }

  override flush(): boolean {
    return this.shared.flush()
  }

  /** The window is closed: its tabs, if it had tabs of its own, go to the first window. */
  dispose(): void {
    this.siblings.delete(this)
    this.shared.replace(handOverTabs(this.shared.get(), this.key))
  }

  private release(state: SidebarState, taken: ReadonlySet<string>): void {
    this.selection = release(this.selection, state, taken, this.key)
  }
}

/** Whether two views of the state are the same in everything a window draws: the same values, the tabs and split views being the same ones in the same order. */
function sameView(a: SidebarState, b: SidebarState): boolean {
  if (a === b) return true
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => sameValue(left[key], right[key]))
}

/** Equal, or arrays with the same items, or records (the settings, the selection of each space) with the same values: one level deep, which is how a projection rebuilds them. */
function sameValue(x: unknown, y: unknown): boolean {
  if (Object.is(x, y)) return true
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((item, i) => Object.is(item, y[i]))
  if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null || Array.isArray(x) || Array.isArray(y)) return false
  const p = x as Record<string, unknown>
  const q = y as Record<string, unknown>
  return Object.keys(p).length === Object.keys(q).length && Object.keys(p).every((id) => Object.is(p[id], q[id]))
}
