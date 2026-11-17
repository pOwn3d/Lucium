import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { linkTabMode, opensPeek, openTabMode } from './link-open'
import { planOpen } from './popup'

const defaults = defaultSettings()

describe('linkTabMode', () => {
  it('has the usual defaults: ⌘-click and middle click open behind, a link that opens a tab by itself opens in front', () => {
    expect(linkTabMode('background', defaults)).toBe('background')
    expect(linkTabMode('foreground', defaults)).toBe('foreground')
  })

  it('brings the tab of a ⌘-click or a middle click to the front when asked to', () => {
    expect(linkTabMode('background', { ...defaults, modifiedClickBackground: false })).toBe('foreground')
    // The other setting is not touched by it.
    expect(linkTabMode('foreground', { ...defaults, modifiedClickBackground: false })).toBe('foreground')
  })

  it('opens the tab of a link that opens one by itself behind when asked to', () => {
    expect(linkTabMode('foreground', { ...defaults, blankLinkBackground: true })).toBe('background')
    expect(linkTabMode('background', { ...defaults, blankLinkBackground: true })).toBe('background')
  })

  it('follows what Chromium reports through planOpen: a background-tab disposition is a modified click, a foreground-tab one is not', () => {
    const modified = planOpen({ disposition: 'background-tab', features: '' })
    const blank = planOpen({ disposition: 'foreground-tab', features: '' })
    expect(modified).toEqual({ kind: 'tab', mode: 'background' })
    expect(blank).toEqual({ kind: 'tab', mode: 'foreground' })
    const prefs = { modifiedClickBackground: false, blankLinkBackground: true }
    expect(linkTabMode(modified.kind === 'tab' && modified.mode !== 'peek' ? modified.mode : 'foreground', prefs)).toBe('foreground')
    expect(linkTabMode(blank.kind === 'tab' && blank.mode !== 'peek' ? blank.mode : 'foreground', prefs)).toBe('background')
  })

  it('keeps both settings as plain flags in the model, with those values by default', () => {
    expect([defaults.modifiedClickBackground, defaults.blankLinkBackground]).toEqual([true, false])
  })
})

describe('openTabMode', () => {
  const prefs = { modifiedClickBackground: false, blankLinkBackground: true }

  it('applies the settings to what a page asked for', () => {
    expect(openTabMode('background', true, prefs)).toBe('foreground')
    expect(openTabMode('foreground', true, prefs)).toBe('background')
  })

  it('keeps a choice made in a menu as it is, whatever the settings', () => {
    expect(openTabMode('background', false, prefs)).toBe('background')
    expect(openTabMode('foreground', false, prefs)).toBe('foreground')
  })

  it('never turns a Glance or a mini window into a tab', () => {
    for (const byPage of [true, false]) {
      expect(openTabMode('peek', byPage, prefs)).toBe('peek')
      expect(openTabMode('little', byPage, prefs)).toBe('little')
    }
  })
})

describe('opensPeek', () => {
  const peekPrefs = (peekWithShift: boolean, peekOnExternalLinks: boolean) => ({ peekWithShift, peekOnExternalLinks })

  it('lets “Coup d’œil avec Maj” decide for a Shift+click: a Glance with the option on, an ordinary tab with it off', () => {
    const shiftClick = { disposition: 'peek', byPage: true, external: false } as const
    expect(opensPeek(shiftClick, peekPrefs(true, false))).toBe(true)
    expect(opensPeek(shiftClick, peekPrefs(false, false))).toBe(false)
    expect(opensPeek(shiftClick, peekPrefs(false, true))).toBe(false)
  })

  it('always opens the preview for “Aperçu du lien (Coup d’œil)” of the page menu, whatever “Coup d’œil avec Maj” says', () => {
    for (const external of [true, false]) {
      for (const shift of [true, false]) {
        for (const onExternal of [true, false]) expect(opensPeek({ disposition: 'peek', byPage: false, external }, peekPrefs(shift, onExternal)), `${external} ${shift} ${onExternal}`).toBe(true)
      }
    }
  })

  it('opens a Glance for a link to another site that opens a tab by itself only when the option for other sites is on', () => {
    const toOtherSite = { disposition: 'foreground', byPage: true, external: true } as const
    expect(opensPeek(toOtherSite, peekPrefs(false, true))).toBe(true)
    expect(opensPeek(toOtherSite, peekPrefs(true, false))).toBe(false)
    // A link to the same site stays a tab, and so does a tab opened behind.
    expect(opensPeek({ ...toOtherSite, external: false }, peekPrefs(true, true))).toBe(false)
    expect(opensPeek({ disposition: 'background', byPage: true, external: true }, peekPrefs(true, true))).toBe(false)
  })

  it('keeps « Ouvrir le lien dans un nouvel onglet » of the menu of a link a tab, even to another site with the option for other sites on', () => {
    expect(opensPeek({ disposition: 'foreground', byPage: false, external: true }, peekPrefs(true, true))).toBe(false)
  })

  it('leaves a mini window to its own opener', () => {
    for (const byPage of [true, false]) expect(opensPeek({ disposition: 'little', byPage, external: true }, peekPrefs(true, true))).toBe(false)
  })
})
