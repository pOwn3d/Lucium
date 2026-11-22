// The menus of the bar that belong to the application rather than to the page: Lucium, Extensions, Fenêtre and Aide (menu.ts puts them in
// their places). Built from what menu-bar-kit.ts reads once for the whole bar.

import type { MenuItemConstructorOptions } from 'electron'
import { GUIDED_SETUP_REQUEST } from '@shared/settings-guide'
import { ARC_GUIDE_REQUEST } from '@shared/arc-guide'
import { DISCOVER_REQUEST } from '@shared/discover'
import { PROBLEM_REPORT_REQUEST } from '@shared/problem-report'
import { extensionMenuCommands, takenExtensionShortcuts } from '@shared/keybindings'
import { windowEntryLabel } from '@shared/window-names'
import { t } from '@shared/i18n'
import { shareApp } from './page-commands'
import type { MenuBarKit } from './menu-bar-kit'

/** Lucium: About, Settings, sharing, the default browser, import and export, updates, and the system's entries. */
export function luciumMenu({ browser, actions, acc, alone, kept }: MenuBarKit): MenuItemConstructorOptions {
  return {
    label: t('menu.lucium'),
    submenu: [
      { label: t('menu.a-propos-d-lucium'), click: actions.showAbout },
      { type: 'separator' },
      { label: t('menu.reglages'), accelerator: acc('settings'), click: alone(() => browser.openOverlay({ panel: 'settings' })) },
      { label: t('menu.partager-lucium'), click: () => shareApp(actions.window()) },
      { label: t('menu.definir-comme-navigateur-par-defaut'), enabled: !actions.isDefaultBrowser(), click: actions.setDefaultBrowser },
      { type: 'separator' },
      { label: t('menu.importer-depuis-un-autre-navigateur'), accelerator: acc('importData'), ...kept, click: actions.importDialog },
      { label: t('menu.exporter-les-signets-html'), ...kept, click: actions.exportBookmarks },
      { label: t('menu.rechercher-les-mises-a-jour'), click: actions.checkForUpdates },
      { type: 'separator' },
      { role: 'services', label: t('menu.services') },
      { label: t('menu.politique-de-confidentialite'), click: actions.showPrivacyPolicy },
      { type: 'separator' },
      { role: 'hide', label: t('menu.masquer-lucium') },
      { role: 'hideOthers', label: t('menu.masquer-les-autres') },
      { role: 'unhide', label: t('menu.tout-afficher') },
      { type: 'separator' },
      { role: 'quit', label: t('menu.quitter-lucium') }
    ]
  }
}

/** Extensions: each extension and the commands it suggests a key for, the Web Store, adding one, managing them. */
export function extensionsMenu({ browser, actions, options, state, acc, alone, kept, report }: MenuBarKit): MenuItemConstructorOptions {
  const takenShortcuts = takenExtensionShortcuts(
    actions.extensions().flatMap((extension) => (extension.commands ?? []).map((command) => ({ extensionId: extension.id, name: command.name, accelerator: command.accelerator }))),
    state().settings.keyBindings
  )
  return {
    label: t('menu.extensions'),
    submenu: [
      ...(actions.extensions().length === 0
        ? ([{ label: t('menu.aucune-extension-chargee'), enabled: false }] satisfies MenuItemConstructorOptions[])
        : actions.extensions().flatMap((extension): MenuItemConstructorOptions[] => [
            { label: extension.name, click: () => void browser.activateExtension(extension.id).catch(report(`opening ${extension.name}`)) },
            // The shortcuts an extension suggests (chrome.commands): a menu item gives each one its key, for the whole window. A key that a command of
            // Lucium or another extension already holds is not given twice: the item stays, to be clicked, without a key it would never receive.
            ...extensionMenuCommands(extension).map((command): MenuItemConstructorOptions => ({
              label: command.label,
              ...(takenShortcuts.has(`${extension.id}:${command.name}`) ? {} : { accelerator: command.accelerator }),
              click: () => browser.runExtensionCommand(extension.id, command.name)
            }))
          ])),
      { type: 'separator' },
      { label: t('menu.ouvrir-le-chrome-web-store'), enabled: options.private !== true && state().settings.webStoreInstall, click: () => browser.openWebStore() },
      { label: t('menu.ajouter-une-extension'), accelerator: acc('addExtension'), ...kept, click: actions.loadExtension },
      { label: t('menu.gerer-les-extensions'), accelerator: acc('manageExtensions'), ...kept, click: alone(() => browser.openOverlay({ panel: 'settings', pane: 'tools', anchor: 'extensions' })) }
    ]
  }
}

