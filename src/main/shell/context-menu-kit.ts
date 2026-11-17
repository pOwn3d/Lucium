// What the context menus of the sidebar share (context-menus.ts, and one module per kind of menu: context-menu-tab.ts, -favorite, -toolbar,
// -download, -split, -space, -folder): an entry with its icon, the blocks a menu is set in and the template made of them, the copy to the
// clipboard, the system's sharing, and moving tabs to another space.

import { clipboard, dialog, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { movesAcrossProfiles } from '@shared/dnd'
import { changesSession } from '@shared/tab-transfer'
import { layoutBlocks, menuHeadersSupported, type MenuBlock } from '@shared/menu-blocks'
import { t } from '@shared/i18n'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { noteFailure } from './failure-notice'
import { menuIcon, type MenuIconName } from './menu-icons'

export type Item = MenuItemConstructorOptions
export type Block = MenuBlock<Item>

/** What a menu needs to know that is not in the state. */
export interface MenuContext {
  /** The text on the clipboard when the menu was asked for; without it "Coller le thème" is greyed. */
  clipboardText?: string
  /** Whether the titles of the blocks are section headers (macOS 14 and later) or separators; left out, the system decides. */
  headers?: boolean
}

/**
 * An entry with the icon of its kind (one monochrome icon per entry). `danger` is for an entry that erases, closes or removes: its icon
 * is red. An icon that cannot be made leaves the entry as it is.
 */
export function entry(icon: MenuIconName, item: Item, danger = false): Item {
  const image = menuIcon(icon, danger)
  return image ? { ...item, icon: image } : item
}

/** A block of a menu: its discreet title and its entries. A destructive block comes after all the others. */
export const block = (title: string, items: Item[], destructive = false): Block => ({ title, destructive, items })

/** The rows of a menu as an Electron template: titles are section headers where the system draws them (macOS 14), else separators. */
export function template(blocks: Block[], context: MenuContext): Item[] {
  const headers = context.headers ?? menuHeadersSupported(process.platform, typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : undefined)
  return layoutBlocks(blocks, { headers }).map((row): Item => (row.kind === 'header' ? { type: 'header', label: row.title } : row.kind === 'separator' ? { type: 'separator' } : row.item))
}

/**
 * Moves tabs to another space. Another profile means other cookies and logins, so the user is told first,
 * once for the whole move. Used by the menus and by a drop on a space of the footer. In the same profile, the pages stay as they are.
 */
export function moveTabsToSpace(browser: Browser, store: StateStore, win: BrowserWindow, ids: string[], spaceId: string): void {
  const state = store.get()
  const target = state.spaces.find((sp) => sp.id === spaceId)
  const moving = state.tabs.filter((t) => ids.includes(t.id) && t.spaceId !== spaceId)
  if (!target || moving.length === 0) return
  if (movesAcrossProfiles(state, ids, spaceId)) {
    // A page in a call or playing is made again in the other profile: what is under way is cut, so the box says that first and leans on Annuler.
    const live = browser.hasLivePage(moving.filter((tab) => changesSession(state, tab, spaceId)).map((tab) => tab.id))
    const answer = dialog.showMessageBoxSync(win, {
      type: 'warning',
      // Not `menu.annuler`: its English wording is the Edit menu's “Undo”.
      buttons: [t('ctx.deplacer'), t('confirm-box.annuler')],
      defaultId: live ? 1 : 0,
      cancelId: 1,
      message: live ? t('tabtransfer.page-rechargee-appel-coupe') : t('ctx.name-utilise-un-autre-profil', { name: target.name }),
      // Two sentences rather than a count: neither says how many pages there are.
      detail: moving.length > 1 ? t('ctx.chaque-profil-a-ses-propres-donnees-ces-pages') : t('ctx.chaque-profil-a-ses-propres-donnees-cette-page')
    })
    if (answer !== 0) return
  }
  for (const tab of moving) browser.dispatch({ type: 'tab/move-to-space', id: tab.id, spaceId })
}

export const writeClipboard = (browser: Browser, text: string, done: () => void) =>
  void clipboard
    .writeText(text)
    .then(done)
    .catch((error: unknown) => noteFailure('[menu] cannot write to the clipboard:', error, (message) => browser.showToast(message), t('ctx.impossible-de-copier-dans-le-presse-papiers')))

/** "Share ▸": the system's sharing services for an address, as a submenu of the menu itself. */
export const shareItem = (url: string): MenuItemConstructorOptions => ({ label: t('keybindings.partager'), role: 'shareMenu', sharingItem: { urls: [url] } })
