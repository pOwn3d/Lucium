// The recolouring engine of the readable mode (readable-engine.ts): the colour arithmetic, the rewriting of a stylesheet, and the engine run as
// the page runs it (the very text the shell sends) against the stand-in window of readable-engine.test-support.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTRAST_LARGE, CONTRAST_TEXT, DARK_PROBE_SCRIPT, READABLE_BUDGET, READABLE_STATE, READABLE_STOP_SCRIPT, readableEngineCall, readableKit, type ColourRole, type ReadableScheme, type Rgb } from './readable-engine'
import { FakeElement, FakeObserver, FakeShadowRoot, FakeSheet, SVG, declarationsOf, fakeWindow, flushIdle, markOf, runEngine, type FakeWindow } from './readable-engine.test-support'

const kit = readableKit()
const rgb = (r: number, g: number, b: number, a = 1): Rgb => ({ r, g, b, a })
const hex = (text: string): Rgb => kit.parse(text)!
const SCHEMES: ReadableScheme[] = ['dark', 'light']
const ROLES: ColourRole[] = ['bg', 'fg', 'border', 'shadow']
/** A grid of sRGB colours, greys and saturated ones. */
const GRID: Rgb[] = []
for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) GRID.push(rgb(r, g, b))
const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

describe('the colour arithmetic', () => {
  it('goes to OKLCH and back to the same sRGB colour', () => {
    for (const c of GRID) {
      const o = kit.toOklch(c)
      const back = kit.fromOklch(o.l, o.c, o.h)
      expect([back.r, back.g, back.b], kit.format(c)).toEqual([c.r, c.g, c.b])
    }
    // Known values: white is L 1, black L 0, both without chroma.
    expect(kit.toOklch(rgb(255, 255, 255)).l).toBeCloseTo(1, 3)
    expect(kit.toOklch(rgb(0, 0, 0)).l).toBeCloseTo(0, 3)
    expect(kit.toOklch(rgb(128, 128, 128)).c).toBeLessThan(1e-3)
  })

  it('keeps the hue and lowers only the chroma the gamut cannot hold', () => {
    // A vivid blue at a lightness where sRGB has little room: same hue, less chroma, in gamut.
    const blue = kit.toOklch(rgb(0, 80, 255))
    const light = kit.fromOklch(0.92, blue.c, blue.h)
    const o = kit.toOklch(light)
    expect(o.l).toBeCloseTo(0.92, 2)
    expect(o.c).toBeLessThan(blue.c)
    expect(hueGap(o.h, blue.h)).toBeLessThan(3)
  })

  it('computes the contrast ratio of WCAG 2', () => {
    expect(kit.contrast(rgb(255, 255, 255), rgb(0, 0, 0))).toBeCloseTo(21, 5)
    expect(kit.contrast(rgb(10, 20, 30), rgb(10, 20, 30))).toBe(1)
    // #767676 on white is the classic lightest grey that passes 4.5 : 1; #777 is just under.
    expect(kit.contrast(hex('#767676'), hex('#fff'))).toBeGreaterThanOrEqual(4.5)
    expect(kit.contrast(hex('#777'), hex('#fff'))).toBeLessThan(4.5)
    // A text at half opacity is mixed with what is behind it first.
    expect(kit.contrastOver(rgb(0, 0, 0), rgb(255, 255, 255), 0.5)).toBeCloseTo(kit.contrast(rgb(128, 128, 128), rgb(255, 255, 255)), 1)
  })

  it('reads the colour syntaxes of a page and of a computed style, and nothing else', () => {
    expect(kit.parse('#fff')).toEqual(rgb(255, 255, 255))
    expect(kit.parse('#11223380')).toEqual(rgb(17, 34, 51, 128 / 255))
    expect(kit.parse('rgb(1, 2, 3)')).toEqual(rgb(1, 2, 3))
    expect(kit.parse('rgba(1, 2, 3, 0.5)')).toEqual(rgb(1, 2, 3, 0.5))
    expect(kit.parse('rgb(1 2 3 / 50%)')).toEqual(rgb(1, 2, 3, 0.5))
    expect(kit.parse('hsl(0, 100%, 50%)')).toEqual(rgb(255, 0, 0))
    expect(kit.parse('hwb(0 0% 0%)')).toEqual(rgb(255, 0, 0))
    expect(kit.parse('White')).toEqual(rgb(255, 255, 255))
    expect(kit.parse('rebeccapurple')).toEqual(rgb(102, 51, 153))
    expect(kit.parse('transparent')).toEqual(rgb(0, 0, 0, 0))
    expect(kit.parse('color(srgb 1 0 0 / 0.25)')).toEqual(rgb(255, 0, 0, 0.25))
    const ok = kit.parse('oklch(0.627955 0.257683 29.2339)')!
    expect([ok.r, ok.g, ok.b]).toEqual([255, 0, 0])
    // CSS Lab is relative to D50: sRGB red is lab(54.29 80.82 69.89).
    const lab = kit.parse('lab(54.29 80.82 69.89)')!
    expect(Math.abs(lab.r - 255) + lab.g + lab.b).toBeLessThan(6)
    for (const text of ['currentcolor', 'var(--x)', 'inherit', 'canvastext', 'rgb(1, 2)', 'color(rec2020 1 0 0)', '#ggg', '#12345']) expect(kit.parse(text), text).toBeNull()
  })
})

describe('the lightness of each role', () => {
  it('Dark: a white background goes dark, black text goes light, and both keep their hue', () => {
    const page = kit.recolour(rgb(255, 255, 255), 'bg', 'dark', 1)
    expect(kit.toOklch(page).l).toBeCloseTo(0.2, 2)
    expect(kit.toOklch(kit.recolour(rgb(0, 0, 0), 'fg', 'dark', 1)).l).toBeCloseTo(0.93, 2)
    // A link blue stays blue, lighter; a pale yellow note stays yellow, darker.
    for (const [text, role] of [['#0645ad', 'fg'], ['#fff3cd', 'bg'], ['#d73a49', 'fg'], ['#e6f4ea', 'bg']] as const) {
      const before = kit.toOklch(hex(text))
      const after = kit.toOklch(kit.recolour(hex(text), role, 'dark', 1))
      expect(hueGap(before.h, after.h), text).toBeLessThan(6)
    }
  })

  it('Light is the mirror: a dark background goes light, light text goes dark', () => {
    expect(kit.toOklch(kit.recolour(hex('#0d1117'), 'bg', 'light', kit.toOklch(hex('#0d1117')).l)).l).toBeGreaterThan(0.97)
    expect(kit.toOklch(kit.recolour(rgb(255, 255, 255), 'fg', 'light', 0.2)).l).toBeCloseTo(0.2, 2)
  })

  it('keeps the order of backgrounds (a card lighter than its page stays apart from it) and leaves dark ones in Dark', () => {
    const page = kit.toOklch(kit.recolour(hex('#f6f8fa'), 'bg', 'dark', 1)).l
    const card = kit.toOklch(kit.recolour(hex('#ffffff'), 'bg', 'dark', 1)).l
    expect(page).toBeGreaterThan(card)
    expect(kit.recolour(hex('#222'), 'bg', 'dark', 1)).toEqual(hex('#222'))
  })

  it('keeps the hue of every colour it moves (where the colour has a hue to keep)', () => {
    for (const scheme of SCHEMES)
      for (const role of ROLES)
        for (const c of GRID) {
          const before = kit.toOklch(c)
          const after = kit.toOklch(kit.recolour(c, role, scheme, scheme === 'dark' ? 1 : 0.2))
          if (before.c > 0.06 && after.c > 0.03) expect(hueGap(before.h, after.h), `${scheme} ${role} ${kit.format(c)}`).toBeLessThan(8)
        }
  })

  it('gives colours that are in the scheme, so that the element pass never maps a colour twice', () => {
    for (const scheme of SCHEMES)
      for (const role of ['bg', 'fg', 'border'] as const)
        for (const c of GRID)
          for (const a of [1, 0.1]) {
            const out = kit.recolour({ ...c, a }, role, scheme, scheme === 'dark' ? 1 : 0.2)
            expect(kit.inScheme(out, role, scheme), `${scheme} ${role} ${kit.format({ ...c, a })} → ${kit.format(out)}`).toBe(true)
          }
  })

  it('tells a colour that was not mapped: a white background or black text in Dark, a black background or white text in Light', () => {
    expect(kit.inScheme(rgb(255, 255, 255), 'bg', 'dark')).toBe(false)
    expect(kit.inScheme(rgb(0, 0, 0), 'fg', 'dark')).toBe(false)
    expect(kit.inScheme(hex('#ddd'), 'border', 'dark')).toBe(false)
    expect(kit.inScheme(rgb(0, 0, 0), 'bg', 'light')).toBe(false)
    expect(kit.inScheme(rgb(255, 255, 255), 'fg', 'light')).toBe(false)
    expect(kit.inScheme(hex('#222'), 'border', 'light')).toBe(false)
  })

  it('treats a faint background as ink (a hover tint turns light in Dark) and a veil as a background (a dimming backdrop stays dark)', () => {
    const hover = kit.recolour(rgb(0, 0, 0, 0.05), 'bg', 'dark', 1)
    expect(kit.toOklch(hover).l).toBeGreaterThan(0.85)
    expect(hover.a).toBe(0.05)
    expect(kit.recolour(rgb(0, 0, 0, 0.5), 'bg', 'dark', 1)).toEqual(rgb(0, 0, 0, 0.5))
  })

  it('keeps a little more light in a strong colour, so that a brand bar stays its colour', () => {
    const orange = kit.toOklch(kit.recolour(hex('#ff6600'), 'bg', 'dark', 1)).l
    const grey = kit.toOklch(kit.recolour(rgb(kit.fromOklch(kit.toOklch(hex('#ff6600')).l, 0, 0).r, kit.fromOklch(kit.toOklch(hex('#ff6600')).l, 0, 0).g, kit.fromOklch(kit.toOklch(hex('#ff6600')).l, 0, 0).b), 'bg', 'dark', 1)).l
    expect(orange - grey).toBeGreaterThan(0.05)
  })
})