// Fenêtre: the system's own menu, unless windows can be named: then the entry that names the window, and the windows listed by name.
export function windowMenu({ browser, actions, state, acc, alone }: MenuBarKit): MenuItemConstructorOptions {
  if (!state().settings.nameWindows) return { role: 'windowMenu', label: t('menu.fenetre') }
  const entries = actions.windows()
  const here = entries.find((entry) => entry.focused)
  return {
    label: t('menu.fenetre'),
    submenu: [
      { role: 'minimize', label: t('menu.reduire') },
      { role: 'zoom', label: t('menu.zoom') },
      { type: 'separator' },
      // The same entry as File's: shown here with its shortcut, registered once (there).
      { label: t('menu.nommer-la-fenetre'), accelerator: acc('nameWindow'), registerAccelerator: false, click: () => browser.openOverlay({ panel: 'windowname' }) },
      { label: t('menu.retirer-le-nom-de-la-fenetre'), visible: here?.name !== undefined, click: () => here && actions.setWindowName(here.id, '') },
      { type: 'separator' },
      { role: 'front', label: t('menu.tout-ramener-au-premier-plan') },
      { type: 'separator' },
      ...entries.map((entry): MenuItemConstructorOptions => ({ label: windowEntryLabel(entry), type: 'checkbox', checked: entry.focused, click: alone(() => actions.focusWindow(entry.id)) }))
    ]
  }
}

/** Aide: the guides, the shortcuts, the news, the first launch, the quick setup, restoring data, the state of Lucium, a problem report, troubleshooting. */
export function helpMenu({ browser, actions, state, acc, alone, kept, withSecondKey, toggleOverlay }: MenuBarKit): MenuItemConstructorOptions {
  // Optional: the "Onglets" mode of the command bar (⌘⇧A) and the sheet of the shortcuts (⌘/). Their entries are hidden and their keys dead while the function is off.
  const shortcutHelpOn = state().settings.shortcutHelp
  return {
    label: t('menu.aide'),
    role: 'help',
    submenu: [
      { label: t('menu.premiers-pas'), click: alone(() => actions.openDocumentation('start')) },
      // Greyed out in a private window: the panel leads to others that window does not open (shared/private-window.ts).
      { label: t('discover.titre'), ...kept, click: () => browser.openOverlay(DISCOVER_REQUEST) },
      ...withSecondKey('shortcutHelp', { label: t('menu.aide-des-raccourcis'), accelerator: acc('shortcutHelp'), visible: shortcutHelpOn, enabled: shortcutHelpOn, click: toggleOverlay({ panel: 'shortcuts' }) }),
      { label: t('menu.raccourcis-clavier-essentiels'), click: alone(() => browser.openOverlay({ panel: 'settings', pane: 'keyboard', anchor: 'shortcuts' })) },
      { label: t('menu.documentation-d-lucium'), click: alone(() => actions.openDocumentation('folder')) },
      { label: t('menu.nouveautes'), click: actions.showWhatsNew },
      { label: t('menu.premier-lancement'), click: actions.showFirstLaunch },
      { label: t('menu.configuration-rapide'), click: () => browser.openOverlay(GUIDED_SETUP_REQUEST) },
      { label: t('arc-guide.vous-venez-d-arc'), click: () => browser.openOverlay(ARC_GUIDE_REQUEST) },
      { label: t('menu.restaurer-les-donnees'), ...kept, click: actions.restoreData },
      { type: 'separator' },
      { label: t('menu.etat-d-lucium'), click: alone(() => browser.openOverlay({ panel: 'settings', pane: 'about', anchor: 'status' })) },
      // Greyed out in a private window, which has no extension to list (shared/problem-report.ts): the report would say « aucune » where the profiles have some.
      { label: t('menu.signaler-un-probleme'), ...kept, click: () => browser.openOverlay(PROBLEM_REPORT_REQUEST) },
      {
        label: t('menu.depannage'),
        submenu: [
          { label: actions.isRecordingTrace() ? t('menu.arreter-et-enregistrer-la-trace') : t('menu.enregistrer-une-trace'), click: actions.recordTrace },
          { label: t('menu.ouvrir-le-gestionnaire-de-taches'), accelerator: acc('taskManager'), click: actions.openTaskManager },
          { type: 'separator' },
          { label: t('menu.afficher-les-donnees-d-lucium'), click: actions.showDataFolder },
          { label: t('menu.copier-les-infos-d-lucium'), click: actions.copyInfo }
        ]
      }
    ]
  }
}
