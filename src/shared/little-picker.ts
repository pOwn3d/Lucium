// The space picker of a mini window (the chevron of the "open in" pill).

import { foldMarks } from './fold'

/** The popover: 244 x 230, 4 px from the top and right edges of the window, over a transparent layer that covers the window. */
export const LITTLE_PICKER = { width: 244, height: 230, top: 4, right: 4, searchHeight: 45, rowHeight: 46 } as const

const OPEN_IN = 'open-in:'

/** The command that opens the page in a given space. */
export const openInCommand = (spaceId: string): `open-in:${string}` => `${OPEN_IN}${spaceId}`

/** The space a command names, or null when it is not an `open-in:` command. */
export function openInTarget(command: string): string | null {
  return command.startsWith(OPEN_IN) && command.length > OPEN_IN.length ? command.slice(OPEN_IN.length) : null
}

const GOTO_TAB = 'goto-tab:'

/** The command of a row "Onglets ouverts" of the bar: the main window goes to that tab. */
export const gotoTabCommand = (tabId: string): `goto-tab:${string}` => `${GOTO_TAB}${tabId}`

/** The tab a command names, or null when it is not a `goto-tab:` command. */
export function gotoTabTarget(command: string): string | null {
  return command.startsWith(GOTO_TAB) && command.length > GOTO_TAB.length ? command.slice(GOTO_TAB.length) : null
}

const fold = (text: string): string => foldMarks(text).trim()

/** The spaces whose name contains what was typed, ignoring case and accents; all of them for an empty query. */
export function filterSpaces<T extends { name: string }>(spaces: readonly T[], query: string): T[] {
  const needle = fold(query)
  return needle === '' ? [...spaces] : spaces.filter((space) => fold(space.name).includes(needle))
}

/** Moves the highlighted row by `delta`, staying inside the list; 0 when the list is empty. */
export function moveHighlight(current: number, delta: number, count: number): number {
  return count === 0 ? 0 : Math.min(count - 1, Math.max(0, current + delta))
}
