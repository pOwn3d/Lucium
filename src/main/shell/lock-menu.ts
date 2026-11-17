// The application menu while Lucium is locked: what cannot reveal or change anything. Quit, hiding, and the editing commands (the lock
// screen has a field to type the phrase in, and ⌘V must reach it). Every other entry (new tab, history, spaces, settings…) is gone, and with
// it their shortcuts.

import { Menu, type MenuItemConstructorOptions } from 'electron'
import { t } from '@shared/i18n'

export function lockedMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: t('menu.lucium'),
      submenu: [{ role: 'about', label: t('menu.a-propos-d-lucium') }, { type: 'separator' }, { role: 'hide', label: t('menu.masquer-lucium') }, { role: 'unhide', label: t('menu.tout-afficher') }, { type: 'separator' }, { role: 'quit', label: t('menu.quitter-lucium') }]
    },
    {
      label: t('menu.edition'),
      submenu: [{ role: 'undo', label: t('menu.annuler') }, { role: 'redo', label: t('menu.retablir') }, { type: 'separator' }, { role: 'cut', label: t('menu.couper') }, { role: 'copy', label: t('menu.copier') }, { role: 'paste', label: t('menu.coller') }, { role: 'selectAll', label: t('menu.tout-selectionner') }]
    },
    // The system's own Window menu (minimize, close, bring to front): ⌘M and ⌘W keep working over the lock screen, and they show nothing.
    { role: 'windowMenu', label: t('menu.fenetre') }
  ]
}

export const lockedMenu = (): Menu => Menu.buildFromTemplate(lockedMenuTemplate())
