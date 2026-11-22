// What a row of the command bar does once chosen: the action of the reducer or the command it stands for. Moved out of command-bar.ts as it was.

import type { SidebarState } from './model'
import { isReadLaterUrl } from './read-later'
import { isBookmarkUrl } from './bookmarks'
import { activeTab, type Action } from './sidebar'
import { t } from './i18n'
import { isReadableWebPage } from './readable-mode'
import type { CommandAction, Candidate } from './command-bar-types'
import { newFolderName, READABLE_COMMANDS, SPACE_EMOJIS } from './command-bar-sources'

/** Maps a command-bar action to a reducer action. `null` when it does not apply. */
export function actionToDispatch(action: CommandAction, state: SidebarState): Action | null {
  const tab = activeTab(state)
  switch (action) {
    case 'pin-toggle':
      return tab ? { type: tab.pinned ? 'tab/unpin' : 'tab/pin', id: tab.id } : null
    case 'toggle-sidebar':
      return { type: 'settings/update', patch: { sidebarVisible: !state.settings.sidebarVisible } }
    case 'clear-today':
      return { type: 'today/clear' }
    case 'new-folder':
      return { type: 'folder/create', name: newFolderName() }
    case 'find':
    case 'downloads':
    case 'edit-space':
    case 'edit-theme':
    case 'settings':
    case 'edit-shortcuts':
    case 'clear-site-data':
    case 'export-markdown':
    case 'save-markdown':
    case 'save-session':
    case 'sessions':
    case 'clear-site-now':
    case 'clear-everything':
    case 'new-identity':
    case 'reload-all':
    case 'recent-notices':
    case 'discover':
    case 'web-store':
    case 'name-window':
    case 'aside-space':
    case 'lock-now':
    case 'web-panel-add':
    case 'web-panel-close':
    case 'auto-reload':
    case 'read-later-list':
    case 'import-boost':
    case 'paste-boost':
    case 'import-theme':
    case 'export-theme':
    case 'new-private-tab':
    case 'cookie-manager':
    case 'passwords':
    case 'fill-password':
    case 'archive':
    case 'create-shortcut':
    case 'site-info':
    case 'capture':
    case 'capture-full':
    case 'capture-region':
      return null // opens an overlay panel, handled by the caller
    case 'auto-reload-off':
      return tab?.autoReload ? { type: 'tab/auto-reload', id: tab.id, seconds: null } : null
    case 'readable-dark':
    case 'readable-light':
    case 'readable-original':
    case 'readable-default':
      return tab && tab.private !== true && isReadableWebPage(tab.url) ? { type: 'readable/site', site: tab.url, mode: READABLE_COMMANDS[action], tabId: tab.id } : null
    case 'toggle-compact':
      return state.settings.compactMode ? { type: 'compact/toggle' } : null
    // The sidebar of this window is the window's, not the state's: the bar asks the main process (CommandBar.tsx).
    case 'toggle-dock':
    case 'sidebar-left':
    case 'sidebar-right':
    case 'sidebar-follow':
      return null
    // The bar changes mode instead of dispatching anything (CommandBar.tsx).
    case 'search-tabs':
    case 'tab-grid':
      return null
    case 'toggle-tab-branch':
      return tab && state.settings.tabTree ? { type: 'tab/tree-collapse', id: tab.id } : null
    case 'detach-tab':
      return tab && state.settings.tabTree ? { type: 'tab/tree-detach', id: tab.id } : null
    case 'read-later':
      return tab && isReadLaterUrl(tab.url) ? { type: 'readlater/add', tabId: tab.id } : null
    case 'bookmark-add':
      return tab && isBookmarkUrl(tab.url) ? { type: 'bookmark/add', tabId: tab.id } : null
    case 'bookmarks-list':
    case 'live-folder-new':
    case 'open-as-app':
    case 'notes':
    case 'new-note':
    case 'jot-note':
      return null // opens a panel or a window, or asks the main process, handled by the caller
    case 'new-space': {
      const n = state.spaces.length
      return { type: 'space/create', name: t('cmd.new-space-name', { n: n + 1 }), emoji: SPACE_EMOJIS[n % SPACE_EMOJIS.length]!, hue: (250 + n * 47) % 360 }
    }
  }
}

/**
 * The reducer actions of a candidate that moves things around the sidebar: going to a space, and moving the current tab to
 * Today or to the pinned tabs of another space. Empty for every other kind (the caller handles those).
 */
export function candidateDispatches(candidate: Candidate): Action[] {
  switch (candidate.kind) {
    case 'space':
      return [{ type: 'space/select', id: candidate.spaceId }]
    case 'move':
      // A tab always lands in Today of its new space; pinning it is a second step.
      return [{ type: 'tab/move-to-space', id: candidate.tabId, spaceId: candidate.spaceId }, ...(candidate.pinned ? ([{ type: 'tab/pin', id: candidate.tabId }] satisfies Action[]) : [])]
    case 'session':
      return [candidate.aside ? { type: 'space/reopen', id: candidate.sessionId } : { type: 'session/restore', id: candidate.sessionId }]
    // The space is the one the bar was opened over (the reducer reads it), unless the view always opens elsewhere.
    case 'workview':
      return [{ type: 'view/open', id: candidate.viewId }]
    case 'container':
      if (candidate.mode === 'new') return [{ type: 'tab/open', url: 'about:blank', container: candidate.containerId }]
      return candidate.tabId !== undefined ? [{ type: 'tab/set-container', id: candidate.tabId, container: candidate.containerId }] : []
    default:
      return []
  }
}
