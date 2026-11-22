// The View menu of the bar (Affichage): the appearances, the sidebar of this window and the toolbar, reloading, the split view, the web tools,
// zoom, reader mode, the developer's entries, the site and full screen. Built from what menu-bar-kit.ts reads once for the whole bar.

import type { MenuItemConstructorOptions } from 'electron'
import { activeTab, splitFor, splitIsFull } from '@shared/sidebar'
import { compactLabel, isCompact } from '@shared/compact'
import { developerModeLabel } from '@shared/developer-mode'
import { toggledGrid, toggledRatios } from '@shared/split-expand'
import { isGridCount } from '@shared/split'
import { hostnameOf } from '@shared/url'
import type { Settings } from '@shared/model'
import { sidebarPlacement } from '@shared/window-sidebar'
import { devToolsExtraAccelerator } from '@shared/devtools-request'
import { t } from '@shared/i18n'
import { autoReloadMenuItem } from './auto-reload-menu'
import { webToolsViewItems } from './web-tools-menu'
import { setReadableSite, toggleDeveloperMode, viewSource } from './page-commands'
import { readableSiteItems } from './readable-menu'
import type { MenuBarKit } from './menu-bar-kit'

const appearances = (): Array<[Settings['interfaceAppearance'], string]> => [['auto', t('menu.automatique')], ['light', t('menu.clair')], ['dark', t('menu.sombre')]]

