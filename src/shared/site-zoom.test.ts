import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { createPrivateState, inheritedSettings, privateAction } from './private-window'
import { createInitialState, reduce, type Ctx } from './sidebar'
import { SITE_ZOOM_MAX, ZOOM_MAX, ZOOM_MIN, ZOOM_PRESETS, chosenZoomOf, cleanSiteZoom, siteZoomOf, stepZoom, withSiteZoom, zoomHostOf, zoomLabel, zoomMark, zoomSiteOf } from './site-zoom'
import { frenchSpaces } from './french-typography'
import { setLanguage } from './i18n'

const ctx: Ctx = { now: 0, newId: () => 'id' }

describe('stepZoom', () => {
  it('goes up and down the presets Chromium uses', () => {
    expect(stepZoom(1, 1)).toBe(1.1)
    expect(stepZoom(1.1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(0.9, -1)).toBe(0.8)
  })

  it('stays on the ends', () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
  })

  it('brings a factor beyond the ends back to them', () => {
    expect(stepZoom(9, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(0.1, -1)).toBe(ZOOM_MIN)
  })

  it('moves a factor between two presets to the next one on its side', () => {
    expect(stepZoom(1.18, 1)).toBe(1.25)
    expect(stepZoom(1.18, -1)).toBe(1.1)
  })

  it('treats a damaged factor as 100 %', () => {
    expect(stepZoom(Number.NaN, 1)).toBe(1.1)
    expect(stepZoom(Number.POSITIVE_INFINITY, -1)).toBe(0.9)
  })

  it('has 100 % among the presets, so ⌘0 and the steps agree', () => {
    expect(ZOOM_PRESETS).toContain(1)
    expect([...ZOOM_PRESETS].sort((a, b) => a - b)).toEqual([...ZOOM_PRESETS])
  })

  it('tells a factor in percent', () => {
    expect(zoomLabel(1.1)).toBe(frenchSpaces('110 %'))
    expect(zoomLabel(0.67)).toBe(frenchSpaces('67 %'))
  })

  it('writes it without a space in an English interface, on the label and on the mark of the toolbar', () => {
    setLanguage('en')
    try {
      expect(zoomLabel(1.1)).toBe('110%')
      expect(zoomMark({ showZoomIndicator: true, siteZoom: { 'example.com': 1.25 } }, 'https://example.com/page')).toBe('125%')
    } finally {
      setLanguage('fr')
    }
  })
})

describe('the site of an address', () => {
  it('is its host name without www, in lower case', () => {
    expect(zoomHostOf('https://www.Exemple.fr/a?b=1')).toBe('exemple.fr')
    expect(zoomHostOf('http://docs.exemple.fr:8080/')).toBe('docs.exemple.fr')
    expect(zoomHostOf('http://127.0.0.1:3000/')).toBe('127.0.0.1')
    expect(zoomHostOf('http://[::1]:3000/')).toBe('[::1]')
  })

  it('is none for an address without a host: such a page only zooms for as long as it is open', () => {
    expect(zoomHostOf('file:///tmp/a.html')).toBeNull()
    expect(zoomHostOf('about:blank')).toBeNull()
    expect(zoomHostOf('chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.html')).toBeNull()
    expect(zoomHostOf('pas une adresse')).toBeNull()
  })

  it('finds the remembered factor, 100 % otherwise', () => {
    const zoom = { 'exemple.fr': 1.25 }
    expect(siteZoomOf(zoom, 'https://www.exemple.fr/p')).toBe(1.25)
    expect(siteZoomOf(zoom, 'https://docs.exemple.fr/p')).toBe(1)
    expect(siteZoomOf(zoom, 'file:///a.html')).toBe(1)
    expect(siteZoomOf(undefined, 'https://exemple.fr/')).toBe(1)
  })
})

describe('what is remembered', () => {
  it('keeps a factor for a site, without touching the others or the map it was given', () => {
    const before = { 'a.fr': 1.5 }
    const after = withSiteZoom(before, 'b.fr', 1.1)
    expect(after).toEqual({ 'a.fr': 1.5, 'b.fr': 1.1 })
    expect(before).toEqual({ 'a.fr': 1.5 })
  })

  it('forgets a site that goes back to 100 % (⌘0)', () => {
    expect(withSiteZoom({ 'a.fr': 1.5, 'b.fr': 1.1 }, 'a.fr', 1)).toEqual({ 'b.fr': 1.1 })
  })

  it('keeps a factor in range', () => {
    expect(withSiteZoom({}, 'a.fr', 50)['a.fr']).toBe(ZOOM_MAX)
    expect(withSiteZoom({}, 'a.fr', 0.01)['a.fr']).toBe(ZOOM_MIN)
  })

  it('cleans a saved file: valid hosts and factors only, 100 % dropped', () => {
    expect(cleanSiteZoom({ 'a.fr': 1.5, 'b.fr': 1, 'c.fr': 99, 'd.fr': 'grand', 'e e': 2, '': 2, 'f.fr': Number.NaN, '[::1]': 0.5 })).toEqual({ 'a.fr': 1.5, '[::1]': 0.5 })
    expect(cleanSiteZoom(null)).toEqual({})
    expect(cleanSiteZoom([1.5])).toEqual({})
    expect(cleanSiteZoom('1.5')).toEqual({})
  })

  it('keeps the newest sites when there are too many', () => {
    const many = Object.fromEntries(Array.from({ length: SITE_ZOOM_MAX + 10 }, (_, i) => [`site${i}.fr`, 1.25]))
    const cleaned = cleanSiteZoom(many)
    expect(Object.keys(cleaned)).toHaveLength(SITE_ZOOM_MAX)
    expect(cleaned['site0.fr']).toBeUndefined()
    expect(cleaned[`site${SITE_ZOOM_MAX + 9}.fr`]).toBe(1.25)
  })
})

describe('the setting', () => {
  it('starts empty: every site at 100 %', () => {
    expect(defaultSettings().siteZoom).toEqual({})
  })

  it('goes through the reducer and is cleaned there', () => {
    const state = createInitialState(ctx)
    const set = reduce(state, { type: 'settings/update', patch: { siteZoom: { 'a.fr': 1.5, 'mauvais hôte': 2, 'b.fr': 7 } } }, ctx)
    expect(set.settings.siteZoom).toEqual({ 'a.fr': 1.5 })
  })
})

describe('in a private window', () => {
  it('starts from the main window’s zooms, then keeps its own: the zoom is a setting of the window', () => {
    const main = createInitialState(ctx)
    const withZoom = { ...main, settings: { ...main.settings, siteZoom: { 'a.fr': 1.5 } } }
    expect(createPrivateState(withZoom, ctx).settings.siteZoom).toEqual({ 'a.fr': 1.5 })
    expect('siteZoom' in inheritedSettings(withZoom.settings)).toBe(false)
  })

  it('accepts a zoom change (it lasts as long as the window: its state is never written)', () => {
    const action = privateAction({ type: 'settings/update', patch: { siteZoom: { 'a.fr': 1.25 }, blockAds: true } })
    expect(action).toEqual({ type: 'settings/update', patch: { siteZoom: { 'a.fr': 1.25 } } })
  })
})

describe('zoomMark', () => {
  const on = { showZoomIndicator: true, siteZoom: { 'example.com': 1.25, 'petit.fr': 0.8 } }

  it('says the zoom of the page while it is not at 100 %', () => {
    expect(zoomMark(on, 'https://example.com/page')).toBe(frenchSpaces('125 %'))
    expect(zoomMark(on, 'https://www.example.com/')).toBe(frenchSpaces('125 %'))
    expect(zoomMark(on, 'https://petit.fr/')).toBe(frenchSpaces('80 %'))
  })

  it('draws nothing at 100 %, for a page with no host, or without a page', () => {
    expect(zoomMark(on, 'https://autre.org/')).toBeNull()
    expect(zoomMark(on, 'file:///tmp/a.html')).toBeNull()
    expect(zoomMark(on, 'about:blank')).toBeNull()
    expect(zoomMark(on, undefined)).toBeNull()
    expect(zoomMark({ showZoomIndicator: true, siteZoom: { 'example.com': 1.0001 } }, 'https://example.com/')).toBeNull()
  })

  it('draws nothing while the setting is off, whatever the zoom', () => {
    expect(zoomMark({ ...on, showZoomIndicator: false }, 'https://example.com/')).toBeNull()
  })
})

describe('the zoom of a page that has no host', () => {
  const blank = { url: 'about:blank' }
  const site = { 'docs.google.com': 1.5 }

  it('is the tab’s own: about:blank (a window written by the page that opened it), a file, a private tab', () => {
    expect(zoomSiteOf(blank)).toBeNull()
    expect(zoomSiteOf({ url: 'file:///Users/me/notes.html' })).toBeNull()
    expect(zoomSiteOf({ url: 'https://docs.google.com/presentation/d/1', private: true })).toBeNull()
    expect(zoomSiteOf({ url: 'https://www.zoom.us/wc/1' })).toBe('zoom.us')
  })

  // Guard: ⌘+ on such a page steps from the zoom the tab has, and the factor applied is that one (not 100 %, not the zoom of a site).
  it('steps from the zoom the tab has, and is the factor given to its page', () => {
    let tabZoom: number | undefined
    for (const step of [1, 1] as const) tabZoom = stepZoom(chosenZoomOf(blank, site, tabZoom), step)
    expect(tabZoom).toBe(1.25)
    expect(chosenZoomOf(blank, site, tabZoom)).toBe(1.25)
    expect(chosenZoomOf(blank, site, undefined)).toBe(1)
  })

  it('leaves a page of a site with its site’s zoom, whatever the tab holds', () => {
    expect(chosenZoomOf({ url: 'https://docs.google.com/presentation/d/1' }, site, 2)).toBe(1.5)
    expect(chosenZoomOf({ url: 'https://docs.google.com/presentation/d/1', private: true }, site, 2)).toBe(2)
  })
})
