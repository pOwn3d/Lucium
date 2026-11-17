import { clipboard, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { MenuTarget } from '@shared/ipc'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { template, type MenuContext } from './context-menu-kit'
import { tabMenuItems } from './context-menu-tab'
import { favoriteMenuItems } from './context-menu-favorite'
import { workViewMenuItems } from './context-menu-work-view'
import { extensionsMenuItems, navMenuItems, readableMenuItems } from './context-menu-toolbar'
import { downloadMenuItems } from './context-menu-download'
import { splitMenuItems } from './context-menu-split'
import { spaceMenuItems, windowSidebarBlock } from './context-menu-space'
import { folderMenuItems } from './context-menu-folder'

// Each kind of menu is built in a module of its own (context-menu-*.ts), with what they share in context-menu-kit.ts.
export { moveTabsToSpace, type MenuContext } from './context-menu-kit'

/** Native context menus for sidebar items (tabs, spaces, folders). Page menus live in the engine. */
export function showMenu(target: MenuTarget, browser: Browser, store: StateStore, win: BrowserWindow): void {
  const open = (context: MenuContext) => {
    const items = menuItems(target, browser, store, win, context)
    if (items.length > 0) Menu.buildFromTemplate(items).popup({ window: win })
  }
  // The menu of a space greys "Coller le thème" unless the clipboard holds a theme, and the clipboard can only be read asynchronously.
  if (target.kind === 'space') {
    void clipboard
      .readText()
      .then((clipboardText) => open({ clipboardText }))
      .catch((error: unknown) => {
        console.error('[menu] cannot read the clipboard:', error)
        open({})
      })
    return
  }
  open({})
}

export function menuItems(target: MenuTarget, browser: Browser, store: StateStore, win: BrowserWindow, context: MenuContext = {}): MenuItemConstructorOptions[] {
  const state = store.get()

  if (target.kind === 'tab') return tabMenuItems(target, browser, store, win, context)

  if (target.kind === 'favorite') return favoriteMenuItems(target, browser, store, context)

  if (target.kind === 'workview') return workViewMenuItems(target, browser, store, context)

  if (target.kind === 'nav') return navMenuItems(target, browser)

  if (target.kind === 'extensions') return extensionsMenuItems(target, browser, store)

  if (target.kind === 'readable') return readableMenuItems(target, browser, store)

  if (target.kind === 'download') return downloadMenuItems(target, browser, store)

  if (target.kind === 'split') return splitMenuItems(target, browser, store, context)

  // A private window has a single space and keeps nothing: the space menu would only offer inert entries. Its sidebar is its own all the same.
  if (browser.isPrivate() && target.kind === 'space') return target.sidebar === true ? template([windowSidebarBlock(browser, state)], context) : []

  if (target.kind === 'space') return spaceMenuItems(target, browser, store, win, context)

  return folderMenuItems(target, browser, store, win, context)
}
