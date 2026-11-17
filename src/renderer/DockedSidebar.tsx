// The docked sidebar (« barre collée », shared/window-sidebar.ts): the sidebar of one window folded into a column of site icons, at the side of the
// sidebar. The pinned tabs of the space, or its favourites when it has none (shared/docked-sidebar.ts); a click shows the site. The site on screen is a white tile
// ringed with the accent of the space, with a small bar on the edge that faces the page; the unread count and the dot are those of the rows of the full
// sidebar. The bubble of a tile says its name, its unread count and its shortcut. At the foot, « Nouvel onglet » and « Déplier ». Every tile is a button
// with a name: the keyboard goes through them, the focus shows.

import type { MouseEvent } from 'react'
import type { UiSnapshot } from '@shared/ipc'
import type { Space } from '@shared/model'
import { dockColumn, type DockTile } from '@shared/docked-sidebar'
import { acceleratorKeys, effectiveAccelerator } from '@shared/keybindings'
import { platformOf } from '@shared/platform'
import { TOOLTIP_TEXT_MAX } from '@shared/tooltip'
import { t, tp } from '@shared/i18n'
import { api } from './api'
import { rectOf } from './anchor'
import { TabMark } from './TabPicture'
import { PlusGlyph } from './sidebar-icons'
import { UnfoldSidebarIcon } from './Toolbar'
import { tipProps } from './tooltip'
import './docked-sidebar.css'

/** The name of a tile, with what its page says: « WhatsApp · 12 non lus », « Slack · du nouveau », or the name alone. */
export function tileLabel(tile: Pick<DockTile, 'title' | 'url' | 'unread' | 'dot'>): string {
  const name = tile.title.trim() || tile.url
  if (tile.unread !== undefined) return tp('docked.non-lus', tile.unread, { name })
  return tile.dot ? t('docked.du-nouveau', { name }) : name
}

/** The bubble takes a short label only (shared/tooltip.ts): a long name is cut, the button keeps it whole. */
const bubbleText = (label: string): string => (label.length > TOOLTIP_TEXT_MAX ? `${label.slice(0, TOOLTIP_TEXT_MAX - 1)}…` : label)

function Tile({ tile, keys, side, onOpen, onMenu }: { tile: DockTile; keys: string[]; side: 'left' | undefined; onOpen: () => void; onMenu: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const label = tileLabel(tile)
  return (
    <button
      className={`dock-tile ${tile.active ? 'active' : ''}`}
      data-tile={`${tile.kind}:${tile.id}`}
      aria-label={label}
      aria-current={tile.active ? 'page' : undefined}
      {...tipProps(bubbleText(label), keys.length > 0 ? keys : undefined, undefined, side)}
      onClick={onOpen}
      onContextMenu={onMenu}
    >
      <TabMark tab={tile} />
      {tile.unread !== undefined && (
        <span className="dock-badge" aria-hidden="true">
          {tile.unread}
        </span>
      )}
      {tile.unread === undefined && tile.dot && <span className="dock-dot" aria-hidden="true" />}
    </button>
  )
}

/** `right`: the column is at the right of the window (its bubbles open to the left, on the page; its marks face the page). */
export function DockedSidebar({ snapshot, space, right }: { snapshot: UiSnapshot; space: Space; right: boolean }) {
  const { state, runtime } = snapshot
  const act = api()
  const column = dockColumn(state, space.id, runtime)
  const platform = platformOf(snapshot.platform)
  const keysOf = (accelerator: string | undefined): string[] => acceleratorKeys(accelerator, platform)
  const side = right ? 'left' : undefined
  const open = (tile: DockTile) => void act.dispatch(tile.kind === 'favorite' ? { type: 'favorite/open', id: tile.id, spaceId: space.id } : { type: 'tab/select', id: tile.id })
  // A right click on a tile is the menu of that favourite or tab, as on the full sidebar; its sheets (Renommer…) hang from the tile.
  const menuOf = (tile: DockTile) => (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    act.showMenu(tile.kind === 'favorite' ? { kind: 'favorite', id: tile.id, anchor: rectOf(event.currentTarget) } : { kind: 'tab', id: tile.id, anchor: rectOf(event.currentTarget) })
  }
  const tile = (item: DockTile) => <Tile key={`${item.kind}:${item.id}`} tile={item} keys={keysOf(item.shortcut)} side={side} onOpen={() => open(item)} onMenu={menuOf(item)} />
  return (
    <nav
      className={`sidebar docked-sidebar ${right ? 'at-right' : 'at-left'}`}
      aria-label={t('docked.colonne', { name: space.name })}
      // A right click on the column itself is the one on the full sidebar: « Barre de cette fenêtre » (« Déplier la barre »), then the menu of the space.
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        e.preventDefault()
        act.showMenu({ kind: 'space', id: space.id, sidebar: true })
      }}
    >
      <div className="dock-tiles">
        {column.favorites.map(tile)}
        {column.pinned.map(tile)}
      </div>
      <div className="dock-tools">
        <button className="dock-tool" aria-label={t('sidebar.nouvel-onglet')} {...tipProps(t('sidebar.nouvel-onglet'), keysOf(effectiveAccelerator('newTab', state.settings.keyBindings, platform)), undefined, side)} onClick={() => act.openOverlay({ panel: 'commandbar', mode: 'new', initial: '' })}>
          <PlusGlyph size={16} />
        </button>
        <button className="dock-tool dock-unfold" aria-label={t('docked.deplier-la-barre')} {...tipProps(t('docked.deplier-la-barre'), keysOf(effectiveAccelerator('dockSidebar', state.settings.keyBindings, platform)), undefined, side)} onClick={() => act.windowSidebar({ op: 'dock', docked: false })}>
          <UnfoldSidebarIcon />
        </button>
      </div>
      {/* The edge that faces the page: a double-click gives the full sidebar back, as one on the full sidebar's edge docks it. */}
      <div className="dock-edge" aria-hidden="true" onDoubleClick={() => act.windowSidebar({ op: 'dock', docked: false })} />
    </nav>
  )
}
