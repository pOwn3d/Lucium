// The two appearances of the settings, and what each one drives (View › Appearance, Settings › Appearance):
//  - « Apparence de Lucium » (`interfaceAppearance`): the appearance of the application's own windows. It is the only setting that moves
//    `nativeTheme.themeSource`, which is global in Electron (it turns every window and every page the same way): Automatique is the Mac's;
//  - « Apparence demandée aux sites » (`websiteAppearance`): what the web pages read of `prefers-color-scheme`, given to each page by the engine
//    (engine/color-scheme.ts) and to no window of Lucium. Automatique leaves the pages with the appearance of Lucium.
// Before they had names of their own they were one setting, which turned the Settings and the sidebar dark while macOS was light.

import type { Settings } from '@shared/model'
import { pageSchemeOf, themeSourceOf } from '@shared/theme'

/** The part of Electron's `nativeTheme` that is driven. */
export interface ThemeHost {
  themeSource: 'system' | 'light' | 'dark'
}

/** The part of the engine that gives the pages their scheme. */
export interface PageSchemeHost {
  setPageColorScheme(scheme: 'light' | 'dark' | null): void
}

export interface AppearanceStore {
  get(): { settings: Pick<Settings, 'interfaceAppearance' | 'websiteAppearance'> }
  subscribe(listener: () => void): unknown
}

/**
 * Puts the application in line with the two settings now, and at every change of the state. Idempotent: `themeSource` is written only when it differs
 * (writing it makes macOS redraw the windows), and the engine does nothing for a scheme it already has.
 */
export function followAppearance(store: AppearanceStore, theme: ThemeHost, engine: PageSchemeHost): void {
  const apply = (): void => {
    const { interfaceAppearance, websiteAppearance } = store.get().settings
    const source = themeSourceOf(interfaceAppearance)
    if (theme.themeSource !== source) theme.themeSource = source
    engine.setPageColorScheme(pageSchemeOf(websiteAppearance))
  }
  apply()
  store.subscribe(apply)
}
