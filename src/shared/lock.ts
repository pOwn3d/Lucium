// The lock (Réglages › Vie privée et sécurité › Verrouillage): of the application at launch and when the Mac wakes up, and of single spaces.
//
// What it is, and is not: a lock of the interface. While it holds, the window shows a lock screen instead of the tabs, the pages of what
// is locked are put to sleep (their web views are gone), and the shell answers nothing about them. The files stay as they are on the disk:
// cookies, profiles and state.json are not encrypted (Chromium's own storage cannot be, from here), so someone who can read the disk is
// not stopped by it. The panel says so. Pure rules here; the service that holds the state is main/lock-service.ts.

import { defaultSettings, type RuntimeState, type Settings, type SidebarState, type Space } from './model'
import { cleanId } from './state-clean'
import { t } from './i18n'
import { PRIVATE_IDLE_CHOICES } from './private-lock'

/** The settings only the lock's own handler may change (the interface cannot patch them, see ipc-policy.ts). */
export const LOCK_SETTING_KEYS = ['lockEnabled', 'lockApp', 'lockedSpaces', 'lockTouchId', 'lockPrivateIdle'] as const satisfies readonly (keyof Settings)[]

export const LOCKED_SPACES_MAX = 200
export const LOCK_PHRASE_MIN = 8
export const LOCK_PHRASE_MAX = 1024

/** The spaces set to be locked: ids, each once, at most `LOCKED_SPACES_MAX`; `spaceIds`, when given, drops those that do not exist. */
export function cleanLockedSpaces(raw: unknown, spaceIds?: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.size >= LOCKED_SPACES_MAX) break
    const id = cleanId(entry)
    if (id !== null && (!spaceIds || spaceIds.has(id))) out.add(id)
  }
  return [...out]
}

/** Why a phrase cannot be the lock's, or null when it can. */
export function lockPhraseProblem(phrase: unknown): string | null {
  if (typeof phrase !== 'string') return t('lock.la-phrase-du-verrou-est-invalide')
  if ([...phrase.normalize('NFKC')].length < LOCK_PHRASE_MIN) return t('lock.la-phrase-du-verrou-doit-faire-au-moins-lock', { LOCK_PHRASE_MIN })
  if (phrase.length > LOCK_PHRASE_MAX) return t('lock.la-phrase-du-verrou-est-trop-longue')
  return null
}

/**
 * The file an export is made from: the lock's settings are this installation's own (which spaces are locked means nothing on another
 * Mac, and a file must never switch a lock off or on), so they are left at their defaults. The phrase is not in the state at all: its
 * hash lives in a file of its own that no export reads. Same object when there is nothing to change.
 */
export function exportableState(state: SidebarState): SidebarState {
  const defaults = defaultSettings()
  const { settings } = state
  if (LOCK_SETTING_KEYS.every((key) => JSON.stringify(settings[key]) === JSON.stringify(defaults[key]))) return state
  const reset = Object.fromEntries(LOCK_SETTING_KEYS.map((key) => [key, defaults[key]]))
  return { ...state, settings: { ...settings, ...reset } }
}

/** What the interface needs to know about the lock (absent from the snapshot while the lock is off). */
export interface LockView {
  /** Turned on and a phrase exists. */
  active: boolean
  /** The whole window is covered. */
  appLocked: boolean
  /** The spaces that are locked at this moment (set to be locked, and not unlocked since). */
  lockedSpaces: string[]
  /** Every space set to be locked, unlocked now or not. */
  guardedSpaces: string[]
  /** Touch ID can be offered: this Mac has it, the setting allows it. */
  touchId: boolean
  /** Milliseconds before another phrase is tried; 0 when one can be tried now. */
  retryInMs: number
}

/** The space without the picture and the web panels the user gave it: what names the sites it is used for. */
function withoutSites(space: Space): Space {
  const { image: _image, webPanels: _webPanels, ...rest } = space
  return rest
}

/**
 * The state the interface is shown. With the application locked it is a skeleton (the spaces' colours and nothing else: no names, no tab,
 * no folder, no favourite, no host in a setting); with spaces locked it is the state without their tabs, folders, archive, splits and
 * saved sessions. The same object comes back when nothing is locked. The real state is never touched.
 */
