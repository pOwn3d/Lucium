// The private window (incognito). Pure rules: what the window keeps (nothing), what it refuses, what it inherits.
// The main process applies them (shell/windows.ts, shell/browser.ts, store.ts); nothing here touches Electron.

import type { OverlayRequest } from './ipc'
import type { Settings, SidebarState, Space } from './model'
import { createInitialState, type Action, type Ctx } from './sidebar'
import type { SpaceTheme } from './theme'
import { t } from './i18n'
import { PRIVATE_PROFILE_ID } from './profiles'

/** The name of the only space of a private window, in the language of the interface when the window is made. */
export const privateSpaceName = (): string => t('private-window.navigation-privee')
export const PRIVATE_SPACE_EMOJI = '🕶️'
/** The profile id of the private space. The engine ignores it: every page of the window goes to the window's own throw-away session. */
export { PRIVATE_PROFILE_ID }
/** The sidebar background of the private window. */
export const PRIVATE_BACKGROUND = '#0e0f15'

/**
 * A fixed dark theme. One colour, full intensity, no texture: `#252737` shaded by the dark appearance comes out as
 * exactly `PRIVATE_BACKGROUND` (see theme.ts, `backgroundColors`).
 */
export function privateTheme(): SpaceTheme {
  return {
    baseColors: ['#252737'],
    harmony: 'custom',
    angle: 155,
    intensity: 1,
    overlay: 'none',
    noise: 0,
    translucency: 'dark',
    vibrant: false,
    appearance: 'dark'
  }
}

/** Settings that describe one window (its layout): the private window keeps its own. Everything else follows the main window. */
export const WINDOW_LOCAL_SETTINGS = ['sidebarVisible', 'sidebarWidth', 'sidePanelWidth', 'showToolbar', 'fullUrlInToolbar', 'suggestionsNoticeSeen', 'siteZoom'] as const satisfies readonly (keyof Settings)[]

const LOCAL = new Set<string>(WINDOW_LOCAL_SETTINGS)
/** Never inherited: extensions do not run in a private window, and it has no containers (a container is a persistent identity: nothing of it is written from here). */
const NOT_INHERITED = new Set<string>(['extensionPaths', 'webStoreInstall', 'webStoreUpdates', 'tabContainers', 'containers', 'containerRules'])

/** A record without the entry of the private window's profile id; the same object when it has none. */
function withoutPrivateId<T>(record: Record<string, T>): Record<string, T> {
  if (!Object.hasOwn(record, PRIVATE_PROFILE_ID)) return record
  const { [PRIVATE_PROFILE_ID]: _theirs, ...others } = record
  return others
}

/**
 * The settings without what a profile of the user holds under the id of the private window's space (a profile made before the id was kept
 * for it, or brought by a file): its name and its own settings. A private window reads the settings of its space by that id, and would take
 * the search engine, the suggestions, the download folder and the proxy of that profile for its own, in place of the default profile's.
 */
export function withoutPrivateProfile<S extends Partial<Pick<Settings, 'profiles' | 'profileNames'>>>(settings: S): S {
  const profiles = settings.profiles && withoutPrivateId(settings.profiles)
  const profileNames = settings.profileNames && withoutPrivateId(settings.profileNames)
  return profiles === settings.profiles && profileNames === settings.profileNames ? settings : { ...settings, ...(profiles ? { profiles } : {}), ...(profileNames ? { profileNames } : {}) }
}

/** The settings a private window takes from the main window and follows when they change (search engine, blocking, shortcuts…). */
export function inheritedSettings(main: Settings): Partial<Settings> {
  return withoutPrivateProfile(Object.fromEntries(Object.entries(main).filter(([key]) => !LOCAL.has(key) && !NOT_INHERITED.has(key))) as Partial<Settings>)
}

/** The entries of `patch` that differ from `current`: a private window only reacts to a real change of the main window's settings. */
export function changedSettings(current: Settings, patch: Partial<Settings>): Partial<Settings> {
  const now = current as unknown as Record<string, unknown>
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => JSON.stringify(now[key]) !== JSON.stringify(value))) as Partial<Settings>
}