describe('reaching a contrast', () => {
  it('moves only the lightness, same hue, until the target is reached, against any background', () => {
    for (const bg of GRID.filter((_, i) => i % 7 === 0))
      for (const fg of GRID.filter((_, i) => i % 11 === 0))
        for (const target of [CONTRAST_TEXT + 0.1, CONTRAST_LARGE + 0.1]) {
          const out = kit.reach(fg, bg, target)
          const ratio = kit.contrastOver(out, bg)
          // Where no colour reaches the target (a mid grey background has at most about 5 : 1), the best end is given.
          const best = Math.max(kit.contrast(rgb(255, 255, 255), bg), kit.contrast(rgb(0, 0, 0), bg))
          expect(ratio, `${kit.format(fg)} on ${kit.format(bg)}`).toBeGreaterThanOrEqual(Math.min(target, best) - 0.01)
          const before = kit.toOklch(fg)
          const after = kit.toOklch(out)
          if (before.c > 0.08 && after.c > 0.04) expect(hueGap(before.h, after.h)).toBeLessThan(8)
        }
  })

  it('leaves a colour that reaches the target already as it is', () => {
    expect(kit.reach(hex('#000'), hex('#fff'), 4.5)).toEqual(hex('#000'))
  })

  it('makes the smallest move, toward the side with room: light grey text on a dark ground gets lighter, not black', () => {
    const out = kit.reach(hex('#555'), hex('#1a1a1a'), 4.6)
    expect(kit.toOklch(out).l).toBeGreaterThan(kit.toOklch(hex('#555')).l)
    expect(kit.toOklch(out).l).toBeLessThan(0.8)
  })

  it('counts the fading of a text (its alpha and the opacity of what holds it)', () => {
    const out = kit.reach(hex('#888'), hex('#111'), 4.6, 0.6)
    expect(kit.contrastOver(out, hex('#111'), 0.6)).toBeGreaterThanOrEqual(4.6)
    expect(kit.contrastOver(hex('#888'), hex('#111'), 0.6)).toBeLessThan(4.6)
  })
})

describe('rewriting a value', () => {
  const ctx = { map: (c: Rgb, role: ColourRole) => kit.recolour(c, role, 'dark', 1), twin: (role: ColourRole, name: string) => `--T-${role}${name}`, need: new Map() }

  it('maps every colour of a gradient and of shadows, and leaves pictures, quoted text and other words alone', () => {
    expect(kit.rewrite('linear-gradient(to right, white 0%, #000 100%), url(red.png)', 'bg', ctx)).toBe(`linear-gradient(to right, ${kit.format(kit.recolour(rgb(255, 255, 255), 'bg', 'dark', 1))} 0%, rgb(0, 0, 0) 100%), url(red.png)`)
    expect(kit.rewrite('url("white.svg#black")', 'bg', ctx)).toBe('url("white.svg#black")')
    expect(kit.rewrite('0 1px 2px rgba(0, 0, 0, 0.2)', 'shadow', ctx)).toBe('0 1px 2px rgba(0, 0, 0, 0.2)')
    expect(kit.rewrite('inset 0 0 0 1px #ddd', 'shadow', ctx)).toBe(`inset 0 0 0 1px ${kit.format(kit.recolour(hex('#ddd'), 'shadow', 'dark', 1))}`)
    expect(kit.rewrite('"red" currentcolor transparent', 'fg', ctx)).toBe('"red" currentcolor transparent')
  })

  it('makes a `var()` read the twin of its custom property for the role first, then the property itself, then its own fallback mapped', () => {
    expect(kit.rewrite('var(--fg)', 'fg', ctx)).toBe('var(--T-fg--fg,var(--fg))')
    expect(kit.rewrite('var(--a, var(--b, #000))', 'fg', ctx)).toBe(`var(--T-fg--a,var(--a, var(--T-fg--b,var(--b, ${kit.format(kit.recolour(rgb(0, 0, 0), 'fg', 'dark', 1))}))))`)
    expect(kit.rewrite('rgba(var(--rgb), 0.5)', 'bg', ctx)).toBe('rgba(var(--T-bg--rgb,var(--rgb)), 0.5)')
  })

  it('gives a custom property of channels (fed to `rgb(var(--x))` or `hsl(var(--x))`) a twin in the same notation', () => {
    expect(kit.twinValue('255, 255, 255', 'bg', ctx)).toMatch(/^\d+, \d+, \d+$/)
    // A twin that would be the property itself is not made.
    expect(kit.twinValue('34, 34, 34', 'bg', ctx)).toBe('')
    expect(kit.twinValue('#222', 'bg', ctx)).toBe('')
    expect(kit.twinValue('var(--x)', 'bg', ctx)).toBe('var(--T-bg--x,var(--x))')
    expect(kit.twinValue('255 255 255', 'bg', ctx)).toMatch(/^\d+ \d+ \d+$/)
    expect(kit.twinValue('0 0% 100%', 'bg', ctx)).toMatch(/^[\d.]+ [\d.]+% [\d.]+%$/)
    expect(kit.colourish('12px')).toBe(false)
    expect(kit.colourish('0 0% 100%')).toBe(true)
  })
})

// ---- a stand-in for the CSSOM ----
type Decl = [string, string, boolean?]
function style(decls: Decl[]): any {
  const out: any = { length: decls.length }
  decls.forEach(([name], i) => (out[i] = name))
  out.getPropertyValue = (name: string) => decls.find(([n]) => n === name)?.[1] ?? ''
  out.getPropertyPriority = (name: string) => (decls.find(([n]) => n === name)?.[2] ? 'important' : '')
  return out
}
const rule = (selectorText: string, decls: Decl[], cssRules?: unknown[]) => ({ type: 1, selectorText, style: style(decls), ...(cssRules ? { cssRules } : {}) })
const sheetCtx = (need = new Map<string, Set<ColourRole>>()) => ({ map: (c: Rgb, role: ColourRole) => kit.recolour(c, role, 'dark', 1), twin: (role: ColourRole, name: string) => `--T-${role}${name}`, need, memo: new Map<string, string>() })
const WHITE_BG = kit.format(kit.recolour(rgb(255, 255, 255), 'bg', 'dark', 1))

