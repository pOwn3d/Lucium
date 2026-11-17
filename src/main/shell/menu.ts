import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { StateStore } from '../store'
import type { Browser } from './browser'
import { menuBarKit, type MenuActions, type MenuClick, type MenuOptions } from './menu-bar-kit'
import { extensionsMenu, helpMenu, luciumMenu, windowMenu } from './menu-bar-app'
import { fileMenu } from './menu-bar-file'
import { editMenu } from './menu-bar-edit'
import { viewMenu } from './menu-bar-view'
import { archiveMenu, spacesMenu, tabsMenu } from './menu-bar-tabs'

export type { MenuActions, MenuOptions } from './menu-bar-kit'

/** The entries of `items` (and of their submenus) with a click that brings the window back first, except the clicks of `alone`. */
function bringingBack(items: MenuItemConstructorOptions[], reveal: () => void, alone: ReadonlySet<unknown>): MenuItemConstructorOptions[] {
  return items.map((item) => {
    const submenu = Array.isArray(item.submenu) ? { submenu: bringingBack(item.submenu, reveal, alone) } : {}
    const click = item.click
    const wrapped: Pick<MenuItemConstructorOptions, 'click'> =
      click && !alone.has(click)
        ? {
            click: (...args: Parameters<MenuClick>) => {
              reveal()
              click(...args)
            }
          }
        : {}
    return { ...item, ...submenu, ...wrapped }
  })
}

/**
 * The application menu bar, in a fixed order (Lucium, File, Edit, View, Spaces, Tabs, Archive,
 * Extensions, Window, Help). Shortcuts come from the settings: the menu is rebuilt whenever they change. An entry with nothing to act on
 * (Back with nothing to go back to, Stop with nothing loading, the split entries outside a split view) is greyed out.
 * Each menu is built in a module of its own (menu-bar-*.ts), from what menu-bar-kit.ts reads once for the whole bar, in this order.
 */
export function buildMenu(browser: Browser, store: StateStore, actions: MenuActions, options: MenuOptions = {}): Menu {
  const kit = menuBarKit(browser, store, actions, options)
  const template: MenuItemConstructorOptions[] = [luciumMenu(kit), fileMenu(kit), editMenu(kit), viewMenu(kit), spacesMenu(kit), tabsMenu(kit), archiveMenu(kit), extensionsMenu(kit), windowMenu(kit), helpMenu(kit)]
  return Menu.buildFromTemplate(kit.platform.adaptMenu(options.away ? bringingBack(template, options.away, kit.standalone) : template))
}