export function redactForLock(state: SidebarState, view: Pick<LockView, 'appLocked' | 'lockedSpaces'>): SidebarState {
  if (view.appLocked) {
    const { settings } = state
    const blank = defaultSettings()
    return {
      ...state,
      spaces: state.spaces.map((space) => ({ ...withoutSites(space), name: t('lock.verrouille'), emoji: '🔒' })),
      tabs: [],
      folders: [],
      favorites: [],
      // The names and the addresses of the work views say what the user works on, as the favourites do.
      workViews: [],
      archive: [],
      readLater: [],
      bookmarks: [],
      readLaterFolders: [],
      activeTabBySpace: Object.fromEntries(state.spaces.map((space) => [space.id, null])),
      sitePermissions: {},
      siteVisits: {},
      sidePanelBehavior: {},
      commandBarUsage: {},
      splits: [],
      boosts: [],
      sessions: [],
      settings: {
        ...blank,
        sidebarVisible: settings.sidebarVisible,
        sidebarWidth: settings.sidebarWidth,
        sidePanelWidth: settings.sidePanelWidth,
        showToolbar: settings.showToolbar,
        interfaceAppearance: settings.interfaceAppearance,
        websiteAppearance: settings.websiteAppearance,
        lockEnabled: settings.lockEnabled,
        lockApp: settings.lockApp,
        lockTouchId: settings.lockTouchId
      }
    }
  }
  if (view.lockedSpaces.length === 0) return state
  const hidden = new Set(view.lockedSpaces)
  return {
    ...state,
    // The sites kept beside the pages of a locked space (titles and addresses) are part of the space, like its tabs.
    spaces: state.spaces.map((space) => (hidden.has(space.id) ? withoutSites(space) : space)),
    tabs: state.tabs.filter((tab) => !hidden.has(tab.spaceId)),
    folders: state.folders.filter((folder) => !hidden.has(folder.spaceId)),
    archive: state.archive.filter((entry) => !hidden.has(entry.spaceId)),
    splits: state.splits.filter((split) => !hidden.has(split.spaceId)),
    // A space put aside keeps its tabs inside the session it became: that session is part of the space.
    sessions: state.sessions.filter((session) => !session.space || !hidden.has(session.space.space.id)),
    activeTabBySpace: Object.fromEntries(Object.entries(state.activeTabBySpace).map(([id, tabId]) => [id, hidden.has(id) ? null : tabId]))
  }
}

/** What a snapshot of the interface carries beside the state that names the user's pages, files, extensions and windows (shared/ipc.ts `UiSnapshot`). */
interface SnapshotExtras {
  state: Pick<SidebarState, 'splits'>
  extensions: readonly unknown[]
  downloads: readonly unknown[]
  find: unknown
  peek: unknown
  sidePanel: unknown
  toast: unknown
  scrollSyncedSplits?: string[]
  webPanel?: unknown
  windows?: unknown
  windowName?: string
  foreignDrag?: unknown
  reloadRun?: unknown
  deadTabs?: ReadonlyArray<{ id: string }>
}

/**
 * The snapshot the interface is given, beside its state (which `redactForLock` made): while the whole application is locked, the lock screen is
 * told nothing of the downloads (names, addresses, paths), the extensions, a notice, the find bar, a Glance, a side or web panel, the names of the
 * windows or a drag between them (LockScreen.tsx reads the state and the lock only), nor of a run of « Actualiser tous les onglets ». With spaces
 * locked, only the split views and the tabs whose site no longer answers that the shown state still holds are named. `snapshot.state` is the state already redacted. The same object when nothing changes.
 * The downloads are the application's list, not a space's: a single locked space does not hide them (a download is tied to no space once it ends).
 */
export function redactSnapshotForLock<T extends SnapshotExtras>(snapshot: T, view: Pick<LockView, 'appLocked'> | undefined): T {
  if (!view) return snapshot
  if (view.appLocked) {
    // THE GUARD of what the lock screen is told: nothing but the skeleton of the state and the lock itself.
    const rest = withoutKeys(snapshot, ['webPanel', 'windows', 'windowName', 'foreignDrag', 'scrollSyncedSplits', 'reloadRun', 'deadTabs', 'spaceTabs'])
    return { ...rest, extensions: [], downloads: [], find: null, peek: null, sidePanel: null, toast: null }
  }
  snapshot = withShownDeadTabs(snapshot)
  const synced = snapshot.scrollSyncedSplits
  if (synced === undefined) return snapshot
  const shownSplits = new Set(snapshot.state.splits.map((split) => split.id))
  const kept = synced.filter((id) => shownSplits.has(id))
  if (kept.length === synced.length) return snapshot
  return kept.length > 0 ? { ...snapshot, scrollSyncedSplits: kept } : withoutKeys(snapshot, ['scrollSyncedSplits'])
}

