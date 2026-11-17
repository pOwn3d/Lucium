// The application icon choices (Settings › Icon): the Lucium fan logo in eight colour versions (drawn by scripts/logo/fan-logo.ts, rendered by
// scripts/logo/make-icons.mjs) and shipped as 512 px PNG files in resources/app-icons/<id>.png: the Settings window shows them and the main process
// puts the chosen one in the Dock, and on the application bundle so that the Dock, the Finder and the Launchpad keep it once Lucium is closed
// (main/shell/app-icon.ts). The ids are those of the themes of the drawing (a test keeps them together); `clair` is the default.

import { t } from './i18n'

export interface AppIcon {
  /** Also the name of the file in resources/app-icons. */
  id: string
  label: string
}

export const APP_ICONS: readonly AppIcon[] = [
  { id: 'clair', get label() { return t('icons.clair') } },
  { id: 'boreal', get label() { return t('icons.boreal') } },
  { id: 'crepuscule', get label() { return t('icons.crepuscule') } },
  { id: 'nebula', get label() { return t('icons.nebula') } },
  { id: 'cyber', get label() { return t('icons.cyber') } },
  { id: 'solaire', get label() { return t('icons.solaire') } },
  { id: 'abysse', get label() { return t('icons.abysse') } },
  { id: 'sepia-or', get label() { return t('icons.sepia-or') } }
]

/** The icon of the bundle (build/icon.icns) and the one a new profile starts with: the default value of the setting `appIcon` (shared/model.ts) says the same. */
export const DEFAULT_APP_ICON = 'clair'

/**
 * The ids of the former sets of icons, mapped to the nearest one of the current set (an old choice is kept, in spirit): the colours of the second set
 * (coral, amber, mint, ocean, orchid, graphite) and the names of the first one (braise, nuit, bonbon). Mint has no entry: it becomes the default icon,
 * which is what any id without one becomes.
 */
const FORMER_APP_ICONS: Readonly<Record<string, string>> = {
  corail: 'solaire',
  ambre: 'sepia-or',
  ocean: 'crepuscule',
  orchidee: 'nebula',
  graphite: 'cyber',
  braise: 'solaire',
  nuit: 'cyber',
  bonbon: 'nebula'
}

export const isAppIconId = (id: unknown): id is string => typeof id === 'string' && APP_ICONS.some((icon) => icon.id === id)

/** A known icon id, the nearest one for an id of the former set, or the default for anything else. */
export function normalizeAppIcon(id: unknown): string {
  if (isAppIconId(id)) return id
  return (typeof id === 'string' && Object.hasOwn(FORMER_APP_ICONS, id) ? FORMER_APP_ICONS[id] : undefined) ?? DEFAULT_APP_ICON
}

/**
 * Why the chosen icon is not shown as it should be, which Settings › Icône tells: `missing-picture`, its picture is missing from the application (a
 * damaged copy), and the Dock keeps what it showed; `bundle-not-writable`, the icon could not be put on the application bundle (installed by an
 * administrator, a read-only folder or volume, macOS refused): the Dock shows it while Lucium runs, and loses it once Lucium is closed.
 */
export interface AppIconIssue {
  reason: 'missing-picture' | 'bundle-not-writable'
}

/**
 * What to do with the custom icon of the application bundle so that it follows the choice `wanted`: `set` puts the chosen picture on the bundle,
 * `clear` takes the custom icon off, `none` leaves the bundle as it is. `found.custom` says whether the bundle carries a custom icon now (its `Icon\r`),
 * `found.posed` which icon Lucium last put on this very bundle (null when it does not know). The default icon is the one of the bundle itself: it is
 * never put on it, and choosing it takes off what is there, since a custom icon fails `codesign --verify --strict` (docs/drm.md). An id that is not
 * one of the list counts as the default one.
 */
export function bundleIconStep(wanted: string, found: { custom: boolean; posed: string | null }): 'set' | 'clear' | 'none' {
  if (!isAppIconId(wanted) || wanted === DEFAULT_APP_ICON) return found.custom ? 'clear' : 'none'
  return found.custom && found.posed === wanted ? 'none' : 'set'
}