describe('the copy of a stylesheet', () => {
  it('repeats each rule with its selector, only its colour declarations, rewritten, importance kept', () => {
    const rules = [rule('.a', [['color', 'rgb(0, 0, 0)'], ['margin', '4px'], ['background-color', 'rgb(255, 255, 255)', true]]), rule('.b', [['padding', '1px']])]
    expect(kit.sheetText(rules, sheetCtx(), { count: 0 })).toBe(`.a{color:${kit.format(kit.recolour(rgb(0, 0, 0), 'fg', 'dark', 1))};background-color:${WHITE_BG} !important;}`)
  })

  it('repeats a colour it keeps as it is, so that the copies keep the order of the page’s rules', () => {
    expect(kit.sheetText([rule('.a', [['background-color', 'transparent']]), rule('.b', [['color', 'inherit']])], sheetCtx(), { count: 0 })).toBe('.a{background-color:transparent;}.b{color:inherit;}')
  })

  it('reads the relative addresses of a sheet from the address of that sheet, not from the document its copy is adopted in', () => {
    const at = (base: string) => ({ ...sheetCtx(), base })
    const bg = (value: string, base: string): string => kit.sheetText([rule('.i', [['background-image', value]])], at(base), { count: 0 })
    // Chromium gives a declared address back as it was written; the copy would read it from the page (`/article/1`) and ask for `/img/x.png`.
    expect(bg('url("../img/x.png")', 'https://site.example/static/css/site.css')).toBe('.i{background-image:url("https://site.example/static/img/x.png");}')
    expect(bg('url(sprite.png), linear-gradient(white, white)', 'https://cdn.example/a/b.css')).toBe(`.i{background-image:url("https://cdn.example/a/sprite.png"), linear-gradient(${WHITE_BG}, ${WHITE_BG});}`)
    expect(bg("url('/abs.png')", 'https://cdn.example/a/b.css')).toBe('.i{background-image:url("https://cdn.example/abs.png");}')
    // The strings of an image set are addresses too; the one of `type()` is not.
    expect(bg('image-set("a.png" 1x, url(b.png) 2x type("image/png"))', 'https://cdn.example/a/b.css')).toBe('.i{background-image:image-set("https://cdn.example/a/a.png" 1x, url("https://cdn.example/a/b.png") 2x type("image/png"));}')
    // Nothing to resolve: a whole address, an image written in the sheet, a part of the document itself (a gradient of the page's own SVG).
    for (const whole of ['url("https://other.example/x.png")', 'url("data:image/png;base64,AAAA")', 'url("#paint")', 'url()'])
      expect(bg(whole, 'https://cdn.example/a/b.css'), whole).toBe(`.i{background-image:${whole};}`)
    expect(kit.sheetText([rule('.f', [['fill', 'url("#gradient") rgb(255, 255, 255)']])], at('https://cdn.example/a/b.css'), { count: 0 })).toMatch(/^\.f\{fill:url\("#gradient"\) rgb/)
    // An address this cannot read is left as the page wrote it.
    expect(bg('url(a\\ b.png)', 'https://cdn.example/a/b.css')).toBe('.i{background-image:url(a\\ b.png);}')
    // A sheet written in the page has no address: its copy reads the same document, and nothing is touched.
    expect(kit.sheetText([rule('.i', [['background-image', 'url("../img/x.png")']])], sheetCtx(), { count: 0 })).toBe('.i{background-image:url("../img/x.png");}')
  })

  it('reads the addresses of an imported sheet from that sheet, and those of a keyframe as those of a rule', () => {
    const ctx = { ...sheetCtx(), base: 'https://site.example/css/site.css' }
    const imported = { type: 3, media: { mediaText: '' }, styleSheet: { href: 'https://site.example/vendor/kit/kit.css', cssRules: [rule('.k', [['background-image', 'url("img/k.png")']])] } }
    const text = kit.sheetText([imported, rule('.s', [['background-image', 'url("img/s.png")']])], ctx, { count: 0 })
    expect(text).toBe('.k{background-image:url("https://site.example/vendor/kit/img/k.png");}.s{background-image:url("https://site.example/css/img/s.png");}')
    expect(ctx.base).toBe('https://site.example/css/site.css')
    const frames = { type: 7, name: 'swap', cssRules: [{ keyText: '0%', style: style([['background-color', 'rgb(255, 255, 255)'], ['mask-image', 'url("m.svg")'], ['content', '"url(not-an-address)"']]) }] }
    expect(kit.sheetText([frames], ctx, { count: 0 })).toBe(`@keyframes swap{0%{background-color:${WHITE_BG};mask-image:url("https://site.example/css/m.svg");content:"url(not-an-address)";}}`)
  })

  it('does not give one sheet the address another sheet resolved for the same text', () => {
    const memo = new Map<string, string>()
    const copy = (base: string): string => kit.sheetText([rule('.i', [['background-image', 'url("x.png")']])], { ...sheetCtx(), memo, base }, { count: 0 })
    expect(copy('https://site.example/a/one.css')).toContain('https://site.example/a/x.png')
    expect(copy('https://site.example/b/two.css')).toContain('https://site.example/b/x.png')
  })

  it('keeps the grouping: media queries, supports, layers, imported sheets (and counts those it cannot read)', () => {
    const unreadable = { count: 0 }
    const rules = [
      { type: 4, media: { mediaText: '(min-width: 600px)' }, cssRules: [rule('.m', [['color', 'rgb(0, 0, 0)']])] },
      { type: 12, conditionText: '(display: grid)', cssRules: [rule('.s', [['color', 'rgb(0, 0, 0)']])] },
      { type: 0, name: 'base', cssRules: [rule('.l', [['color', 'rgb(0, 0, 0)']])] },
      { type: 3, layerName: '', media: { mediaText: 'print' }, styleSheet: { cssRules: [rule('.i', [['color', 'rgb(0, 0, 0)']])] } },
      {
        type: 3,
        media: { mediaText: '' },
        get styleSheet() {
          return {
            get cssRules() {
              throw new Error('SecurityError')
            }
          }
        }
      },
      { type: 4, media: { mediaText: 'screen' }, cssRules: [rule('.none', [['margin', '0']])] }
    ]
    const text = kit.sheetText(rules, sheetCtx(), unreadable)
    expect(text).toMatch(/^@media \(min-width: 600px\)\{\.m\{color:[^}]+\}\}@supports \(display: grid\)\{\.s\{[^}]+\}\}@layer base\{\.l\{[^}]+\}\}@media print\{@layer\{\.i\{[^}]+\}\}\}$/)
    expect(unreadable.count).toBe(1)
  })

  it('copies keyframes that hold a colour whole (a copy replaces the page’s), and leaves the others to the page', () => {
    const frames = (decls: Decl[]) => ({ type: 7, name: 'pulse', cssRules: [{ type: 8, keyText: '0%', style: style(decls) }] })
    expect(kit.sheetText([frames([['background-color', 'rgb(255, 255, 255)'], ['opacity', '0.5']])], sheetCtx(), { count: 0 })).toBe(`@keyframes pulse{0%{background-color:${WHITE_BG};opacity:0.5;}}`)
    expect(kit.sheetText([frames([['opacity', '0.5']])], sheetCtx(), { count: 0 })).toBe('')
  })

  it('copies nested rules and nested declarations inside their parent, and skips a block of descriptors that indexes no property name', () => {
    const nested = rule('.p', [['color', 'rgb(0, 0, 0)']], [rule('&:hover', [['color', 'rgb(0, 0, 0)']]), { type: 0, style: style([['background-color', 'rgb(255, 255, 255)']]) }])
    expect(kit.sheetText([nested], sheetCtx(), { count: 0 })).toMatch(/^\.p\{color:[^;]+;&:hover\{color:[^;]+;\}background-color:[^;]+;\}$/)
    // An @position-try block: a name, and a style whose entries are not property names.
    const tryRule = { type: 0, name: '--x', style: { length: 1, 0: undefined, getPropertyValue: () => '', getPropertyPriority: () => '' } }
    expect(kit.sheetText([tryRule], sheetCtx(), { count: 0 })).toBe('')
    expect(kit.declarations({ length: 2, 0: undefined, 1: 'color', getPropertyValue: () => 'rgb(0, 0, 0)', getPropertyPriority: () => '' }, sheetCtx())).toMatch(/^color:/)
  })

  it('rewrites a shorthand that holds a `var()` (its longhands are empty in the CSSOM), once', () => {
    const r = rule('.v', [['background-color', ''], ['background-image', ''], ['background', 'var(--bg) url(a.png)']])
    expect(kit.sheetText([r], sheetCtx(), { count: 0 })).toBe('.v{background:var(--T-bg--bg,var(--bg)) url(a.png);}')
  })

  it('asks for the declarations the CSSOM lost (a shorthand and a longhand of it in one block), from what an element computes', () => {
    const recover = vi.fn(() => 'background-image:none;')
    const r = rule('.lost::after', [['background-image', ''], ['background-color', ''], ['background-repeat', 'no-repeat']])
    expect(kit.sheetText([r], { ...sheetCtx(), recover }, { count: 0 })).toBe('.lost::after{background-image:none;}')
    expect(recover).toHaveBeenCalledWith('.lost::after', [['background-image', 'bg'], ['background-color', 'bg']])
  })

  it('gives custom properties twins only for the roles that read them, through chains of references, and none equal to the property', () => {
    const rules = [rule(':root', [['--base', '#ffffff'], ['--surface', 'var(--base)'], ['--gap', '8px'], ['--ink', '#000'], ['--same', '#222']]), rule('.c', [['background-color', 'var(--surface)'], ['color', 'var(--ink)'], ['border-top-color', 'var(--same)']])]
    const need = new Map<string, Set<ColourRole>>()
    const deps = new Map<string, Set<string>>()
    kit.collect(rules, need, deps, { count: 0 })
    kit.closeNeed(need, deps)
    expect(Object.fromEntries([...need].map(([k, v]) => [k, [...v]]))).toEqual({ '--surface': ['bg'], '--ink': ['fg'], '--same': ['border'], '--base': ['bg'] })
    const text = kit.sheetText(rules, sheetCtx(need), { count: 0 })
    expect(text).toContain(`--T-bg--base:${WHITE_BG};`)
    expect(text).toContain('--T-bg--surface:var(--T-bg--base,var(--base));')
    expect(text).toContain('--T-fg--ink:')
    expect(text).not.toContain('--gap')
    // #222 as a border in Dark is mirrored to a light grey: its twin is written. As a background it would be kept, and no twin written.
    expect(text).toContain('--T-border--same:')
    expect(kit.sheetText([rule(':root', [['--same', '#222']])], sheetCtx(new Map([['--same', new Set<ColourRole>(['bg'])]])), { count: 0 })).toBe('')
  })
})

