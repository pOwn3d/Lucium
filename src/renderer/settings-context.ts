// What the rows of the Settings window read from the window around them (the settings, the card that is open, the part of the page, the search) instead of being
// handed it through every pane.

import { createContext } from 'react'
import type { SettingsPane, SettingsSubpage } from '@shared/ipc'
import type { Settings } from '@shared/model'
import type { SettingKey } from '@shared/settings-catalog'

/** The settings the window shows, so that a row can tell whether it is at its default. Absent in a pane drawn alone (a test): nothing is marked then. */
export const SettingsStateContext = createContext<Settings | null>(null)

/**
 * How a row that is not at its default puts it back (« Rétablir » on the row): the window writes the default of its settings (every one a preset
 * writes) and offers to undo it. Absent in a pane drawn alone (a test): no row offers it then.
 */
export const ResetContext = createContext<((keys: readonly SettingKey[], label?: string) => void) | null>(null)

/** Which card is open (one at a time), and how a row opens or closes its own. */
export interface IllustrationState {
  open: SettingKey | null
  toggle: (key: SettingKey) => void
}
export const IllustrationContext = createContext<IllustrationState | null>(null)

/**
 * Which part of a page is being drawn. A page is drawn twice: once for its top (`page`: a group draws the rows placed there, shared/settings-placement.ts),
 * once inside its fold « Plus de réglages » (`more`: a group draws the rest, under its title); in both, a subpage is the row that opens it. What a page
 * draws whole in one of its two parts (`Place`, the catalogue of « Fonctions en option ») is `whole`: every row of it, a subpage by its row still. One
 * of its subpages is drawn alone (`sub:<id>`, shared/settings-subpages.ts): nothing of the page but what that subpage holds. `all` draws every row where
 * it is, the rows of the subpages included: a search, the view of the modified settings, and a pane drawn alone (a test).
 */
export type FoldPass = 'all' | 'page' | 'more' | 'whole' | `sub:${SettingsSubpage}`
export const FoldPassContext = createContext<FoldPass>('all')

/** The subpage a pass draws alone, if any. */
export const subpageOfPass = (pass: FoldPass): SettingsSubpage | null => (pass.startsWith('sub:') ? (pass.slice(4) as SettingsSubpage) : null)

/**
 * The subpage a row is drawn in, if any: a result of a search, or a row of « Réglages modifiés », says it in its path and opens it to land on the row.
 * `alone`: the subpage is the one the window shows (not a part of a search). `open`: what the row that opens a subpage does (the window goes to its
 * address); `close`: the way back to its page. Nothing outside the window (a test).
 */
export interface SubpageNavigation {
  current: SettingsSubpage | null
  alone: boolean
  open: (id: SettingsSubpage) => void
  close: () => void
}
export const SubpageContext = createContext<SubpageNavigation>({ current: null, alone: false, open: () => undefined, close: () => undefined })

/**
 * Whether the rows drawn again outside their category (`mirror`: « Pour commencer », « Fonctions en option ») are drawn. Not in the results of a search
 * nor in « Réglages modifiés », which show each setting once, where it lives.
 */
export const MirrorsContext = createContext<boolean>(true)

/** The category a row is drawn in: the results of a search draw every category, and a row says where it lives ("Ouvrir dans Vie privée › Bloqueur"). */
export const PaneContext = createContext<SettingsPane | null>(null)

/** The group a row is drawn in: its title (the path of a result) and the id of its section (what a result with no key of its own scrolls to). */
export const GroupContext = createContext<{ title?: string; id?: string } | null>(null)

/** A place a result leads to: a category, the subpage of it the row lives on (if any), and a row (by its key) or a group (by the id of its section) in it. */
export interface JumpTarget {
  pane: SettingsPane
  sub?: SettingsSubpage
  key?: string
  group?: string
}

/**
 * Whether the window is showing search results, and how a result opens its row where it lives: the category opens, opens « Plus de réglages » if
 * the row waits there, scrolls to the row and flashes it.
 */
export const SearchingContext = createContext<{ searching: boolean; jump: (target: JumpTarget) => void }>({ searching: false, jump: () => undefined })

/** What « Fonctions en option » shows: every line, the lines of the features that are on, or those that are off. */
export type FeatureFilter = 'all' | 'on' | 'off'

/**
 * The filter of « Fonctions en option », held by the window (SettingsWindow.tsx), which puts it back to « Toutes » whenever it leads somewhere: a result
 * of a search, an address, another page. Without it (the page drawn alone), the page keeps its own.
 */
export const FeatureFilterContext = createContext<{ filter: FeatureFilter; choose: (filter: FeatureFilter) => void } | null>(null)
