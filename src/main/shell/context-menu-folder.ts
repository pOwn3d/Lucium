// The context menu of a folder of the sidebar (context-menus.ts, kind `folder`), a live folder's entries included.

import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import type { MenuTarget } from '@shared/ipc'
import { FOLDER_MAX_DEPTH, folderDepth, folderSubtreeIds, sideOfFolder } from '@shared/folders'
import { markdownLinks } from '@shared/selection'
import { sidebarOrder } from '@shared/sidebar'
import { t } from '@shared/i18n'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { block, entry, template, writeClipboard, type MenuContext } from './context-menu-kit'

/** A name as a menu shows it inside quotation marks: short enough not to stretch the menu. */
const quotedName = (name: string): string => (name.length > 32 ? `${name.slice(0, 31)}…` : name)

export function folderMenuItems(target: Extract<MenuTarget, { kind: 'folder' }>, browser: Browser, store: StateStore, win: BrowserWindow, context: MenuContext): MenuItemConstructorOptions[] {
  const state = store.get()
  const act = (action: Parameters<Browser['dispatch']>[0]) => () => browser.dispatch(action)
  const folder = state.folders.find((f) => f.id === target.id)
  if (!folder) return []
  const side = sideOfFolder(folder)
  // The folder's own tabs and those of the folders inside it, in the order the sidebar shows them.
  const subtree = new Set(folderSubtreeIds(state.folders, folder.id))
  const inside = sidebarOrder(state, folder.spaceId).filter((t) => t.folderId && subtree.has(t.folderId))
  const copyLinks = (text: string) => writeClipboard(browser, text, () => browser.showToast(inside.length === 1 ? t('browser.lien-copie') : t('ctx.length-liens-copies', { length: inside.length })))
  // The menu of a folder, without what is excluded (sharing a folder) or not modelled (moving a folder to another space),
  // then what Lucium adds (archiving), in blocks.
  return template(
    [
      block(t('ctx.bloc-creer-et-copier'), [
        entry('folder', { label: t('ctx.nouveau-sous-dossier'), enabled: folderDepth(state.folders, folder.id) < FOLDER_MAX_DEPTH, click: act({ type: 'folder/create', name: t('menu.nouveau-dossier-2'), parentId: folder.id }) }),
        entry('space', { label: t('ctx.transformer-name-en-espace', { name: quotedName(folder.name) }), enabled: !browser.isPrivate(), click: act({ type: 'folder/to-space', id: folder.id }) }),
        // The Markdown copy and the plain one are both listed: a native menu has no Option variant here.
        entry('copy', { label: t('ctx.copier-tous-les-liens'), enabled: inside.length > 0, click: () => copyLinks(inside.map((t) => browser.copyable(t.url)).join('\n')) }),
        entry('copy', {
          label: t('ctx.copier-tous-les-liens-en-markdown'),
          enabled: inside.length > 0,
          // A folder copies as a bulleted list, a selection as plain lines.
          click: () => writeClipboard(browser, inside.map((t) => `- ${markdownLinks([t], state.settings.stripCopiedLinks)}`).join('\n'), () => browser.showToast(inside.length === 1 ? t('ctx.lien-markdown-copie') : t('ctx.length-liens-markdown-copies', { length: inside.length })))
        })
      ]),
      // A live folder (setting `liveFolders`): looked at again at once, and its source changed in the sheet.
      block(
        t('ctx.bloc-dossier-en-direct'),
        folder.live && state.settings.liveFolders && !browser.isPrivate()
          ? [
              entry('reload', { label: t('ctx.actualiser-le-dossier-en-direct'), click: act({ type: 'livefolder/refresh', id: folder.id }) }),
              entry('link', { label: t('ctx.modifier-la-source'), click: () => browser.openOverlay({ panel: 'livefolder', folderId: folder.id }) })
            ]
          : []
      ),
      block(t('ctx.bloc-personnaliser'), [
        // The emoji of the row, chosen in the picker of the spaces. A private window keeps no folder, so it opens no sheet for one (see canOpenInPrivate).
        entry('icon', { label: t('ctx.changer-l-icone'), enabled: !browser.isPrivate(), click: () => browser.openOverlay({ panel: 'foldericon', folderId: folder.id }) }),
        // The row renames in place when it is double-clicked: this is that double click.
        entry('rename', {
          label: t('ctx.renommer'),
          click: () =>
            void win.webContents
              .executeJavaScript(`document.querySelector('.folder-title[data-id=${JSON.stringify(folder.id)}]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`)
              .catch((error: unknown) => console.error('[menu] cannot start renaming the folder:', error))
        })
      ]),
      block(t('ctx.bloc-organiser'), [
        entry('dup', { label: t('ctx.dupliquer'), click: act({ type: 'folder/duplicate', id: folder.id }) }),
        // A folder inside another is placed with it: only a root folder has a place in the list, and the menu offers the two it is not in.
        ...(folder.parentId === undefined
          ? [
              ...(side !== 'top' ? [entry('up', { label: t('ctx.mettre-en-haut-de-la-liste'), click: act({ type: 'folder/bottom', id: folder.id, bottom: false }) })] : []),
              ...(side !== 'today-start'
                ? [entry('up', { label: t('ctx.mettre-au-debut-d-aujourd-hui'), click: act({ type: 'folder/move', id: folder.id, parentId: null, toIndex: 0, side: 'today-start' }) })]
                : []),
              ...(side !== 'bottom' ? [entry('down', { label: t('ctx.mettre-en-bas-de-la-liste'), click: act({ type: 'folder/bottom', id: folder.id, bottom: true }) })] : [])
            ]
          : []),
        // Its tabs stay asleep: no reload of every tab and no launch wakes them (Folder.noWake). Ticked while it is so.
        entry('sleep', { label: t('ctx.ne-jamais-reveiller-automatiquement'), type: 'checkbox', checked: folder.noWake === true, click: act({ type: 'folder/no-wake', id: folder.id, on: folder.noWake !== true }) }),
        entry('archive', {
          label: t('ctx.archiver-le-dossier'),
          click: () => {
            browser.dispatch({ type: 'folder/archive', id: folder.id })
            browser.showToast(inside.length === 0 ? t('ctx.dossier-supprime') : inside.length === 1 ? t('ctx.dossier-archive-1-onglet') : t('ctx.dossier-archive-length-onglets', { length: inside.length }))
          }
        })
      ]),
      block(t('ctx.bloc-supprimer'), [entry('trash', { label: t('ctx.supprimer-le-dossier-garder-les-onglets'), click: act({ type: 'folder/delete', id: folder.id }) }, true)], true)
    ],
    context
  )
}
