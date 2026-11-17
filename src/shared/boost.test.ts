import { describe, expect, it } from 'vitest'
import {
  BOOST_FONTS,
  BOOST_SIZE_STEPS,
  HISTORY_LIMIT,
  PRIMARY_REST,
  SECONDARY_REST,
  boostIsModified,
  bundledFaceName,
  bundledFontsOf,
  cleanBoostExtras,
  combineBoosts,
  composeBoostCss,
  draftToInput,
  scriptPreview,
  scriptPreviewMessage,
  fontFaceScript,
  missingFacesScript,
  nextBoostName,
  nextTextCase,
  nextZoom,
  primaryPoint,
  primaryToTint,
  pushHistory,
  resetBoost,
  ringColors,
  secondaryPoint,
  secondaryToTint,
  shuffleTint,
  sizeColor,
  sizeLabel,
  sliderOf,
  textCaseLabel,
  tintWithSlider,
  zapScript,
  zapStopName,
  zapStopScript,
  zapSelectors,
  ZAP_FRAME,
  type BoostDraft
} from './boost'
import { setLanguage } from './i18n'
import { NEUTRAL_TINT, type Boost } from './model'
import { frenchSpaces } from './french-typography'

const boost = (patch: Partial<Boost>): Boost => ({ id: 'b', name: 'b', host: 'a.fr', enabled: true, css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT, ...patch })
const draft = (patch: Partial<BoostDraft> = {}): BoostDraft => ({ name: 'x', enabled: true, css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT, ...patch })

