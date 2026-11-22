// The menus of the bar about what the sidebar holds: Espaces (the spaces, their profiles, the web panels, a space put aside, the lock), Onglets
// (the tab on screen, its folder and its branch, the ⌘1 … ⌘9 rows) and Archive (back and forward, history, archive, downloads, the data of the
// site). Built from what menu-bar-kit.ts reads once for the whole bar.

import type { MenuItemConstructorOptions } from 'electron'
import { activeTab, stepSpace } from '@shared/sidebar'
import { tabOfItem } from '@shared/sidebar-items'
import { tabStep } from '@shared/tab-step'
import { spaceGlyph } from '@shared/space-icon'
import { asideRefusal, asideSessions } from '@shared/sessions'
import { newFolderRefusal } from '@shared/lock'
import { spaceTransferRefusal } from '@shared/space-transfer'
import { t } from '@shared/i18n'
import { moveTabsToSpace } from './context-menus'
import { asideSpace, withEveryWindowsTabs } from './space-aside'
import { exportSpace, importSpace } from './space-transfer'
import { webPanelMenuItems } from './web-panel-menu'
import type { MenuBarKit } from './menu-bar-kit'

export function spacesMenu({ browser, store, actions, options, state, acc, kept, withSecondKey }: MenuBarKit): MenuItemConstructorOptions {
  const profiles = [...new Set(['default', ...state().spaces.map((sp) => sp.profileId)])]
  const currentSpace = state().spaces.find((sp) => sp.id === state().activeSpaceId)
  const transferRefusal = spaceTransferRefusal(withEveryWindowsTabs(store), state().activeSpaceId, options.lockedSpaces ?? [])
  const profileName = (id: string) => state().settings.profileNames[id] ?? (id === 'default' ? t('menu.profil-par-defaut') : id)

  const spaceItems: MenuItemConstructorOptions[] = state().spaces.slice(0, 9).flatMap((space, i) =>
    withSecondKey(`space${i + 1}`, {
      label: `${spaceGlyph(space)} ${space.name}`,
      accelerator: acc(`space${i + 1}`),
      type: 'checkbox',
      checked: space.id === state().activeSpaceId,
      click: () => browser.dispatch({ type: 'space/select', id: space.id })
    })
  )
  return {
    label: t('menu.espaces'),
    submenu: [
      { label: t('menu.nouvel-espace'), accelerator: acc('newSpace'), ...kept, click: () => browser.openOverlay({ panel: 'spacecreate' }) },
      { label: t('menu.modifier-le-theme'), accelerator: acc('editTheme'), ...kept, click: () => browser.openOverlay({ panel: 'theme', spaceId: state().activeSpaceId }) },
      { label: t('menu.renommer-l-espace'), accelerator: acc('renameSpace'), ...kept, click: () => browser.openOverlay({ panel: 'space', spaceId: state().activeSpaceId, focus: 'name' }) },
      {
        label: t('menu.changer-de-profil'),
        ...kept,
        submenu: profiles.map((id): MenuItemConstructorOptions => ({
          label: profileName(id),
          type: 'radio',
          checked: id === currentSpace?.profileId,
          click: () => browser.dispatch({ type: 'space/update', id: state().activeSpaceId, patch: { profileId: id } })
        }))
      },
      { type: 'separator' },
      { label: t('menu.espace-suivant'), accelerator: acc('nextSpace'), click: () => browser.stepSpace(1) },
      { label: t('menu.espace-precedent'), accelerator: acc('previousSpace'), click: () => browser.stepSpace(-1) },
      { type: 'separator' },
      ...spaceItems,
      { type: 'separator' },
      { label: t('menu.gerer-les-espaces'), accelerator: acc('manageSpaces'), ...kept, click: () => browser.openOverlay({ panel: 'spaces' }) },
      { type: 'separator' },
      // Sites kept beside the page: absent while the function is off.
      ...(currentSpace && webPanelMenuItems(browser, state(), currentSpace).length > 0 ? [...webPanelMenuItems(browser, state(), currentSpace), { type: 'separator' } as MenuItemConstructorOptions] : []),
      // A space put aside is a session that remembers the space (see sessions.ts): the menu lists them, the panel of the sessions has them too.
      {
        label: t('menu.mettre-l-espace-de-cote'),
        accelerator: acc('asideSpace'),
        enabled: options.private !== true && asideRefusal(state(), state().activeSpaceId) === null,
        click: () => asideSpace(browser, store, actions.window(), state().activeSpaceId)
      },
      {
        label: t('menu.rouvrir-un-espace-mis-de-cote'),
        enabled: options.private !== true && asideSessions(state()).length > 0,
        submenu:
          asideSessions(state()).length === 0
            ? [{ label: t('menu.aucun-espace-mis-de-cote'), enabled: false }]
            : asideSessions(state())
                .slice(0, 20)
                .map((session): MenuItemConstructorOptions => ({ label: `${spaceGlyph(session.space!.space)} ${session.name}`, click: () => browser.dispatch({ type: 'space/reopen', id: session.id }) }))
      },
      // One space with its tabs to another Mac, as a file (no cookies, no passwords): see space-transfer.ts.
      // Greyed out, with the reason under the pointer, while the space on screen is locked (it would leave in the clear) or too large.
      { label: t('space-transfer.exporter-cet-espace'), enabled: options.private !== true && transferRefusal === null, ...(transferRefusal === null ? {} : { toolTip: transferRefusal }), click: () => void exportSpace(browser, store, actions.window(), state().activeSpaceId) },
      { label: t('space-transfer.importer-un-espace'), enabled: options.private !== true, click: () => void importSpace(browser, store, actions.window()) },
      // Locks the application again, and the spaces that are set to be locked.
      ...(actions.lockNow && options.private !== true
        ? ([{ type: 'separator' }, { label: t('menu.verrouiller-maintenant'), accelerator: acc('lockNow'), click: actions.lockNow }] satisfies MenuItemConstructorOptions[])
        : [])
    ]
  }
}

