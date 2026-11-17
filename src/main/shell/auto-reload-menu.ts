import type { MenuItemConstructorOptions } from 'electron'
import { AUTO_RELOAD_PRESETS, autoReloadLabel, isAutoReloadable, isPresetInterval } from '@shared/auto-reload'
import type { TabItem } from '@shared/model'
import type { PlusAnchor } from '@shared/plus-menu'
import type { Browser } from './browser'
import { t } from '@shared/i18n'

/**
 * "Recharger automatiquement ▸" for a tab: off, the module's intervals, or a typed one (opens the small panel). The interval of the
 * tab is checked; it is greyed out for a page that cannot be reloaded. Shared by the tab menu and the View menu.
 * `anchor` is the row of the tab the menu was opened on (the tab menu): the typed interval's sheet then hangs from it.
 */
export function autoReloadMenuItem(tab: Pick<TabItem, 'id' | 'url' | 'autoReload'> | undefined, browser: Browser, anchor?: PlusAnchor): MenuItemConstructorOptions {
  const seconds = tab?.autoReload?.seconds
  const custom = seconds !== undefined && !isPresetInterval(seconds)
  const choose = (value: number | null) => () => {
    if (tab) browser.dispatch({ type: 'tab/auto-reload', id: tab.id, seconds: value })
  }
  return {
    label: t('menu.recharger-automatiquement'),
    enabled: tab !== undefined && isAutoReloadable(tab.url),
    submenu: [
      { label: t('menu.desactive'), type: 'radio', checked: seconds === undefined, click: choose(null) },
      { type: 'separator' },
      ...AUTO_RELOAD_PRESETS.map((value): MenuItemConstructorOptions => ({ label: autoReloadLabel(value), type: 'radio', checked: seconds === value, click: choose(value) })),
      { type: 'separator' },
      {
        label: custom ? t('menu.custom-interval', { every: autoReloadLabel(seconds) }) : t('menu.personnalise'),
        type: 'radio',
        checked: custom,
        click: () => {
          if (tab) browser.openOverlay({ panel: 'autoreload', tabId: tab.id, ...(anchor ? { anchor } : {}) })
        }
      }
    ]
  }
}
