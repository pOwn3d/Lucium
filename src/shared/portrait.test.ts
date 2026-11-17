import { describe, expect, it } from 'vitest'
import { PORTRAIT_CANVAS, PORTRAIT_MARGIN, portraitHtml, portraitLayout } from './portrait'

describe('portraitLayout', () => {
  it('fits a wide capture to the width the margins leave, centred', () => {
    const l = portraitLayout({ width: 2000, height: 1000 })!
    expect(l.width).toBe(PORTRAIT_CANVAS.width - PORTRAIT_MARGIN * 2)
    expect(l.height).toBe(460)
    expect(l.x).toBe(PORTRAIT_MARGIN)
    expect(l.y).toBe(Math.round((PORTRAIT_CANVAS.height - 460) / 2))
  })

  it('fits a tall capture to the height, and never enlarges a small one', () => {
    const tall = portraitLayout({ width: 1000, height: 6000 })!
    expect(tall.height).toBe(PORTRAIT_CANVAS.height - PORTRAIT_MARGIN * 2)
    expect(tall.width).toBe(Math.round((1000 * tall.height) / 6000))
    expect(portraitLayout({ width: 300, height: 200 })).toEqual({ x: 390, y: 860, width: 300, height: 200 })
  })

  it('has nothing to place for an empty picture', () => {
    for (const size of [{ width: 0, height: 100 }, { width: 100, height: 0 }, { width: NaN, height: 5 }]) expect(portraitLayout(size)).toBeNull()
  })
})

describe('portraitHtml', () => {
  const layout = { x: 1, y: 2, width: 3, height: 4 }
  it('paints the site’s colour, or a neutral one when the page declares none or something that is not a colour', () => {
    expect(portraitHtml('data:image/png;base64,AA==', layout, '#3366cc')).toContain('#3366cc')
    for (const bad of [null, 'red', 'url(javascript:1)', '#12']) expect(portraitHtml('data:image/png;base64,AA==', layout, bad)).toContain('#26262e')
  })

  // The colour is the page's own (its theme-color) and is written into a style sheet: a value that only starts or ends like a colour would carry
  // the rest of the page's text into that sheet.
  it('takes a colour only when it is one from end to end, and writes nothing of a value that is not', () => {
    for (const bad of ['#3366cc;}body{background:url(https://evil.example/)}', 'x#3366cc', '#3366ccff']) {
      const html = portraitHtml('data:image/png;base64,AA==', layout, bad)
      expect(html, bad).toContain('#26262e')
      expect(html, bad).not.toContain(bad)
    }
  })
})