/** The tabs whose site no longer answers, among those the shown state still holds: a tab of a locked space is not named. */
function withShownDeadTabs<T extends SnapshotExtras>(snapshot: T): T {
  const dead = snapshot.deadTabs
  if (dead === undefined) return snapshot
  const shown = new Set((snapshot.state as Partial<Pick<SidebarState, 'tabs'>>).tabs?.map((tab) => tab.id) ?? [])
  const kept = dead.filter((entry) => shown.has(entry.id))
  if (kept.length === dead.length) return snapshot
  return kept.length > 0 ? { ...snapshot, deadTabs: kept } : withoutKeys(snapshot, ['deadTabs'])
}

/** `object` without `keys` (absent, not undefined: the snapshot crosses IPC as it is). */
function withoutKeys<T extends object>(object: T, keys: readonly string[]): T {
  const copy = { ...object } as Record<string, unknown>
  for (const key of keys) delete copy[key]
  return copy as T
}

/**
 * The facts about the life of each tab (loading, sound, asleep…) restricted to the tabs `shown` holds. For the interface, `shown` is the state it
 * is given: the entry of a tab the lock hides would give its id away. For the shell, it is the state itself: the entry of a tab that is gone
 * (a sleeping tab keeps one, no page remains to remove it) is dropped. The same object comes back when nothing is dropped.
 */
export function runtimeOfTabs(runtime: RuntimeState, shown: Pick<SidebarState, 'tabs'>): RuntimeState {
  const ids = new Set(shown.tabs.map((tab) => tab.id))
  const tabs = Object.entries(runtime.tabs).filter(([id]) => ids.has(id))
  const media = runtime.media?.filter((id) => ids.has(id))
  const marks = runtime.reloadMarks ? Object.entries(runtime.reloadMarks).filter(([id]) => ids.has(id)) : undefined
  if (tabs.length === Object.keys(runtime.tabs).length && media?.length === runtime.media?.length && marks?.length === (runtime.reloadMarks ? Object.keys(runtime.reloadMarks).length : undefined)) return runtime
  const { reloadMarks: _marks, ...rest } = runtime
  return { ...rest, tabs: Object.fromEntries(tabs), ...(media ? { media } : {}), ...(marks && marks.length > 0 ? { reloadMarks: Object.fromEntries(marks) } : {}) }
}

/**
 * The ids of what `redactForLock` hides (tabs, folders, archive entries, split views, sessions put aside): the interface never saw them, so a
 * request from it that names one is not an honest one. Empty when nothing is locked.
 */
export function hiddenIds(state: SidebarState, view: Pick<LockView, 'appLocked' | 'lockedSpaces'>): Set<string> {
  const shown = redactForLock(state, view)
  if (shown === state) return new Set()
  const idsOf = (s: SidebarState): string[] => [...s.tabs, ...s.folders, ...s.archive, ...s.splits, ...s.sessions].map((entry) => entry.id)
  const kept = new Set(idsOf(shown))
  return new Set(idsOf(state).filter((id) => !kept.has(id)))
}

/** The fields of an action, or of a request, that name a tab, a folder or a split view (`ids` and `tabIds` hold several; `splitId`: « Enregistrer comme vue de travail… »). */
const TARGET_FIELDS = ['id', 'tabId', 'withTabId', 'parentId', 'folderId', 'openerId', 'splitId'] as const
const TARGET_LIST_FIELDS = ['ids', 'tabIds'] as const

