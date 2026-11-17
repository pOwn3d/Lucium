// The media player of the sidebar and the bar of the floating video window are on fixed colours (a navy, a fade over the video): what is
// written or drawn there is measured from the sheets themselves. A control that still works keeps 3:1, a text 4.5:1, whatever the video.

import { describe, expect, it } from 'vitest'
import { AA_CONTROL, AA_TEXT, compositeOver, contrastRatio, parseColor, type Rgba } from '@shared/contrast'
import floatingVideo from './floating-video.css?raw'
import mediaPlayer from './media-player.css?raw'
import palette from './palette.css?raw'

/** The declarations of the rules whose selector is exactly `selector`. */
const ruleOf = (css: string, selector: string): string =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selectors]) => selectors!.split(',').some((one) => one.trim() === selector)).map(([, , body]) => body!).join(' ')

/** The colour of a custom property of the fixed palette. */
function fixed(name: string): Rgba {
  const value = new RegExp(`${name}:\\s*([^;]+);`).exec(palette)?.[1]
  const colour = value ? parseColor(value) : null
  if (!colour) throw new Error(`no colour ${name} in palette.css`)
  return colour
}

/** The value of `property` in a rule, a `var(--fixed-…)` read from the palette. */
const colourOf = (rule: string, property: string): Rgba => fixed(new RegExp(`(?:^|[\\s;])${property}:\\s*var\\((--fixed-[0-9a-f-]+)\\)`).exec(rule)![1]!)
const opacityOf = (rule: string): number => Number(/opacity:\s*([\d.]+)/.exec(rule)?.[1] ?? NaN)
const withAlpha = (colour: Rgba, alpha: number): Rgba => ({ ...colour, a: colour.a * alpha })

describe('the media player of the sidebar', () => {
  const navy = colourOf(ruleOf(mediaPlayer, '.media-player .mp-clip'), 'background')
  const glyph = colourOf(ruleOf(mediaPlayer, '.media-player'), 'color')

  it('keeps the pause of a muted tab at 3:1 on its navy: the button still pauses, it is not one that cannot act', () => {
    const quiet = opacityOf(ruleOf(mediaPlayer, '.media-player .mp-button.quiet > *'))
    expect(contrastRatio(withAlpha(glyph, quiet), navy)).toBeGreaterThanOrEqual(AA_CONTROL)
  })

  it('draws a button that cannot act fainter than one that works', () => {
    expect(opacityOf(ruleOf(mediaPlayer, '.media-player .mp-button.dim > *'))).toBeLessThan(opacityOf(ruleOf(mediaPlayer, '.media-player .mp-button.quiet > *')))
  })
})

describe('the bar of the floating video window', () => {
  it('writes « EN DIRECT » at 4.5:1 on its red, and on the red of « Revenir au direct » under the pointer', () => {
    const live = ruleOf(floatingVideo, '.fv-live')
    expect(contrastRatio(colourOf(live, 'color'), colourOf(live, 'background'))).toBeGreaterThanOrEqual(AA_TEXT)
    expect(contrastRatio(colourOf(live, 'color'), colourOf(ruleOf(floatingVideo, 'button.fv-live.behind:hover'), 'background'))).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('keeps the name of the site at 4.5:1 over a white picture: the fade holds its darkest step down past the foot of the line', () => {
    const fade = /background:\s*linear-gradient\(var\((--fixed-[0-9a-f-]+)\),\s*var\((--fixed-[0-9a-f-]+)\)\s*(\d+)%,\s*transparent\)/.exec(ruleOf(floatingVideo, '.fv-top'))
    expect(fade, 'the fade of the top band').not.toBeNull()
    const [, top, held, until] = fade!
    expect(held).toBe(top)
    // The band is 44 px high and the 12 px name sits in its middle: its line ends at about 67 % of the band.
    expect(Number(until)).toBeGreaterThanOrEqual(68)
    const ground = compositeOver(fixed(held!), parseColor('#ffffff')!)
    const name = withAlpha(fixed('--fixed-ffffff'), opacityOf(ruleOf(floatingVideo, '.fv-site')))
    expect(contrastRatio(name, ground)).toBeGreaterThanOrEqual(AA_TEXT)
  })
})
