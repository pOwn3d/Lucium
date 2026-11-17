// The tiles of the work views, after the favourites in their grid (setting `workViewsEnabled`): each one draws the layout of its split view in small,
// with the icon of each site, and opens it with a click (a second click shows it again as it was left). A right click, the Menu key or ⇧F10 open its
// menu (main/shell/context-menu-work-view.ts). Rules: shared/work-views.ts.

import type { KeyboardEvent } from 'react'
import type { Space, SidebarState, WorkView } from '@shared/model'
import { workViewLabel, workViewShown, workViewThumbnail } from '@shared/work-views'
import { t } from '@shared/i18n'
import { api } from './api'
import { rectOf } from './anchor'
import { Favicon } from './SidebarRows'
import './work-views.css'

/** The keys that open the menu of the tile that has the focus, as a right click does: the Menu key, and Shift+F10. */
const opensMenu = (event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean => event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)

/** The panes of a view drawn in small, in the places and the proportions they keep. */
function Thumbnail({ view }: { view: WorkView }) {
  const rects = workViewThumbnail(view)
  return (
    <span className="work-view-mini" aria-hidden="true">
      {view.panes.map((pane, at) => {
        const rect = rects[at]
        if (!rect) return null
        return (
          <span key={at} className="work-view-pane" style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }}>
            <Favicon tab={{ faviconUrl: pane.faviconUrl, url: pane.url, title: pane.title }} />
          </span>
        )
      })}
    </span>
  )
}

/** The tiles of the views of the space's profile; nothing at all while there is none (the grid of the favourites draws them after its own). */
export function WorkViewTiles({ state, space, views }: { state: SidebarState; space: Space; views: readonly WorkView[] }) {
  const act = api()
  const menu = (view: WorkView, element: Element) => act.showMenu({ kind: 'workview', id: view.id, anchor: rectOf(element) })
  return (
    <>
      {views.map((view) => {
        const lit = workViewShown(state, view.id, space.id)
        return (
          <button
            key={view.id}
            type="button"
            className={`favorite work-view-tile ${lit ? 'active' : ''}`}
            // The name a screen reader gives: the view, what it is and how many sites it opens; « current » while it is on screen.
            aria-label={workViewLabel(view)}
            aria-description={t('work-view.aide-tuile')}
            aria-current={lit ? 'true' : undefined}
            data-work-view={view.id}
            onClick={() => void act.dispatch({ type: 'view/open', id: view.id, spaceId: space.id })}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              menu(view, e.currentTarget)
            }}
            onKeyDown={(e) => {
              if (!opensMenu(e)) return
              e.preventDefault()
              menu(view, e.currentTarget)
            }}
          >
            <Thumbnail view={view} />
            <span className="favorite-name" aria-hidden="true">
              {`${view.emoji} ${view.name}`}
            </span>
          </button>
        )
      })}
    </>
  )
}