describe('the probe', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[READABLE_STATE]
  })

  it('reads the page as it is without the engine: the engine is suspended for the time of the read, then resumed', () => {
    const order: string[] = []
    ;(globalThis as Record<string, unknown>)[READABLE_STATE] = { suspend: () => (order.push('suspend'), () => order.push('resume')) }
    const doc = { documentElement: {}, body: {}, contentType: 'text/html', elementFromPoint: () => (order.push('read'), null) }
    const run = new Function('document', 'window', 'getComputedStyle', `return ${DARK_PROBE_SCRIPT}`)
    run(doc, { innerWidth: 100, innerHeight: 100 }, () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', colorScheme: 'normal' }))
    expect(order[0]).toBe('suspend')
    expect(order.at(-1)).toBe('resume')
    expect(order.filter((o) => o === 'read')).toHaveLength(5)
  })

  it('resumes the engine even when the read throws', () => {
    const resume = vi.fn()
    ;(globalThis as Record<string, unknown>)[READABLE_STATE] = { suspend: () => resume }
    const run = new Function('document', 'window', 'getComputedStyle', `return ${DARK_PROBE_SCRIPT}`)
    expect(() => run({ documentElement: {}, body: {}, elementFromPoint: () => { throw new Error('no') } }, { innerWidth: 1, innerHeight: 1 }, () => ({ backgroundColor: 'rgb(255, 255, 255)' }))).toThrow('no')
    expect(resume).toHaveBeenCalledOnce()
  })
})

