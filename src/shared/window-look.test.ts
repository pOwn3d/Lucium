import { describe, expect, it } from 'vitest'
import { PAGE_MARGIN } from './ipc'
import { SIDEBAR_OPACITY_MIN, WINDOW_BORDER_DEFAULT, WINDOW_BORDER_MAX, WINDOW_VIBRANCIES, defaultSettings } from './model'
import { DEFAULT_WINDOW_LOOK_KEY, cleanWindowLook, isTranslucent, pageMargin, windowLookKey, windowLookVars, windowOpacity } from './window-look'
import { createInitialState, normalize, reduce, type Ctx } from './sidebar'

describe('the window keeps its defaults unless asked otherwise', () => {
  it('has an opaque window, a 10 px border and no hairline by default', () => {
    const s = defaultSettings()
    expect(s.windowVibrancy).toBe('none')
    expect(s.sidebarOpacity).toBe(100)
    expect(s.windowBorder).toBe(PAGE_MARGIN)
    expect(WINDOW_BORDER_DEFAULT).toBe(PAGE_MARGIN)
    expect(s.cardOutline).toBe(false)
    expect(pageMargin(s)).toBe(10)
    expect(isTranslucent(s)).toBe(false)
    expect(windowLookKey(s)).toBe(DEFAULT_WINDOW_LOOK_KEY)
  })

  it('gives the interface no variable at all, so its markup is the same as before these settings existed', () => {
    expect(windowLookVars(defaultSettings())).toEqual({})
  })

  it('gives it only what differs from the default window', () => {
    expect(windowLookVars({ ...defaultSettings(), windowBorder: 0 })).toEqual({ '--window-border': '0px' })
    expect(windowLookVars({ ...defaultSettings(), windowVibrancy: 'sidebar', sidebarOpacity: 60 })).toEqual({ '--window-alpha': '0.6' })
    expect(windowLookVars({ ...defaultSettings(), sidebarOpacity: 60 })).toEqual({})
    expect(windowLookVars({ ...defaultSettings(), cardOutline: true })).toEqual({ '--card-outline': 'rgb(255 255 255 / 0.16)' })
  })
})

describe('opacity', () => {
  it('only counts while a material is behind the window: without one it would only darken the window', () => {
    expect(windowOpacity({ windowVibrancy: 'none', sidebarOpacity: 50 })).toBe(1)
    expect(windowOpacity({ windowVibrancy: 'sidebar', sidebarOpacity: 50 })).toBe(0.5)
    expect(isTranslucent({ windowVibrancy: 'hud', sidebarOpacity: 100 })).toBe(false)
    expect(isTranslucent({ windowVibrancy: 'hud', sidebarOpacity: 99 })).toBe(true)
  })

  it('changes the look of the window itself only when the material or the translucency flips, not on each step of the slider', () => {
    const key = (windowVibrancy: 'none' | 'sidebar', sidebarOpacity: number) => windowLookKey({ windowVibrancy, sidebarOpacity })
    expect(key('sidebar', 80)).toBe(key('sidebar', 60))
    expect(key('sidebar', 80)).not.toBe(key('sidebar', 100))
    expect(key('sidebar', 80)).not.toBe(key('none', 80))
    expect(key('none', 60)).toBe(DEFAULT_WINDOW_LOOK_KEY)
  })
})

describe('the settings of a saved file', () => {
  it('keep every value in its range and every word in its list', () => {
    expect(cleanWindowLook({ windowVibrancy: 'sidebar', sidebarOpacity: 70.4, windowBorder: 4.6, cardOutline: true })).toEqual({ windowVibrancy: 'sidebar', sidebarOpacity: 70, windowBorder: 5, cardOutline: true })
    expect(cleanWindowLook({ windowVibrancy: 'ultra-thin-material', sidebarOpacity: 3, windowBorder: 999, cardOutline: 'yes' })).toEqual({
      windowVibrancy: 'none',
      sidebarOpacity: SIDEBAR_OPACITY_MIN,
      windowBorder: WINDOW_BORDER_MAX,
      cardOutline: false
    })
    expect(cleanWindowLook({ sidebarOpacity: NaN, windowBorder: -4 })).toMatchObject({ sidebarOpacity: 100, windowBorder: 0 })
    expect(cleanWindowLook({ windowBorder: '12' })).toMatchObject({ windowBorder: 10 })
  })

  it('offers the materials Electron knows by name', () => {
    expect(WINDOW_VIBRANCIES).toEqual(['none', 'sidebar', 'under-window', 'hud'])
  })

  it('go through the reducer and the loader cleaned', () => {
    const ctx: Ctx = { now: 1, newId: () => 'id' }
    const start = createInitialState(ctx)
    const updated = reduce(start, { type: 'settings/update', patch: { windowBorder: 400, windowVibrancy: 'sidebar', sidebarOpacity: 1 } }, ctx)
    expect(updated.settings).toMatchObject({ windowBorder: WINDOW_BORDER_MAX, windowVibrancy: 'sidebar', sidebarOpacity: SIDEBAR_OPACITY_MIN })
    const loaded = normalize({ ...start, settings: { ...start.settings, windowVibrancy: 'bogus' as never, windowBorder: Infinity } })
    expect(loaded.settings).toMatchObject({ windowVibrancy: 'none', windowBorder: 10 })
  })
})
