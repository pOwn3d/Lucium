// What the command bar shows beside a row: the shortcut and the detail of an action, and what choosing a result will do. Moved out of
// command-bar.ts as it was.

import type { SidebarState } from './model'
import { t } from './i18n'
import { effectiveAccelerator, formatAccelerator } from './keybindings'
import type { PlatformId } from './platform'
import type { Candidate, CommandAction } from './command-bar-types'

/** What the right of a result says it will do ("Switch to Tab"). */
export function candidateHint(candidate: Candidate): string {
  switch (candidate.kind) {
    case 'tab':
      return candidate.split ? t('cmd.aller-a-la-vue-scindee') : t('cmd.aller-a-l-onglet')
    case 'archived':
      return t('cmd.restaurer-l-onglet')
    case 'readlater':
    case 'bookmark':
      return t('cmd.ouvrir-la-page')
    case 'calc':
      return t('cmd.copier-le-resultat')
    case 'site-search':
      return 'Tab'
    case 'omnibox':
      return t('command-bar.envoyer-a-l-extension')
    default:
      return ''
  }
}

/** The command of the keyboard shortcuts (keybindings.ts) a command of the bar is the same thing as: its key is shown with it, as the user set it. */
const ACTION_SHORTCUT: Partial<Record<CommandAction, string>> = {
  'pin-toggle': 'pin',
  'toggle-sidebar': 'toggleSidebar',
  'clear-today': 'clearToday',
  'new-space': 'newSpace',
  find: 'find',
  downloads: 'downloads',
  'edit-theme': 'editTheme',
  settings: 'settings',
  archive: 'archive',
  'site-info': 'siteInfo',
  capture: 'captureVisible',
  'capture-full': 'captureFull',
  'capture-region': 'captureRegion',
  'clear-site-data': 'clearSiteData',
  'clear-site-now': 'clearSiteDataNow',
  'reload-all': 'reloadAll',
  'new-private-tab': 'newPrivateTab',
  'new-folder': 'newFolder',
  passwords: 'passwords',
  'fill-password': 'fillPassword',
  'bookmark-add': 'bookmarkAdd',
  'bookmarks-list': 'bookmarkList',
  'read-later': 'readLater',
  'read-later-list': 'readLaterList',
  'export-markdown': 'exportMarkdown',
  sessions: 'sessions',
  'save-session': 'saveSession',
  'lock-now': 'lockNow',
  'name-window': 'nameWindow',
  'toggle-compact': 'toggleCompact',
  'toggle-dock': 'dockSidebar',
  'toggle-tab-branch': 'toggleTabBranch',
  'detach-tab': 'detachTab',
  'open-as-app': 'openAsApp',
  notes: 'notes',
  'new-note': 'newNote',
  'search-tabs': 'tabSearch',
  'cookie-manager': 'cookieManager',
  'aside-space': 'asideSpace'
}

/**
 * The shortcut of a command of the bar as the user has it, drawn for the system (⌘F on macOS, Ctrl+F elsewhere), or null when it has none. Without
 * a platform no key is drawn: a line says no shortcut rather than the keys of another system.
 */
export function actionShortcut(action: CommandAction, state: Pick<SidebarState, 'settings'>, platform: PlatformId | undefined): string | null {
  const id = ACTION_SHORTCUT[action]
  if (!id || !platform) return null
  const accelerator = effectiveAccelerator(id, state.settings.keyBindings, platform)
  return accelerator ? formatAccelerator(accelerator, platform) : null
}

/**
 * What the line of a command says after its name: « Action », and the shortcut of the command as it is set now when it has one. The key is
 * never written in the text itself: it would stay after the shortcut is changed, or name a key that was never the command's.
 */
export function actionDetail(action: CommandAction, state: Pick<SidebarState, 'settings'>, platform: PlatformId | undefined): string {
  const shortcut = actionShortcut(action, state, platform)
  return shortcut ? `${t('cmd.action')} · ${shortcut}` : t('cmd.action')
}
