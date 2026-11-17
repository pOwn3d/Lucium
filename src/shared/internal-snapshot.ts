// What the Extensions page is told of the application. The page is a tab of the web's own kind (a sandboxed page in a profile's session), so it is given the
// least that lets it draw: the extensions, the eleven settings it reads, and the language, the accessibility and the scroll bars every page of the interface
// follows. No tab, no address, no folder, no favourite, no history, no download, nothing of the life of the windows. It is the same shape as the snapshot of the
// interface (`UiSnapshot`), with a state that is the initial one and those settings copied in, so that the page is the same component as before.

import type { UiSnapshot } from './ipc'
import { defaultSettings } from './model-defaults'
import type { ProfileOverrides } from './profiles'
import type { Settings } from './model'
import { createInitialState } from './sidebar-state'

/** The settings the page reads (ExtensionsPage.tsx, the language of `useSnapshot`, `applyAccessibility`): a test keeps this list the page's. */
export const INTERNAL_PAGE_SETTINGS = [
  'extensionDataApis',
  'extensionTabCapture',
  // Not copied whole: the page reads which extensions the person let capture the sound of a tab in each profile, and nothing of what else a profile sets (`captureChoices`).
  'profiles',
  'keyBindings',
  'webStoreInstall',
  'profileNames',
  'interfaceTranslated',
  'language',
  'forceHighContrast',
  'forceReduceMotion',
  'forceReduceTransparency'
] as const satisfies readonly (keyof Settings)[]

/** What the page reads of the settings of the profiles: the extensions allowed to capture the sound of a tab. The proxy, the download folder and the search address of a profile stay in the window. */
function captureChoices(profiles: ProfileOverrides): ProfileOverrides {
  const kept: ProfileOverrides = {}
  for (const [id, own] of Object.entries(profiles)) if (own.tabCaptureExtensions !== undefined && own.tabCaptureExtensions.length > 0) kept[id] = { tabCaptureExtensions: [...own.tabCaptureExtensions] }
  return kept
}

/** The part of the snapshot of a window the reduced one is made from. */
export type InternalSnapshotSource = Pick<UiSnapshot, 'extensions' | 'platform' | 'scrollBarsAlways'> & { state: { settings: Settings } }

/**
 * The snapshot for the Extensions page. `locked`: the application is locked, and the list of the extensions is not told (as the lock screen is not told it).
 * A new object each time, built from the initial state: nothing of the window's own state is copied but the settings above.
 */
export function internalSnapshot(source: InternalSnapshotSource, locked: boolean): UiSnapshot {
  const state = createInitialState({ now: 0, newId: () => 'extensions-page' })
  const settings: Settings = defaultSettings()
  for (const key of INTERNAL_PAGE_SETTINGS) if (key !== 'profiles') Object.assign(settings, { [key]: source.state.settings[key] })
  settings.profiles = captureChoices(source.state.settings.profiles)
  return {
    state: { ...state, settings },
    runtime: { tabs: {}, canGoBack: false, canGoForward: false },
    engine: { name: '', version: '', chromium: '' },
    extensions: locked ? [] : source.extensions,
    downloads: [],
    find: null,
    peek: null,
    sidePanel: null,
    toast: null,
    platform: source.platform,
    ...(source.scrollBarsAlways === true ? { scrollBarsAlways: true as const } : {})
  }
}
