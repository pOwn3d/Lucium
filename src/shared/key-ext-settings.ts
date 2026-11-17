// The settings of the keyboard navigation and of the extension features of this group (Vim-style keys, per-site access of extensions,
// tab groups in the sidebar, the address bar keyword of extensions): how they are read back from a file. Every switch is on only when
// the file holds exactly `true`; a list is rebuilt entry by entry. See shared/features.ts for the switches themselves.

import { defaultSettings, type Settings } from './model'
import { cleanSleepHosts } from './sleep'

export type KeyExtSettings = Pick<Settings, 'vimKeys' | 'vimKeysExcludedHosts' | 'tabGroupFolders' | 'omniboxKeywords'>

export function cleanKeyExtSettings(settings: Settings): KeyExtSettings {
  const defaults = defaultSettings()
  return {
    vimKeys: settings.vimKeys === true ? true : defaults.vimKeys,
    vimKeysExcludedHosts: cleanSleepHosts(settings.vimKeysExcludedHosts),
    tabGroupFolders: settings.tabGroupFolders === true ? true : defaults.tabGroupFolders,
    omniboxKeywords: settings.omniboxKeywords === true ? true : defaults.omniboxKeywords
  }
}
