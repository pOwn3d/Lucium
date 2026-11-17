// Draws the annotations of annotate.ts on a 2D canvas. It only needs the few calls below, so the same code draws the sheet's preview and the
// picture that is exported (the preview is the picture: what is seen is what is saved), and a test can run it against a recording stand-in.

import { blurCell, type Annotation, type PictureSize, type Point } from './annotate'

/** The part of CanvasRenderingContext2D the drawing uses; the real context fits it. */
export interface DrawContext {
  strokeStyle: unknown
  fillStyle: unknown
  lineWidth: number
  lineCap: string
  lineJoin: string
  font: string
  textBaseline: string
  imageSmoothingEnabled: boolean
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
  stroke(): void
  fill(): void
  arc(x: number, y: number, radius: number, start: number, end: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  strokeText(text: string, x: number, y: number): void
  drawImage(image: any, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void
}

/** A small canvas to downscale a region on (the mosaic); `canvas` is what `drawImage` takes as an image. */
export interface Scratch {
  canvas: unknown
  ctx: DrawContext
}

export const TEXT_FONT = '600 {size}px -apple-system, "Helvetica Neue", Arial, sans-serif'

/** Where the head of an arrow goes: the tip, the two corners, and the point of the shaft where the head begins (the shaft stops there, so it does not poke through the tip). */
export function arrowHead(from: Point, to: Point, width: number): { tip: Point; left: Point; right: Point; base: Point } {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  // A head longer than the arrow itself would point backwards.
  const length = Math.min(Math.max(width * 4, 14), distance)
  const spread = Math.PI / 7
  const corner = (turn: number): Point => ({ x: to.x - length * Math.cos(angle + turn), y: to.y - length * Math.sin(angle + turn) })
  const back = length * Math.cos(spread) * 0.9
  return { tip: to, left: corner(-spread), right: corner(spread), base: { x: to.x - back * Math.cos(angle), y: to.y - back * Math.sin(angle) } }
}

/** Black on a light colour, white on a dark one: the outline that keeps a text readable on any picture. */
export function contrastOf(hex: string): string {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? Number.parseInt(hex.slice(1), 16) : 0xffffff
  const luminance = 0.299 * (value >> 16) + 0.587 * ((value >> 8) & 0xff) + 0.114 * (value & 0xff)
  return luminance > 150 ? '#000000' : '#ffffff'
}

function mosaic(ctx: DrawContext, source: unknown, size: PictureSize, item: Extract<Annotation, { kind: 'blur' }>, makeScratch: (w: number, h: number) => Scratch): void {
  const x = Math.floor(item.x)
  const y = Math.floor(item.y)
  const w = Math.max(1, Math.min(Math.ceil(item.w), size.width - x))
  const h = Math.max(1, Math.min(Math.ceil(item.h), size.height - y))
  const cell = blurCell(size)
  const sw = Math.max(1, Math.ceil(w / cell))
  const sh = Math.max(1, Math.ceil(h / cell))
  // The region is halved until it is one pixel per cell: each step averages 2 x 2 pixels, whatever filter the canvas uses for a big reduction
  // (one jump from many pixels to one can keep a single sample of them, and a mosaic must be the mean of its cell).
  // The picture's own pixels are read, not the canvas: a shape drawn earlier does not leak into the mosaic, and a later one is drawn over it.
  let small: Scratch | null = null
  let cw = w
  let ch = h
  while (cw > sw || ch > sh) {
    const nw = Math.max(sw, Math.ceil(cw / 2))
    const nh = Math.max(sh, Math.ceil(ch / 2))
    const next = makeScratch(nw, nh)
    if (small) next.ctx.drawImage(small.canvas, 0, 0, cw, ch, 0, 0, nw, nh)
    else next.ctx.drawImage(source, x, y, w, h, 0, 0, nw, nh)
    small = next
    cw = nw
    ch = nh
  }
  if (!small) {
    small = makeScratch(sw, sh)
    small.ctx.drawImage(source, x, y, w, h, 0, 0, sw, sh)
  }
  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small.canvas, 0, 0, sw, sh, x, y, w, h)
  ctx.restore()
}

function draw(ctx: DrawContext, source: unknown, size: PictureSize, item: Annotation, makeScratch: (w: number, h: number) => Scratch): void {
  switch (item.kind) {
    case 'pen': {
      ctx.save()
      ctx.strokeStyle = item.color
      ctx.fillStyle = item.color
      ctx.lineWidth = item.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const [first, ...rest] = item.points
      if (first && rest.length === 0) {
        ctx.beginPath()
        ctx.arc(first.x, first.y, item.width / 2, 0, Math.PI * 2)
        ctx.fill()
      } else if (first) {
        ctx.beginPath()
        ctx.moveTo(first.x, first.y)
        for (const point of rest) ctx.lineTo(point.x, point.y)
        ctx.stroke()
      }
      ctx.restore()
      return
    }
    case 'arrow': {
      const head = arrowHead(item.from, item.to, item.width)
      ctx.save()
      ctx.strokeStyle = item.color
      ctx.fillStyle = item.color
      ctx.lineWidth = item.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(item.from.x, item.from.y)
      ctx.lineTo(head.base.x, head.base.y)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(head.tip.x, head.tip.y)
      ctx.lineTo(head.left.x, head.left.y)
      ctx.lineTo(head.right.x, head.right.y)
      ctx.closePath()
      ctx.fill()
      ctx.restore()
      return
    }
    case 'rect':
      ctx.save()
      ctx.strokeStyle = item.color
      ctx.lineWidth = item.width
      ctx.lineJoin = 'round'
      ctx.strokeRect(item.x, item.y, item.w, item.h)
      ctx.restore()
      return
    case 'text':
      ctx.save()
      ctx.font = TEXT_FONT.replace('{size}', String(item.size))
      ctx.textBaseline = 'top'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(2, item.size / 6)
      ctx.strokeStyle = contrastOf(item.color)
      ctx.fillStyle = item.color
      ctx.strokeText(item.text, item.at.x, item.at.y)
      ctx.fillText(item.text, item.at.x, item.at.y)
      ctx.restore()
      return
    case 'blur':
      mosaic(ctx, source, size, item, makeScratch)
  }
}

/** Paints the picture, then every annotation in the order they were made (and the unfinished one last). */
export function renderAnnotations(ctx: DrawContext, source: unknown, size: PictureSize, items: readonly Annotation[], makeScratch: (w: number, h: number) => Scratch, draft: Annotation | null = null): void {
  ctx.drawImage(source, 0, 0, size.width, size.height, 0, 0, size.width, size.height)
  for (const item of items) draw(ctx, source, size, item, makeScratch)
  if (draft) draw(ctx, source, size, draft, makeScratch)
}
