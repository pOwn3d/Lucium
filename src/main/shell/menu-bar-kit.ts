// What every menu of the menu bar reads, made once per build of the bar (menu.ts, `buildMenu`): the state, the keys of the commands, the tab on
// screen, the clicks that do not bring a window put away back, and the small helpers the entries share. Each menu of the bar is built from it in
// a module of its own (menu-bar-app.ts, menu-bar-file.ts, menu-bar-edit.ts, menu-bar-view.ts, menu-bar-tabs.ts).

import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { activeTab } from '@shared/sidebar'
import { NO_FACTS } from '@shared/menu-state'
import type { ExtensionInfo } from '@shared/ipc'
import type { WindowEntry } from '@shared/window-names'
import { withoutConflicts } from '@shared/shortcut-view'
import { currentPlatform } from '../platform'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { noteFailure } from './failure-notice'
import { sharablePage } from './page-commands'

export interface MenuActions {
  /** Lucium › Import from Another Browser… */
  importDialog: () => void
  /** Aide › Premier lancement…: the first-launch guide sheet. */
  showFirstLaunch: () => void
  /** Welcome sheet on first launch. */
  showWelcome: () => void
  /** Aide › Nouveautés: what the version changed, from the changelog shipped with the application. */
  showWhatsNew: () => void
  /** Lucium › Exporter les signets (HTML)…: the bookmarks file of the pinned tabs, folders and favourites. */
  exportBookmarks: () => void
  loadExtension: () => void
  clearHistory: () => void
  /** Archive › Tout effacer… and Nouvelle identité…: the question, then the erasure (clear-everything.ts). */
  clearEverything: () => void
  newIdentity: () => void
  setDefaultBrowser: () => void
  /** Whether Lucium already is the system's browser (the entry is greyed out then). */
  isDefaultBrowser: () => boolean
  savePage: () => void
  clearArchive: () => void
  showDataFolder: () => void
  copyInfo: () => void
  openTaskManager: () => void
  /** Lucium › À propos de Lucium: the small window of the About. */
  showAbout: () => void
  /** File › New Window / Blank Window / New Private Window. */
  newWindow: () => void
  blankWindow: () => void
  privateWindow: () => void
  /** File › New Guest Window (the setting « Profil invité »). */
  guestWindow: () => void
  /** File › Share an Annotated Window (on by default; LUCIUM_ANNOTATE=0 turns it off): the entry exists only when this is given. */
  shareWindow?: () => void
  /** File › Annotate This Page (on by default; LUCIUM_ANNOTATE=0 turns it off; see shell/page-annotate.ts): starts or ends the annotation; checked while it runs. */
  annotatePage?: () => void
  annotatingPage?: () => boolean
  /** File › Close Window: the window that has the focus (a private window, a Settings window…). */
  closeWindow: () => void
  /** The extensions loaded so far (the menu lists them). */
  extensions: () => ExtensionInfo[]
  /** Lucium › Check for Updates… */
  checkForUpdates: () => void
  /** Lucium › Privacy Policy */
  showPrivacyPolicy: () => void
  /** Espaces › Verrouiller maintenant: set only while the lock is on (the settings of « Verrouillage »). */
  lockNow?: () => void
  /** Help › Restore Data… */
  restoreData: () => void
  /** Help › Troubleshooting › Record Trace: starts a recording, or stops the one under way and saves it. */
  recordTrace: () => void
  isRecordingTrace: () => boolean
  /** Help › Getting Started (the README) and Help › Documentation (the folder of the guides). */
  openDocumentation: (what: 'start' | 'folder') => void
  /** Fenêtre: the browser windows (the menu lists them), going to one, and giving one a name (empty: taking it away). */
  windows: () => WindowEntry[]
  focusWindow: (id: string) => void
  setWindowName: (id: string, name: string) => void
  /** The window the menu acts on. */
  window: () => BrowserWindow
  /** Affichage › Toujours au premier plan: whether the window the menu acts on is kept above the other applications' windows, and keeping it there or not. */
  isKeptOnTop: () => boolean
  keepOnTop: () => void
  /** File › Rouvrir la dernière fenêtre fermée: whether a window closed in this session can come back, and bringing it back. */
  canReopenWindow: () => boolean
  reopenWindow: () => void
  /** When this session began: only what was archived since is something Edit › Undo can bring back. */
  sessionStart: number
}

