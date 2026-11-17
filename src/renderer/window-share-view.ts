// The view of the annotated window share (docs/design/annotation-partage-fenetre.md, « Fenêtre annotée »): the picture of the window that the command
// window chose, and a drawing layer on top of it. The layer is part of the picture that is shared (the marks must be in the captured flow).
// The stream comes from getDisplayMedia, and the main process grants that window only (main/shell/window-share.ts). Nothing is recorded: the
// elements live in this page's memory. The brush and the edit commands (undo, redo, clear) come from the command window through the main process.

import { t } from '@shared/i18n'
import { languageFromAddress } from './document-language'
import {
  DEFAULT_BRUSH,
  EMPTY_DRAWING,
  REFERENCE_HEIGHT,
  addElement,
  boundsOf,
  canAddElement,
  cleanText,
  clearAll,
  commitElements,
  contentRect,
  draftFor,
  eraseAt,
  extendDraft,
  hitElement,
  isKeepable,
  moveElement,
  pointIn,
  redo,
  restyleElement,
  shortcutOf,
  textKeyOutcome,
  textSizeAt,
  undo,
  type Brush,
  type Draft,
  type Drawing,
  type DrawAction,
  type Element as Item,
  type EditCommand,
  type Point,
  type Rect,
  type ShortcutAction
} from '@shared/window-share-draw'
import type { ShareNotice, WindowShareViewApi } from '@shared/window-share'
import { PICTURE_SAMPLE_MS, isBlackPicture, isBlankRun, nextBlankRun } from '@shared/window-share-picture'
import { lockDocumentDrops } from './surface'

/** The highlighter is wider than the pen and lets the picture show through. */
const HIGHLIGHTER_WIDTH = 3
const HIGHLIGHTER_ALPHA = 0.4
/** The frame of a selected element, in pixels. */
const SELECTION_COLOR = '#4f8cff'
/** The picture is sampled at this size (a few dozen pixels, read in this page only): enough to tell a black picture from a lit one. */
const SAMPLE_WIDTH = 32
const SAMPLE_HEIGHT = 18

lockDocumentDrops()
languageFromAddress(document.documentElement, location.search)
document.title = t('window-share.fenetre-annotee')

const video = document.createElement('video')
video.autoplay = true
video.muted = true
video.playsInline = true

const canvas = document.createElement('canvas')
canvas.className = 'window-share-layer'
// What the picture says of its source: the window is closed, or it sends no picture (minimized, hidden, another desktop, or black). The text is
// the main process's notice (renderNotice); the view stays either way, and the command window chooses or waits.
const gone = document.createElement('p')
gone.className = 'window-share-gone'
gone.hidden = true
document.body.append(video, canvas, gone)

const found = canvas.getContext('2d')
if (!found) throw new Error('[window-share] the drawing layer has no 2D context')
const context: CanvasRenderingContext2D = found

let brush: Brush = DEFAULT_BRUSH
let drawing: Drawing = EMPTY_DRAWING
/** The element selected with the select tool, by identity. */
let selected: number | null = null
/** What the current gesture makes: a draft (not yet kept), or the elements as the gesture leaves them (erasing, moving). */
let gesture: 'draw' | 'erase' | 'move' | null = null
let draft: Draft | null = null
let preview: Item[] | null = null
let moveFrom: Point | null = null
let moved = false
/** The text being typed on the layer, and where it goes. */
let textInput: HTMLInputElement | null = null
let textAt: Point = { x: 0, y: 0 }
let notice: ShareNotice = null
/** Where the picture is in the window (the video is letterboxed inside it). */
let picture: Rect = { x: 0, y: 0, width: 0, height: 0 }
/** The passage mode: a click on the picture goes to the shared window (main decides), and nothing is drawn. */
let passing = false

const aspect = (): number => (picture.height ? picture.width / picture.height : 1)
const scale = (): number => picture.height / REFERENCE_HEIGHT
const shown = (): Item[] => preview ?? drawing.elements
/** A point of the picture as a position in the window. */
const at = (point: Point): [number, number] => [picture.x + point.x * picture.width, picture.y + point.y * picture.height]

/** Changes the drawing, and drops the selection when its element is no longer there (an undo, an erase). */
function setDrawing(next: Drawing): void {
  drawing = next
  if (selected !== null && !drawing.elements.some((element) => element.id === selected)) selected = null
}

function paintStroke(item: Extract<Draft, { kind: 'stroke' }>): void {
  const highlight = item.tool === 'highlighter'
  context.globalAlpha = highlight ? HIGHLIGHTER_ALPHA : 1
  context.lineWidth = item.width * (highlight ? HIGHLIGHTER_WIDTH : 1) * scale()
  const points = item.points.map(at)
  context.beginPath()
  const [startX, startY] = points[0]!
  if (points.length === 1) {
    // A click without a move is a dot.
    context.arc(startX, startY, context.lineWidth / 2, 0, Math.PI * 2)
    context.fill()
    return
  }
  context.moveTo(startX, startY)
  for (const [x, y] of points.slice(1)) context.lineTo(x, y)
  context.stroke()
}