/** Whether an action (or a request: `{ id }`, `{ ids }`) names one of the `hidden` ids, in any field that holds the id of a tab, folder or split view. */
export function namesHiddenId(action: unknown, hidden: ReadonlySet<string>): boolean {
  if (typeof action !== 'object' || action === null || hidden.size === 0) return false
  const fields = action as Record<string, unknown>
  const hides = (value: unknown): boolean => typeof value === 'string' && hidden.has(value)
  const names = (record: unknown): boolean => {
    if (typeof record !== 'object' || record === null) return false
    const own = record as Record<string, unknown>
    return TARGET_FIELDS.some((field) => hides(own[field])) || TARGET_LIST_FIELDS.some((field) => Array.isArray(own[field]) && (own[field] as unknown[]).some(hides))
  }
  // `split/restore` carries the whole split view: its id and its tabs are named one level down. So does `tabs/tidy`, in each of its groups.
  const groups = fields['groups']
  return names(fields) || namesHiddenId(fields['split'], hidden) || (Array.isArray(groups) && groups.some(names))
}

/** Wrong phrases tolerated before the answers slow down, and the bounds of the wait (it doubles at each further failure). */
export const FREE_TRIES = 3
export const RETRY_FIRST_MS = 1000
export const RETRY_MAX_MS = 30_000

/** How long to wait after `failures` wrong phrases in a row. */
export function retryDelayMs(failures: number): number {
  if (!Number.isInteger(failures) || failures < FREE_TRIES) return 0
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - FREE_TRIES))
}

/** What is being unlocked. */
export type LockTarget = { scope: 'app' } | { scope: 'space'; spaceId: string }

/** A request to unlock: with a `phrase` the phrase is checked, without it Touch ID is asked for. */
export interface UnlockRequest {
  target: LockTarget
  phrase?: string
}

/** The answer to an unlock or a configuration request. `retryInMs` tells how long the phrase is refused for. */
export type LockReply = { ok: true } | { ok: false; message: string; retryInMs?: number }

export function parseUnlockRequest(raw: unknown): UnlockRequest | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { target, phrase } = raw as { target?: unknown; phrase?: unknown }
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return null
  const { scope, spaceId } = target as { scope?: unknown; spaceId?: unknown }
  if (phrase !== undefined && (typeof phrase !== 'string' || phrase.length > LOCK_PHRASE_MAX)) return null
  if (scope === 'app') return { target: { scope: 'app' }, ...(phrase !== undefined ? { phrase } : {}) }
  const id = cleanId(spaceId)
  if (scope === 'space' && id !== null) return { target: { scope: 'space', spaceId: id }, ...(phrase !== undefined ? { phrase } : {}) }
  return null
}

/** The changes the interface may ask for (see LockService.configure for who may do what). */
export type LockConfig =
  | { op: 'set-phrase'; phrase: string; current?: string }
  | { op: 'disable'; current: string }
  | { op: 'app'; value: boolean }
  | { op: 'touch-id'; value: boolean }
  | { op: 'private-idle'; minutes: number }
  | { op: 'space'; spaceId: string; locked: boolean }
  | { op: 'lock-now' }

export function parseLockConfig(raw: unknown): LockConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const text = (value: unknown): value is string => typeof value === 'string' && value.length <= LOCK_PHRASE_MAX
  switch (r['op']) {
    case 'set-phrase':
      return text(r['phrase']) && (r['current'] === undefined || text(r['current'])) ? { op: 'set-phrase', phrase: r['phrase'], ...(r['current'] !== undefined ? { current: r['current'] as string } : {}) } : null
    case 'disable':
      return text(r['current']) ? { op: 'disable', current: r['current'] } : null
    case 'app':
    case 'touch-id':
      return typeof r['value'] === 'boolean' ? { op: r['op'], value: r['value'] } : null
    case 'private-idle':
      return (PRIVATE_IDLE_CHOICES as readonly unknown[]).includes(r['minutes']) ? { op: 'private-idle', minutes: r['minutes'] as number } : null
    case 'space': {
      const spaceId = cleanId(r['spaceId'])
      return spaceId !== null && typeof r['locked'] === 'boolean' ? { op: 'space', spaceId, locked: r['locked'] } : null
    }
    case 'lock-now':
      return { op: 'lock-now' }
    default:
      return null
  }
}

/** IPC channels that stay open while the application is locked: reading the snapshot (it is a skeleton), the lock's own, and closing a panel. */
export const OPEN_WHILE_LOCKED: ReadonlySet<string> = new Set(['lucium:get-snapshot', 'lucium:lock-unlock', 'lucium:close-overlay'])

/**
 * The panels that may still open over a locked application. A panel is drawn over the window: opened over the lock screen it would hide the field of the
 * phrase, and the ones of the user's own pages and data (command bar, history, archive, spaces…) list what the lock hides. What is left are the questions
 * a page or an extension asks and that have to be answered (their pages are put to sleep by the lock, so none arises in practice), and ⌃Tab, which is
 * made from the state the interface is given.
 */
