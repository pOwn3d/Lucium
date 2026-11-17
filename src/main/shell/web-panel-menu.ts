// The "Volets web" entries of the menus (the space's context menu and Espaces in the menu bar): the sites of the space's list, one to open each,
// the page on screen to add, a site to remove. Nothing at all while the function is off or in a private window, so that a menu of a browser
// that does not use it is exactly what it was.

import type { MenuItemConstructorOptions } from 'electron'
import type { SidebarState, Space } from '@shared/model'
import { activeTab } from '@shared/sidebar'
import { webPanelRefusal } from '@shared/web-panels'
import type { Browser } from './browser'
import { t } from '@shared/i18n'

export function webPanelMenuItems(browser: Browser, state: SidebarState, space: Space): MenuItemConstructorOptions[] {
  if (!state.settings.webPanels || browser.isPrivate()) return []
  const panels = space.webPanels ?? []
  const shown = space.id === state.activeSpaceId
  const tab = activeTab(state)
  // A panel opens in the space on screen (its pages use that space's profile): choosing one of another space goes there first.
  const open = (panelId: string) => () => {
    if (!shown) browser.dispatch({ type: 'space/select', id: space.id })
    browser.openWebPanel(panelId)
  }
  return [
    {
      label: t('menu.volets-web'),
      submenu: [
        ...panels.map((panel): MenuItemConstructorOptions => ({ label: t('menu.open-panel-quoted', { title: panel.title }), click: open(panel.id) })),
        ...(panels.length > 0 ? ([{ type: 'separator' }] satisfies MenuItemConstructorOptions[]) : []),
        { label: t('menu.ajouter-la-page-en-volet-web'), enabled: shown && tab !== undefined && webPanelRefusal(space.webPanels, tab.url) === null, click: () => browser.addWebPanelFromPage() },
        {
          label: t('menu.retirer-un-volet'),
          enabled: panels.length > 0,
          submenu: panels.map((panel): MenuItemConstructorOptions => ({ label: panel.title, click: () => browser.dispatch({ type: 'space/panel-remove', id: space.id, panelId: panel.id }) }))
        },
        { label: t('menu.fermer-le-volet'), click: () => browser.closeWebPanel() }
      ]
    }
  ]
}
