// The look of the window itself: the material behind the interface (macOS vibrancy), how opaque the space colours are, the thickness of
// the border around the page card and an optional hairline on it. The defaults are an opaque window and a 10 px border.
//
// What is possible in Electron (measured, docs/architecture.md): the window can take a vibrancy material (`BrowserWindow.setVibrancy`), and
// the web contents of the window can be translucent, so the material shows through the space colours. The page cards are native views that
// are opaque: nothing can be blurred behind the command bar or a page (that stays impossible).

import { SIDEBAR_OPACITY_DEFAULT, SIDEBAR_OPACITY_MIN, WINDOW_BORDER_DEFAULT, WINDOW_BORDER_MAX, WINDOW_VIBRANCIES, type Settings, type WindowVibrancy } from './model'
import { t } from './i18n'

export type WindowLookSettings = Pick<Settings, 'windowVibrancy' | 'sidebarOpacity' | 'windowBorder' | 'cardOutline'>

const whole = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback

/** The window settings of a saved file: a word that is not a material is "none", a number is rounded and kept in its range. */
export function cleanWindowLook(settings: Partial<Record<keyof WindowLookSettings, unknown>>): WindowLookSettings {
  return {
    windowVibrancy: WINDOW_VIBRANCIES.find((v) => v === settings.windowVibrancy) ?? 'none',
    sidebarOpacity: whole(settings.sidebarOpacity, SIDEBAR_OPACITY_MIN, 100, SIDEBAR_OPACITY_DEFAULT),
    windowBorder: whole(settings.windowBorder, 0, WINDOW_BORDER_MAX, WINDOW_BORDER_DEFAULT),
    cardOutline: settings.cardOutline === true
  }
}

/** The border around the page card, in px: the one number the layout of the window and of the interface agree on. */
export const pageMargin = (settings: Pick<Settings, 'windowBorder'>): number => settings.windowBorder

/**
 * How opaque the window background is. Without a material behind it, a translucent background would only show the dark colour the window
 * is made of, so the percentage only counts while a material is chosen.
 */
export function windowOpacity(settings: Pick<Settings, 'windowVibrancy' | 'sidebarOpacity'>): number {
  return settings.windowVibrancy === 'none' ? 1 : settings.sidebarOpacity / 100
}

/** Whether the window shows a material through its background: the interface then draws its colours translucent. */
export const isTranslucent = (settings: Pick<Settings, 'windowVibrancy' | 'sidebarOpacity'>): boolean => windowOpacity(settings) < 1

/** What changes in the window itself when the look changes; the same key means there is nothing to do. */
export function windowLookKey(settings: Pick<Settings, 'windowVibrancy' | 'sidebarOpacity'>): string {
  return `${settings.windowVibrancy}|${isTranslucent(settings) ? 'clear' : 'opaque'}`
}

/** The key of the default window: the one a window has before anything is changed. */
export const DEFAULT_WINDOW_LOOK_KEY = 'none|opaque'

/**
 * The custom properties of the shell. Only what differs from the default window is set: the stylesheets carry the default values as the fallback
 * of each variable, so a window that was never changed has the same markup as before these settings existed.
 */
export function windowLookVars(settings: WindowLookSettings): Record<string, string> {
  const alpha = windowOpacity(settings)
  return {
    ...(pageMargin(settings) !== WINDOW_BORDER_DEFAULT ? { '--window-border': `${pageMargin(settings)}px` } : {}),
    ...(alpha < 1 ? { '--window-alpha': String(alpha) } : {}),
    ...(settings.cardOutline ? { '--card-outline': 'rgb(255 255 255 / 0.16)' } : {})
  }
}

export const VIBRANCY_LABELS: Record<WindowVibrancy, string> = {
  get none() { return t('window-look.aucun-fenetre-opaque') },
  get sidebar() { return t('window-look.barre-laterale') },
  get 'under-window'() { return t('window-look.sous-la-fenetre') },
  get hud() { return t('window-look.verre-sombre') }
}