export function tabsMenu({ browser, store, actions, options, state, acc, kept, onTab, facts, tabNow, dispatch, withTab, toggleOverlay }: MenuBarKit): MenuItemConstructorOptions {
  // The functions of the library are optional: their entries are hidden (and their shortcuts dead) while the function is off, and in a private window, which keeps nothing.
  const liveFoldersOn = options.private !== true && state().settings.liveFolders
  // A new folder (a live one too) lands in the space on screen: while that space is locked, the lock refuses it, so its entries are greyed out
  // and say why under the pointer, and their shortcuts do nothing.
  const folderRefusal = newFolderRefusal(state().activeSpaceId, options.lockedSpaces ?? [])
  const newFolder: Pick<MenuItemConstructorOptions, 'toolTip'> = folderRefusal === null ? {} : { toolTip: folderRefusal }
  // Optional: the "Onglets" mode of the command bar (⌘⇧A) and the sheet of the shortcuts (⌘/). Their entries are hidden and their keys dead while the function is off.
  const tabSearchOn = state().settings.tabSearch
  const tabGridOn = state().settings.tabGrid
  // Tabs menu: the folder the tab on screen sits in, and the spaces before and after the current one (null with a single space).
  const tabFolder = tabNow?.folderId ? state().folders.find((f) => f.id === tabNow.folderId) : undefined
  const nextSpace = stepSpace(state(), 1)
  const previousSpace = stepSpace(state(), -1)
  const moveTabAcross = (spaceId: string | null) => {
    const tab = activeTab(state())
    if (tab && spaceId !== null) moveTabsToSpace(browser, store, actions.window(), [tab.id], spaceId)
  }
  // Tabs › Déplacer l’onglet vers le haut / le bas: one place in its group, as the same entries of the tab's menu. The place is read when the key is
  // pressed (the menu is not rebuilt at each move): at the top or the bottom of its group, nothing happens.
  const moveTabStep = (direction: -1 | 1) =>
    withTab((tab) => {
      const step = tabStep(state(), tab.id, direction)
      if (step) browser.dispatch({ type: 'tab/move', id: tab.id, ...step })
    })
  const tabShortcuts: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: t('menu.go-to-item', { n: i + 1 }),
    accelerator: acc(`item${i + 1}`),
    click: () => {
      // The nth row the sidebar shows (see sidebar-items.ts), not the nth tab of the state.
      const tab = tabOfItem(state(), i + 1)
      if (tab) browser.dispatch({ type: 'tab/select', id: tab.id })
    }
  }))
  return {
    label: t('menu.onglets'),
    submenu: [
      // The same shortcut as File › New Tab: shown here, registered once.
      { label: t('menu.nouvel-onglet'), accelerator: acc('newTab'), registerAccelerator: false, click: () => browser.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' }) },
      { label: t('menu.rechercher-un-onglet'), accelerator: acc('tabSearch'), visible: tabSearchOn, enabled: tabSearchOn, click: toggleOverlay({ panel: 'commandbar', mode: 'tabs', initial: '' }) },
      { label: t('menu.vue-d-ensemble-des-onglets'), accelerator: acc('tabGrid'), visible: tabGridOn, enabled: tabGridOn, click: toggleOverlay({ panel: 'tabgrid' }) },
      {
        label: tabNow?.pinned ? t('menu.desepingler-l-onglet') : t('menu.epingler-l-onglet'),
        accelerator: acc('pin'),
        enabled: options.private !== true && tabNow !== undefined,
        click: withTab((tab) => browser.dispatch({ type: tab.pinned ? 'tab/unpin' : 'tab/pin', id: tab.id }))
      },
      { label: t('menu.nouveau-dossier'), accelerator: acc('newFolder'), enabled: options.private !== true && folderRefusal === null, ...newFolder, click: dispatch({ type: 'folder/create', name: t('menu.nouveau-dossier-2') }) },
      { label: t('menu.nouveau-dossier-en-direct'), accelerator: acc('newLiveFolder'), visible: liveFoldersOn, enabled: liveFoldersOn && folderRefusal === null, ...newFolder, click: () => browser.openOverlay({ panel: 'livefolder' }) },
      { type: 'separator' },
      { label: t('menu.onglet-suivant'), accelerator: acc('nextTab'), click: () => browser.stepTab(1) },
      { label: t('menu.onglet-precedent'), accelerator: acc('previousTab'), click: () => browser.stepTab(-1) },
      { label: t('menu.reveler-l-onglet-dans-la-barre-laterale'), accelerator: acc('revealTab'), ...onTab, click: () => browser.revealActiveTab() },
      { label: t('menu.dupliquer-l-onglet'), accelerator: acc('duplicateTab'), enabled: tabNow !== undefined, click: withTab((tab) => browser.dispatch({ type: 'tab/duplicate', id: tab.id })) },
      // "Mute" is greyed out for a page that makes no sound; a muted tab always can be given its sound back.
      {
        label: facts.sound === 'muted' ? t('menu.retablir-le-son-de-l-onglet') : t('menu.couper-le-son-de-l-onglet'),
        accelerator: acc('muteTab'),
        enabled: facts.sound !== 'silent',
        click: withTab((tab) => browser.toggleMute(tab.id))
      },
      { label: tabFolder?.collapsed ? t('menu.deplier-le-dossier-de-l-onglet') : t('menu.replier-le-dossier-de-l-onglet'), accelerator: acc('toggleFolder'), enabled: tabFolder !== undefined && options.private !== true, click: () => tabFolder && browser.dispatch({ type: 'folder/toggle', id: tabFolder.id }) },
      // Optional: only while the setting « Arbre d’onglets » is on.
      {
        label: tabNow?.treeCollapsed ? t('ctx.deplier-les-onglets-enfants') : t('ctx.replier-les-onglets-enfants'),
        accelerator: acc('toggleTabBranch'),
        visible: state().settings.tabTree,
        enabled: state().settings.tabTree && tabNow !== undefined && state().tabs.some((t) => t.parentId === tabNow.id),
        click: withTab((tab) => browser.dispatch({ type: 'tab/tree-collapse', id: tab.id }))
      },
      {
        label: t('menu.sortir-l-onglet-de-son-parent'),
        accelerator: acc('detachTab'),
        visible: state().settings.tabTree,
        enabled: state().settings.tabTree && tabNow?.parentId !== undefined,
        click: withTab((tab) => browser.dispatch({ type: 'tab/tree-detach', id: tab.id }))
      },
      { label: t('menu.deplacer-l-onglet-vers-l-espace-suivant'), accelerator: acc('moveTabNextSpace'), enabled: tabNow !== undefined && nextSpace !== null, click: () => moveTabAcross(nextSpace) },
      { label: t('menu.deplacer-l-onglet-vers-l-espace-precedent'), accelerator: acc('moveTabPreviousSpace'), enabled: tabNow !== undefined && previousSpace !== null, click: () => moveTabAcross(previousSpace) },
      { label: t('menu.deplacer-l-onglet-vers-le-haut'), accelerator: acc('moveTabUp'), ...onTab, click: moveTabStep(-1) },
      { label: t('menu.deplacer-l-onglet-vers-le-bas'), accelerator: acc('moveTabDown'), ...onTab, click: moveTabStep(1) },
      { type: 'separator' },
      ...tabShortcuts,
      { type: 'separator' },
      { label: t('menu.vider-les-onglets-du-jour'), accelerator: acc('clearToday'), click: dispatch({ type: 'today/clear' }) },
      { label: t('menu.reinitialiser-tous-les-onglets-epingles-de'), accelerator: acc('resetPinned'), ...kept, click: dispatch({ type: 'tabs/reset-pinned' }) }
    ]
  }
}