function paintShape(item: Extract<Draft, { kind: 'shape' }>): void {
  context.lineWidth = item.width * scale()
  const [x1, y1] = at(item.from)
  const [x2, y2] = at(item.to)
  context.beginPath()
  if (item.shape === 'rectangle') {
    context.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
    return
  }
  if (item.shape === 'ellipse') {
    context.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2)
    context.stroke()
    return
  }
  context.moveTo(x1, y1)
  context.lineTo(x2, y2)
  if (item.shape === 'arrow') {
    // The head: two short lines back from the end, opened by about 25 degrees on each side.
    const angle = Math.atan2(y2 - y1, x2 - x1)
    const head = 10 + item.width * 2 * scale()
    for (const side of [-0.45, 0.45]) {
      context.moveTo(x2, y2)
      context.lineTo(x2 - head * Math.cos(angle + side), y2 - head * Math.sin(angle + side))
    }
  }
  context.stroke()
}

function paint(item: Draft): void {
  context.save()
  context.strokeStyle = item.color
  context.fillStyle = item.color
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (item.kind === 'stroke') paintStroke(item)
  else if (item.kind === 'shape') paintShape(item)
  else {
    const [x, y] = at(item.at)
    context.font = `${textSizeAt(item.width) * scale()}px system-ui, -apple-system, sans-serif`
    context.textBaseline = 'top'
    context.fillText(item.text, x, y)
  }
  context.restore()
}

function paintSelection(item: Item): void {
  const box = boundsOf(item, aspect())
  const [x1, y1] = at({ x: box.minX, y: box.minY })
  const [x2, y2] = at({ x: box.maxX, y: box.maxY })
  context.save()
  context.setLineDash([6, 4])
  context.strokeStyle = SELECTION_COLOR
  context.lineWidth = 1
  context.strokeRect(x1 - 4, y1 - 4, x2 - x1 + 8, y2 - y1 + 8)
  context.restore()
}

function redraw(): void {
  const dpr = window.devicePixelRatio || 1
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  context.clearRect(0, 0, window.innerWidth, window.innerHeight)
  const items = shown()
  for (const item of items) paint(item)
  if (draft) paint(draft)
  const chosen = items.find((item) => item.id === selected)
  if (chosen) paintSelection(chosen)
}

/** The layer follows the window, and the place of the picture in it. */
function layout(): void {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(window.innerWidth * dpr)
  canvas.height = Math.round(window.innerHeight * dpr)
  picture = contentRect({ width: window.innerWidth, height: window.innerHeight }, { width: video.videoWidth, height: video.videoHeight })
  redraw()
}

/** Shows the notice of the source over the picture (none, the window closed, or it sends no picture). */
function renderNotice(): void {
  gone.hidden = notice === null
  gone.textContent = notice === 'closed' ? t('window-share.source-fermee') : notice === 'away' ? t('window-share.fenetre-masquee') : ''
}

/** Applies an edit of the whole picture: from the command window, or a shortcut here. */
function apply(action: ShortcutAction | EditCommand): void {
  if (action === 'undo') setDrawing(undo(drawing))
  else if (action === 'redo') setDrawing(redo(drawing))
  else if (action === 'clear') setDrawing(clearAll(drawing))
  else setDrawing(commitElements(drawing, drawing.elements.filter((item) => item.id !== selected)))
  redraw()
}

function openText(point: Point): void {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'window-share-text'
  input.setAttribute('aria-label', t('window-share.texte'))
  const [x, y] = at(point)
  input.style.left = `${x}px`
  input.style.top = `${y}px`
  input.style.color = brush.color
  input.style.fontSize = `${textSizeAt(brush.width) * scale()}px`
  input.addEventListener('keydown', (event) => {
    const outcome = textKeyOutcome(event)
    if (outcome !== null) finishText(outcome === 'keep')
  })
  // A click elsewhere keeps the text. The guard in finishText makes the Enter and the blur that follow it a single commit.
  input.addEventListener('blur', () => finishText(true))
  document.body.append(input)
  textInput = input
  textAt = point
  input.focus()
}

/** Ends the text being typed: kept when `keep` and the text is valid (not empty, not too long), dropped otherwise. */
function finishText(keep: boolean): void {
  const input = textInput
  if (!input) return
  textInput = null
  const value = cleanText(input.value)
  input.remove()
  if (keep && value !== null) setDrawing(addElement(drawing, { kind: 'text', at: textAt, text: value, color: brush.color, width: brush.width }))
  redraw()
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  if (passing) {
    // The point is sent as it is in this page; main places it on the shared window (and drops it when it is outside the picture).
    api.sendClick({ point: { x: event.clientX, y: event.clientY }, picture: { ...picture }, stream: { width: video.videoWidth, height: video.videoHeight } })
    return
  }
  if (textInput) {
    finishText(true)
    return
  }
  canvas.setPointerCapture(event.pointerId)
  const point = pointIn(picture, event.clientX, event.clientY)
  const tool = brush.tool
  if (tool === 'text') {
    if (canAddElement(drawing.elements.length)) openText(point)
    return
  }
  if (tool === 'select') {
    const hit = hitElement(drawing.elements, point, aspect())
    selected = hit?.id ?? null
    if (hit) {
      gesture = 'move'
      moveFrom = point
      moved = false
    }
    redraw()
    return
  }
  if (tool === 'eraser') {
    gesture = 'erase'
    preview = eraseAt(drawing.elements, point, aspect())
    redraw()
    return
  }
  // Past the limit of elements, nothing new starts.
  const next = draftFor(brush, point)
  if (!next || !canAddElement(drawing.elements.length)) return
  gesture = 'draw'
  draft = next
  redraw()
})

