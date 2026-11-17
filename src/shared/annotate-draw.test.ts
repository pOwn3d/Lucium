import { describe, expect, it } from 'vitest'
import { blurCell, type Annotation } from './annotate'
import { arrowHead, contrastOf, renderAnnotations, type DrawContext, type Scratch } from './annotate-draw'

/** A context that writes down what it is asked to do, with the style it had at that moment. */
function recorder(name = 'main') {
  const calls: Array<{ op: string; args: unknown[]; style: Record<string, unknown> }> = []
  const style: Record<string, unknown> = { strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', font: '', textBaseline: 'alphabetic', imageSmoothingEnabled: true }
  const stack: Array<Record<string, unknown>> = []
  const handler: ProxyHandler<object> = {
    get(_target, prop: string) {
      if (prop === 'name') return name
      if (prop in style) return style[prop]
      if (prop === 'save') return () => (stack.push({ ...style }), calls.push({ op: 'save', args: [], style: { ...style } }))
      if (prop === 'restore') return () => (Object.assign(style, stack.pop()), calls.push({ op: 'restore', args: [], style: { ...style } }))
      return (...args: unknown[]) => calls.push({ op: prop, args, style: { ...style } })
    },
    set(_target, prop: string, value) {
      style[prop] = value
      return true
    }
  }
  return { ctx: new Proxy({}, handler) as unknown as DrawContext, calls, style }
}

const size = { width: 400, height: 300 }
const source = { image: 'source' }

function render(items: Annotation[], draft: Annotation | null = null) {
  const main = recorder('main')
  const scratches: Array<ReturnType<typeof recorder> & { canvas: object; w: number; h: number }> = []
  const makeScratch = (w: number, h: number): Scratch => {
    const made = Object.assign(recorder('scratch'), { canvas: { scratch: scratches.length }, w, h })
    scratches.push(made)
    return { canvas: made.canvas, ctx: made.ctx }
  }
  renderAnnotations(main.ctx, source, size, items, makeScratch, draft)
  return { main, scratches }
}

describe('renderAnnotations', () => {
  it('paints the picture first, whole, then the shapes in the order they were made, the unfinished one last', () => {
    const { main } = render(
      [
        { kind: 'rect', color: '#ff3b30', width: 6, x: 10, y: 10, w: 50, h: 40 },
        { kind: 'text', color: '#ffffff', size: 30, at: { x: 5, y: 5 }, text: 'a' }
      ],
      { kind: 'pen', color: '#0a84ff', width: 6, points: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }
    )
    const ops = main.calls.map((c) => c.op).filter((op) => ['drawImage', 'strokeRect', 'fillText', 'lineTo'].includes(op))
    expect(ops).toEqual(['drawImage', 'strokeRect', 'fillText', 'lineTo'])
    expect(main.calls[0]).toMatchObject({ op: 'drawImage', args: [source, 0, 0, 400, 300, 0, 0, 400, 300] })
  })

  it('draws a rectangle with the colour and thickness it was made with, and leaves the style as it found it', () => {
    const { main } = render([{ kind: 'rect', color: '#34c759', width: 8, x: 1, y: 2, w: 30, h: 20 }])
    const stroke = main.calls.find((c) => c.op === 'strokeRect')!
    expect(stroke.args).toEqual([1, 2, 30, 20])
    expect(stroke.style).toMatchObject({ strokeStyle: '#34c759', lineWidth: 8 })
    expect(main.style).toMatchObject({ strokeStyle: '', lineWidth: 1 })
  })

  it('draws an arrow as a shaft that stops where the head begins, and a filled head on the tip', () => {
    const { main } = render([{ kind: 'arrow', color: '#ff3b30', width: 6, from: { x: 10, y: 10 }, to: { x: 110, y: 10 } }])
    const head = arrowHead({ x: 10, y: 10 }, { x: 110, y: 10 }, 6)
    const lines = main.calls.filter((c) => c.op === 'lineTo').map((c) => c.args)
    expect(lines[0]).toEqual([head.base.x, head.base.y])
    expect(lines.slice(1)).toEqual([[head.left.x, head.left.y], [head.right.x, head.right.y]])
    expect(main.calls.filter((c) => c.op === 'moveTo').map((c) => c.args)).toEqual([[10, 10], [110, 10]])
    expect(main.calls.some((c) => c.op === 'fill')).toBe(true)
  })

  it('draws a single point of a stroke as a dot and a longer stroke as a line through all of its points', () => {
    const dot = render([{ kind: 'pen', color: '#ff3b30', width: 10, points: [{ x: 20, y: 30 }] }]).main.calls
    expect(dot.find((c) => c.op === 'arc')?.args).toEqual([20, 30, 5, 0, Math.PI * 2])
    expect(dot.some((c) => c.op === 'stroke')).toBe(false)
    const line = render([{ kind: 'pen', color: '#ff3b30', width: 4, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 2 }] }]).main.calls
    expect(line.filter((c) => c.op === 'lineTo').map((c) => c.args)).toEqual([[5, 5], [9, 2]])
    expect(line.find((c) => c.op === 'stroke')?.style).toMatchObject({ lineCap: 'round', lineJoin: 'round' })
  })

  it('outlines a text in the colour that contrasts with it so that it reads on any picture', () => {
    const white = render([{ kind: 'text', color: '#ffffff', size: 30, at: { x: 5, y: 6 }, text: 'Voir' }]).main.calls
    expect(white.find((c) => c.op === 'strokeText')).toMatchObject({ args: ['Voir', 5, 6], style: { strokeStyle: '#000000', font: expect.stringContaining('30px') } })
    expect(white.find((c) => c.op === 'fillText')?.style).toMatchObject({ fillStyle: '#ffffff', textBaseline: 'top' })
    // The outline goes under the letters.
    expect(white.findIndex((c) => c.op === 'strokeText')).toBeLessThan(white.findIndex((c) => c.op === 'fillText'))
  })

  it('makes a mosaic from the picture’s own pixels, halved step by step to one pixel per cell, then scaled up without smoothing', () => {
    const cell = blurCell(size)
    const { main, scratches } = render([{ kind: 'blur', x: 100, y: 50, w: 100, h: 60 }])
    const sw = Math.ceil(100 / cell)
    const sh = Math.ceil(60 / cell)
    // 100 x 60 -> 50 x 30 -> 25 x 15 -> 13 x 8 -> 10 x 6 (cells of 10 pixels): each step reads the one before.
    expect(scratches.map((s) => [s.w, s.h])).toEqual([[50, 30], [25, 15], [13, 8], [sw, sh]])
    // The first step reads the source image, not the canvas that already holds shapes.
    expect(scratches[0]!.calls.find((c) => c.op === 'drawImage')?.args).toEqual([source, 100, 50, 100, 60, 0, 0, 50, 30])
    expect(scratches[1]!.calls.find((c) => c.op === 'drawImage')?.args).toEqual([scratches[0]!.canvas, 0, 0, 50, 30, 0, 0, 25, 15])
    expect(scratches[3]!.calls.find((c) => c.op === 'drawImage')?.args).toEqual([scratches[2]!.canvas, 0, 0, 13, 8, 0, 0, sw, sh])
    const up = main.calls.filter((c) => c.op === 'drawImage')[1]!
    expect(up.args).toEqual([scratches[3]!.canvas, 0, 0, sw, sh, 100, 50, 100, 60])
    expect(up.style.imageSmoothingEnabled).toBe(false)
    expect(main.style.imageSmoothingEnabled).toBe(true)
  })

  it('makes a mosaic of a region smaller than one cell with a single pixel', () => {
    const { main, scratches } = render([{ kind: 'blur', x: 10, y: 10, w: 5, h: 4 }])
    expect(scratches.at(-1) && [scratches.at(-1)!.w, scratches.at(-1)!.h]).toEqual([1, 1])
    expect(main.calls.filter((c) => c.op === 'drawImage')[1]!.args.slice(1, 5)).toEqual([0, 0, 1, 1])
    const one = render([{ kind: 'blur', x: 10, y: 10, w: 1, h: 1 }])
    expect(one.scratches).toHaveLength(1)
    expect(one.scratches[0]!.calls.find((c) => c.op === 'drawImage')?.args).toEqual([source, 10, 10, 1, 1, 0, 0, 1, 1])
  })

  it('keeps a mosaic inside the picture even when its numbers go past the edge', () => {
    const { main } = render([{ kind: 'blur', x: 380.4, y: 290.2, w: 90, h: 90 }])
    const up = main.calls.filter((c) => c.op === 'drawImage')[1]!
    expect(up.args.slice(5)).toEqual([380, 290, 20, 10])
  })
})