describe('the text sent to the page', () => {
  it('is self-contained: no import, no helper of the bundler, and the engine and its kit as functions', () => {
    const call = readableEngineCall('start', { scheme: 'dark', fallbackCss: '' })
    expect(call).not.toMatch(/\bimport\b|__name|__vite|require\(/)
    expect(call.startsWith('(function readableEngine')).toBe(true)
    expect(call).toContain('(function readableKit')
    expect(call).toContain(JSON.stringify(READABLE_BUDGET))
  })

  it('keeps its state under the name the probe and the stop script read', () => {
    expect(readableEngineCall('stop')).toMatch(new RegExp(`["']${READABLE_STATE}["']`))
    expect(READABLE_STOP_SCRIPT).toContain(`globalThis.${READABLE_STATE}`)
    expect(DARK_PROBE_SCRIPT).toContain(`globalThis.${READABLE_STATE}`)
  })
})

// ---- the engine in a page ----

/** A page with a white body holding the given elements. */
function page(...children: FakeElement[]): FakeWindow {
  const win = fakeWindow()
  win.document.body.append(...children)
  return win
}
const p = (text: string, styles: Record<string, string> = {}) => new FakeElement('P', styles).append(text)
const ratioOf = (win: FakeWindow, el: FakeElement, bg: Rgb): number => kit.contrast(kit.parse(/color:([^;!]+)/.exec(declarationsOf(win, el))![1]!.trim())!, bg)
const ours = (win: FakeWindow) => win.document.adoptedStyleSheets

describe('the engine on a page', () => {
  it('starts: adopts the copies of the page’s sheets after them, then its own sheet with the colour scheme, and keeps its state in its world', () => {
    const win = page(p('hello'))
    const pageSheet = new FakeSheet()
    win.document.adoptedStyleSheets = [pageSheet]
    win.document.styleSheets = [{ cssRules: [rule('body', [['background-color', 'rgb(255, 255, 255)']])] }]
    const answer = runEngine(win, 'start', { scheme: 'dark' })
    expect(answer.ok).toBe(true)
    expect(ours(win)[0]).toBe(pageSheet)
    expect(ours(win)[1]!.text).toBe(`body{background-color:${WHITE_BG};}`)
    expect(ours(win).at(-1)!.text).toBe(':root{color-scheme:dark !important}')
    expect(win[READABLE_STATE]).toBeDefined()
    expect(runEngine(win, 'start', { scheme: 'dark' })).toMatchObject({ ok: true, already: true })
  })

  it('copies a linked sheet with its relative addresses read from the sheet, and a sheet of the page next to it with its own left alone', () => {
    const win = page(p('hello'))
    const icon = (selector: string) => rule(selector, [['background-image', 'url("../img/icon.png")']])
    // The same text in two sheets of two folders and in a `<style>` of the page: three different files.
    win.document.styleSheets = [{ href: 'https://site.example/static/css/site.css', cssRules: [icon('.a')] }, { href: 'https://cdn.example/lib/1.2/css/lib.css', cssRules: [icon('.b')] }, { href: null, cssRules: [icon('.c')] }]
    expect(runEngine(win, 'start', { scheme: 'dark' }).ok).toBe(true)
    expect(ours(win).slice(0, 3).map((sheet) => sheet.text)).toEqual([
      '.a{background-image:url("https://site.example/static/img/icon.png");}',
      '.b{background-image:url("https://cdn.example/lib/1.2/img/icon.png");}',
      '.c{background-image:url("../img/icon.png");}'
    ])
  })

  it('maps a background no sheet gave (an inline style, a colour attribute) with a rule of its own, and writes the text colour that reaches 4.5 : 1', () => {
    const box = new FakeElement('DIV', { 'background-color': 'rgb(255, 255, 255)' })
    const text = p('dark grey', { color: 'rgb(60, 60, 60)' })
    box.append(text)
    const win = page(box)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(declarationsOf(win, box)).toBe(`background-color:${WHITE_BG} !important`)
    expect(ratioOf(win, text, hex(WHITE_BG))).toBeGreaterThanOrEqual(4.5)
  })

  it('asks 3 : 1 only of large text (24 px, or 18.66 px bold), and nothing of text that reaches its target already', () => {
    // A grey band the page made dark already (kept as it is), with a light text on it: about 4.35 : 1.
    const dim = { color: 'rgb(190, 190, 190)', 'background-color': 'rgb(80, 80, 80)' }
    const big = p('big', { ...dim, 'font-size': '24px' })
    const bold = p('bold', { ...dim, 'font-size': '19px', 'font-weight': '700' })
    const small = p('small', dim)
    const fine = p('fine', { color: 'rgb(230, 230, 230)', 'background-color': 'rgb(30, 30, 30)' })
    const win = page(big, bold, small, fine)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(kit.contrast(rgb(190, 190, 190), rgb(80, 80, 80))).toBeGreaterThan(3.1)
    expect(kit.contrast(rgb(190, 190, 190), rgb(80, 80, 80))).toBeLessThan(4.5)
    expect(markOf(big)).toBeNull()
    expect(markOf(bold)).toBeNull()
    expect(ratioOf(win, small, rgb(80, 80, 80))).toBeGreaterThanOrEqual(4.5)
    expect(markOf(fine)).toBeNull()
  })

  it('leaves text over a picture alone (what is behind it is not known) and counts it', () => {
    const hero = new FakeElement('DIV', { 'background-image': 'url("photo.jpg")' })
    const text = p('caption', { color: 'rgb(90, 90, 90)' })
    hero.append(text)
    const win = page(hero)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(markOf(text)).toBeNull()
    expect(runEngine(win, 'stats').unknown).toBe(1)
  })

  it('checks a text again once an opaque background of its own is laid over a picture (a card on a photograph)', () => {
    const hero = new FakeElement('DIV', { 'background-image': 'url("photo.jpg")' })
    const card = new FakeElement('DIV', { 'background-color': 'rgb(40, 40, 40)' })
    const band = new FakeElement('DIV', { 'background-image': 'linear-gradient(rgb(40, 40, 40), rgb(60, 60, 60))' })
    const onCard = p('on the card', { color: 'rgb(110, 110, 110)', 'font-size': '30px' })
    const onBand = p('on the band', { color: 'rgb(110, 110, 110)', 'font-size': '30px' })
    card.append(onCard)
    band.append(onBand)
    hero.append(card, band)
    const win = page(hero)
    runEngine(win, 'start', { scheme: 'dark' })
    // rgb(110, 110, 110) is mapped light first (it is dark text in Dark), then held to 3 : 1 on the card and on the band.
    expect(ratioOf(win, onCard, rgb(40, 40, 40))).toBeGreaterThanOrEqual(3)
    expect(ratioOf(win, onBand, rgb(60, 60, 60))).toBeGreaterThanOrEqual(3)
    expect(runEngine(win, 'stats').unknown).toBe(0)
  })

  it('takes the stops of a gradient as what is behind a text, the worst of them', () => {
    // A dark gradient (kept as it is in Dark) under a light grey text: about 3.2 : 1 against its lighter stop.
    const band = new FakeElement('DIV', { 'background-image': 'linear-gradient(rgb(20, 20, 20), rgb(85, 85, 85))' })
    const text = p('on a gradient', { color: 'rgb(170, 170, 170)' })
    band.append(text)
    const win = page(band)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(ratioOf(win, text, rgb(85, 85, 85))).toBeGreaterThanOrEqual(4.5)
  })

  it('does not read what is not rendered (display: none), nor the inside of a picture, a frame or a large SVG', () => {
    const hidden = new FakeElement('DIV', { display: 'none' }).append(p('x', { color: 'rgb(0, 0, 0)' }))
    const frame = new FakeElement('IFRAME').append(p('x', { color: 'rgb(0, 0, 0)' }))
    const drawing = new FakeElement('svg', {}, SVG)
    drawing.setAttribute('viewBox', '0 0 800 600')
    const shape = new FakeElement('path', { fill: 'rgb(0, 0, 0)' }, SVG)
    drawing.append(shape)
    const win = page(hidden, frame, drawing)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(markOf(hidden.children[0]!)).toBeNull()
    expect(markOf(frame.children[0]!)).toBeNull()
    expect(markOf(shape)).toBeNull()
  })

  it('makes a single-colour icon stand out at 3 : 1 from what is behind it, and leaves a picture of several colours as it is', () => {
    const icon = (fills: string[]) => {
      const svg = new FakeElement('svg', {}, SVG)
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.append(...fills.map((fill) => new FakeElement('path', { fill }, SVG)))
      return svg
    }
    const mono = icon(['rgb(20, 20, 20)', 'rgb(20, 20, 20)'])
    const logo = icon(['rgb(20, 20, 20)', 'rgb(250, 200, 0)'])
    const win = page()
    win.document.body.styles = { 'background-color': 'rgb(24, 24, 24)' }
    win.document.body.append(mono, logo)
    runEngine(win, 'start', { scheme: 'dark' })
    const fill = /fill:([^;!]+)/.exec(declarationsOf(win, mono.children[0]!))
    expect(kit.contrast(kit.parse(fill![1]!.trim())!, rgb(24, 24, 24))).toBeGreaterThanOrEqual(3)
    expect(markOf(logo.children[0]!)).toBeNull()
  })

  it('gives the border of a form field that does not stand out the 3 : 1 of WCAG 1.4.11', () => {
    const field = new FakeElement('INPUT', { 'background-color': 'rgb(24, 24, 24)', 'border-bottom-width': '1px', 'border-bottom-style': 'solid', 'border-bottom-color': 'rgb(40, 40, 40)' })
    field.type = 'text'
    const win = page()
    win.document.body.styles = { 'background-color': 'rgb(24, 24, 24)' }
    win.document.body.append(field)
    runEngine(win, 'start', { scheme: 'dark' })
    const border = /border-bottom-color:([^;!]+)/.exec(declarationsOf(win, field))
    expect(kit.contrast(kit.parse(border![1]!.trim())!, rgb(24, 24, 24))).toBeGreaterThanOrEqual(3)
  })

  it('turns a picture of one dark colour on a transparent ground light in Dark (a logo, a formula), and leaves photographs and pictures of other sites', () => {
    const glyph = (pixels: number[][], src: string) => {
      const img = new FakeElement('IMG')
      Object.assign(img, { pixels, naturalWidth: 48, naturalHeight: 48, currentSrc: src })
      return img
    }
    const clear = [0, 0, 0, 0]
    const ink = [10, 10, 10, 255]
    const logo = glyph([...Array(1000).fill(clear), ...Array(1304).fill(ink)], 'logo.svg')
    const photo = glyph(Array(2304).fill([200, 120, 40, 255]), 'photo.jpg')
    const foreign = glyph([...Array(1000).fill(clear), ...Array(1304).fill(ink)], 'https://cdn.example/logo.svg')
    foreign.setAttribute('crossorigin-tainted', '')
    const win = page(logo, photo, foreign)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(declarationsOf(win, logo)).toBe('filter:invert(1) hue-rotate(180deg) !important')
    expect(markOf(photo)).toBeNull()
    expect(markOf(foreign)).toBeNull()
    expect(runEngine(win, 'stats')).toMatchObject({ images: 1, unreadImages: 1 })
  })

  it('reads the elements of an open shadow root, with the copies of its own sheets adopted in it', () => {
    const host = new FakeElement('X-CARD')
    const root = new FakeShadowRoot(host)
    host.shadowRoot = root
    const inner = p('in the shadow', { 'background-color': 'rgb(255, 255, 255)' })
    root.append(inner)
    root.styleSheets = [{ cssRules: [rule('.b', [['color', 'rgb(0, 0, 0)']])] } as unknown as FakeSheet]
    const win = page(host)
    runEngine(win, 'start', { scheme: 'dark' })
    flushIdle(win)
    expect(root.adoptedStyleSheets.map((s) => s.text)[0]).toMatch(/^\.b\{color:/)
    expect(root.adoptedStyleSheets.at(-1)).toBe(ours(win).at(-1))
    expect(markOf(inner)).not.toBeNull()
  })

  it('follows the page: an element added later is read in an idle slice, a class change reads the element again', () => {
    const win = page()
    runEngine(win, 'start', { scheme: 'dark' })
    const added = p('new', { 'background-color': 'rgb(250, 250, 250)' })
    win.document.body.append(added)
    const observer = FakeObserver.all[0]!
    observer.callback([{ type: 'childList', target: win.document.body, addedNodes: [added], removedNodes: [] }])
    expect(markOf(added)).toBeNull()
    flushIdle(win)
    expect(markOf(added)).not.toBeNull()
    // The page makes it dark itself: the mark goes once the class change is read.
    added.styles = { 'background-color': 'rgb(20, 20, 20)', color: 'rgb(240, 240, 240)' }
    observer.callback([{ type: 'attributes', attributeName: 'class', target: added, oldValue: '' }])
    flushIdle(win)
    expect(markOf(added)).toBeNull()
  })

  it('does not read again an element whose style attribute changed without a colour (an animation moves it sixty times a second)', () => {
    const moving = p('moving', { 'background-color': 'rgb(250, 250, 250)' })
    const win = page(moving)
    runEngine(win, 'start', { scheme: 'dark' })
    const scanned = runEngine(win, 'stats').scanned
    moving.setAttribute('style', 'transform: translateX(3px)')
    FakeObserver.all[0]!.callback([{ type: 'attributes', attributeName: 'style', target: moving, oldValue: 'transform: translateX(2px)' }])
    flushIdle(win)
    expect(runEngine(win, 'stats').scanned).toBe(scanned)
    moving.setAttribute('style', 'background: #fff')
    FakeObserver.all[0]!.callback([{ type: 'attributes', attributeName: 'style', target: moving, oldValue: '' }])
    flushIdle(win)
    expect(runEngine(win, 'stats').scanned).toBeGreaterThan(scanned)
  })

  it('reads a page longer than its budget in slices, and stops at the cap of elements of the first pass', () => {
    const many = Array.from({ length: 120 }, (_, i) => p(`line ${i}`, { color: 'rgb(0, 0, 0)' }))
    const win = page(...many)
    // Each read of a style takes 1 ms on this clock: the first slice (12 ms, the clock is read every 32 elements) cannot read them all.
    const read = win.getComputedStyle
    win.getComputedStyle = (el, pseudo) => ((win.clock += 1), read(el, pseudo))
    runEngine(win, 'start', { scheme: 'dark', budget: { maxElements: 80 } })
    expect(runEngine(win, 'stats').scanned).toBeLessThan(80)
    expect(win.idle.length).toBe(1)
    flushIdle(win)
    expect(runEngine(win, 'stats')).toMatchObject({ scanned: 80, capped: true, pending: 0 })
    expect(markOf(many.at(-1)!)).toBeNull()
  })

  it('stops reading elements on a page that keeps it too busy, and keeps its sheets', () => {
    const win = page(p('a'))
    runEngine(win, 'start', { scheme: 'dark', budget: { busyMs: 5 } })
    const read = win.getComputedStyle
    win.getComputedStyle = (el, pseudo) => ((win.clock += 3), read(el, pseudo))
    const added = Array.from({ length: 5 }, () => p('b'))
    win.document.body.append(...added)
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: added, removedNodes: [] }])
    flushIdle(win)
    expect(runEngine(win, 'stats').degraded).toBe(true)
    expect(ours(win).at(-1)!.text).toContain('color-scheme:dark')
    // What the page adds next is not read.
    const scanned = runEngine(win, 'stats').scanned
    const more = p('c', { 'background-color': 'rgb(255, 255, 255)' })
    win.document.body.append(more)
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [more], removedNodes: [] }])
    flushIdle(win)
    expect([runEngine(win, 'stats').scanned, markOf(more)]).toEqual([scanned, null])
  })

  /** A page that moves the background of one element by script: a new colour at each step, read again each time. */
  const animate = (win: FakeWindow, el: FakeElement, steps: number, from = 0): void => {
    for (let i = from; i < from + steps; i++) {
      el.styles = { 'background-color': `rgb(${200 + ((i * 7) % 56)}, ${200 + ((i * 13) % 56)}, ${200 + ((i * 29) % 56)})` }
      el.setAttribute('style', 'background: changed')
      FakeObserver.all[0]!.callback([{ type: 'attributes', attributeName: 'style', target: el, oldValue: '' }])
      flushIdle(win)
    }
  }

  it('writes a bounded number of rules for a page that changes a colour without end, then stops reading its elements', () => {
    const moving = p('moving', { 'background-color': 'rgb(250, 250, 250)' })
    const win = page(moving)
    runEngine(win, 'start', { scheme: 'dark', budget: { maxRules: 8 } })
    // The page as it starts takes two rules.
    expect(runEngine(win, 'stats')).toMatchObject({ rules: 2, degraded: false })
    animate(win, moving, 3)
    // Under the bound: every step got its rule, and the engine goes on.
    expect(runEngine(win, 'stats')).toMatchObject({ rules: 5, degraded: false })
    animate(win, moving, 40, 3)
    expect(runEngine(win, 'stats')).toMatchObject({ rules: 8, degraded: true })
    expect(ours(win).reduce((sum, sheet) => sum + sheet.cssRules.length, 0)).toBeLessThan(40)
    // The sheets stay, and what the page adds next is not read.
    expect(ours(win).at(-1)!.text).toContain('color-scheme:dark')
    const scanned = runEngine(win, 'stats').scanned
    const more = p('later', { 'background-color': 'rgb(255, 255, 255)' })
    win.document.body.append(more)
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [more], removedNodes: [] }])
    flushIdle(win)
    expect([runEngine(win, 'stats').scanned, markOf(more)]).toEqual([scanned, null])
  })

  it('gives a set of colours it already wrote to an element read at the bound: only a new rule is refused', () => {
    const first = p('first', { 'background-color': 'rgb(250, 250, 250)' })
    const twin = p('twin', { 'background-color': 'rgb(250, 250, 250)' })
    const win = page(first)
    runEngine(win, 'start', { scheme: 'dark', budget: { maxRules: 2 } })
    expect(runEngine(win, 'stats')).toMatchObject({ rules: 2, degraded: false })
    win.document.body.append(twin)
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [twin], removedNodes: [] }])
    flushIdle(win)
    expect(markOf(twin)).not.toBeNull()
    expect(markOf(twin)).toBe(markOf(first))
    expect(runEngine(win, 'stats')).toMatchObject({ rules: 2, degraded: false })
  })

  it('keeps a bounded number of colours in memory on such a page', () => {
    const moving = p('moving', { 'background-color': 'rgb(250, 250, 250)' })
    const win = page(moving)
    runEngine(win, 'start', { scheme: 'dark', budget: { maxRemembered: 8 } })
    animate(win, moving, 60)
    const { remembered, rules } = runEngine(win, 'stats')
    // The steps were all read (a rule each): what is bounded is the memory, not the work.
    expect(rules).toBeGreaterThan(50)
    expect(remembered).toBeLessThanOrEqual(8)
    expect(remembered).toBeGreaterThan(0)
  })

  it('keeps a bounded number of pictures and of sheet values in memory', () => {
    const clear = [0, 0, 0, 0]
    const ink = [10, 10, 10, 255]
    const logos = Array.from({ length: 12 }, (_, i) => {
      const img = new FakeElement('IMG')
      Object.assign(img, { pixels: [...Array(1000).fill(clear), ...Array(1304).fill(ink)], naturalWidth: 48, naturalHeight: 48, currentSrc: `logo-${i}.svg` })
      return img
    })
    const pictures = page(...logos)
    runEngine(pictures, 'start', { scheme: 'dark', budget: { maxRemembered: 4 } })
    expect(runEngine(pictures, 'stats')).toMatchObject({ images: 12 })
    expect(runEngine(pictures, 'stats').remembered).toBeLessThanOrEqual(4)

    const sheets = page(p('hello'))
    sheets.document.styleSheets = [{ cssRules: Array.from({ length: 12 }, (_, i) => rule(`.c${i}`, [['box-shadow', `0 0 ${i + 1}px rgb(${i * 20}, 10, 10)`]])) }]
    runEngine(sheets, 'start', { scheme: 'dark', budget: { maxRemembered: 4 } })
    expect(ours(sheets)[0]!.text).toContain('.c11{box-shadow:')
    expect(runEngine(sheets, 'stats').remembered).toBeLessThanOrEqual(4)
  })

  it('stops: takes its sheets and its marks off, and forgets its state', () => {
    const box = p('x', { 'background-color': 'rgb(255, 255, 255)' })
    const win = page(box)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(markOf(box)).not.toBeNull()
    expect(runEngine(win, 'stop')).toBe(true)
    expect(ours(win)).toEqual([])
    expect(markOf(box)).toBeNull()
    expect(win[READABLE_STATE]).toBeUndefined()
    expect(FakeObserver.all[0]!.connected).toBe(false)
    expect(runEngine(win, 'stop')).toBe(false)
  })

  it('switches scheme: a start for the other scheme takes the first one off before it starts', () => {
    const win = page(p('x'))
    runEngine(win, 'start', { scheme: 'dark' })
    expect(runEngine(win, 'start', { scheme: 'light' }).already).toBeUndefined()
    expect(ours(win).filter((s) => s.text.startsWith(':root')).map((s) => s.text)).toEqual([':root{color-scheme:light !important}'])
  })

  it('suspends for the probe: every sheet of its own off, then back as it was', () => {
    const win = page(p('x'))
    win.document.styleSheets = [{ cssRules: [rule('p', [['color', 'rgb(0, 0, 0)']])] }]
    runEngine(win, 'start', { scheme: 'dark' })
    const resume = (win[READABLE_STATE] as { suspend(): () => void }).suspend()
    expect(ours(win).every((s) => s.disabled)).toBe(true)
    resume()
    expect(ours(win).some((s) => s.disabled)).toBe(false)
  })

  it('answers a failure and leaves nothing behind when it cannot start (a sheet refused), so that the shell inverts the page instead', () => {
    const win = page(p('x', { 'background-color': 'rgb(255, 255, 255)' }))
    win.document.styleSheets = [{ cssRules: [rule('p', [['color', 'rgb(0, 0, 0)']])] }]
    FakeSheet.failing = true
    const answer = runEngine(win, 'start', { scheme: 'dark' })
    expect(answer).toEqual({ ok: false, reason: 'the browser refused the sheet' })
    expect(ours(win)).toEqual([])
    expect(win[READABLE_STATE]).toBeUndefined()
  })

  it('takes back what it had put on the page already when its first slice fails', () => {
    const win = page(p('x', { 'background-color': 'rgb(255, 255, 255)' }))
    win.document.styleSheets = [{ cssRules: [rule('p', [['color', 'rgb(0, 0, 0)']])] }]
    const read = win.getComputedStyle
    win.getComputedStyle = (el, pseudo) => {
      if (el.tagName === 'P') throw new Error('broken')
      return read(el, pseudo)
    }
    expect(runEngine(win, 'start', { scheme: 'dark' })).toEqual({ ok: false, reason: 'broken' })
    expect(ours(win)).toEqual([])
    expect(FakeObserver.all[0]!.connected).toBe(false)
    expect(win[READABLE_STATE]).toBeUndefined()
  })

  it('gives up when its stylesheets take longer than the budget of the start', () => {
    const win = page(p('x'))
    const slow = { get type() { return (win.clock += 100), 1 }, selectorText: '.s', style: style([['color', 'rgb(0, 0, 0)']]) }
    win.document.styleSheets = [{ cssRules: Array(200).fill(slow) }]
    const answer = runEngine(win, 'start', { scheme: 'dark', budget: { startMs: 500 } })
    expect(answer.ok).toBe(false)
    expect(answer.reason).toContain('500 ms')
    expect(ours(win)).toEqual([])
  })

  it('falls back to the inversion on the page itself when it fails after its start, and says so', () => {
    const box = p('x', { 'background-color': 'rgb(255, 255, 255)' })
    const win = page(box)
    runEngine(win, 'start', { scheme: 'dark', fallbackCss: 'html { filter: invert(1) }' })
    const added = p('y')
    win.document.body.append(added)
    win.getComputedStyle = () => {
      throw new Error('broken')
    }
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [added], removedNodes: [] }])
    flushIdle(win)
    expect(ours(win).map((s) => s.text)).toEqual(['html { filter: invert(1) }'])
    expect(markOf(box)).toBeNull()
    expect(win.warnings.join()).toContain('the recolouring stopped (broken)')
    expect(runEngine(win, 'stats').failed).toBe('broken')
    // A stop takes the inversion off too.
    runEngine(win, 'stop')
    expect(ours(win)).toEqual([])
  })

  it('counts a rule of its own the browser refuses, and goes on (the element keeps the colours it has)', () => {
    const win = page(p('x', { 'background-color': 'rgb(255, 255, 255)' }))
    FakeSheet.refusing = true
    expect(runEngine(win, 'start', { scheme: 'dark' }).ok).toBe(true)
    // The body's background and the paragraph's background and text: two rules, both refused.
    expect(runEngine(win, 'stats').rejected).toBe(2)
  })

  it('recovers a declaration the CSSOM lost from what an element of the page computes for it (a pseudo-element included)', () => {
    const win = page(new FakeElement('ASIDE'))
    win.pseudo.set('aside::after', { 'background-image': 'linear-gradient(rgba(255, 255, 255, 0), rgb(255, 255, 255))' })
    win.document.styleSheets = [{ cssRules: [rule('aside:-moz-focusring::after, aside::after', [['background-image', ''], ['background-repeat', 'no-repeat']]), rule('.nowhere::before', [['background-color', '']])] }]
    runEngine(win, 'start', { scheme: 'dark' })
    // The first part of the list is a selector this browser refuses: the next one is tried.
    expect(ours(win)[0]!.text).toBe(`aside:-moz-focusring::after, aside::after{background-image:linear-gradient(rgba(255, 255, 255, 0), ${WHITE_BG});}`)
    expect(runEngine(win, 'stats')).toMatchObject({ recovered: 1, unrecovered: 1 })
  })
})

