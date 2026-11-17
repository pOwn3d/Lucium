import { describe, expect, it } from 'vitest'
import { defaultSettings, type Settings } from './model'
import { NO_PAGE_TOOLS } from './page-tools'
import { anyToolWanted, pageToolsFor } from './page-tools-for'

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaultSettings(), ...patch })
const SITE = 'https://example.org/page'

describe('the tools of a page', () => {
  it('are none, the shared frozen none, while every tool is off', () => {
    expect(anyToolWanted(settings())).toBe(false)
    expect(pageToolsFor(settings(), SITE, true)).toBe(NO_PAGE_TOOLS)
  })

  it('carry the Vim keys when the setting is on and the site is not in the list', () => {
    expect(pageToolsFor(settings({ vimKeys: true }), SITE, false)).toEqual({ autoScroll: false, mouseGestures: false, scrollSync: false, vimKeys: true })
    expect(anyToolWanted(settings({ vimKeys: true }))).toBe(true)
  })

  it('leave the Vim keys off a site of the list, its subdomains too, and keep the other tools there', () => {
    const s = settings({ vimKeys: true, vimKeysExcludedHosts: ['example.org'], autoScroll: true })
    expect(pageToolsFor(s, SITE, false)).toEqual({ autoScroll: true, mouseGestures: false, scrollSync: false, vimKeys: false })
    expect(pageToolsFor(s, 'https://mail.example.org/', false).vimKeys).toBe(false)
    expect(pageToolsFor(s, 'https://example.com/', false).vimKeys).toBe(true)
  })

  it('keep the two lists apart: a site left out of the gestures still has the Vim keys, and the other way round', () => {
    const s = settings({ vimKeys: true, mouseGestures: true, mouseGestureExcludedHosts: ['example.org'], vimKeysExcludedHosts: ['example.com'] })
    expect(pageToolsFor(s, 'https://example.org/', false)).toMatchObject({ mouseGestures: false, vimKeys: true })
    expect(pageToolsFor(s, 'https://example.com/', false)).toMatchObject({ mouseGestures: true, vimKeys: false })
  })

  it('carry the scroll sync only for a pane of a split view that scrolls together', () => {
    expect(pageToolsFor(settings({ scrollSync: true }), SITE, true).scrollSync).toBe(true)
    expect(pageToolsFor(settings({ scrollSync: true }), SITE, false).scrollSync).toBe(false)
    expect(pageToolsFor(settings({ scrollSync: false }), SITE, true)).toBe(NO_PAGE_TOOLS)
  })
})
