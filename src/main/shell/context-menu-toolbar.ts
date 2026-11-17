// The menus of the buttons of the toolbar (context-menus.ts): the pages behind back and forward (kind `nav`), the extensions the « button holds
// (kind `extensions`), and the modes of « Contraste de la page » (kind `readable`).

import type { MenuItemConstructorOptions } from 'electron'
import type { MenuTarget } from '@shared/ipc'
import { takesReadableMode } from '@shared/readable-mode'
import { t } from '@shared/i18n'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { setReadableSite } from './page-commands'
import { readableSiteItems } from './readable-menu'

/** Long press on back or forward: the page history of the current tab. */
export function navMenuItems(target: Extract<MenuTarget, { kind: 'nav' }>, browser: Browser): MenuItemConstructorOptions[] {
  const entries = browser.navigationHistory(target.id)
  return entries.length === 0
    ? [{ label: target.id === 'back' ? t('ctx.aucune-page-precedente') : t('ctx.aucune-page-suivante'), enabled: false }]
    : entries.slice(0, 20).map((entry): MenuItemConstructorOptions => ({
        label: (entry.title || entry.url).slice(0, 70),
        sublabel: entry.title ? entry.url.replace(/^https?:\/\//, '').slice(0, 60) : undefined,
        click: () => browser.goToHistoryIndex(entry.index)
      }))
}

// The « button of the toolbar: the extensions that did not fit or were unpinned, then what pins them. The ids come from the page of
// the interface, so only the ones that are loaded are listed.
export function extensionsMenuItems(target: Extract<MenuTarget, { kind: 'extensions' }>, browser: Browser, store: StateStore): MenuItemConstructorOptions[] {
  const state = store.get()
  const loaded = browser.snapshot().extensions
  const wanted = Array.isArray(target.hidden) ? target.hidden : []
  const hidden = wanted.flatMap((id) => loaded.filter((extension) => extension.id === id))
  const unpinned = new Set(state.settings.unpinnedExtensions)
  return [
    ...hidden.map((extension): MenuItemConstructorOptions => ({ label: extension.name, click: () => void browser.activateExtension(extension.id).catch((error: unknown) => console.error(`[menu] cannot open ${extension.name}:`, error)) })),
    ...(hidden.length > 0 ? ([{ type: 'separator' }] satisfies MenuItemConstructorOptions[]) : []),
    {
      label: t('ctx.epingler-a-la-barre-d-outils'),
      enabled: loaded.length > 0,
      submenu: loaded.map((extension): MenuItemConstructorOptions => ({ label: extension.name, type: 'checkbox', checked: !unpinned.has(extension.id), click: () => browser.setExtensionPinned(extension.id, unpinned.has(extension.id)) }))
    },
    { label: t('menu.gerer-les-extensions'), click: () => browser.openOverlay({ panel: 'settings', pane: 'tools', anchor: 'extensions' }) }
  ]
}

// The button « Contraste de la page » of the toolbar: the entries of View › Appearance › Contraste de la page pour ce site, for the tab the button is on. Nothing for a page
// that takes no mode, a private tab or a private window: an empty menu is not shown (the button is not drawn there, so this only answers a forged request).
export function readableMenuItems(target: Extract<MenuTarget, { kind: 'readable' }>, browser: Browser, store: StateStore): MenuItemConstructorOptions[] {
  const state = store.get()
  const tab = state.tabs.find((t) => t.id === target.id)
  if (!tab || tab.private === true || browser.isPrivate() || !takesReadableMode(tab.url)) return []
  return readableSiteItems('toolbar', { settings: state.settings, url: tab.url, systemDark: browser.isSystemDark() }, (mode) => setReadableSite(browser, store, mode, tab))
}
