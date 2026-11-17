// The entries that set the readable mode of a site, for the two menus that offer them: View › Appearance › Contraste de la page pour ce site, and the menu of the
// toolbar's button « Contraste de la page ». One place for the labels, the ticks and what a click does, so that the two cannot drift apart.

import type { MenuItemConstructorOptions } from 'electron'
import type { Settings } from '@shared/model'
import { READABLE_LABELS, READABLE_MODES, readableModeFor, siteReadableOf, type ReadableMode } from '@shared/readable-mode'
import { t } from '@shared/i18n'

/**
 * `view`: « Comme les autres sites » first and ticked while the site has no mode of its own, then the three modes with the site's own choice ticked.
 * `toolbar`: the three modes with the mode the page really has ticked (its own, else the default's), then, only for a site that has a mode of its own, a
 * separator and « Comme les autres sites (Original) » to give it back to the default.
 */
export type ReadableMenuLayout = 'view' | 'toolbar'

export interface ReadableMenuPage {
  settings: Pick<Settings, 'readableMode' | 'siteReadableMode'>
  /** The address of the page the choice is made for. */
  url: string | undefined
  /** The appearance of the interface, which the default Automatic follows: needed to tick the mode the page has (the toolbar's menu; the View menu ticks the site's own choice). */
  systemDark?: boolean
}

/** The entries for the page; `set` is what a click does (`null`: the site follows the default again). */
export function readableSiteItems(layout: ReadableMenuLayout, page: ReadableMenuPage, set: (mode: ReadableMode | null) => void): MenuItemConstructorOptions[] {
  const own = siteReadableOf(page.settings.siteReadableMode, page.url)
  const modes = (ticked: ReadableMode | null): MenuItemConstructorOptions[] =>
    READABLE_MODES.map((mode): MenuItemConstructorOptions => ({ label: READABLE_LABELS[mode].name, type: 'radio', checked: ticked === mode, click: () => set(mode) }))
  if (layout === 'view') return [{ label: t('readable-mode.comme-les-autres-sites'), type: 'radio', checked: own === null, click: () => set(null) }, ...modes(own)]
  return [
    ...modes(readableModeFor(page.settings, page.url, page.systemDark === true)),
    ...(own === null
      ? []
      : ([
          { type: 'separator' },
          { label: t('readable-mode.comme-les-autres-sites-name', { name: READABLE_LABELS[page.settings.readableMode].name }), click: () => set(null) }
        ] satisfies MenuItemConstructorOptions[]))
  ]
}