canvas.addEventListener('pointermove', (event) => {
  if (!gesture) return
  const point = pointIn(picture, event.clientX, event.clientY)
  if (gesture === 'draw' && draft) {
    extendDraft(draft, point)
  } else if (gesture === 'erase') {
    preview = eraseAt(preview ?? drawing.elements, point, aspect())
  } else if (gesture === 'move' && moveFrom && selected !== null) {
    const dx = point.x - moveFrom.x
    const dy = point.y - moveFrom.y
    moved = moved || dx !== 0 || dy !== 0
    // The moved element is computed from the kept one each time: the offsets do not add up.
    preview = drawing.elements.map((item) => (item.id === selected ? moveElement(item, dx, dy) : item))
  }
  redraw()
})

function release(): void {
  if (gesture === 'draw' && draft && isKeepable(draft)) setDrawing(addElement(drawing, draft))
  else if (gesture === 'erase' && preview) setDrawing(commitElements(drawing, preview))
  else if (gesture === 'move' && preview && moved) setDrawing(commitElements(drawing, preview))
  gesture = null
  draft = null
  preview = null
  moveFrom = null
  redraw()
}
canvas.addEventListener('pointerup', release)
canvas.addEventListener('pointercancel', release)

// The shortcuts work where the drawing happens. While a text is typed, the keys belong to the text.
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return
  const action = shortcutOf(event)
  if (!action) return
  event.preventDefault()
  apply(action)
})

// The layer follows the window, and the picture's size, which is only known once the stream has its metadata.
window.addEventListener('resize', layout)
video.addEventListener('resize', layout)
video.addEventListener('loadedmetadata', layout)

/**
 * Asks for the picture of the window chosen (main grants it). The stream replaces the previous one in the same video element: the page, the
 * drawing and the window stay. A refusal is logged and the window stays as it is; the command window shows the share's state.
 */
function startPicture(): void {
  navigator.mediaDevices
    .getDisplayMedia({ video: true, audio: false })
    .then((stream) => {
      const previous = video.srcObject as MediaStream | null
      previous?.getTracks().forEach((track) => track.stop())
      video.srcObject = stream
    })
    .catch((error: unknown) => console.warn('[window-share] the picture of the window did not start:', error))
}

// Asked as soon as the page is shown, and again each time the command window chooses another window.
startPicture()

// The black picture check: a few pixels of the picture, sampled once a second, read here and kept nowhere. The main process gets the verdict
// only when it changes. Without a frame yet, the picture is black too: a stream that never starts is reported as well.
let blankRun = 0
let blankSent: boolean | null = null
const sampler = document.createElement('canvas')
sampler.width = SAMPLE_WIDTH
sampler.height = SAMPLE_HEIGHT
const samplerContext = sampler.getContext('2d', { willReadFrequently: true })

function samplePicture(): void {
  let black = true
  if (samplerContext && video.videoWidth > 0) {
    samplerContext.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
    black = isBlackPicture(samplerContext.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data)
  }
  blankRun = nextBlankRun(blankRun, black)
  const blank = isBlankRun(blankRun)
  if (blank !== blankSent) {
    blankSent = blank
    api.sendPicture(blank)
  }
}
setInterval(samplePicture, PICTURE_SAMPLE_MS)

// The brush and the edit commands come from the command window, through the main process only. A new colour or thickness restyles the selection.
const api = (window as unknown as { luciumShareView: WindowShareViewApi }).luciumShareView
api.onDraw((action: DrawAction) => {
  if (action.type === 'source') {
    // A new window starts its own count: its black picture is judged on its own samples, and the verdict is sent again.
    blankRun = 0
    blankSent = null
    startPicture()
    return
  }
  if (action.type === 'notice') {
    notice = action.notice
    renderNotice()
    return
  }
  if (action.type === 'pass') {
    // A text being typed is kept before the clicks go to the window; the drawing gesture is dropped.
    if (action.on && textInput) finishText(true)
    passing = action.on
    gesture = null
    draft = null
    preview = null
    redraw()
    return
  }
  if (action.type !== 'brush') {
    apply(action.type)
    return
  }
  const previous = brush
  brush = action.brush
  if (selected !== null && (previous.color !== brush.color || previous.width !== brush.width)) {
    setDrawing(commitElements(drawing, restyleElement(drawing.elements, selected, brush.color, brush.width)))
  }
  redraw()
})

layout()
renderNotice()