const PANELS_OPEN_WHILE_LOCKED: ReadonlySet<string> = new Set(['dialog', 'leave', 'permission', 'auth', 'extreview', 'passphrase', 'tabcycle'])

/** Whether a panel may open while the whole application is locked (`appLocked`); always true when it is not. */
export function canOpenWhileLocked(panel: string, appLocked: boolean): boolean {
  return !appLocked || PANELS_OPEN_WHILE_LOCKED.has(panel)
}

/**
 * Actions on a locked space that are refused (the interface cannot see its tabs, but it can see the space): deleting it, copying it into something
 * visible, changing the sites kept beside its pages, or changing what it is recognised by (its name, its icon, its theme, its picture, its header).
 * Its place in the list is not among them: `space/move` stays free.
 */
const REFUSED_ON_LOCKED_SPACE = new Set(['space/delete', 'space/aside', 'space/panel-add', 'space/panel-remove', 'space/update', 'space/background-position', 'space/header', 'space/image'])
/** Actions that copy the tabs of the space on screen into something that shows. */
const COPY_OF_ACTIVE_SPACE = new Set(['session/save', 'readlater/add'])
/**
 * Actions that change or remove what a space already holds, in the space they name (`spaceId`) or, without one, in the space on screen: a native
 * menu sends them whatever the interface shows, so they are refused here and not only greyed out.
 */
const CHANGES_SPACE_CONTENT = new Set(['today/clear', 'tabs/reset-pinned', 'tabs/tidy', 'folder/collapse-all'])
/**
 * The actions of a work view that open tabs in a space, or change the ones it opened there: the space is the one the view is always opened in (when that
 * space exists), else the one named, else the one on screen, as the reducer finds it (work-views.ts `workViewSpace`).
 */
const OPENS_A_WORK_VIEW = new Set(['view/open', 'view/reset', 'view/capture'])
/**
 * Actions that make a folder (a live one too): it lands in the space of the folder it is made in (`parentId`), else in the space that is named,
 * else in the one on screen, as the reducer places it. A folder is a part of what a space is recognised by, and « Nouveau dossier » comes from a
 * native menu whatever the window shows.
 */
const MAKES_A_FOLDER = new Set(['folder/create', 'livefolder/create'])
/**
 * Actions that put another set of spaces and tabs in the place of the present one, or take whole spaces away with their tabs: a locked space would
 * be replaced or removed by someone who was never asked for the phrase. They are refused while any space is locked, as an export is.
 */
const REPLACES_SPACES = new Set(['state/restore', 'backup/restore', 'import/revert'])

/**
 * What `lockRefuses` reads of the state to know the space a new folder lands in: the spaces that exist, and the space of each folder; and the space a work
 * view is always opened in (`workViews`, absent: none is).
 */
export type FolderPlaces = { spaces: readonly { id: string }[]; folders: readonly { id: string; spaceId: string }[]; workViews?: readonly { id: string; target?: { kind: string; spaceId?: string } }[] }
const NO_PLACES: FolderPlaces = { spaces: [], folders: [] }

/** Whether an action is refused because a space is locked. `places`: the state, for an action that makes a folder. (While the whole application is locked the interface's messages are refused at the door: see OPEN_WHILE_LOCKED.) */
export function lockRefuses(action: unknown, lockedSpaces: readonly string[], activeSpaceId: string, places: FolderPlaces = NO_PLACES): boolean {
  if (typeof action !== 'object' || action === null || lockedSpaces.length === 0) return false
  const { type, id, spaceId, parentId } = action as { type?: unknown; id?: unknown; spaceId?: unknown; parentId?: unknown }
  if (typeof type !== 'string') return false
  if (REPLACES_SPACES.has(type)) return true
  const locked = (space: unknown): boolean => typeof space === 'string' && lockedSpaces.includes(space)
  // Among the changes of `space/update`, a new profile also loses the pages the tabs were on (they are bound to the session they were made in).
  if (REFUSED_ON_LOCKED_SPACE.has(type)) return locked(id)
  if (CHANGES_SPACE_CONTENT.has(type)) return locked(spaceId === undefined ? activeSpaceId : spaceId)
  if (OPENS_A_WORK_VIEW.has(type)) {
    const target = places.workViews?.find((view) => view.id === id)?.target
    const always = target?.kind === 'space' && places.spaces.some((sp) => sp.id === target.spaceId) ? target.spaceId : undefined
    return locked(always ?? (spaceId === undefined ? activeSpaceId : spaceId))
  }
  if (MAKES_A_FOLDER.has(type)) {
    const parent = typeof parentId === 'string' && parentId !== '' ? places.folders.find((f) => f.id === parentId) : undefined
    if (parent) return locked(parent.spaceId)
    // The reducer puts a folder whose space is not named, or does not exist, in the one on screen: the refusal follows it there.
    return locked(typeof spaceId === 'string' && places.spaces.some((sp) => sp.id === spaceId) ? spaceId : activeSpaceId)
  }
  return COPY_OF_ACTIVE_SPACE.has(type) && locked(activeSpaceId)
}

