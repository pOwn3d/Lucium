// What the interface may ask the reducer to do through the `dispatch` channel. The interface is a trusted surface (it is locked
// to the application's own pages, see surface-guard.ts), but the main process still checks what crosses the channel: an action
// that replaces the whole state or loads code at startup is the main process' to dispatch, never the interface's.

import { mayOnlyForget } from './open-with'
import { LOCK_SETTING_KEYS } from './lock'

/**
 * Dispatched by the menu and the importers inside the main process only. A custom filter list is added and removed by the main process,
 * which reads the file and keeps its rules on disk first: the interface only switches one on or off (`filterlist/enable`). `space/image` names
 * a file of the pictures folder: only the code that has just made that file may say so (shell/space-images.ts), never a name the interface sends.
 * The containers are changed through the `container/*` actions only (see `interfaceMayDispatch`).
 * `bookmarks/import` carries what the main process read from a file it chose: the interface never sends the entries of an import.
 * `livefolder/result` is the answer of a look made by the scheduler of the main process: the interface never says what a feed held.
 * `split/restore` is the "Annuler" of the notice of a closed pane: the main process kept the split view as it was, the interface never sends one whole.
 * `tabs/untidy` is the "Annuler" of the notice of "Ranger les onglets…": the main process worked out what to put back from the states before and after.
 * `archive/forget-pages` is sent when the history of a profile or the history of a site is cleared (the main process also cleans the copies of the session then).
 * `tab/image` names a file of the pictures folder, like `space/image`. `favicon/fill` is the answer of the icon resolver of the main process.
 * `profile/revert-missing` puts the spaces of a profile whose folder is gone back on the default profile, which only the launch decides.
 * `sidepanel/behavior` is what an extension asked through `chrome.sidePanel`, relayed by the main process.
 * `view/restore` is the "Annuler" of the notice of a work view removed: the main process kept the view as it was, with the split views it had open.
 * `sync/apply` is what a synchronisation session writes into the state (sidebar-sync.ts): the interface never sends a patch.
 * `permission/visit`, `permission/forget-visits` and `permission/sweep` are the visits the pages report and the daily pass of « Oublier les autorisations des sites non visités »: only the main process knows the day and what was visited.
 *
 * Not in this list, on purpose: `permission/set` and `container/permission` grant or refuse a permission to a site without a question, and
 * they are the interface's to send: that is what the site panel and the permissions of the settings do when the user changes an answer.
 */
export const MAIN_ONLY_ACTIONS: ReadonlySet<string> = new Set(['permission/visit', 'permission/sweep', 'permission/forget-visits', 'state/restore', 'import/merge', 'import/revert', 'backup/restore', 'space/import', 'boost/import', 'filterlist/add', 'filterlist/remove', 'space/image', 'bookmarks/import', 'livefolder/result', 'split/restore', 'tabs/untidy', 'archive/forget-pages', 'tab/image', 'favicon/fill', 'profile/revert-missing', 'sidepanel/behavior', 'view/restore', 'sync/apply'])

const ACTION_TYPE_MAX = 64

/** The settings of the lock (lock.ts) change through the lock's own handler, which checks who asks: a patch that names one is the main process' to send. */
const LOCK_KEYS: ReadonlySet<string> = new Set(LOCK_SETTING_KEYS)

/** The folders a profile may be told to download into: the ones the user picked in the system's folder box, and the ones already in use. */
export interface KnownFolders {
  has(folder: string): boolean
}

const NO_FOLDER: KnownFolders = { has: () => false }

/** How many folders are remembered; the oldest goes first. A user picks a handful in a run. */
export const DOWNLOAD_FOLDERS_MAX = 64

/**
 * The download folders the main process knows to be the user's choice, for the run: what the folder box answered, and what the profiles
 * already had when the interface last spoke (so that « Annuler » of a reset can put a folder back). A path the interface sends is compared
 * with them and never taken on its word: downloads are written there without another question.
 */
export class DownloadFolders implements KnownFolders {
  private readonly known = new Set<string>()

  note(folder: unknown): void {
    if (typeof folder !== 'string' || folder.length === 0) return
    this.known.delete(folder)
    this.known.add(folder)
    for (const oldest of this.known) {
      if (this.known.size <= DOWNLOAD_FOLDERS_MAX) break
      this.known.delete(oldest)
    }
  }

