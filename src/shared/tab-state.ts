// What a tab row says of its page: loading, asleep, frozen, playing sound, failed to load. The states are read from the runtime flags the
// shell already keeps for every tab (`loading`, `awake`, `audible`, `muted`, `frozen`, `failed`), and drawn by CSS from classes on the row.
//
// The switch (`tabStateBadges`, a feature of the registry) costs nothing when it is off: `tabStates(false, …)` answers the same empty list for
// every tab without looking at it, so no class is put on a row, no badge is rendered, and the hover card carries no legend.

import type { TabRuntime } from './model'
import { t } from './i18n'

export type TabStateId = 'loading' | 'asleep' | 'frozen' | 'sound' | 'error'

/** The states in the order the legend lists them. */
export const TAB_STATE_ORDER: readonly TabStateId[] = ['loading', 'asleep', 'frozen', 'sound', 'error']

/** What the states are read from: the part of a tab's runtime entry that says what its page is doing. */
export type TabStateInput = Pick<TabRuntime, 'loading' | 'awake' | 'audible' | 'muted'> & Partial<Pick<TabRuntime, 'frozen' | 'failed'>>

const NONE: readonly TabStateId[] = Object.freeze([])

/**
 * The states a tab is in, in legend order. A frozen page is not awake either, but it is not asleep: it keeps its memory and its document, so it
 * shows as frozen only. With the switch off, or a tab the shell knows nothing of, the list is empty.
 */
export function tabStates(enabled: boolean, info: TabStateInput | undefined): readonly TabStateId[] {
  if (!enabled || !info) return NONE
  const states: TabStateId[] = []
  if (info.loading) states.push('loading')
  if (!info.awake && info.frozen !== true) states.push('asleep')
  if (info.frozen === true) states.push('frozen')
  if (info.audible || info.muted) states.push('sound')
  if (info.failed === true) states.push('error')
  return states
}

/** The classes a row wears for its states (`st-loading`, `st-asleep`…): the CSS of the badges hangs on these and on nothing else. */
export const tabStateClasses = (states: readonly TabStateId[]): string[] => states.map((state) => `st-${state}`)

/** The words of a state, for the legend of the hover card and for the screen readers. */
export function tabStateLabel(state: TabStateId): string {
  switch (state) {
    case 'loading':
      return t('tab-state.chargement')
    case 'asleep':
      return t('tab-state.veille')
    case 'frozen':
      return t('tab-state.gele')
    case 'sound':
      return t('tab-state.son')
    case 'error':
      return t('tab-state.erreur')
  }
}

/** The legend line of the hover card: the five states, in order. Empty with the switch off. */
export const tabStateLegend = (enabled: boolean): string[] => (enabled ? TAB_STATE_ORDER.map(tabStateLabel) : [])

/**
 * The extra lines of the card of a tab in one of these states (its status line already says "En veille" or "Gelé"). Failed: the load did not come to a
 * page. Asleep: the memory is released (the card used to say "Mémoire —"), unless the card has a line of resources, which says it. Frozen: the page is
 * kept, stopped. Nothing when the switch is off (no states), so the card is the one it was.
 */
export function tabStateNotes(states: readonly TabStateId[], resourcesShown = false): string[] {
  const notes: string[] = []
  if (states.includes('error')) notes.push(t('tab-state.chargement-impossible'))
  if (states.includes('asleep') && !resourcesShown) notes.push(t('tab-state.memoire-liberee'))
  if (states.includes('frozen')) notes.push(t('tab-state.page-gardee-en-memoire'))
  return notes
}

/**
 * Whether the tab's last load failed, after an update from its page: a load that starts clears it, a load that ends sets it when one of our error pages
 * is on screen (`showsError`), and an update that says nothing of loading leaves it as it was. The shell calls this for every update of a page.
 */
export function failedAfter(was: boolean, loading: boolean | undefined, showsError: boolean): boolean {
  if (loading === true) return false
  if (loading === false) return showsError
  return was
}
