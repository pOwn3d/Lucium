import { useEffect, useId, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import {
  ANNOTATE_COLORS,
  ANNOTATE_COLOR_NAMES,
  ANNOTATE_TEXT_SIZES,
  ANNOTATE_TOOLS,
  ANNOTATE_TOOL_LABELS,
  annotateCentre,
  annotateNudge,
  annotateReduce,
  annotateScale,
  annotateStrengthLabels,
  initialAnnotate,
  type AnnotateActionName,
  type AnnotateState,
  type Point
} from '@shared/annotate'
import { renderAnnotations, type Scratch } from '@shared/annotate-draw'
import { api } from './api'
import { toolbarKeys } from './radio-keys'
import './annotate.css'
import { t } from '@shared/i18n'

/** A small canvas for the mosaic to be drawn on before it is scaled up (see shared/annotate-draw.ts). */
function makeScratch(w: number, h: number): Scratch {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2D context for the mosaic')
  ctx.imageSmoothingQuality = 'high'
  return { canvas, ctx }
}

interface TextEdit {
  /** Where the text will be drawn, in pixels of the picture, and where the field sits over the sheet, in CSS pixels of the canvas box. */
  at: Point
  left: number
  top: number
  /** Opened from the keyboard: when it settles, the focus goes back to the picture, where the keys go on. */
  fromKeys?: boolean
}

/**
 * The sheet that follows a capture ("Annoter les captures", Settings › Fonctions): the picture, five tools (line, arrow, rectangle, text,
 * mosaic), undo and redo, then Copier, Partager… or Enregistrer. The picture is the main process' to keep: the sheet asks for it by the id it
 * was opened with, draws on a canvas of its size, and hands the PNG back with the user's choice. Nothing is written before that choice.
 */
export function AnnotateSheet({ id, width, height }: { id: string; width: number; height: number }) {
  const [state, dispatch] = useReducer(annotateReduce, { width, height }, initialAnnotate)
  const latest = useRef<AnnotateState>(state)
  latest.current = state
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState<AnnotateActionName | null>(null)
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmRetake, setConfirmRetake] = useState(false)
  // The point the keyboard places shapes and texts at, in pixels of the picture; null until an arrow or Return is pressed on the picture.
  const [cursor, setCursor] = useState<Point | null>(null)
  const keysId = useId()
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => root.current?.focus(), [])

  useEffect(() => {
    let live = true
    api()
      .annotateImage(id)
      .then((url) => {
        if (!live) return
        if (!url) return setProblem(t('annotate-sheet.cette-capture-n-est-plus-disponible'))
        const picture = new Image()
        picture.onload = () => live && setImage(picture)
        picture.onerror = () => live && setProblem(t('annotate-sheet.la-capture-n-a-pas-pu-etre-affichee'))
        picture.src = url
      })
      .catch((error: unknown) => {
        console.error('[capture] the annotation sheet could not get its picture:', error)
        if (live) setProblem(t('annotate-sheet.la-capture-n-a-pas-pu-etre-chargee'))
      })
    return () => {
      live = false
    }
  }, [id])

  // One drawing per frame at most: a pointer sends many moves for one frame.
  useEffect(() => {
    const target = canvas.current
    const ctx = target?.getContext('2d')
    if (!image || !ctx) return
    const frame = requestAnimationFrame(() => renderAnnotations(ctx, image, { width, height }, state.items, makeScratch, state.draft))
    return () => cancelAnimationFrame(frame)
  }, [image, state.items, state.draft, width, height])

  const pictureAt = (event: { clientX: number; clientY: number }): Point | null => {
    const box = canvas.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return null
    return { x: ((event.clientX - box.left) * width) / box.width, y: ((event.clientY - box.top) * height) / box.height }
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !image || state.tool === 'text') return
    const at = pictureAt(event)
    if (!at) return
    dispatch({ type: 'begin', at })
    // The drag goes on when the pointer leaves the canvas.
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent) => {
    const at = state.draft ? pictureAt(event) : null
    if (at) dispatch({ type: 'extend', at })
  }
  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const at = pictureAt(event)
    if (at) dispatch({ type: 'extend', at })
    dispatch({ type: 'end' })
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  // The field of a text opens on the click, not on the press: the press ends by giving the focus to the sheet, which would take it from the field at once.
  const onClick = (event: MouseEvent<HTMLCanvasElement>) => {
    if (state.tool !== 'text' || !image) return
    const at = pictureAt(event)
    const box = wrap.current?.getBoundingClientRect()
    if (at && box) setTextEdit({ at, left: event.clientX - box.left, top: event.clientY - box.top })
  }

  const abandon = () => {
    if (state.items.length > 0 && !confirmDiscard) {
      setConfirmRetake(false)
      return setConfirmDiscard(true)
    }
    api().closeOverlay()
  }
  // Starts a new capture: opening another panel drops this picture (the browser does that), so nothing is kept. What was drawn would go with
  // it, and the button sits beside Annuler and Rétablir: with an annotation on the picture it asks first, as « Abandonner » does.
  const retake = () => {
    if (state.items.length > 0 && !confirmRetake) {
      setConfirmDiscard(false)
      return setConfirmRetake(true)
    }
    api().openOverlay({ panel: 'capture' })
  }

  // Heard on the window, not on the sheet: a button that has just been used up (Rétablir with nothing left to redo) is disabled and takes the focus
  // with it, and Escape must still reach the sheet. A key typed in the text field belongs to the field.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return
    if (event.key === 'Escape') {
      event.preventDefault()
      return abandon()
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      dispatch({ type: event.shiftKey ? 'redo' : 'undo' })
    }
  }
  const keys = useRef(onKeyDown)
  keys.current = onKeyDown
  useEffect(() => {
    const heard = (event: KeyboardEvent) => keys.current(event)
    window.addEventListener('keydown', heard)
    return () => window.removeEventListener('keydown', heard)
  }, [])

  /** The picture with its annotations, at the capture's own size, drawn afresh from the latest state (a text still being typed has just been added). */
  const exported = async (): Promise<Uint8Array> => {
    if (!image) throw new Error('the picture is not loaded')
    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('no 2D context')
    renderAnnotations(ctx, image, { width, height }, latest.current.items, makeScratch)
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
    out.width = 0
    if (!blob) throw new Error('the picture could not be encoded')
    return new Uint8Array(await blob.arrayBuffer())
  }

  const finish = async (action: AnnotateActionName) => {
    if (busy || !image) return
    setBusy(action)
    setProblem('')
    try {
      const reply = await api().annotateDone({ id, action, png: await exported() })
      if (!reply.ok) setProblem(reply.message)
    } catch (error) {
      console.error(`[capture] the annotation sheet could not ${action}:`, error)
      setProblem(t('annotate-sheet.l-action-a-echoue-reessayez-ou-abandonnez-la'))
    } finally {
      setBusy(null)
    }
  }

  // A click elsewhere on the picture opens the next field while the old one loses the focus: only the field that settles is closed.
  const settleText = (edit: TextEdit, value: string) => {
    setTextEdit((current) => (current === edit ? null : current))
    dispatch({ type: 'text', at: edit.at, text: value })
    // The field was holding the focus: without it the keys (Escape, ⌘Z) would reach no one.
    ;(edit.fromKeys ? canvas.current : root.current)?.focus()
  }

  const boxWidth = canvas.current?.getBoundingClientRect().width ?? width
  const shown = boxWidth / width
  const mosaic = state.tool === 'blur'

  // The picture from the keyboard, where the pointer has its drag: the arrows move a point (the first shows it in the middle), Return begins the
  // shape there and ends it, or opens the field of a text; Escape drops a shape under way, and only then leaves the key to the sheet.
  const onCanvasKey = (event: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (!image) return
    const size = { width, height }
    if (event.key === 'Escape' && state.draft) {
      event.preventDefault()
      event.stopPropagation()
      return dispatch({ type: 'abort' })
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const at = cursor ?? annotateCentre(size)
      setCursor(at)
      if (state.tool === 'text') return setTextEdit({ at, left: at.x * shown, top: at.y * shown, fromKeys: true })
      return dispatch(state.draft ? { type: 'end' } : { type: 'begin', at })
    }
    const next = annotateNudge(cursor, event.key, event.shiftKey, size)
    if (!next) return
    event.preventDefault()
    setCursor(next)
    if (state.draft) dispatch({ type: 'extend', at: next })
  }

  return (
    <div className="annotate-surface" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('annotate-sheet.annoter-la-capture')}>
      <div className="annotate-card">
        <div className="annotate-toolbar" role="toolbar" aria-label={t('annotate-sheet.outils-d-annotation')} onKeyDown={toolbarKeys}>
          <div className="annotate-group" role="group" aria-label={t('annotate-sheet.outil')}>
            {ANNOTATE_TOOLS.map((tool) => (
              <button key={tool} className={`annotate-tool${state.tool === tool ? ' on' : ''}`} aria-pressed={state.tool === tool} title={tool === 'blur' ? t('annotate-sheet.flou-mosaique-le-texte-dessous-ne-peut-pas-etre-relu') : undefined} onClick={() => dispatch({ type: 'tool', tool })}>
                {ANNOTATE_TOOL_LABELS[tool]}
              </button>
            ))}
          </div>
          {!mosaic && (
            <div className="annotate-group" role="group" aria-label={t('annotate-sheet.couleur')}>
              {ANNOTATE_COLORS.map((color) => (
                <button key={color} className={`annotate-swatch${state.color === color ? ' on' : ''}`} style={{ background: color }} aria-label={ANNOTATE_COLOR_NAMES[color]} aria-pressed={state.color === color} title={ANNOTATE_COLOR_NAMES[color]} onClick={() => dispatch({ type: 'color', color })} />
              ))}
            </div>
          )}
          {!mosaic && (
            <div className="annotate-group" role="group" aria-label={state.tool === 'text' ? t('search-settings.taille') : t('annotate-sheet.epaisseur')}>
              {annotateStrengthLabels().map((label, index) => (
                <button key={label} className={`annotate-tool${state.strength === index ? ' on' : ''}`} aria-pressed={state.strength === index} onClick={() => dispatch({ type: 'strength', strength: index })}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="annotate-group" role="group" aria-label={t('annotate-sheet.historique')}>
            <button className="annotate-tool" disabled={state.items.length === 0} aria-label={t('annotate-sheet.annuler-la-derniere-annotation')} title={t('annotate-sheet.annuler-la-derniere-annotation-z')} onClick={() => dispatch({ type: 'undo' })}>
              ↶
            </button>
            <button className="annotate-tool" disabled={state.redo.length === 0} aria-label={t('annotate-sheet.retablir-l-annotation')} title={t('annotate-sheet.retablir-z')} onClick={() => dispatch({ type: 'redo' })}>
              ↷
            </button>
            <button type="button" className="annotate-tool" aria-label={t('annotate-sheet.reprendre-la-capture')} title={t('annotate-sheet.reprendre-la-capture')} onClick={retake}>
              {t('annotate-sheet.nouvelle-capture')}
            </button>
          </div>
        </div>

        <div className="annotate-stage">
          <div className="annotate-wrap" ref={wrap}>
            <canvas
              ref={canvas}
              className={`annotate-canvas${state.tool === 'text' ? ' text' : ''}`}
              width={width}
              height={height}
              tabIndex={0}
              role="application"
              aria-label={t('annotate-sheet.capture-a-annoter')}
              aria-describedby={keysId}
              onKeyDown={onCanvasKey}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onClick={onClick}
              onPointerCancel={() => dispatch({ type: 'abort' })}
            />
            {cursor && <span className="annotate-cursor" aria-hidden="true" style={{ left: cursor.x * shown, top: cursor.y * shown }} />}
            {textEdit && (
              <TextField
                key={`${textEdit.left}:${textEdit.top}`}
                left={textEdit.left}
                top={textEdit.top}
                color={state.color}
                pixels={Math.max(12, Math.round(ANNOTATE_TEXT_SIZES[state.strength] * annotateScale(width) * shown))}
                onSettle={(value) => settleText(textEdit, value)}
              />
            )}
          </div>
        </div>

        <p id={keysId} className="annotate-keys">
          {t('annotate-sheet.au-clavier')}
        </p>

        {problem && (
          <p className="warning annotate-note" role="alert">
            {problem}
          </p>
        )}
        {confirmDiscard && (
          <p className="annotate-note" role="alert">
            {t('annotate-sheet.abandonner-la-capture-et-ses-annotations')}
            <button className="link-button annotate-continue" onClick={() => setConfirmDiscard(false)}>
              {t('annotate-sheet.continuez-a-annoter')}
            </button>
          </p>
        )}
        {confirmRetake && (
          <p className="annotate-note" role="alert">
            {t('annotate-sheet.reprendre-abandonne-les-annotations')}
            <button className="link-button annotate-continue" onClick={retake}>
              {t('annotate-sheet.reprendre-la-capture')}
            </button>
            <button className="link-button annotate-continue" onClick={() => setConfirmRetake(false)}>
              {t('annotate-sheet.continuer-a-annoter')}
            </button>
          </p>
        )}
        <div className="row annotate-actions">
          <span className="muted annotate-hint">{t('annotate-sheet.rien-n-est-enregistre-avant-votre-choix')}</span>
          <button className="button" onClick={abandon}>
            {t('annotate-sheet.abandonner')}
          </button>
          <button className="button" disabled={!image || busy !== null} onClick={() => void finish('copy')}>
            {t('cmd.copier')}
          </button>
          <button className="button" disabled={!image || busy !== null} onClick={() => void finish('share')} title={t('annotate-sheet.enregistre-la-capture-dans-images-lucium')}>
            {t('menu.partager')}
          </button>
          <button className="button" disabled={!image || busy !== null} onClick={() => void finish('open')} title={t('annotate-sheet.ouvre-la-capture-avec-apercu')}>
            {t('annotate-sheet.ouvrir-avec-apercu')}
          </button>
          <button className="button primary" disabled={!image || busy !== null} onClick={() => void finish('save')}>
            {t('templates.enregistrer')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The field a text is typed in, over the picture where the text will go. Return or a click elsewhere keeps it, Escape drops it. */
function TextField({ left, top, color, pixels, onSettle }: { left: number; top: number; color: string; pixels: number; onSettle: (value: string) => void }) {
  const settled = useRef(false)
  const settle = (value: string) => {
    if (settled.current) return
    settled.current = true
    onSettle(value)
  }
  return (
    <input
      className="annotate-text"
      style={{ left, top, color, fontSize: pixels }}
      aria-label={t('annotate-sheet.texte-a-ajouter-sur-la-capture')}
      maxLength={200}
      autoFocus
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          settle(event.currentTarget.value)
        } else if (event.key === 'Escape') {
          // Only the text goes: the sheet stays.
          event.preventDefault()
          event.stopPropagation()
          settle('')
        }
      }}
      onBlur={(event) => settle(event.currentTarget.value)}
    />
  )
}
