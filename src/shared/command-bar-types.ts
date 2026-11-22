// The command bar's vocabulary: the actions it can run and the rows it lists. Moved out of command-bar.ts as it was.

import type { SettingsAnchor, SettingsPane } from './ipc'
import type { ExtensionsTarget } from './extension-page'
import type { ChromePage } from './chrome-pages'

export type CommandAction =
  | 'pin-toggle'
  | 'toggle-sidebar'
  | 'clear-today'
  | 'new-space'
  | 'find'
  | 'downloads'
  | 'edit-space'
  | 'edit-theme'
  | 'settings'
  | 'archive'
  | 'site-info'
  | 'create-shortcut'
  | 'capture'
  | 'capture-full'
  | 'capture-region'
  | 'new-folder'
  | 'edit-shortcuts'
  | 'clear-site-data'
  | 'export-markdown'
  | 'save-markdown'
  | 'save-session'
  | 'sessions'
  | 'clear-site-now'
  | 'clear-everything'
  | 'new-identity'
  | 'reload-all'
  | 'recent-notices'
  /** « Découvrir Lucium »: opens the panel of the features by task (shared/discover.ts). */
  | 'discover'
  | 'web-store'
  | 'aside-space'
  | 'lock-now'
  | 'auto-reload'
  | 'auto-reload-off'
  /** "Contraste de la page : sombre / clair / original pour ce site", and "…comme les autres sites" (the site follows the default again): the page contrast of the site on screen. */
  | 'readable-dark'
  | 'readable-light'
  | 'readable-original'
  | 'readable-default'
  | 'read-later'
  | 'read-later-list'
  | 'import-boost'
  | 'paste-boost'
  | 'import-theme'
  | 'export-theme'
  | 'new-private-tab'
  | 'cookie-manager'
  | 'passwords'
  | 'fill-password'
  | 'web-panel-add'
  | 'web-panel-close'
  | 'name-window'
  | 'toggle-compact'
  | 'toggle-tab-branch'
  | 'detach-tab'
  | 'bookmark-add'
  | 'bookmarks-list'
  | 'live-folder-new'
  | 'open-as-app'
  /** "Rechercher un onglet…": the bar becomes the "Onglets" mode, over the tabs of every space. Only while the function `tabSearch` is on. */
  | 'search-tabs'
  /** "Ouvrir les notes": the panel of the quick notes takes the place of the bar. Only while the function `notes` is on, never in a private window. */
  | 'notes'
  /** "Nouvelle note": the same panel, on a new note tied to the page on screen. Same conditions. */
  | 'new-note'
  /** "note <text>" typed in the bar: the note (`text`) is made at once, tied to the page on screen, and a notice says so. Same conditions. */
  | 'jot-note'
  /** The sidebar of this window (window-sidebar.ts): docked to a column of icons or the full one back (⌃⌘S), on the other side, or as the new windows again. */
  | 'toggle-dock'
  | 'sidebar-left'
  | 'sidebar-right'
  | 'sidebar-follow'

export type Candidate =
  /** `search` marks what the user typed when it is a web search rather than an address. */
  | { kind: 'open'; id: string; label: string; detail: string; url: string; search?: boolean }
  /** `split` marks a tab that belongs to another split view than the one on screen: choosing it switches to that view. */
  | { kind: 'tab'; id: string; label: string; detail: string; tabId: string; url: string; faviconUrl?: string; split?: boolean }
  | { kind: 'suggestion'; id: string; label: string; detail: string; query: string }
  | { kind: 'archived'; id: string; label: string; detail: string; archivedId: string }
  | { kind: 'history'; id: string; label: string; detail: string; url: string }
  | { kind: 'site-search'; id: string; label: string; detail: string; keyword: string }
  | { kind: 'action'; id: string; label: string; detail: string; action: CommandAction; url?: string; /** The text of the note `jot-note` makes. */ text?: string }
  /** "Lire plus tard — <title>": a page saved with File › Lire plus tard; choosing it opens the page in a new tab. */
  | { kind: 'readlater'; id: string; label: string; detail: string; readLaterId: string; faviconUrl?: string }
  /** "Signet — <title>": a bookmark of the library (setting `bookmarkManager`); choosing it opens the page in a new tab. */
  | { kind: 'bookmark'; id: string; label: string; detail: string; bookmarkId: string; faviconUrl?: string }
  /** "Restaurer la session <name>": choosing it opens the saved pages as tabs of the current space. */
  | { kind: 'session'; id: string; label: string; detail: string; sessionId: string; /** Set for a space put aside: choosing it opens the space again, as it was. */ aside?: true }
  /** "Focus on <space>". */
  | { kind: 'space'; id: string; label: string; detail: string; spaceId: string; emoji: string }
  /** A work view of the profile on screen (setting `workViewsEnabled`): choosing it opens the view, or shows again the split view it has open. */
  | { kind: 'workview'; id: string; label: string; detail: string; viewId: string; emoji: string }
  /** "Move to Today/Pinned in <space>": the current tab goes to another space. */
  | { kind: 'move'; id: string; label: string; detail: string; tabId: string; spaceId: string; pinned: boolean; emoji: string }
  /**
   * "Nouvel onglet dans le conteneur « X »" (`mode` new: a blank tab in the container, and the bar over it to type where it goes) and "Ouvrir cette
   * page dans le conteneur « X »" (`mode` reopen: the tab on screen, `tabId`, goes to the container). Only while tab containers are on.
   */
  | { kind: 'container'; id: string; label: string; detail: string; containerId: string; mode: 'new' | 'reopen'; tabId?: string }
  /** "Ouvrir <site> en volet": a site of the space's web panels; choosing it opens it beside the page. Only while the function is on. */
  | { kind: 'webpanel'; id: string; label: string; detail: string; panelId: string }
  /** "Use an extension's action": a click on the extension's toolbar icon. */
  | { kind: 'extension'; id: string; label: string; detail: string; extensionId: string }
  /** The keyword of an extension (chrome.omnibox) and the text typed after it: choosing it hands the text to the extension. Only while the function is on. */
  | { kind: 'omnibox'; id: string; label: string; detail: string; extensionId: string; text: string }
  /** "Open preferences pane". */
  | { kind: 'pane'; id: string; label: string; detail: string; pane: SettingsPane; /** Where inside the pane the Settings window scrolls to. */ anchor?: SettingsAnchor }
  /** `chrome://extensions` typed in the bar: the Extensions page, or the page of one extension when the address names it (`?id=`). */
  | { kind: 'extpage'; id: string; label: string; detail: string; target: ExtensionsTarget }
  /** What a `chrome://` address stands for here (shared/chrome-pages.ts): a panel or a pane of Settings to open, or nothing to open when the address leads nowhere (the label and the detail say so). */
  | { kind: 'internal'; id: string; label: string; detail: string; request?: ChromePage['request'] }
  /** "Aller à la fenêtre « nom »": a named window other than this one comes to the front. */
  | { kind: 'window'; id: string; label: string; detail: string; windowId: string }
  /** The answer of a calculation typed in the bar (shared/calc.ts): choosing it copies `copy` to the clipboard. */
  | { kind: 'calc'; id: string; label: string; detail: string; copy: string }
