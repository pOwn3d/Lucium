// The tabs whose site no longer answers: after « Actualiser tous les onglets » or the load of every tab at launch, the ones that failed in a way that
// says the site is gone (no such address, connection refused or reset, timed out, unreachable, a page removed) are listed in a sheet, where each
// can be shown, kept or closed (renderer/DeadTabsSheet.tsx). Pinned tabs are listed too, in a group of their own: a test server that went away is
// often a pinned tab, and the user wants it gone as well. The shell collects how each load ended (main/shell/browser-sleep.ts); this decides.

import { tabName, type SidebarState, type TabItem } from './model'
import { compactAddress } from './compact'
import { spaceGlyph } from './space-icon'
import { t } from './i18n'

/** How the last load of a page ended badly, as the engine knows it (main/engine/error-pages.ts). Null for a page that loaded. */
export type LoadFailure = { kind: 'network'; name: string } | { kind: 'certificate'; name: string } | { kind: 'status'; status: number }

/** Why a tab is offered: the words of each are `deadReasonLabel`'s. */
export type DeadReason = 'not-found' | 'refused' | 'reset' | 'timed-out' | 'unreachable' | 'missing' | 'removed'

/** The network errors that say the site is gone, not that this Mac is offline (ERR_INTERNET_DISCONNECTED, ERR_NAME_RESOLUTION_FAILED and the proxy errors are not here). */
const NETWORK_REASONS: Readonly<Record<string, DeadReason>> = {
  ERR_NAME_NOT_RESOLVED: 'not-found',
  ERR_CONNECTION_REFUSED: 'refused',
  ERR_CONNECTION_RESET: 'reset',
  ERR_CONNECTION_CLOSED: 'reset',
  ERR_CONNECTION_TIMED_OUT: 'timed-out',
  ERR_TIMED_OUT: 'timed-out',
  ERR_ADDRESS_UNREACHABLE: 'unreachable'
}

/**
 * Why this failure makes a dead tab, or null when it does not. A certificate that is refused is not a dead site (a test server often has one of its
 * own), and a status other than 404 or 410 is the server having trouble, not the page gone.
 */
export function deadReasonOf(failure: LoadFailure | null | undefined): DeadReason | null {
  if (!failure) return null
  if (failure.kind === 'network') return NETWORK_REASONS[failure.name] ?? null
  if (failure.kind === 'status') return failure.status === 404 ? 'missing' : failure.status === 410 ? 'removed' : null
  return null
}

/** The reason in plain words, for the row of the sheet. */
export function deadReasonLabel(reason: DeadReason): string {
  switch (reason) {
    case 'not-found':
      return t('dead-tabs.adresse-introuvable')
    case 'refused':
      return t('dead-tabs.connexion-refusee')
    case 'reset':
      return t('dead-tabs.connexion-reinitialisee')
    case 'timed-out':
      return t('dead-tabs.delai-depasse')
    case 'unreachable':
      return t('dead-tabs.adresse-injoignable')
    case 'missing':
      return t('dead-tabs.page-introuvable-404')
    case 'removed':
      return t('dead-tabs.page-supprimee-410')
  }
}

/** How long a tab the user kept is left out of the offer, for the address it had: thirty days, then it may be offered again if it is still dead. */
export const DEAD_KEPT_MS = 30 * 24 * 60 * 60 * 1000

/** Whether the user kept this tab, for the address it shows, less than `DEAD_KEPT_MS` ago. */
export function isKeptDead(tab: Pick<TabItem, 'url' | 'deadKept'>, now: number): boolean {
  const kept = tab.deadKept
  return kept !== undefined && kept.url === tab.url && now - kept.at < DEAD_KEPT_MS && now >= kept.at
}

/** A row of the sheet: the tab, and why it is offered. */
export interface DeadTabEntry {
  id: string
  reason: DeadReason
}

/** What the choice needs besides the loads: whether the network is up, the time, and the tabs nobody may see (a locked space). */
export interface DeadTabsFacts {
  online: boolean
  now: number
  hidden?: (tab: TabItem) => boolean
}