describe('composeBoostCss', () => {
  it('appends one hiding rule per erased element after the custom CSS', () => {
    expect(composeBoostCss(boost({ css: 'a { color: red }', zap: ['#ad', 'div.promo'] }))).toBe(
      'a { color: red }\n#ad { display: none !important; }\ndiv.promo { display: none !important; }'
    )
  })

  it('is empty when there is nothing to inject, and adds a colour filter only when it changes something', () => {
    expect(composeBoostCss(boost({ css: '  ' }))).toBe('')
    expect(composeBoostCss(boost({ tint: { hue: 90, saturation: 1.2, brightness: 1, contrast: 1 } }))).toBe(
      'html { filter: hue-rotate(90deg) saturate(1.2) brightness(1) contrast(1); }'
    )
  })

  it('forces the chosen font family on the text of the page, but not on code and icon fonts', () => {
    const css = composeBoostCss(boost({ fontFamily: 'georgia' }))
    expect(css).toContain('font-family: Georgia, "Times New Roman", serif !important;')
    expect(css).toContain(':not(code)')
    expect(css).toContain(':not([class*="icon" i])')
  })

  it('ignores a font id it does not know, so no stylesheet can be smuggled in through the field', () => {
    expect(composeBoostCss(boost({ fontFamily: 'x; } body { display: none' }))).toBe('')
    expect(composeBoostCss(boost({ fontFamily: '' }))).toBe('')
  })

  it('applies the chosen case with one text-transform rule, and ignores an unknown one', () => {
    expect(composeBoostCss(boost({ textCase: 'upper' }))).toBe('body, body * { text-transform: uppercase !important; }')
    expect(composeBoostCss(boost({ textCase: 'lower' }))).toContain('text-transform: lowercase')
    expect(composeBoostCss(boost({ textCase: 'capitalize' }))).toContain('text-transform: capitalize')
    expect(composeBoostCss(boost({ textCase: 'shout' as never }))).toBe('')
  })

  it('inverts the lightness of the page but gives pictures and videos their own colours back', () => {
    const css = composeBoostCss(boost({ invert: true }))
    expect(css).toBe('html { filter: invert(1) hue-rotate(180deg); }\nimg, video, picture, canvas, svg image { filter: invert(1) hue-rotate(180deg); }')
  })

  it('stacks the inversion and the colour filter in one filter, and only inverts for a real `true`', () => {
    const css = composeBoostCss(boost({ invert: true, tint: { hue: 30, saturation: 1, brightness: 1, contrast: 1 } }))
    expect(css).toContain('html { filter: invert(1) hue-rotate(180deg) hue-rotate(30deg) saturate(1) brightness(1) contrast(1); }')
    expect(composeBoostCss(boost({ invert: 'yes' as never }))).toBe('')
  })

  it('puts the custom CSS first, then the erased elements, the font, the case and the filter', () => {
    const css = composeBoostCss(boost({ css: 'p{}', zap: ['#a'], fontFamily: 'menlo', textCase: 'upper', tint: { hue: 10, saturation: 1, brightness: 1, contrast: 1 } }))
    const order = ['p{}', '#a {', 'font-family', 'text-transform', 'hue-rotate'].map((part) => css.indexOf(part))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})

describe('combineBoosts', () => {
  it('stacks the CSS in order, runs every script and lets the last non-100 % zoom win', () => {
    const combined = combineBoosts([
      boost({ css: 'a{}', js: 'one()', zoom: 1.5 }),
      boost({ css: 'b{}', js: '  ', zoom: 1 }),
      boost({ css: 'c{}', js: 'two()', zoom: 1.25 }),
      boost({ css: '', zoom: 1 })
    ])
    expect(combined).toEqual({ css: 'a{}\nb{}\nc{}', scripts: ['one()', 'two()'], zoom: 1.25 })
  })

  it('is neutral for no boost at all', () => {
    expect(combineBoosts([])).toEqual({ css: '', scripts: [], zoom: 1 })
  })

  it('runs the saved script only: the one being typed is never given to a page', () => {
    expect(combineBoosts([boost({ js: 'saved()', jsDraft: 'half(' }), boost({ js: '', jsDraft: 'typed()' })]).scripts).toEqual(['saved()'])
  })

  it('runs no script that does not show what it runs, even one kept by an earlier version', () => {
    for (const hidden of ['\u202E', '\u2066', '\u2028', '\u2029']) expect(combineBoosts([boost({ js: `a() // x${hidden}b()` })]).scripts, hidden.codePointAt(0)!.toString(16)).toEqual([])
    // Another invisible character is taken (the editor warns about it).
    expect(combineBoosts([boost({ js: 'a("x\u200By")' })]).scripts).toEqual(['a("x\u200By")'])
  })
})

describe('the preview of the script being typed', () => {
  const here = { matches: true, private: false }

  it('is the script of the field, or the saved one when nothing is being typed', () => {
    expect(scriptPreview(boost({ js: 'saved()', jsDraft: 'typed()' }), here, true)).toEqual({ ok: true, js: 'typed()' })
    expect(scriptPreview(boost({ js: 'saved()' }), here, true)).toEqual({ ok: true, js: 'saved()' })
  })

  it.each([
    ['no such Tweak', undefined, here, true, 'no-tweak'],
    ['an empty script', boost({ js: 'saved()', jsDraft: '  ' }), here, true, 'no-script'],
    ['a script that waits to be read and switched on', boost({ js: 'a()', jsEnabled: false }), here, true, 'waiting'],
    ['a script with a character that reorders a line', boost({ js: '', jsDraft: 'a(\u202E)' }), here, true, 'unreadable'],
    ['a script with a line end that is not drawn', boost({ js: '', jsDraft: '// x\u2028a()' }), here, true, 'unreadable'],
    ['no page shown', boost({ js: 'a()' }), undefined, true, 'no-page'],
    ['a page of another site', boost({ js: 'a()' }), { matches: false, private: false }, true, 'no-page'],
    ['a private tab', boost({ js: 'a()' }), { matches: true, private: true }, true, 'no-page'],
    ['the Tweaks switched off', boost({ js: 'a()' }), here, false, 'no-page']
  ] as const)('is refused for %s', (_name, tweak, page, enabled, reason) => {
    expect(scriptPreview(tweak, page, enabled)).toEqual({ ok: false, reason })
  })

  it('says in a sentence that it was started, or why it was not', () => {
    setLanguage('fr')
    const typed = boost({ js: '', jsDraft: 'a()\nb(\u202E)' })
    expect(scriptPreviewMessage({ ok: true, js: 'a()' }, typed)).toBe(frenchSpaces('Aperçu lancé dans la page affichée. Les autres pages exécutent toujours le script enregistré.'))
    expect(scriptPreviewMessage(scriptPreview(typed, here, true), typed)).toMatch(/^La ligne 2 contient des caractères qui changent le sens de lecture/)
    expect(scriptPreviewMessage({ ok: false, reason: 'no-page' }, typed)).toMatch(/^L’aperçu ne peut pas être lancé ici/)
    expect(scriptPreviewMessage({ ok: false, reason: 'waiting' }, typed)).toMatch(/^Ce script n’est pas exécuté/)
    expect(scriptPreviewMessage({ ok: false, reason: 'no-script' }, typed)).toBe(frenchSpaces('Il n’y a aucun script à lancer.'))
    expect(scriptPreviewMessage({ ok: false, reason: 'no-tweak' }, undefined)).toBe(frenchSpaces('Il n’y a aucun script à lancer.'))
  })
})

describe('fonts and case', () => {
  it('offers thirty families with distinct ids, each ending on a generic fallback', () => {
    expect(BOOST_FONTS).toHaveLength(30)
    expect(new Set(BOOST_FONTS.map((f) => f.id)).size).toBe(30)
    for (const font of BOOST_FONTS) expect(font.family).toMatch(/(sans-serif|serif|monospace|cursive)$/)
  })

  it('keeps the twenty system fonts of the grid first and unchanged, the bundled ones after them', () => {
    expect(BOOST_FONTS.slice(0, 20).every((f) => f.file === undefined)).toBe(true)
    expect(BOOST_FONTS.slice(20).every((f) => f.file !== undefined)).toBe(true)
    expect(BOOST_FONTS.slice(0, 3).map((f) => f.id)).toEqual(['system', 'helvetica', 'avenir'])
  })

  it('cleanBoostExtras keeps a known font, a known case and a true flag, and nothing else', () => {
    expect(cleanBoostExtras({ fontFamily: 'menlo', textCase: 'lower', invert: true })).toEqual({ fontFamily: 'menlo', textCase: 'lower', invert: true })
    expect(cleanBoostExtras({ fontFamily: 'comic', textCase: 'title', invert: 1 })).toEqual({})
    expect(cleanBoostExtras({ fontFamily: 7, textCase: null, invert: false })).toEqual({})
    expect(cleanBoostExtras({})).toEqual({})
  })

  it('the Case button goes upper, lower, capitalize, then back to the page\'s own case', () => {
    expect(nextTextCase(undefined)).toBe('upper')
    expect(nextTextCase('upper')).toBe('lower')
    expect(nextTextCase('lower')).toBe('capitalize')
    expect(nextTextCase('capitalize')).toBeUndefined()
    expect(['upper', 'lower', 'capitalize', undefined].map((c) => textCaseLabel(c as never))).toEqual(['AA', 'aa', 'Aa', 'Casse'])
  })
})

describe('bundled fonts', () => {
  const bundled = BOOST_FONTS.filter((f) => f.file !== undefined)

  it('carries ten, each asking for a file name made of lower case letters, digits and dashes', () => {
    expect(bundled).toHaveLength(10)
    for (const font of bundled) expect(font.file).toMatch(/^[a-z0-9-]+$/)
    expect(new Set(bundled.map((f) => f.file)).size).toBe(10)
  })

  it('names the face the page receives first in the font stack, so the page uses it before anything installed', () => {
    for (const font of bundled) {
      const face = bundledFaceName(font)
      expect(face).toBe(`Lucium ${font.label}`)
      expect(font.family.startsWith(`"${face}", `)).toBe(true)
    }
    expect(bundledFaceName(BOOST_FONTS[0]!)).toBeUndefined()
  })

  it('finds the bundled fonts a set of Tweaks asks for, once each, and ignores system fonts', () => {
    expect(bundledFontsOf([{ fontFamily: 'inter' }, { fontFamily: 'menlo' }, { fontFamily: 'inter' }, {}, { fontFamily: 'fraunces' }]).map((f) => f.id)).toEqual(['inter', 'fraunces'])
    expect(bundledFontsOf([{ fontFamily: 'georgia' }, {}])).toEqual([])
    expect(bundledFontsOf([{ fontFamily: 'not-a-font' }])).toEqual([])
  })

  it('puts the font stack of a bundled font in the rule of the Tweak', () => {
    const css = composeBoostCss({ css: '', zap: [], fontFamily: 'literata' })
    expect(css).toContain('"Lucium Literata", Literata, Georgia, serif')
  })

  it('builds a script that makes the face from the bytes, with the name and the data as quoted strings', () => {
    const script = fontFaceScript('Lucium Inter', 'AAEC')
    expect(script).toContain('new FontFace("Lucium Inter", bytes.buffer')
    expect(script).toContain('atob("AAEC")')
    expect(script).toContain('document.fonts.add(font)')
  })

  it('asks the page which of the faces its document does not have yet', () => {
    expect(missingFacesScript(['Lucium Inter', 'Lucium Fraunces'])).toContain('["Lucium Inter","Lucium Fraunces"].filter((face) => !have.has(face))')
  })

  it('the script of the missing faces runs as written: a face present with or without quotes is not asked for again', () => {
    const run = (families: string[], faces: string[]) => new Function('document', `return ${missingFacesScript(faces)}`)({ fonts: families.map((family) => ({ family })) })
    expect(run(['"Lucium Inter"'], ['Lucium Inter', 'Lucium Fraunces'])).toEqual(['Lucium Fraunces'])
    expect(run(['Lucium Inter'], ['Lucium Inter'])).toEqual([])
    expect(run([], ['Lucium Inter'])).toEqual(['Lucium Inter'])
  })
})

describe('Size button', () => {
  it('goes 100 %, 110 %… 150 %, then round to 100 %', () => {
    const seen = [1]
    for (let i = 0; i < 6; i++) seen.push(nextZoom(seen.at(-1)!))
    expect(seen).toEqual([1, 1.1, 1.2, 1.3, 1.4, 1.5, 1])
    expect(BOOST_SIZE_STEPS).toEqual([1, 1.1, 1.2, 1.3, 1.4, 1.5])
  })

  it('a zoom set elsewhere (a slider) joins the cycle: below 100 % it goes to 100 %, between steps to the next one', () => {
    expect(nextZoom(0.75)).toBe(1)
    expect(nextZoom(1.15)).toBe(1.2)
    expect(nextZoom(2)).toBe(1)
  })

  it('says "Taille" until the zoom changes, then the percentage', () => {
    expect(sizeLabel(1)).toBe('Taille')
    expect(sizeLabel(1.3)).toBe(frenchSpaces('130 %'))
    expect(sizeLabel(0.75)).toBe(frenchSpaces('75 %'))
  })

  it('says "Size" in an English interface', () => {
    setLanguage('en')
    try {
      expect(sizeLabel(1)).toBe('Size')
      expect(sizeLabel(1.3)).toBe('130%')
    } finally {
      setLanguage('fr')
    }
  })

  it('turns from orange at 110 % to red at 150 %, and has no colour at 100 % or less', () => {
    expect(sizeColor(1)).toBeNull()
    expect(sizeColor(0.8)).toBeNull()
    expect(sizeColor(1.1)).toBe('rgb(255, 159, 26)')
    expect(sizeColor(1.5)).toBe('rgb(245, 32, 15)')
    expect(sizeColor(1.3)).toBe('rgb(250, 96, 21)')
  })
})

describe('boost naming and state', () => {
  it('names a new Tweak after the first free "Ma Retouche", whatever the case', () => {
    expect(nextBoostName([])).toBe('Ma Retouche')
    expect(nextBoostName(['Ma Retouche'])).toBe('Ma Retouche 2')
    expect(nextBoostName(['ma retouche', 'Ma Retouche 2', 'Autre'])).toBe('Ma Retouche 3')
    expect(nextBoostName(['Ma Retouche 2'])).toBe('Ma Retouche')
  })

  it('numbers the next names in the language of the interface, not in French only', () => {
    setLanguage('en')
    try {
      expect(nextBoostName(['My Tweak'])).toBe('My Tweak 2')
    } finally {
      setLanguage('fr')
    }
  })

  it('is untouched until something changes the page, and every kind of change counts', () => {
    expect(boostIsModified(draft())).toBe(false)
    expect(boostIsModified(draft({ css: '  ', js: '\n' }))).toBe(false)
    const changes: Array<Partial<BoostDraft>> = [
      { css: 'a{}' },
      { js: 'x()' },
      { zoom: 1.1 },
      { zap: ['#a'] },
      { tint: { ...NEUTRAL_TINT, hue: 5 } },
      { fontFamily: 'menlo' },
      { textCase: 'upper' },
      { invert: true }
    ]
    for (const change of changes) expect(boostIsModified(draft(change)), JSON.stringify(change)).toBe(true)
  })

  it('"Réinitialiser" takes away every change but keeps the name and whether the Tweak is on', () => {
    const edited = draft({ name: 'Lecture', enabled: false, css: 'a{}', js: 'x()', zoom: 1.4, zap: ['#a'], tint: { ...NEUTRAL_TINT, hue: 40 }, fontFamily: 'menlo', textCase: 'upper', invert: true })
    const reset = resetBoost(edited)
    expect(reset).toEqual({ name: 'Lecture', enabled: false, css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT })
    expect(boostIsModified(reset)).toBe(false)
    // The editor merges the result over its draft: the optional fields must be named there, or they would survive the merge.
    const merged = { ...edited, ...reset }
    expect(merged.fontFamily).toBeUndefined()
    expect(merged.textCase).toBeUndefined()
    expect(merged.invert).toBeUndefined()
  })

  it('hands the draft to boost/save with the Tweak\'s identity', () => {
    expect(draftToInput('id1', 'a.fr', draft({ name: 'N', zoom: 1.2 }), '')).toMatchObject({ id: 'id1', host: 'a.fr', name: 'N', zoom: 1.2 })
    // What the field holds goes as the script being typed; the script the pages run stays the saved one.
    expect(draftToInput('id1', 'a.fr', draft({ js: 'half(' }), 'saved()')).toMatchObject({ js: 'saved()', jsDraft: 'half(' })
  })

  it('keeps the undo history bounded, dropping the oldest entries', () => {
    let history: number[] = []
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) history = pushHistory(history, i)
    expect(history).toHaveLength(HISTORY_LIMIT)
    expect(history[0]).toBe(5)
    expect(history.at(-1)).toBe(HISTORY_LIMIT + 4)
  })
})

describe('colour pad', () => {
  it('rests with the main handle right of centre, the small one lower left of it', () => {
    expect(primaryPoint(NEUTRAL_TINT)).toEqual(PRIMARY_REST)
    expect(secondaryPoint(NEUTRAL_TINT)).toEqual(SECONDARY_REST)
    expect(primaryToTint(NEUTRAL_TINT, PRIMARY_REST)).toEqual(NEUTRAL_TINT)
    expect(secondaryToTint(NEUTRAL_TINT, SECONDARY_REST)).toEqual(NEUTRAL_TINT)
  })

  it('the main handle sets hue along x and saturation up y, and leaves brightness and contrast alone', () => {
    const base = { ...NEUTRAL_TINT, brightness: 1.2, contrast: 0.8 }
    expect(primaryToTint(base, { x: 0, y: 0.5 })).toEqual({ ...base, hue: -180 })
    expect(primaryToTint(base, { x: 1, y: 0.5 })).toEqual({ ...base, hue: 180 })
    expect(primaryToTint(base, { x: 0.8, y: 0 }).saturation).toBe(2)
    expect(primaryToTint(base, { x: 0.8, y: 1 }).saturation).toBe(0)
  })

  it('the small handle sets contrast along x and brightness up y, and leaves hue and saturation alone', () => {
    const base = { ...NEUTRAL_TINT, hue: 40, saturation: 1.5 }
    expect(secondaryToTint(base, { x: 0, y: SECONDARY_REST.y })).toEqual({ ...base, contrast: 0.5 })
    expect(secondaryToTint(base, { x: 1, y: SECONDARY_REST.y })).toEqual({ ...base, contrast: 1.5 })
    expect(secondaryToTint(base, { x: SECONDARY_REST.x, y: 0 }).brightness).toBe(1.5)
    expect(secondaryToTint(base, { x: SECONDARY_REST.x, y: 1 }).brightness).toBe(0.5)
  })

  it('keeps a position inside the pad and each value inside its range', () => {
    const wild = primaryToTint(NEUTRAL_TINT, { x: -3, y: 9 })
    expect(wild).toMatchObject({ hue: -180, saturation: 0 })
    expect(secondaryToTint(NEUTRAL_TINT, { x: 7, y: -2 })).toMatchObject({ contrast: 1.5, brightness: 1.5 })
  })

  it('a position read back from a value lands where it was dragged to', () => {
    for (const point of [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.5 }, { x: 0.95, y: 0.9 }]) {
      const back = primaryPoint(primaryToTint(NEUTRAL_TINT, point))
      expect(back.x).toBeCloseTo(point.x, 1)
      expect(back.y).toBeCloseTo(point.y, 1)
    }
    for (const point of [{ x: 0.2, y: 0.1 }, { x: 0.71, y: 0.71 }, { x: 0.9, y: 0.95 }]) {
      const back = secondaryPoint(secondaryToTint(NEUTRAL_TINT, point))
      expect(back.x).toBeCloseTo(point.x, 1)
      expect(back.y).toBeCloseTo(point.y, 1)
    }
  })

  it('a value out of its range reads back at the edge of the pad', () => {
    expect(primaryPoint({ ...NEUTRAL_TINT, hue: 500, saturation: 9 })).toEqual({ x: 1, y: 0 })
    expect(primaryPoint({ ...NEUTRAL_TINT, hue: -500, saturation: -3 })).toEqual({ x: 0, y: 1 })
    expect(secondaryPoint({ ...NEUTRAL_TINT, contrast: -4, brightness: 7 })).toEqual({ x: 0, y: 0 })
    expect(secondaryPoint({ ...NEUTRAL_TINT, contrast: 9, brightness: -7 })).toEqual({ x: 1, y: 1 })
  })

  it('the ring is grey until a colour is chosen, then follows the hue', () => {
    expect(ringColors(NEUTRAL_TINT)).toEqual(['#373737', '#dcdcdc'])
    const [dark, light] = ringColors({ ...NEUTRAL_TINT, hue: 90 })
    expect(dark).toMatch(/^hsl\(270 /)
    expect(light).toMatch(/^hsl\(270 /)
  })
})

describe('advanced sliders', () => {
  it('rest in the middle and run from 0 to 100 over the range of each value', () => {
    for (const key of ['hue', 'saturation', 'brightness', 'contrast'] as const) {
      expect(sliderOf(key, NEUTRAL_TINT)).toBe(50)
      expect(tintWithSlider(NEUTRAL_TINT, key, 50)).toEqual(NEUTRAL_TINT)
    }
    expect(tintWithSlider(NEUTRAL_TINT, 'hue', 0).hue).toBe(-180)
    expect(tintWithSlider(NEUTRAL_TINT, 'hue', 100).hue).toBe(180)
    expect(tintWithSlider(NEUTRAL_TINT, 'saturation', 100).saturation).toBe(2)
    expect(tintWithSlider(NEUTRAL_TINT, 'brightness', 0).brightness).toBe(0.5)
    expect(tintWithSlider(NEUTRAL_TINT, 'contrast', 75).contrast).toBe(1.25)
  })

  it('changes one value and keeps the others, and clamps what is out of range', () => {
    const base = { hue: 20, saturation: 1.1, brightness: 0.9, contrast: 1.3 }
    expect(tintWithSlider(base, 'contrast', 40)).toEqual({ ...base, contrast: 0.9 })
    expect(tintWithSlider(base, 'hue', 500).hue).toBe(180)
    expect(tintWithSlider(base, 'hue', -20).hue).toBe(-180)
  })
})

describe('shuffleTint', () => {
  it('gives a look inside the ranges the editor allows, whatever the random numbers', () => {
    for (const r of [0, 0.25, 0.5, 0.999999]) {
      const tint = shuffleTint(() => r)
      expect(tint.hue).toBeGreaterThanOrEqual(-180)
      expect(tint.hue).toBeLessThanOrEqual(180)
      expect(tint.saturation).toBeGreaterThanOrEqual(0.6)
      expect(tint.saturation).toBeLessThanOrEqual(1.6)
      expect(tint.brightness).toBeGreaterThanOrEqual(0.9)
      expect(tint.brightness).toBeLessThanOrEqual(1.1)
      expect(tint.contrast).toBeGreaterThanOrEqual(0.9)
      expect(tint.contrast).toBeLessThanOrEqual(1.1)
    }
  })

  it('follows the random numbers it is given', () => {
    expect(shuffleTint(() => 0)).toEqual({ hue: -180, saturation: 0.6, brightness: 0.9, contrast: 0.9 })
    expect(shuffleTint(() => 0.5)).toEqual({ hue: 0, saturation: 1.1, brightness: 1, contrast: 1 })
  })
})

describe('Eraser mode (blue frame, hint, Terminé)', () => {
  it('joins the new selectors to the list, once each, in click order', () => {
    expect(zapSelectors(['#a'], ['#b', '#a'])).toEqual(['#b', '#a'])
    expect(zapSelectors([], ['div.x', 'p.y', 'div.x'])).toEqual(['div.x', 'p.y'])
  })

  it('keeps every form the picker writes: an id, a tag with classes and a position, up to four parts', () => {
    const written = ['#main', 'div', 'div.card.wide', 'li:nth-of-type(12)', 'ul.menu > li.item:nth-of-type(3)', '#page > div.col:nth-of-type(2) > section > p.lead.big:nth-of-type(1)']
    expect(zapSelectors([], written)).toEqual(written)
  })

  // The page runs the picker's script and answers with what it likes.
  it('drops what the picker never writes: a rule, a comma list, a pseudo-class, a part too many, an attribute', () => {
    const hostile = ['@import url(//evil.example/x.css)', 'a, b', 'div:hover', '*', 'body > div > div > div > div', 'a[href^="x"]', 'div.a.b.c', 'div > ', '#1x', 'x'.repeat(5) + '\\3a', 'div\n.x', '/* c */ div', 'div:nth-of-type(99999)', 'DIV.x']
    expect(zapSelectors(['#kept'], hostile)).toEqual(['#kept'])
    expect(zapSelectors([], ['div.ok', ...hostile, 'p.fine'])).toEqual(['div.ok', 'p.fine'])
  })

  it('does not trust what the page gives back', () => {
    expect(zapSelectors(['#a'], null)).toEqual(['#a'])
    expect(zapSelectors(['#a'], 'nope')).toEqual(['#a'])
    expect(zapSelectors([], [1, null, '', 'ok', { x: 1 }, 'a'.repeat(400)])).toEqual(['ok'])
    expect(zapSelectors([], Array.from({ length: 500 }, (_, i) => `div.n${i}`))).toHaveLength(200)
  })

  const STOP = zapStopName(() => Uint8Array.from({ length: 12 }, (_, i) => i * 17))

  /** A page with just what the Eraser touches: the script runs in it as it would in the page, with `window` for its globals. */
  function zapPage() {
    const listeners = new Map<string, unknown[]>()
    const part = () => ({ style: {} as Record<string, string>, addEventListener: () => undefined })
    const host = { style: {} as Record<string, string>, removed: false, attachShadow: () => ({ innerHTML: '', querySelector: part }), remove: () => void (host.removed = true) }
    const window: Record<string, unknown> = {}
    const scope = {
      window,
      document: { createElement: () => host, documentElement: { appendChild: () => undefined } },
      addEventListener: (type: string, fn: unknown) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      removeEventListener: (type: string, fn: unknown) => void listeners.set(type, (listeners.get(type) ?? []).filter((kept) => kept !== fn)),
      Element: class {}
    }
    const run = new Function('scope', 'script', 'with (scope) { return eval(script) }') as (scope: unknown, script: string) => unknown
    return { window, host, listening: () => [...listeners.values()].flat().length, run: (script: string) => run(scope, script) }
  }

  it('draws the name of the function that ends the Eraser: an underscore and the bytes it is given, never a fixed word', () => {
    expect(STOP).toBe('_00112233445566778899aabb')
    expect(zapStopName(() => new Uint8Array(12).fill(255))).toBe('_ffffffffffffffffffffffff')
  })

  it('leaves one global in the page while it erases, under the drawn name: nothing there names the application', async () => {
    const page = zapPage()
    const picked = page.run(zapScript(STOP)) as Promise<string[]>
    expect(Object.keys(page.window)).toEqual([STOP])
    expect(page.listening()).toBeGreaterThan(0)
    // The same name ends it from outside: the page is as it was, and the global is gone.
    page.run(zapStopScript(STOP))
    await expect(picked).resolves.toEqual([])
    expect(Object.keys(page.window)).toEqual([])
    expect(page.host.removed).toBe(true)
    expect(page.listening()).toBe(0)
    // Ending what is over is nothing to do.
    expect(() => page.run(zapStopScript(STOP))).not.toThrow()
  })

  it('refuses a name it did not draw, so that no text of a caller is written into the script of a page', () => {
    for (const name of ['', '__luciumZapStop', "x'];alert(1);['", '_00112233445566778899AABB', '_0011']) {
      expect(() => zapScript(name), name).toThrow(/zapStopName/)
      expect(() => zapStopScript(name), name).toThrow(/started with/)
    }
  })

  it('is a script that draws the blue frame and parses', () => {
    const script = zapScript(STOP)
    expect(script).toContain(ZAP_FRAME.color)
    expect(script).toContain('Terminé')
    // The regexes of the selector builder must reach the page with their single backslash.
    expect(script).toContain('[\\w-]')
    expect(() => new Function(`return ${script}`)).not.toThrow()
  })
})
