import { SIDE_PANEL_HEADER_HEIGHT } from '@shared/ipc'
import { lightsRoom } from '@shared/frame-layout'
import { t } from '@shared/i18n'
import { SIDE_PANEL_WIDTH_MAX, SIDE_PANEL_WIDTH_MIN } from '@shared/model'
import { startDrag } from './drag'

/** How far an arrow moves the edge of the panel, in pixels; four times as far with Shift. */
const STEP = 16

/**
 * The width of the docked panel after a key pressed on its edge, or null for a key the edge does not use. The arrow that points away from the
 * panel widens it (← when the panel is at the right of the page, → when it is at the left); Home and End go to the narrowest and the widest.
 */
export function sidePanelKeyWidth(width: number, key: string, panelAtLeft: boolean, large = false): number | null {
  const clamp = (value: number): number => Math.min(SIDE_PANEL_WIDTH_MAX, Math.max(SIDE_PANEL_WIDTH_MIN, Math.round(value)))
  const step = large ? STEP * 4 : STEP
  switch (key) {
    case 'ArrowLeft':
      return clamp(width + (panelAtLeft ? -step : step))
    case 'ArrowRight':
      return clamp(width + (panelAtLeft ? step : -step))
    case 'Home':
      return SIDE_PANEL_WIDTH_MIN
    case 'End':
      return SIDE_PANEL_WIDTH_MAX
    default:
      return null
  }
}

/**
 * What the shell draws round the panel docked beside the page (an extension's side panel, a web panel): its header, with its name and the
 * button that closes it, and the edge that sets its width. The edge is a window splitter: dragged, or moved from the keyboard (← →, Home, End),
 * and a screen reader reads the width.
 */
export function SidePanelFrame({ name, width, margin, panelAtLeft, onClose, onWidth }: { name: string; width: number; margin: number; panelAtLeft: boolean; onClose: () => void; onWidth: (width: number) => void }) {
  return (
    <>
      {/* Mirrored, the header starts under the traffic lights: the title keeps clear of them. */}
      <div className="side-panel-header" style={{ width, height: SIDE_PANEL_HEADER_HEIGHT, ...(panelAtLeft ? { paddingLeft: 14 + lightsRoom({ sidebarRight: true, x: 8 }) } : {}) }}>
        <span className="side-panel-title">{name}</span>
        <button className="icon" title={t('app.fermer-le-panneau')} aria-label={t('app.fermer-le-panneau')} onClick={onClose}>
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <div
        className="side-panel-resize"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t('app.redimensionner-le-panneau')}
        aria-valuenow={Math.round(width)}
        aria-valuemin={SIDE_PANEL_WIDTH_MIN}
        aria-valuemax={SIDE_PANEL_WIDTH_MAX}
        aria-valuetext={t('app.largeur-du-panneau', { width: Math.round(width) })}
        style={panelAtLeft ? { left: margin + width } : { right: margin + width }}
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.focus({ preventScroll: true })
          startDrag((event) => onWidth(panelAtLeft ? event.clientX - margin : window.innerWidth - margin - event.clientX))
        }}
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return
          const next = sidePanelKeyWidth(width, e.key, panelAtLeft, e.shiftKey)
          if (next === null) return
          e.preventDefault()
          onWidth(next)
        }}
      />
    </>
  )
}