describe('the engine and what the page does to it', () => {
  it('counts the opacity of a text in its contrast, and gives none to a text faded out of sight (an opacity near 0)', () => {
    const band = new FakeElement('DIV', { 'background-color': 'rgb(30, 30, 30)' })
    const faded = p('faded', { color: 'rgb(200, 200, 200)', opacity: '0.4' })
    const invisible = p('invisible', { color: 'rgb(200, 200, 200)', opacity: '0.01' })
    band.append(faded, invisible)
    const win = page(band)
    runEngine(win, 'start', { scheme: 'dark' })
    // rgb(200, 200, 200) has more than 4.5 : 1 on rgb(30, 30, 30), but not at 40 %: the faded text is made as light as it can be.
    expect(kit.contrast(rgb(200, 200, 200), rgb(30, 30, 30))).toBeGreaterThan(4.6)
    expect(declarationsOf(win, faded)).toBe('color:rgb(255, 255, 255) !important')
    expect(markOf(invisible)).toBeNull()
  })

  it('counts a colour it cannot read (a syntax the browser alone knows), and reads the element as having none', () => {
    const win = page(p('x', { 'background-color': 'color(rec2020 1 1 1)' }))
    expect(runEngine(win, 'start', { scheme: 'dark' }).ok).toBe(true)
    expect(runEngine(win, 'stats').unresolved).toBeGreaterThan(0)
  })

  it('leaves a picture over a background picture as it is (what is behind it is not known)', () => {
    const img = new FakeElement('IMG')
    Object.assign(img, { pixels: [...Array(1000).fill([0, 0, 0, 0]), ...Array(1304).fill([10, 10, 10, 255])], naturalWidth: 48, naturalHeight: 48, currentSrc: 'logo.svg' })
    const hero = new FakeElement('DIV', { 'background-image': 'url("hero.jpg")' }).append(img)
    const win = page(hero)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(markOf(img)).toBeNull()
  })

  it('leaves as they are a picture of one light colour, one of a strong dark colour, and one with no transparent ground', () => {
    const make = (pixels: number[][], src: string) => Object.assign(new FakeElement('IMG'), { pixels, naturalWidth: 48, naturalHeight: 48, currentSrc: src })
    const clear = Array(1000).fill([0, 0, 0, 0])
    const pale = make([...clear, ...Array(1304).fill([200, 200, 200, 255])], 'pale.svg')
    const navy = make([...clear, ...Array(1304).fill([20, 40, 160, 255])], 'navy.svg')
    const solid = make(Array(2304).fill([10, 10, 10, 255]), 'solid.png')
    const win = page(pale, navy, solid)
    runEngine(win, 'start', { scheme: 'dark' })
    expect([markOf(pale), markOf(navy), markOf(solid)]).toEqual([null, null, null])
  })

  it('reads a picture once it has loaded', () => {
    const img = Object.assign(new FakeElement('IMG'), { complete: false, pixels: [...Array(1000).fill([0, 0, 0, 0]), ...Array(1304).fill([10, 10, 10, 255])], naturalWidth: 48, naturalHeight: 48, currentSrc: 'late.svg' })
    const win = page(img)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(markOf(img)).toBeNull()
    img.complete = true
    ;(win.document.listeners.get('load') as (event: unknown) => void)({ target: img })
    flushIdle(win)
    expect(declarationsOf(win, img)).toContain('filter:invert(1)')
  })

  it('leaves a single-colour icon that stands out already, and a form field whose own background stands out', () => {
    const svg = new FakeElement('svg', {}, SVG)
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.append(new FakeElement('path', { fill: 'rgb(230, 230, 230)' }, SVG))
    // A strong blue the page gave its field (dark enough for the scheme): it stands out from the near black around it by more than 3 : 1.
    const blue = kit.fromOklch(0.52, 0.2, 260)
    expect(kit.contrast(blue, rgb(24, 24, 24))).toBeGreaterThan(3)
    const field = new FakeElement('INPUT', { 'background-color': kit.format(blue), color: 'rgb(255, 255, 255)', 'border-bottom-width': '1px', 'border-bottom-style': 'solid', 'border-bottom-color': 'rgb(40, 40, 40)' })
    field.type = 'text'
    const win = page()
    win.document.body.styles = { 'background-color': 'rgb(24, 24, 24)' }
    win.document.body.append(svg, field)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(markOf(svg.children[0]!)).toBeNull()
    expect(markOf(field)).toBeNull()
    // A field as dark as what is around it, whose border stands out already: nothing to give.
    const bordered = new FakeElement('INPUT', { 'background-color': 'rgb(24, 24, 24)', color: 'rgb(230, 230, 230)', 'border-bottom-width': '1px', 'border-bottom-style': 'solid', 'border-bottom-color': 'rgb(140, 140, 140)' })
    bordered.type = 'text'
    win.document.body.append(bordered)
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [bordered], removedNodes: [] }])
    flushIdle(win)
    expect(markOf(bordered)).toBeNull()
  })

  it('maps a light gradient no sheet gave, stop by stop', () => {
    const band = new FakeElement('DIV', { 'background-image': 'linear-gradient(rgb(255, 255, 255), rgb(238, 238, 238))' })
    const win = page(band)
    runEngine(win, 'start', { scheme: 'dark' })
    expect(declarationsOf(win, band)).toBe(`background-image:linear-gradient(${WHITE_BG}, ${kit.format(kit.recolour(hex('#eee'), 'bg', 'dark', 1))}) !important`)
  })

  it('does not read an element the page took away before its slice', () => {
    const win = page()
    runEngine(win, 'start', { scheme: 'dark' })
    const gone = p('gone', { 'background-color': 'rgb(255, 255, 255)' })
    win.document.body.append(gone)
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [gone], removedNodes: [] }])
    gone.connected = false
    flushIdle(win)
    expect(markOf(gone)).toBeNull()
  })

  it('stops at once even with a slice already asked for', () => {
    const win = page()
    runEngine(win, 'start', { scheme: 'dark' })
    const added = p('late', { 'background-color': 'rgb(255, 255, 255)' })
    win.document.body.append(added)
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [added], removedNodes: [] }])
    expect(win.idle).toHaveLength(1)
    runEngine(win, 'stop')
    flushIdle(win)
    expect(markOf(added)).toBeNull()
  })

  it('makes a new copy of a sheet a script added rules to (CSS-in-JS, no change of the DOM) at its next slice', () => {
    const rules = [rule('.a', [['color', 'rgb(0, 0, 0)']])]
    const win = page(p('x'))
    win.document.styleSheets = [{ cssRules: rules }]
    runEngine(win, 'start', { scheme: 'dark' })
    expect(ours(win)[0]!.text).not.toContain('.b{')
    rules.push(rule('.b', [['background-color', 'rgb(255, 255, 255)']]))
    win.document.body.append(p('y'))
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [], removedNodes: [] }])
    flushIdle(win)
    expect(ours(win)[0]!.text).toContain(`.b{background-color:${WHITE_BG};}`)
  })

  it('adopts its sheets again when the page takes them off (a page that sets its own list of adopted sheets)', () => {
    const win = page(p('x'))
    runEngine(win, 'start', { scheme: 'dark' })
    win.document.adoptedStyleSheets = []
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [], removedNodes: [] }])
    flushIdle(win)
    expect(ours(win).at(-1)!.text).toContain('color-scheme:dark')
  })

  it('does nothing once stopped, whatever the page does next', () => {
    const win = page(p('x'))
    runEngine(win, 'start', { scheme: 'dark' })
    runEngine(win, 'stop')
    const added = p('late', { 'background-color': 'rgb(255, 255, 255)' })
    win.document.body.append(added)
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [added], removedNodes: [] }])
    expect(win.idle).toEqual([])
    expect(markOf(added)).toBeNull()
  })

  it('starts again after a failure, even for the same scheme', () => {
    const win = page(p('x', { 'background-color': 'rgb(255, 255, 255)' }))
    runEngine(win, 'start', { scheme: 'dark' })
    const read = win.getComputedStyle
    win.getComputedStyle = () => {
      throw new Error('broken')
    }
    const added = p('y')
    win.document.body.append(added)
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [added], removedNodes: [] }])
    flushIdle(win)
    win.getComputedStyle = read
    const again = runEngine(win, 'start', { scheme: 'dark' })
    expect(again.ok).toBe(true)
    expect(again.already).toBeUndefined()
    expect(ours(win).map((s) => s.text)).not.toContain('html { filter: invert(1) }')
  })

  it('says so when even the inversion cannot be put on the page after a failure', () => {
    const win = page(p('x'))
    runEngine(win, 'start', { scheme: 'dark' })
    win.getComputedStyle = () => {
      throw new Error('broken')
    }
    FakeSheet.failing = true
    const added = p('y')
    win.document.body.append(added)
    FakeObserver.all[0]!.callback([{ type: 'childList', target: win.document.body, addedNodes: [added], removedNodes: [] }])
    flushIdle(win)
    expect(win.warnings.join()).toContain('the page keeps its own colours')
  })

  it('says so when a part of the page cannot be given its colours back', () => {
    const host = new FakeElement('X-CARD')
    const root = new FakeShadowRoot(host)
    host.shadowRoot = root
    root.append(p('in', { 'background-color': 'rgb(255, 255, 255)' }))
    const win = page(host)
    runEngine(win, 'start', { scheme: 'dark' })
    flushIdle(win)
    Object.defineProperty(root, 'adoptedStyleSheets', {
      get: () => [],
      set: () => {
        throw new Error('the root went away')
      }
    })
    runEngine(win, 'stop')
    expect(win.warnings.join()).toContain('could not be given its colours back: the root went away')
  })
})
