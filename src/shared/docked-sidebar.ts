// What the docked sidebar (« barre collée », window-sidebar.ts) shows: a column of site icons for the space on screen: its pinned tabs in the order the
// full sidebar draws them (the tabs of the folders included, the folders themselves are not drawn). The favourites of the top of the sidebar are left
// out (decided on 9 Nov 2026: the column is the sites one works in), unless the space has no pinned tab: they are then the column, rather than nothing.
// The tile of the site on screen is marked; a tile carries the unread count its page gives in its title, or the dot of an icon that changed while it
// was in the background (with the marks of `tabStateBadges`, as the rows of the full sidebar), and the shortcut ⌘n of its row.
// The Today tabs are not in it: the column is the sites one keeps. Pure: the interface draws it (renderer/DockedSidebar.tsx).

import { favoritesOfSpace } from './favorite-scope'
import { effectiveAccelerator } from './keybindings'
import { tabName, type RuntimeState, type SidebarState, type TabItem } from './model'
import { sidebarOrder } from './sidebar-selectors'
import { sidebarRows } from './sidebar-items'

export interface DockTile {
  kind: 'favorite' | 'tab'
  /** The favourite's id, or the pinned tab's. */
  id: string
  /** The name the tooltip and the button give: the favourite's title, the tab's name (its own when the user gave one). */
  title: string
  url: string
  faviconUrl?: string
  /** The picture or emoji the user gave a pinned tab (TabPicture.tsx draws it as the row does). */
  icon?: string
  image?: string
  /** The site of this tile is the one on screen. */
  active: boolean
  /** The unread count the page shows in its title; absent when it shows none. */
  unread?: number
  /** The icon of the page changed while it was in the background (only with the marks of `tabStateBadges`, as on the rows). */
  dot: boolean
  /** The keys of ⌘n that select it (the accelerator, as the user set it): a pinned tab among the nine first rows, else absent. */
  shortcut?: string
}

export interface DockColumn {
  favorites: DockTile[]
  pinned: DockTile[]
}

/** The column of the space `spaceId` (the space on screen: the shortcuts are those of its rows). */
export function dockColumn(state: SidebarState, spaceId: string, runtime: Pick<RuntimeState, 'tabs'>): DockColumn {
  const activeId = state.activeTabBySpace[spaceId] ?? null
  const active = activeId === null ? undefined : state.tabs.find((t) => t.id === activeId && t.spaceId === spaceId)
  const badges = state.settings.tabStateBadges
  const marks = (tab: TabItem | undefined): Pick<DockTile, 'unread' | 'dot'> => {
    const info = tab ? runtime.tabs[tab.id] : undefined
    return { ...(info?.unread !== undefined ? { unread: info.unread } : {}), dot: badges && info?.changedIcon === true }
  }
  const favorites = favoritesOfSpace(state, spaceId).map((favorite): DockTile => {
    // The page a favourite opened is a tab of the space that carries its id (favorite-scope.ts): its marks are the tile's.
    const page = state.tabs.find((t) => t.spaceId === spaceId && t.favoriteId === favorite.id)
    return {
      kind: 'favorite',
      id: favorite.id,
      title: favorite.title,
      url: favorite.url,
      ...(favorite.faviconUrl ? { faviconUrl: favorite.faviconUrl } : {}),
      active: active?.favoriteId === favorite.id,
      ...marks(page)
    }
  })
  // ⌘n goes to the nth row of the space on screen; the commands `item1` … `item9` exist, a row beyond the ninth has none.
  const rows = spaceId === state.activeSpaceId ? sidebarRows(state, spaceId).map((t) => t.id) : []
  const pinned = sidebarOrder(state, spaceId)
    .filter((tab) => tab.pinned)
    .map((tab): DockTile => {
      const row = rows.indexOf(tab.id)
      const shortcut = row === -1 ? undefined : effectiveAccelerator(`item${row + 1}`, state.settings.keyBindings)
      return {
        kind: 'tab',
        id: tab.id,
        title: tabName(tab),
        url: tab.url,
        ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
        ...(tab.icon ? { icon: tab.icon } : {}),
        ...(tab.image ? { image: tab.image } : {}),
        active: tab.id === activeId,
        ...marks(tab),
        ...(shortcut ? { shortcut } : {})
      }
    })
  // The favourites only stand in for pinned tabs a space does not have (see above).
  return { favorites: pinned.length > 0 ? [] : favorites, pinned }
}
