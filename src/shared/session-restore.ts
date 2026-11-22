// « Restaurer » after an abnormal exit (a crash, a kill, a power cut: the marker of main/shell/clean-exit.ts was still there). The tabs themselves are always kept
// (the state file), so what the person chooses is which of them come back: the ones they untick go to the archive, which « Annuler » brings back, and the
// page that made Lucium crash is not loaded again by the next start. Pinned tabs stay (they are the person's own place) and so do the tabs of a private session, which
// no file keeps. Pure: the interface draws the rows (renderer/RestoreSheet.tsx), the main process decides whether to offer them (`shouldOfferRestore`).

import { tabName, type SidebarState, type TabItem } from './model'
import { compactAddress } from './compact'
import { spaceGlyph } from './space-icon'

/** At most this many rows: a window with more tabs lists the first of them and says how many it left out (they stay open). */
export const RESTORE_ROWS_MAX = 100

/** What a row shows of a tab: its name, its address (no scheme) and its space when the window has several. */
export interface RestoreRow {
  tab: TabItem
  name: string
  address: string
  space?: string
}

export interface RestoreRows {
  rows: RestoreRow[]
  /** The tabs offered that did not fit in the list: they stay as they are. */
  hidden: number
}

/** Whether a tab is the person's to choose over: a tab of the day, neither pinned nor private. */
const offerable = (tab: TabItem): boolean => !tab.pinned && tab.private !== true

/** The rows of the sheet, in the order of the sidebar. `state` is the one the interface is given, which hides the tabs of a locked space. */
export function restoreRows(state: Pick<SidebarState, 'tabs' | 'spaces'>): RestoreRows {
  const several = state.spaces.length > 1
  const all = state.tabs.filter(offerable)
  const rows = all.slice(0, RESTORE_ROWS_MAX).map((tab): RestoreRow => {
    const space = several ? state.spaces.find((candidate) => candidate.id === tab.spaceId) : undefined
    return { tab, name: tabName(tab), address: compactAddress(tab.url, true), ...(space ? { space: `${spaceGlyph(space)} ${space.name}` } : {}) }
  })
  return { rows, hidden: all.length - rows.length }
}

/** What the main process knows when a launch ends: used by `shouldOfferRestore`. */
export interface RestoreFacts {
  /** The last run did not end by a clean exit (the marker was there). */
  abnormal: boolean
  /** A new profile has nothing to restore. */
  newProfile: boolean
  /** The application is locked: a panel over the lock screen would show tabs the person has not unlocked. */
  appLocked: boolean
  /** How many tabs of the day the person could choose over, as the interface will list them (the tabs of a locked space left out). */
  offerable: number
}

/** Whether the sheet opens by itself: after an abnormal exit, over a profile that was used, an unlocked application, and more than one tab to choose among. */
export const shouldOfferRestore = (facts: RestoreFacts): boolean => facts.abnormal && !facts.newProfile && !facts.appLocked && facts.offerable >= 2

/** How many tabs of the day a state offers (what the interface will list, and the count `shouldOfferRestore` asks for). */
export const offerableTabCount = (state: Pick<SidebarState, 'tabs'>): number => state.tabs.filter(offerable).length