export function viewMenu({ browser, store, actions, options, state, acc, kept, onTab, page, tabNow, facts, report, dispatch, withTab, archiveTab, toolsMenu }: MenuBarKit): MenuItemConstructorOptions {
  const devToolsKey = devToolsExtraAccelerator(state().settings.keyBindings)
  const inSplit = tabNow ? splitFor(state(), tabNow.id) !== undefined : false
  /** View › the sidebar of this window: docked, at the right (checked as they are on screen), and the side of the new windows. */
  const windowSidebarViewItems = (): MenuItemConstructorOptions[] => {
    const placement = sidebarPlacement(state().settings, browser.windowSidebar())
    const newWindowsRight = state().settings.sidebarRight
    return [
      { label: t('menu.replier-la-barre-dans-cette-fenetre'), type: 'checkbox', checked: placement.docked, accelerator: acc('dockSidebar'), click: () => browser.changeWindowSidebar({ op: 'toggle-dock' }) },
      { label: t('menu.barre-a-droite-dans-cette-fenetre'), type: 'checkbox', checked: placement.right, click: () => browser.changeWindowSidebar({ op: 'toggle-side' }) },
      {
        label: t('menu.pour-les-nouvelles-fenetres'),
        submenu: [
          { label: t('menu.barre-a-gauche'), type: 'radio', checked: !newWindowsRight, click: () => browser.dispatch({ type: 'settings/update', patch: { sidebarRight: false } }) },
          { label: t('menu.barre-a-droite'), type: 'radio', checked: newWindowsRight, click: () => browser.dispatch({ type: 'settings/update', patch: { sidebarRight: true } }) }
        ]
      }
    ]
  }
  return {
    label: t('menu.affichage'),
    submenu: [
      {
        label: t('menu.apparence'),
        submenu: [
          // Two choices that do not drive the same thing: the first is Lucium itself (the only one that moves the appearance of the application's windows), the second only
          // what the websites read. Each is a group of radio items of its own.
          { label: t('menu.apparence-de-lucium'), enabled: false },
          ...appearances().map(([value, label]): MenuItemConstructorOptions => ({
            label,
            type: 'radio',
            checked: state().settings.interfaceAppearance === value,
            click: () => browser.dispatch({ type: 'settings/update', patch: { interfaceAppearance: value } })
          })),
          { type: 'separator' },
          { label: t('menu.apparence-demandee-aux-sites'), enabled: false },
          ...appearances().map(([value, label]): MenuItemConstructorOptions => ({
            label,
            type: 'radio',
            checked: state().settings.websiteAppearance === value,
            click: () => browser.dispatch({ type: 'settings/update', patch: { websiteAppearance: value } })
          })),
          { type: 'separator' },
          // The mode of the site on screen: "Comme les autres sites" gives it back to the default. Not for a private tab or window (their sites are not written to the settings).
          {
            label: t('menu.contraste-de-la-page-pour-ce-site'),
            enabled: page !== null && options.private !== true && tabNow?.private !== true,
            submenu: readableSiteItems('view', { settings: state().settings, url: tabNow?.url }, (mode) => setReadableSite(browser, store, mode))
          }
        ]
      },
      { type: 'separator' },
      { label: state().settings.sidebarVisible ? t('menu.masquer-la-barre-laterale') : t('menu.afficher-la-barre-laterale'), accelerator: acc('toggleSidebar'), click: () => browser.toggleSidebar() },
      // The sidebar of this window only (shared/window-sidebar.ts): docked to a column of icons (⌃⌘S), at the other side. The setting stays the side of the
      // new windows: the submenu. Each entry reads what is on screen when it is clicked (the menu is not rebuilt between two clicks).
      ...windowSidebarViewItems(),
      {
        label: state().settings.showToolbar ? t('menu.masquer-la-barre-d-outils') : t('menu.afficher-la-barre-d-outils'),
        accelerator: acc('toggleToolbar'),
        click: () => browser.dispatch({ type: 'settings/update', patch: { showToolbar: !state().settings.showToolbar } })
      },
      // Optional: only while the setting « Mode compact » is on (hidden, and its key does nothing, until then).
      {
        label: compactLabel(isCompact(state().settings)),
        accelerator: acc('toggleCompact'),
        visible: state().settings.compactMode,
        enabled: state().settings.compactMode,
        click: () => browser.dispatch({ type: 'compact/toggle' })
      },
      { label: t('menu.replier-les-dossiers-epingles'), accelerator: acc('collapsePinned'), ...kept, click: dispatch({ type: 'folder/collapse-all' }) },
      // A panel of the window, beside the other things the window shows: not one of the reload commands below.
      { label: t('menu.notifications-recentes'), click: () => browser.openOverlay({ panel: 'notices' }) },
      { type: 'separator' },
      { label: t('menu.arreter-le-chargement'), accelerator: acc('stop'), enabled: facts.loading, click: () => browser.nav('stop') },
      { label: t('menu.actualiser-la-page'), accelerator: acc('reload'), ...onTab, click: () => browser.nav('reload') },
      { label: t('menu.actualiser-tous-les-onglets'), accelerator: acc('reloadAll'), click: () => void browser.reloadAllTabs().catch(report('reload all tabs')) },
      { label: t('menu.actualisation-forcee'), accelerator: acc('hardReload'), ...onTab, click: () => browser.hardReload() },
      { label: t('menu.effacer-les-cookies-et-actualiser'), accelerator: acc('clearCookies'), ...onTab, click: () => void browser.clearSiteData().catch(report('clear cookies')) },
      { label: t('menu.effacer-le-cache-et-actualiser'), accelerator: acc('clearCache'), ...onTab, click: () => void browser.clearCacheAndReload().catch(report('clear cache')) },
      // Optional: the cookies of the profile by site, the sites to keep, and the clean-up that spares them.
      { label: t('menu.cookies-par-site'), accelerator: acc('cookieManager'), visible: options.private !== true && state().settings.cookieManager, click: () => browser.openOverlay({ panel: 'cookies' }) },
      autoReloadMenuItem(tabNow, browser),
      { type: 'separator' },
      { label: t('menu.ajouter-une-vue-scindee'), accelerator: acc('addSplit'), enabled: state().tabs.length > 0 && !splitIsFull(state()), click: () => browser.openOverlay({ panel: 'commandbar', mode: 'split', initial: '' }) },
      { label: t('menu.fermer-ce-volet-scinde'), accelerator: acc('closeSplitPane'), enabled: inSplit, click: archiveTab },
      { label: t('menu.separer-la-page-de-la-vue-scindee'), accelerator: acc('separateSplit'), enabled: inSplit, click: withTab((tab) => browser.dispatch({ type: 'split/remove', tabId: tab.id })) },
      {
        label: t('menu.agrandir-la-vue-scindee-actuelle'),
        accelerator: acc('expandSplit'),
        enabled: inSplit,
        click: withTab((tab) => {
          const current = splitFor(state(), tab.id)
          if (!current) return
          const index = current.tabIds.indexOf(tab.id)
          // A grid grows the pane's column and row; a row or a column, its share.
          if (current.grid && isGridCount(current.tabIds.length)) {
            const { column, row } = toggledGrid(current.grid, current.tabIds.length, index)
            browser.dispatch({ type: 'split/grid', id: current.id, column, row })
          } else browser.dispatch({ type: 'split/ratios', id: current.id, ratios: toggledRatios(current.ratios, index) })
        })
      },
      ...webToolsViewItems(toolsMenu),
      { type: 'separator' },
      { label: t('menu.taille-reelle'), accelerator: acc('zoomReset'), ...onTab, click: () => browser.zoom(0) },
      { label: t('menu.zoom-avant'), accelerator: acc('zoomIn'), ...onTab, click: () => browser.zoom(1) },
      { label: t('menu.zoom-arriere'), accelerator: acc('zoomOut'), ...onTab, click: () => browser.zoom(-1) },
      { type: 'separator' },
      { label: t('menu.mode-lecture'), accelerator: acc('readerMode'), enabled: page !== null, click: () => void browser.toggleReader().catch(report('reader mode')) },
      { type: 'separator' },
      {
        label: t('menu.developpeur'),
        submenu: [
          { label: t('menu.afficher-la-source'), accelerator: acc('viewSource'), enabled: page !== null, click: () => viewSource(browser, store) },
          { label: t('menu.outils-de-developpement'), accelerator: acc('devTools'), ...onTab, click: () => browser.devTools('tools') },
          // F12: a second key for the same entry, which the menu bar does not show (hidden items still answer their key on macOS).
          ...(devToolsKey ? [{ label: t('menu.outils-de-developpement'), accelerator: devToolsKey, visible: false, ...onTab, click: () => browser.devTools('tools') }] : []),
          { label: t('menu.inspecter-les-elements'), accelerator: acc('inspectElement'), ...onTab, click: () => browser.devTools('inspect') },
          { label: t('menu.console-javascript'), accelerator: acc('jsConsole'), ...onTab, click: () => browser.devTools('console') },
          { label: t('menu.inspecteur-reseau'), accelerator: acc('networkInspector'), ...onTab, click: () => browser.devTools('network') },
          {
            label: developerModeLabel(browser.isDeveloperPage()),
            accelerator: acc('developerMode'),
            enabled: page !== null && options.private !== true,
            click: () => toggleDeveloperMode(browser, store)
          },
          // The extensions window: reload an unpacked one, its error journal, its details.
          { label: t('menu.outils-d-extension'), click: () => browser.openOverlay({ panel: 'extensions' }) }
        ]
      },
      { type: 'separator' },
      { label: t('menu.infos-et-reglages-du-site'), accelerator: acc('siteInfo'), ...onTab, click: () => browser.openOverlay({ panel: 'site' }) },
      {
        label: t('menu.retoucher-ce-site'),
        accelerator: acc('boost'),
        enabled: options.private !== true && tabNow !== undefined,
        click: () => {
          const host = hostnameOf(activeTab(state())?.url ?? '')
          if (!host) return
          // A site that already has Tweaks lists them (in the site panel); otherwise start a new one.
          const has = state().boosts.some((b) => host === b.host || host.endsWith(`.${b.host}`))
          browser.openOverlay(has ? { panel: 'site' } : { panel: 'boost', host })
        }
      },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t('menu.activer-le-mode-plein-ecran'), accelerator: acc('fullscreen') },
      // This window only, above the windows of the other applications (always-on-top.ts); each window keeps its own choice, and it is not saved.
      { label: t('menu.toujours-au-premier-plan'), type: 'checkbox', checked: actions.isKeptOnTop(), click: () => actions.keepOnTop() }
    ]
  }
}
