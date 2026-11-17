import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import type { DomHints } from '../blocking/filter-engine'
import type { PageEvents } from '../engine/types'
import { BlockerCss, type BlockerCssPage } from './blocker-css'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The shell reaches Electron only when a method runs.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const hints: DomHints = { classes: ['ad-slot'], ids: [], hrefs: [] }

function setup(patch: Partial<Settings> = {}) {
  let settings: Settings = { ...defaultSettings(), blockAds: true, blockCosmetic: true, ...patch }
  const given: string[] = []
  const skipped: string[] = []
  const scripts: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  const page: BlockerCssPage = {
    applyCss: (css) => void given.push(css),
    evaluate: () => new Promise((resolve, reject) => scripts.push({ resolve, reject }))
  }
  const cosmeticCss = vi.fn((url: string, _settings: Settings, dom?: DomHints) => `css(${new URL(url).hostname}${dom ? '+dom' : ''})`)
  const queued: Array<() => void> = []
  const css = new BlockerCss({ settings: () => settings, blocker: { cosmeticCss }, delays: [0, 1500, 5000], later: (run) => void queued.push(run), skipped: (key, reason) => void skipped.push(`${key}: ${reason}`) })
  return { css, page, given, skipped, scripts, queued, cosmeticCss, set: (next: Partial<Settings>) => void (settings = { ...settings, ...next }) }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the stylesheet that hides ads and banners on one page', () => {
  it('gives the rules of the site at once, and again only when they change', () => {
    const t = setup()
    t.css.apply('a', t.page, () => 'https://news.test/x', () => true)
    expect(t.given).toEqual(['css(news.test)'])
    t.css.apply('a', t.page, () => 'https://news.test/y', () => true)
    expect(t.given).toHaveLength(1)
    t.css.fresh('a')
    t.css.apply('a', t.page, () => 'https://news.test/y', () => true)
    expect(t.given).toHaveLength(2)
  })

  it('looks at the markup at each moment asked for and gives what its classes, ids and links call for', async () => {
    const t = setup()
    t.css.apply('a', t.page, () => 'https://news.test/x', () => true)
    expect(t.queued).toHaveLength(3)
    t.queued[0]!()
    t.scripts[0]!.resolve(hints)
    await flush()
    expect(t.given).toEqual(['css(news.test)', 'css(news.test+dom)'])
    expect(t.cosmeticCss).toHaveBeenLastCalledWith('https://news.test/x', expect.anything(), hints)
  })

  it('drops the answer of a scan that was overtaken: another document, or the page is gone', async () => {
    const t = setup()
    let current = true
    t.css.apply('a', t.page, () => 'https://news.test/x', () => current)
    t.queued[0]!()
    // A newer document starts before the scan of the older one answers.
    t.css.fresh('a')
    t.css.apply('a', t.page, () => 'https://news.test/z', () => current)
    t.scripts[0]!.resolve(hints)
    await flush()
    expect(t.given.filter((css) => css.includes('+dom'))).toEqual([])
    // The page itself is not the one the key answers to any more.
    t.queued[3]!()
    current = false
    t.scripts[1]!.resolve(hints)
    await flush()
    expect(t.given.filter((css) => css.includes('+dom'))).toEqual([])
  })

  it('says so when the page refuses the scan (it is navigating away), and leaves the page as it is', async () => {
    const t = setup()
    t.css.apply('peek-1', t.page, () => 'https://news.test/x', () => true)
    t.queued[0]!()
    t.scripts[0]!.reject(new Error('Script failed to execute'))
    await flush()
    expect(t.skipped).toEqual(['peek-1: Script failed to execute'])
    expect(t.given).toEqual(['css(news.test)'])
  })

  it('does not look at the markup when neither the hiding of ads nor the banners are on', () => {
    const t = setup({ blockCosmetic: false, blockCookieBanners: false })
    t.css.apply('a', t.page, () => 'https://news.test/x', () => true)
    expect(t.queued).toHaveLength(0)
    const banners = setup({ blockCosmetic: false, blockCookieBanners: true })
    banners.css.apply('a', banners.page, () => 'https://news.test/x', () => true)
    expect(banners.queued).toHaveLength(3)
  })

  // The gate is the blocker's (shared/blocker.ts): the ads and trackers switch is `blockAds` or its alias `blockTrackers`, either one.
  it.each([
    { blockAds: false, blockTrackers: false, looks: false },
    { blockAds: true, blockTrackers: false, looks: true },
    { blockAds: false, blockTrackers: true, looks: true },
    { blockAds: true, blockTrackers: true, looks: true }
  ])('looks at the markup for the ads when the ads and trackers switch is on (blockAds $blockAds, blockTrackers $blockTrackers): $looks', ({ looks, ...switches }) => {
    const t = setup({ ...switches, blockCosmetic: true, blockCookieBanners: false })
    t.css.apply('a', t.page, () => 'https://news.test/x', () => true)
    expect(t.queued).toHaveLength(looks ? 3 : 0)
  })

  it('does nothing for a page that has no address (it is gone), and forgets a page that is', () => {
    const t = setup()
    t.css.apply('a', t.page, () => undefined, () => true)
    expect(t.given).toEqual([])
    t.css.apply('a', t.page, () => 'https://news.test/x', () => true)
    t.css.forget('a')
    t.css.apply('a', t.page, () => 'https://news.test/x', () => true)
    expect(t.given).toHaveLength(2)
  })
})