  /** The folders the profiles have now. */
  noteProfiles(profiles: unknown): void {
    if (typeof profiles !== 'object' || profiles === null) return
    for (const own of Object.values(profiles)) if (typeof own === 'object' && own !== null) this.note((own as { downloadDir?: unknown }).downloadDir)
  }

  has(folder: string): boolean {
    return this.known.has(folder)
  }
}

/** Whether every download folder a patch of the profiles names is one the main process knows. A patch that is not a record of records names none it could keep. */
function downloadFoldersKnown(profiles: unknown, folders: KnownFolders): boolean {
  if (typeof profiles !== 'object' || profiles === null) return true
  return Object.values(profiles).every((own) => {
    if (typeof own !== 'object' || own === null) return true
    const folder = (own as { downloadDir?: unknown }).downloadDir
    return folder === undefined || (typeof folder === 'string' && folders.has(folder))
  })
}

/**
 * Whether an action coming from the interface is let through. `settings/update` may only shorten `extensionPaths` (the "Retirer"
 * button): adding an extension goes through the file dialog of the main process, never through a path typed in the interface. The
 * same goes for `openWithApps`, the applications remembered for a type of file: the interface may forget some, never name one.
 * `folders`: the download folders the main process knows (none when the caller gives none: a patch then names no folder at all).
 */
export function interfaceMayDispatch(action: unknown, currentExtensionPaths: readonly string[], currentOpenWithApps: Readonly<Record<string, string>> = {}, folders: KnownFolders = NO_FOLDER): boolean {
  if (typeof action !== 'object' || action === null) return false
  const { type, patch } = action as { type?: unknown; patch?: unknown }
  if (typeof type !== 'string' || type.length === 0 || type.length > ACTION_TYPE_MAX) return false
  if (MAIN_ONLY_ACTIONS.has(type)) return false
  // A page of an extension opens in a tab only when an extension asked for it (chrome.tabs.create, in the main process): the interface never says so.
  if (type === 'tab/open' && Object.hasOwn(action, 'allowExtensionPages')) return false
  // The Extensions page opens in a tab only from the shell (Browser.openExtensionsTab): a page of the interface cannot ask for a tab on an address of the privileged scheme.
  if (type === 'tab/open' && Object.hasOwn(action, 'allowInternalPages')) return false
  // Nor can it say that a tab is on the Extensions page again after the engine saw it commit there: only the main process reports what the page really shows.
  if (type === 'tab/update' && Object.hasOwn(action, 'allowInternalPages')) return false
  if (type === 'settings/update') {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return false
    if (Object.hasOwn(patch, '__proto__')) return false
    if (Object.hasOwn(patch, 'customFilterLists')) return false
    // A container is created, renamed and deleted by its own actions: a patch could drop one without its data being erased, or hand a page a container's permissions.
    if (Object.hasOwn(patch, 'containers') || Object.hasOwn(patch, 'containerRules')) return false
    // The folder the translation models are kept in is chosen in the system's folder box by the main process: a path the interface sends is never kept.
    if (Object.hasOwn(patch, 'translateModelsDir')) return false
    // A deleted profile's id is retired by the main process once its data is erased (profile-retire.ts): the interface could free one whose folder is on disk.
    if (Object.hasOwn(patch, 'retiredProfileIds')) return false
    // The protection a profile began with is what « modified » and « Rétablir » go back to: set when the profile is made or its file first read, never by the interface.
    if (Object.hasOwn(patch, 'protectionBaseline')) return false
    // The address the updates are read at has no control in the interface, by design: it is written by hand in the state file, never sent.
    if (Object.hasOwn(patch, 'updateFeedUrl')) return false
    // The folder a profile downloads into is picked in the system's folder box: the interface hands back the path it was given there.
    if (!downloadFoldersKnown((patch as { profiles?: unknown }).profiles, folders)) return false
    if (Object.keys(patch).some((key) => LOCK_KEYS.has(key))) return false
    const paths = (patch as { extensionPaths?: unknown }).extensionPaths
    if (paths !== undefined) {
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && currentExtensionPaths.includes(p))) return false
    }
    if (Object.hasOwn(patch, 'openWithApps') && !mayOnlyForget(currentOpenWithApps, (patch as { openWithApps?: unknown }).openWithApps)) return false
  }
  return true
}
