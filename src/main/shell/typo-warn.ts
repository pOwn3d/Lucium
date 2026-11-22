// A typed address that is one keystroke from a site of the person (shared/typo-guard.ts) is announced to the lookalike gate (engine/typo-gate.ts), which
// makes the first load of that host stop on the warning page. The sites are those the person's own data already holds on this machine: the history of
// the profile, the favourites, the bookmarks and the pinned tabs. Nothing is read from elsewhere and nothing is sent.

import type { Settings, SidebarState } from '@shared/model'
import { lookalikeOf } from '@shared/typo-guard'
import type { TypoWarnings } from '@shared/typo-warnings'

const hostOfAddress = (address: string): string | null => (URL.canParse(address) ? new URL(address).host : null)

/** The hosts the person's own data holds: history first, then favourites, bookmarks and pinned tabs (the address a pinned tab returns to too). */
export function knownHostsOf(state: Pick<SidebarState, 'favorites' | 'bookmarks' | 'tabs'>, historyHosts: readonly string[]): string[] {
  const addresses = [
    ...state.favorites.map((favorite) => favorite.url),
    ...state.bookmarks.map((bookmark) => bookmark.url),
    ...state.tabs.filter((tab) => tab.pinned).flatMap((tab) => [tab.url, tab.anchorUrl ?? ''])
  ]
  return [...historyHosts, ...addresses.map(hostOfAddress).filter((host): host is string => host !== null)]
}

/** Announces a typed address to the gate when it looks like a known site. `historyHosts` is read only when the guard is on and the address is a web one. */
export function expectLookalikeWarning(
  settings: Pick<Settings, 'typoGuard'>,
  state: Pick<SidebarState, 'favorites' | 'bookmarks' | 'tabs'>,
  historyHosts: () => string[],
  address: string,
  gate: Pick<TypoWarnings, 'expect'>
): void {
  if (!settings.typoGuard) return
  if (!/^https?:\/\//i.test(address) || !URL.canParse(address)) return
  const host = new URL(address).hostname
  const similar = lookalikeOf(host, knownHostsOf(state, historyHosts()))
  if (similar !== null) gate.expect(host, similar)
}