/**
 * The tabs to offer, in the order of the state. `outcomes` holds the tabs whose load was looked at, with how it ended (null: it loaded). Nothing is
 * offered while the network is down, nor when no site answered at all (every load failed on the network side: the trouble is more likely here than at
 * every site). A pinned tab is offered (the sheet puts it in a group of its own, and takes it out of the pinned ones to the archive); the page of a
 * favourite is never (removing a favourite has no archive and no « Annuler »), nor a tab the user kept for this address, nor one of a locked space.
 * A certificate error is never a dead site.
 */
export function deadTabsToOffer(outcomes: ReadonlyMap<string, LoadFailure | null>, tabs: readonly TabItem[], facts: DeadTabsFacts): DeadTabEntry[] {
  if (!facts.online || outcomes.size === 0) return []
  // A page that loaded, a status or a certificate refused: a server answered, so the network works.
  const answered = [...outcomes.values()].some((failure) => failure === null || failure.kind !== 'network')
  if (!answered) return []
  const offered: DeadTabEntry[] = []
  for (const tab of tabs) {
    if (!outcomes.has(tab.id)) continue
    const reason = deadReasonOf(outcomes.get(tab.id))
    if (reason === null || tab.favoriteId !== undefined || isKeptDead(tab, facts.now) || facts.hidden?.(tab) === true) continue
    offered.push({ id: tab.id, reason })
  }
  return offered
}

/**
 * The entries still worth showing when the sheet opens or draws again: the tab is still open, is not the page of a favourite, and was not kept since
 * for the address it shows (`now` given: the sheet, which adds the tabs a run finds while it is open, must not bring back one kept a moment ago).
 */
export function stillOffered(entries: readonly DeadTabEntry[], tabs: readonly TabItem[], now?: number): DeadTabEntry[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]))
  return entries.filter((entry) => {
    const tab = byId.get(entry.id)
    return tab !== undefined && tab.favoriteId === undefined && (now === undefined || !isKeptDead(tab, now))
  })
}

/** The entries of the sheet as a run goes on: those it opened with, in their order, then the ones found since, each tab once. */
export function withLaterEntries(first: readonly DeadTabEntry[], later: readonly DeadTabEntry[] | undefined): DeadTabEntry[] {
  const merged = [...first]
  const seen = new Set(first.map((entry) => entry.id))
  for (const entry of later ?? []) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    merged.push(entry)
  }
  return merged
}

/** What a row of the sheet shows of a tab: its name, its address (no scheme), why it is offered, and its space when the window has several. */
export interface DeadTabRow {
  tab: TabItem
  name: string
  address: string
  reason: string
  space?: string
}

/** The groups of the sheet: the pinned tabs, then the tabs of the day, as the sidebar lists them. */
export type DeadTabGroupKind = 'pinned' | 'today'

export interface DeadTabGroup {
  kind: DeadTabGroupKind
  rows: DeadTabRow[]
}

/** The rows of the sheet in their groups, the pinned ones first; a group with no row is left out. Each group keeps the order of the rows. */
export function deadTabGroups(rows: readonly DeadTabRow[]): DeadTabGroup[] {
  const groups: DeadTabGroup[] = [
    { kind: 'pinned', rows: rows.filter((row) => row.tab.pinned) },
    { kind: 'today', rows: rows.filter((row) => !row.tab.pinned) }
  ]
  return groups.filter((group) => group.rows.length > 0)
}

/** The rows of the sheet, in the order of the entries: only the tabs still offered (`stillOffered`), each with what its row says. */
export function deadTabRows(entries: readonly DeadTabEntry[], state: Pick<SidebarState, 'tabs' | 'spaces'>, now?: number): DeadTabRow[] {
  const byId = new Map(state.tabs.map((tab) => [tab.id, tab]))
  const several = state.spaces.length > 1
  return stillOffered(entries, state.tabs, now).map((entry) => {
    const tab = byId.get(entry.id)!
    const space = several ? state.spaces.find((sp) => sp.id === tab.spaceId) : undefined
    return { tab, name: tabName(tab), address: compactAddress(tab.url, true), reason: deadReasonLabel(entry.reason), ...(space ? { space: `${spaceGlyph(space)} ${space.name}` } : {}) }
  })
}
