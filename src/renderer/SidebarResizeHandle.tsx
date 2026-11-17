import { t } from '@shared/i18n'
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from '@shared/model'
import { api } from './api'
import { startDrag } from './drag'

/** How far an arrow moves the edge of the sidebar, in pixels; four times as far with Shift. */
const STEP = 16

/**
 * The width of the sidebar after a key pressed on its edge, or null for a key the edge does not use. The arrow that points away from the sidebar
 * widens it (→ when the sidebar is at the left of the window, ← when it is at the right); Home and End go to the narrowest and the widest.
 */
export function sidebarKeyWidth(width: number, key: string, right: boolean, large = false): number | null {
  const clamp = (value: number): number => Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)))
  const step = large ? STEP * 4 : STEP
  switch (key) {
    case 'ArrowLeft':
      return clamp(width + (right ? step : -step))
    case 'ArrowRight':
      return clamp(width + (right ? -step : step))
    case 'Home':
      return SIDEBAR_WIDTH_MIN
    case 'End':
      return SIDEBAR_WIDTH_MAX
    default:
      return null
  }
}

/**
 * Drag the edge of the sidebar that faces the page (its right edge, its left one when it is at the right) to resize it. Each move is committed, the main process
 * relays out. A double-click docks the sidebar of this window to its column of icons (the column's own edge gives the full one back).
 * The edge is a window splitter like the one of the docked panel: it takes the keyboard (← →, Home, End), and a screen reader reads the width. No
 * other control sets this width, so without the keys it could only be changed with a pointer.
 */
export function ResizeHandle({ right, width }: { right: boolean; width: number }) {
  const send = (sidebarWidth: number) => void api().dispatch({ type: 'settings/update', patch: { sidebarWidth } })
  return (
    <div
      className="resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('sidebar.redimensionner-la-barre-laterale')}
      aria-valuenow={Math.round(width)}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      aria-valuetext={t('sidebar.largeur-de-la-barre-laterale', { width: Math.round(width) })}
      onPointerDown={(e) => {
        e.preventDefault()
        startDrag((event) => send(right ? window.innerWidth - event.clientX : event.clientX))
      }}
      onDoubleClick={() => api().windowSidebar({ op: 'dock', docked: true })}
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return
        const next = sidebarKeyWidth(width, e.key, right, e.shiftKey)
        if (next === null) return
        e.preventDefault()
        send(next)
      }}
    />
  )
}
