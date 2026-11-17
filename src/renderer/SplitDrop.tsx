// The veil over the page while a tab is dragged from the sidebar: the page shrinks beside an empty box on the side
// the pointer is going to, and a blue ring surrounds the page when the pointer is in the middle. The zones and the cotes are in @shared/split-drop.
// The real page is put away by the shell while the veil is up; this draws a picture of it. Over a split view of two or three panes it draws a
// picture of each pane, and the box opens in the very cell the tab would take, outlined like the focused pane it will be: at a side of the split
// view, or in a corner, the pictures moving to where the grid will have them. Over a split view of four it only says that it takes no more.

import { useRef, useState, type CSSProperties, type DragEvent } from 'react'
import { PAGE_RADIUS } from '@shared/split'
import { TOOLBAR_BAR_HEIGHT } from '@shared/ipc'
import { isJoinZone, type JoinZone } from '@shared/split-grid'
import { DROP_VEIL, NO_DROP_STATE, closedBox, dropLayout, dropPage, isBoxSide, isSplitDropZone, joinLayout, nextZone, type BoxSide, type DropHost, type DropState } from '@shared/split-drop'
import { t } from '@shared/i18n'
import { api } from './api'
import { DRAG_TYPE } from './sidebar-dnd'
import './split-drop.css'

interface Props {
  size: { width: number; height: number }
  /** A picture of the page (a `data:` URL), or null: the card is then plain. */
  snapshot: string | null
  /** The sidebar is at the right: the part of the page next to it is the one where nothing is armed. */
  sidebarRight?: boolean
  /** The page on screen is a split view: the tab would join it, or it is full. */
  split?: DropHost | undefined
}

const px = (rect: { x: number; y: number; width: number; height: number }): CSSProperties => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })

export function SplitDrop({ size, snapshot, sidebarRight = false, split }: Props) {
  const [drop, setDrop] = useState<DropState>(NO_DROP_STATE)
  // The side (or the corner) the box last opened on: it closes back toward it. A stack of panes opens its box at the top or the bottom.
  const [side, setSide] = useState<JoinZone>(split?.grid ? 'bottom-right' : split?.orientation === 'vertical' ? 'bottom' : 'right')
  const root = useRef<HTMLDivElement>(null)
  const latest = useRef<DropState>(NO_DROP_STATE)
  const full = split?.full === true

  /** Only a drag that started in the sidebar (a tab row) is of interest; anything else is left to the surface guard. */
  const ours = (event: DragEvent) => Array.from(event.dataTransfer.types).includes(DRAG_TYPE)

  const move = (event: DragEvent<HTMLDivElement>) => {
    // A full split view takes no drop: the event is not accepted, so the pointer says the drop is refused, and nothing is armed.
    if (!ours(event) || full) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const box = root.current?.getBoundingClientRect()
    if (!box) return
    const next = nextZone(latest.current, { x: event.clientX - box.left, y: event.clientY - box.top }, { width: box.width, height: box.height }, sidebarRight, split)
    const before = latest.current
    if (next.zone === before.zone && next.horizontal === before.horizontal && next.vertical === before.vertical) return
    latest.current = next
    setDrop(next)
    if (isJoinZone(next.zone)) setSide(next.zone)
  }

  const leave = (event: DragEvent<HTMLDivElement>) => {
    // Moving onto a child is not leaving.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    latest.current = NO_DROP_STATE
    setDrop(NO_DROP_STATE)
  }

  const land = (event: DragEvent<HTMLDivElement>) => {
    if (!ours(event) || full) return
    event.preventDefault()
    if (isSplitDropZone(latest.current.zone)) api().splitDrop(latest.current.zone)
  }

  const handlers = {
    ref: root,
    style: { '--sd-ms': `${DROP_VEIL.moveMs}ms`, '--sd-ease': DROP_VEIL.easing } as CSSProperties,
    onDragEnter: move,
    onDragOver: move,
    onDragLeave: leave,
    onDrop: land,
    // A veil that stayed up (a drag that never reported its end) is put away by a click.
    onMouseDown: () => api().closeOverlay()
  }

  if (split) {
    if (full)
      return (
        <div {...handlers} className="split-drop full">
          <div className="sd-full" role="status">{t('split-drop.quatre-volets-au-plus')}</div>
        </div>
      )
    // The panes where the split view has them (each picture keeps that size), and where they go when a box opens at an end.
    const rest = joinLayout('none', size, split, TOOLBAR_BAR_HEIGHT)
    const shown = joinLayout(drop.zone, size, split, TOOLBAR_BAR_HEIGHT)
    const box = shown.box ?? closedBox(side, size)
    return (
      <div {...handlers} className="split-drop">
        {/* The cell the tab would take, outlined in the blue of the focused pane: the dropped tab is the one shown. */}
        <div className={`sd-box cell ${shown.box ? 'open' : ''}`} style={px(box)} />
        {shown.panes.map((pane, i) => {
          const picture = split.snapshots[i]
          const at = rest.panes[i] ?? pane
          return (
            <div key={i} className="sd-page" style={{ ...px(pane), borderRadius: PAGE_RADIUS }}>
              {picture && <img src={picture} alt="" style={{ width: at.width, height: at.height }} draggable={false} />}
            </div>
          )
        })}
        {drop.zone === 'ring' && <div className="sd-ring" />}
      </div>
    )
  }

  const open = isBoxSide(drop.zone)
  const page = dropPage(drop.zone, size)
  const box = open ? dropLayout(drop.zone as BoxSide, size).box : closedBox(side, size)
  return (
    <div {...handlers} className="split-drop">
      <div className={`sd-box ${open ? 'open' : ''}`} style={px(box)} />
      <div className="sd-page" style={{ ...px(page), borderRadius: PAGE_RADIUS }}>
        {snapshot && <img src={snapshot} alt="" style={{ width: size.width, height: size.height }} draggable={false} />}
      </div>
      {drop.zone === 'ring' && <div className="sd-ring" />}
    </div>
  )
}