export interface MenuOptions {
  /** The menu is built for a private window: what it would keep (archive, pins, spaces, history, extensions) is disabled. */
  private?: boolean
  /**
   * Set while the window the menu acts on is put away (macOS keeps the main window hidden once it is closed, see WindowManager): an entry that acts
   * on it brings it back first (what it opens, a box it asks, would be on a hidden window), except the entries that open a window of their own or
   * stand apart from it. The entries of the tab on screen are greyed out meanwhile, as without a tab: ⌘W pressed once more does not archive a tab
   * nobody sees.
   */
  away?: () => void
  /** The spaces locked at this moment (their phrase not given): « Nouveau dossier » is greyed out while the space on screen is one of them. */
  lockedSpaces?: readonly string[]
}

export type MenuClick = NonNullable<MenuItemConstructorOptions['click']>

/** What the menus of the bar share, read once when the bar is built. */
export type MenuBarKit = ReturnType<typeof menuBarKit>

export function menuBarKit(browser: Browser, store: StateStore, actions: MenuActions, options: MenuOptions) {
  const state = () => store.get()
  const platform = currentPlatform()
  // Entries about data a private window does not keep.
  const kept = { enabled: options.private !== true }
  // Two commands the user left on one shortcut: a single entry carries it, the one chosen last (the other shows no key). Two entries with one
  // accelerator would leave it to the order of the menus which of them answers.
  const bindings = withoutConflicts(state().settings.keyBindings ?? {})
  const acc = (id: string) => platform.accelerator(id, bindings)
  // The entry of a command, and a copy of it for its second key when it has one in force: the menu bar does not show the copy (hidden
  // items still answer their key on macOS), and it is greyed out with the entry.
  const withSecondKey = (id: string, item: MenuItemConstructorOptions): MenuItemConstructorOptions[] => {
    const second = platform.secondAccelerator(id, bindings)
    return second ? [item, { ...item, accelerator: second, visible: false }] : [item]
  }
  const report = (what: string, message?: string) => (error: unknown) => noteFailure(`[menu] ${what} failed:`, error, (text) => browser.showToast(text), message)
  const facts = browser.menuFacts?.() ?? NO_FACTS
  const page = sharablePage(store)
  // A window put away shows no tab.
  const tabNow = options.away ? undefined : activeTab(state())
  // The clicks that do not bring a window put away back: they open a window of their own (or go to one), or stand apart from the window.
  const standalone = new Set<unknown>([actions.showAbout, actions.newWindow, actions.blankWindow, actions.privateWindow, actions.guestWindow, actions.reopenWindow, actions.shareWindow, actions.closeWindow, actions.openTaskManager, actions.showDataFolder, actions.copyInfo, actions.recordTrace, actions.lockNow])
  const alone = <F extends MenuClick>(click: F): F => (standalone.add(click), click)
  // The entries that act on the tab on screen are greyed out without one (an empty space, a locked one), and their shortcuts do nothing.
  const onTab = { enabled: tabNow !== undefined }
  // The key opens the panel, and closes it when it is the one on screen (the bar or the sheet has the focus, and the key must still reach the menu).
  const toggleOverlay = (request: Parameters<Browser['openOverlay']>[0]) => () => {
    const open = browser.currentOverlay()
    const same = open && open.panel === request.panel && (request.panel !== 'commandbar' || (open.panel === 'commandbar' && open.mode === request.mode))
    if (same) browser.closeOverlay()
    else browser.openOverlay(request)
  }

  const withTab = (run: (tab: NonNullable<ReturnType<typeof activeTab>>) => void) => () => {
    const tab = activeTab(state())
    if (tab) run(tab)
  }
  const dispatch = (action: Parameters<Browser['dispatch']>[0]) => () => browser.dispatch(action)
  const archiveTab = withTab((tab) => browser.dispatch(tab.pinned ? { type: 'tab/close', id: tab.id } : { type: 'tab/archive', id: tab.id }))
  const toolsMenu = { browser, store, acc, page, facts, private: options.private === true, report }
  return { browser, store, actions, options, state, platform, kept, acc, withSecondKey, report, facts, page, tabNow, standalone, alone, onTab, toggleOverlay, withTab, dispatch, archiveTab, toolsMenu }
}