export function archiveMenu({ browser, actions, state, acc, kept, onTab, facts, report, withSecondKey }: MenuBarKit): MenuItemConstructorOptions {
  return {
    label: t('menu.archive'),
    submenu: [
      ...withSecondKey('back', { label: t('menu.page-precedente'), accelerator: acc('back'), enabled: facts.canGoBack, click: () => browser.nav('back') }),
      ...withSecondKey('forward', { label: t('menu.page-suivante'), accelerator: acc('forward'), enabled: facts.canGoForward, click: () => browser.nav('forward') }),
      { type: 'separator' },
      { label: t('menu.afficher-l-historique'), accelerator: acc('history'), ...kept, click: () => browser.openOverlay({ panel: 'history' }) },
      { label: t('menu.afficher-l-archive'), accelerator: acc('archive'), ...kept, click: () => browser.openOverlay({ panel: 'archive' }) },
      { label: t('menu.afficher-les-telechargements'), accelerator: acc('downloads'), click: () => browser.openOverlay({ panel: 'downloads' }) },
      { type: 'separator' },
      { label: t('menu.vider-l-archive'), accelerator: acc('clearArchive'), enabled: state().archive.length > 0, click: actions.clearArchive },
      { label: t('menu.effacer-l-historique-de-navigation'), accelerator: acc('clearHistory'), ...kept, click: actions.clearHistory },
      { label: t('menu.tout-effacer'), accelerator: acc('clearEverything'), ...kept, click: actions.clearEverything },
      { label: t('menu.nouvelle-identite'), accelerator: acc('newIdentity'), ...kept, click: actions.newIdentity },
      ...withSecondKey('clearSiteData', { label: t('menu.effacer-les-donnees-du-site'), accelerator: acc('clearSiteData'), ...onTab, click: () => browser.openOverlay({ panel: 'sitedata' }) }),
      { label: t('menu.effacer-les-donnees-du-site-maintenant'), accelerator: acc('clearSiteDataNow'), ...onTab, click: () => void browser.quickClearSite().catch(report('clear site data')) }
    ]
  }
}