// The preview runs here on a stand-in for the window (browser-fake.test-support.ts): the engine gives it a page and keeps the events of the page.
describe('the pages of a window that hide ads and banners', () => {
  function previewing() {
    const log: string[] = []
    const blockerCss = { fresh: vi.fn((id: string) => void log.push(`fresh:${id}`)), apply: vi.fn((id: string) => void log.push(`apply:${id}`)), forget: vi.fn((id: string) => void log.push(`forget:${id}`)) }
    let events: PageEvents | null = null
    const page = { id: 'peek-1', loadURL: () => {}, destroy: () => void log.push('destroy') }
    const state = createInitialState({ now: 0, newId: () => 'x' })
    const own: Record<string, unknown> = {
      blockerCss,
      peek: null,
      peekCounter: 0,
      options: {},
      store: { get: () => state },
      pageId: (id: string) => id,
      containerKeyOf: () => '',
      engine: { createPage: (_options: unknown, given: PageEvents) => ((events = given), page) }
    }
    const fake = fakeBrowser(own)
    shell['openPeek']!.call(fake.self, 'https://news.test/x')
    return { fake, own, log, blockerCss, page, events: () => events! }
  }

  it('are the tabs and the preview (Glance): the preview is not left with the ads and the cookie banners the tabs lose', () => {
    const t = previewing()
    t.events().domReady!()
    expect(t.log).toEqual(['fresh:peek-1', 'apply:peek-1'])
    const [, page, urlOf, isCurrent] = t.blockerCss.apply.mock.calls[0] as unknown as [string, unknown, () => string | undefined, () => boolean]
    expect(page).toBe(t.page)
    expect(urlOf()).toBe('https://news.test/x')
    expect(isCurrent()).toBe(true)
    // Another preview took its place: its answers are not for this page any more.
    t.own['peek'] = { page: {}, url: 'https://other.test/' }
    expect(urlOf()).toBeUndefined()
    expect(isCurrent()).toBe(false)
  })

  it('forget the preview with it: nothing is kept for a page that is gone', () => {
    const t = previewing()
    t.log.length = 0
    shell['destroyPeek']!.call(t.fake.self)
    expect(t.log).toEqual(['forget:peek-1', 'destroy'])
    expect(t.own['peek']).toBeNull()
  })

  // The mini windows and the windows of a web app hide what a tab hides and forget their page when they close: little.test.ts and web-apps.test.ts.
})
