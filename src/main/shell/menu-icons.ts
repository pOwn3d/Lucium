// The icons of the context menus: one monochrome icon of 16 pt per entry. The pictures are in menu-icons-data.ts (made by
// scripts/make-menu-icons.mjs, 32 px PNG = the @2x of 16 pt); this module turns them into native images, once each.
//
// A plain icon is a template image: macOS paints it in the colour of the text of the entry, so it is right in the light and in the dark menu and
// when the entry is highlighted. The icon of an entry that erases or closes is red and not a template: it keeps its colour everywhere.
// An icon that cannot be made leaves the entry without one (the menu still works): it is said once in the log and not asked again.

import { nativeImage, type NativeImage } from 'electron'
import { MENU_ICON_PNG, MENU_ICON_RED_PNG } from './menu-icons-data'

export type MenuIconName = keyof typeof MENU_ICON_PNG

const made = new Map<string, NativeImage | undefined>()

/** The icon `name`, in red for an entry that erases or closes (an icon that has no red version comes plain), or undefined when it cannot be made. */
export function menuIcon(name: MenuIconName, danger = false): NativeImage | undefined {
  const red = danger && Object.hasOwn(MENU_ICON_RED_PNG, name)
  const key = `${red ? 'red:' : ''}${name}`
  if (made.has(key)) return made.get(key)
  let image: NativeImage | undefined
  try {
    const base64 = red ? MENU_ICON_RED_PNG[name as keyof typeof MENU_ICON_RED_PNG] : MENU_ICON_PNG[name]
    const picture = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'), { scaleFactor: 2 })
    if (picture.isEmpty()) throw new Error('the picture is empty')
    if (!red) picture.setTemplateImage(true)
    image = picture
  } catch (error) {
    console.error(`[menu] cannot make the icon "${name}":`, error)
  }
  made.set(key, image)
  return image
}