/** The sentence that tells why `lockRefuses` refused an action. */
export function lockRefusalMessage(action: { type: string }): string {
  if (action.type === 'import/revert') return t('lock.deverrouillez-vos-espaces-avant-d-annuler-l-import')
  if (REPLACES_SPACES.has(action.type)) return t('lock.deverrouillez-vos-espaces-avant-de-restaurer')
  return t('lock.deverrouillez-l-espace-d-abord')
}

/**
 * Why nothing may be restored now (a state file, a copy of the session), or null when it may: the question is asked before a file is chosen
 * or a copy of the present state is made, so that a refusal costs nothing.
 */
export function restoreRefusal(lockedSpaces: readonly string[]): string | null {
  return lockedSpaces.length > 0 ? t('lock.deverrouillez-vos-espaces-avant-de-restaurer') : null
}

/** Why the latest import may not be taken back now, or null when it may. */
export function importUndoRefusal(lockedSpaces: readonly string[]): string | null {
  return lockedSpaces.length > 0 ? t('lock.deverrouillez-vos-espaces-avant-d-annuler-l-import') : null
}

/** Why the name, the icon, the theme, the picture or the header of a space may not change now, or null when they may. */
export function spaceLookRefusal(spaceId: string, lockedSpaces: readonly string[]): string | null {
  return lockedSpaces.includes(spaceId) ? t('lock.deverrouillez-l-espace-d-abord') : null
}

/**
 * Why no folder may be made in a space now (it is locked and its phrase was not given), or null when one may. The menus that offer « Nouveau
 * dossier » grey the entry out and say this, rather than leave a click that `lockRefuses` turns down.
 */
export function newFolderRefusal(spaceId: string, lockedSpaces: readonly string[]): string | null {
  return lockedSpaces.includes(spaceId) ? t('lock.deverrouillez-l-espace-d-abord') : null
}

/** Whether a panel is the editor of a locked space (its name and icon, or its theme): it would only collect changes that are refused. */
export function editsLockedSpace(request: { panel: string; spaceId?: unknown }, lockedSpaces: readonly string[]): boolean {
  return (request.panel === 'space' || request.panel === 'theme') && typeof request.spaceId === 'string' && lockedSpaces.includes(request.spaceId)
}

/**
 * What an action becomes while spaces are locked, when it reaches several spaces at once and only the locked ones are to be left alone.
 * « Vider l'archive »: the action with the spaces whose entries stay (the archive of a locked space is hidden, so emptying "the archive" means the
 * one that shows). Whatever the sender put there is replaced: without a locked space the action carries none.
 * « Appliquer ce thème à tous les espaces »: the locked spaces keep their theme.
 */
export function sparingLockedSpaces<A extends { type: string }>(action: A, lockedSpaces: readonly string[]): A {
  if (action.type === 'space/apply-themes') {
    const { entries } = action as A & { entries?: unknown }
    if (lockedSpaces.length === 0 || !Array.isArray(entries)) return action
    return { ...action, entries: entries.filter((entry: unknown) => !(typeof entry === 'object' && entry !== null && lockedSpaces.includes((entry as { id?: unknown }).id as string))) }
  }
  if (action.type !== 'archive/clear') return action
  const { keepSpaces: _sent, ...rest } = action as A & { keepSpaces?: unknown }
  return (lockedSpaces.length > 0 ? { ...rest, keepSpaces: [...lockedSpaces] } : rest) as A
}
