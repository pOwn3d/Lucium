// The container entries of the tab's context menu: open the tab in a container (or take it out), and send its site to a container for good.
// Nothing at all while the function is off, in a private window, for a private tab or when there is no container, so that the menu of a browser
// that does not use it is exactly what it was.

import type { MenuItemConstructorOptions } from 'electron'
import { containerOfTab, containerRuleHost, ruleOfHost } from '@shared/containers'
import type { SidebarState, TabItem } from '@shared/model'
import { isExtensionPageUrl } from '@shared/url'
import type { Browser } from './browser'
import { t } from '@shared/i18n'

export function containerMenuItems(browser: Browser, state: SidebarState, tab: TabItem): MenuItemConstructorOptions[] {
  const { settings } = state
  if (!settings.tabContainers || browser.isPrivate() || tab.private === true || settings.containers.length === 0) return []
  const current = containerOfTab(settings, tab)
  const host = containerRuleHost(tab.url)
  const rule = host === null ? undefined : ruleOfHost(settings, host)
  const items: MenuItemConstructorOptions[] = []
  // An extension's page needs the session of its profile.
  if (!isExtensionPageUrl(tab.url)) {
    items.push({
      label: t('container-menu.ouvrir-dans-un-conteneur'),
      submenu: [
        ...settings.containers.map((container): MenuItemConstructorOptions => ({
          label: container.name,
          type: 'checkbox',
          checked: current?.id === container.id,
          click: () => browser.dispatch({ type: 'tab/set-container', id: tab.id, container: container.id })
        })),
        { type: 'separator' },
        { label: t('container-menu.sans-conteneur'), enabled: current !== undefined, click: () => browser.dispatch({ type: 'tab/set-container', id: tab.id, container: null }) }
      ]
    })
  }
  if (host !== null) {
    items.push({
      label: t('container-menu.toujours-ouvrir-host-dans', { host }),
      submenu: [
        ...settings.containers.map((container): MenuItemConstructorOptions => ({
          label: container.name,
          type: 'checkbox',
          checked: rule?.containerId === container.id,
          click: () => browser.dispatch({ type: 'container/rule', host, container: container.id })
        })),
        { type: 'separator' },
        { label: t('container-menu.aucun-conteneur-retirer-la-regle'), enabled: rule !== undefined, click: () => browser.dispatch({ type: 'container/rule', host, container: null }) }
      ]
    })
  }
  return items
}
