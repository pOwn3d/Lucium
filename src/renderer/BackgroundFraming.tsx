// The frame that chooses which part of a video background the sidebar shows (« Cadrage »): the whole video is drawn small, and a frame the shape of the
// sidebar sits over it. Dragging the frame (pointer) or pressing the arrow keys moves it; the position is written once the drag is over, and at each key.
// The geometry is in shared/space-media.ts (coverShare, draggedPosition, steppedPosition), tested without a screen. The caller gives it a `key` of the
// file, so a video of another file is measured again from a new start.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { t } from '@shared/i18n'
import { SIDEBAR_WIDTH_DEFAULT } from '@shared/model'
import { CENTERED_POSITION, coverShare, draggedPosition, steppedPosition, type BackgroundPosition } from '@shared/space-media'

/**
 * The shape of the box the video covers in the sidebar. The window is not known here (the panel opens in another document), so the width is the
 * default one of the sidebar and the height a usual window's: it sizes the frame only. The position is a percent of the video, which is the same
 * whatever the real size of the sidebar.
 */
const SIDEBAR_SHAPE = { width: SIDEBAR_WIDTH_DEFAULT, height: 720 }

interface Drag {
  pointerId: number
  startX: number
  startY: number
  from: BackgroundPosition
  /** Where the frame is now: read when the pointer is released, which a closure over the last render could miss. */
  last: BackgroundPosition
}

export function BackgroundFraming({ src, position, onChange, disabled = false }: { src: string; position: BackgroundPosition | undefined; onChange: (x: number, y: number) => void; disabled?: boolean }) {
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  // What the frame shows while the user moves it, until the state has the same position: the sidebar's state comes back after the write.
  const [draft, setDraft] = useState<BackgroundPosition | null>(null)
  const stored = position ?? CENTERED_POSITION
  const current = draft ?? stored
  useEffect(() => {
    if (draft && draft.x === stored.x && draft.y === stored.y) setDraft(null)
  }, [draft, stored.x, stored.y])

  const share = size ? coverShare(size, SIDEBAR_SHAPE) : null
  // A video of the sidebar's own shape fills it on both axes: there is no part to choose.
  if (share && share.x >= 1 && share.y >= 1) return null

  const commit = (next: BackgroundPosition) => {
    setDraft(next)
    onChange(next.x, next.y)
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || !share || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, from: current, last: current }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current
    const box = stage.current?.getBoundingClientRect()
    if (!active || active.pointerId !== event.pointerId || !share || !box) return
    active.last = draggedPosition(active.from, { x: event.clientX - active.startX, y: event.clientY - active.startY }, share, { width: box.width, height: box.height })
    setDraft(active.last)
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    drag.current = null
    // One write at the end of the drag, not one for each pixel of the pointer.
    if (active.last.x !== stored.x || active.last.y !== stored.y) onChange(active.last.x, active.last.y)
    else setDraft(null)
  }
  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    // The system took the pointer (a gesture, a window change): the frame goes back to where it was, nothing is written.
    drag.current = null
    setDraft(null)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !share) return
    const next = steppedPosition(current, event.key, share)
    if (!next) return
    event.preventDefault()
    if (next.x !== current.x || next.y !== current.y) commit(next)
  }

  return (
    <div className="media-framing" role="group" aria-label={t('space-media.cadrage')}>
      <span className="media-framing-title">{t('space-media.cadrage')}</span>
      <div className="media-framing-stage" ref={stage} style={size ? { aspectRatio: `${size.width} / ${size.height}` } : undefined}>
        {/* Still, on its first frame: the frame is what the user looks at; the video that plays is the preview above. */}
        <video src={src} muted playsInline preload="auto" aria-hidden="true" tabIndex={-1} onLoadedMetadata={(e) => setSize({ width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })} />
        {share && (
          <div
            className="media-framing-frame"
            // A frame moves along two axes, which a slider says with its text: its number is the axis the video can move on most.
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={t('space-media.cadrage-cadre')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={share.x < share.y ? current.x : current.y}
            aria-valuetext={t('space-media.cadrage-valeur', { x: current.x, y: current.y })}
            aria-disabled={disabled}
            style={{ width: `${share.x * 100}%`, height: `${share.y * 100}%`, left: `${(current.x / 100) * (1 - share.x) * 100}%`, top: `${(current.y / 100) * (1 - share.y) * 100}%` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
      <p className="media-info">{t('space-media.cadrage-aide')}</p>
      {(stored.x !== CENTERED_POSITION.x || stored.y !== CENTERED_POSITION.y) && (
        <button type="button" className="media-button" disabled={disabled} onClick={() => commit(CENTERED_POSITION)}>
          {t('space-media.cadrage-recentrer')}
        </button>
      )}
    </div>
  )
}