describe('arrowHead', () => {
  it('ends the shaft where the head begins, so that the line does not poke through the tip', () => {
    const head = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 6)
    expect(head.tip).toEqual({ x: 100, y: 0 })
    expect(head.base.x).toBeLessThan(100)
    expect(head.base.x).toBeGreaterThan(head.left.x - 1)
    expect(head.base.y).toBeCloseTo(0)
    // The corners are on both sides of the shaft, behind the tip.
    expect(head.left.x).toBeLessThan(100)
    expect(Math.sign(head.left.y)).toBe(-Math.sign(head.right.y))
  })

  it('never makes a head longer than the arrow', () => {
    const head = arrowHead({ x: 0, y: 0 }, { x: 6, y: 0 }, 10)
    expect(Math.hypot(head.left.x - head.tip.x, head.left.y - head.tip.y)).toBeLessThanOrEqual(6 + 1e-9)
  })
})

describe('contrastOf', () => {
  it('gives black to light colours and white to dark ones, and reads what is not a colour as white', () => {
    expect(contrastOf('#ffffff')).toBe('#000000')
    expect(contrastOf('#ffcc00')).toBe('#000000')
    expect(contrastOf('#1c1c1e')).toBe('#ffffff')
    expect(contrastOf('#ff3b30')).toBe('#ffffff')
    expect(contrastOf('not a colour')).toBe('#000000')
  })
})
