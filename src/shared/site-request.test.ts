import { describe, expect, it } from 'vitest'
import { paneRightInset } from './frame-layout'
import { siteRequest } from './site-request'

// The toolbar, the backdrop of the layer and the anchor the shell finds for ⌘I, which use these: renderer/site-anchor.test.ts.
// Seen once: the panel of the site, opened from the left pane of a split view, appeared over the right pane (it hung from the window's right edge).
describe('the panel of the site opened from a pane of a split view', () => {
  const strip = (x: number, width: number) => ({ getBoundingClientRect: () => ({ x, y: 0, width, height: 40 }) })

  it('carries the strip it was opened from', () => {
    expect(siteRequest(strip(240, 600))).toEqual({ panel: 'site', anchor: { x: 240, y: 0, width: 600, height: 40 } })
  })

  it('has no place of its own without a strip: it hangs where it always did', () => {
    expect(siteRequest(null)).toEqual({ panel: 'site' })
  })

  it('hangs from the right edge of that strip, 13 px inside', () => {
    expect(paneRightInset({ x: 240, width: 600 }, 1440)).toBe(1440 - 840 + 13)
    expect(paneRightInset({ x: 840, width: 600 }, 1440)).toBe(13)
  })

  it('keeps the usual place for a strip that cannot be believed', () => {
    for (const bad of [undefined, { x: NaN, width: 600 }, { x: 0, width: Infinity }, { x: 0, width: 0 }, { x: 900, width: 0 }, { x: 900, width: -5 }, { x: 900, width: 900 }, { x: -50, width: 3000 }]) expect(paneRightInset(bad, 1440)).toBeNull()
    expect(paneRightInset({ x: 0, width: 600 }, NaN)).toBeNull()
  })
})