/** What a new private window starts with: one empty space, the main window's settings, nothing of its tabs, archive or favourites. */
export function createPrivateState(main: SidebarState, ctx: Ctx): SidebarState {
  const initial = createInitialState(ctx)
  const space: Space = { ...initial.spaces[0]!, name: privateSpaceName(), emoji: PRIVATE_SPACE_EMOJI, theme: privateTheme(), profileId: PRIVATE_PROFILE_ID }
  return {
    ...initial,
    spaces: [space],
    activeSpaceId: space.id,
    activeTabBySpace: { [space.id]: null },
    // No extension in a private window: the store cannot install into it, and nothing is looked up for it.
    settings: { ...withoutPrivateProfile(main.settings), sidebarVisible: true, extensionPaths: [], webStoreInstall: false, webStoreUpdates: 'manual', tabContainers: false, containers: [], containerRules: [] }
  }
}

/**
 * Applied after every change of the private state: the archive, the read-later list (and its folders), the bookmarks, the favourites, the work views and
 * the Tweaks are never kept. Same object when there is nothing to drop.
 */
export function scrubPrivateState(state: SidebarState): SidebarState {
  if (state.archive.length === 0 && state.readLater.length === 0 && state.readLaterFolders.length === 0 && state.bookmarks.length === 0 && state.favorites.length === 0 && state.boosts.length === 0 && state.workViews.length === 0) return state
  return { ...state, archive: [], readLater: [], readLaterFolders: [], bookmarks: [], favorites: [], boosts: [], workViews: [] }
}

/** Actions the private window accepts from its UI. Anything not listed is refused, so a new kind of action is private-safe by default. */
const PRIVATE_ACTIONS = new Set<Action['type']>([
  'tab/open',
  'tab/select',
  'tab/forget-origin',
  'tab/back-to-origin',
  'tab/close',
  'tab/update',
  'tab/rename',
  'tab/icon',
  'tab/duplicate',
  // The window's store is never written to disk: the interval lasts as long as the window, and nothing outlives it.
  'tab/auto-reload',
  'tab/close-others',
  // The layout of the window and the tree of its tabs: both live and die with the window.
  'compact/toggle',
  'tab/tree-collapse',
  'tab/tree-detach',
  // Closing a tab archives it in the shared window; the private store scrubs the archive right away, so these only close.
  'tab/archive',
  'tab/archive-group',
  'today/clear',
  'split/create',
  'split/remove',
  'split/orientation',
  'split/layout',
  'split/move',
  'split/ratios',
  'split/grid',
  'split/restore',
  'commandbar/used',
  'permission/set',
  // The private store is never written to disk: an exception made here lasts as long as the window.
  'blocking/exempt-site',
  // Same for a site's autoplay choice. "Effacer à la fermeture" (siteclear/site) is not here: a private session is thrown away whole, so there is nothing to list.
  'autoplay/site',
  'javascript/site',
  'unread/site'
])

/** The action to run, or null when the private window refuses it (spaces, profiles, pins, folders, favourites, Tweaks, archive, import). */
export function privateAction(action: Action): Action | null {
  if (action.type === 'settings/update') {
    const patch = Object.fromEntries(Object.entries(action.patch).filter(([key]) => LOCAL.has(key))) as Partial<Settings>
    return Object.keys(patch).length > 0 ? { type: 'settings/update', patch } : null
  }
  // Every tab of a private window is private already: the flag of a private tab (see `persistableState`) has nothing to add here, and a container
  // (which would be a persistent session) is not for a tab of this window.
  if (action.type === 'tab/open' && (action.private !== undefined || action.container !== undefined)) {
    const { private: _flag, container: _container, ...plain } = action
    return plain
  }
  // The private window has no pinned area.
  if (action.type === 'tab/move') return action.pinned || action.folderId ? null : action
  return PRIVATE_ACTIONS.has(action.type) ? action : null
}

const PRIVATE_PANELS = new Set<OverlayRequest['panel']>(['commandbar', 'shortcuts', 'find', 'findreplace', 'downloads', 'settings', 'extensions', 'capture', 'annotate', 'site', 'sitedata', 'tab', 'autoreload', 'permission', 'auth', 'dialog', 'leave', 'peek', 'qr', 'windowname', 'splitdrop', 'tabcycle', 'tabgrid', 'translate', 'translatepop'])

/** Panels that make sense in a private window; the rest (archive, history, spaces, themes, Tweaks) are about data it does not keep. */
export function canOpenInPrivate(panel: OverlayRequest['panel']): boolean {
  return PRIVATE_PANELS.has(panel)
}
