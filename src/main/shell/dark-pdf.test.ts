// The readable mode must not recolour a PDF. The address says so only when it ends with `.pdf`; a PDF served from
// `/download?id=3` is drawn by the viewer (a frame of its extension in the tab) and is a PDF by its MIME type, which the probe reads.
// And the shell's side of the readable mode: which pages are looked at, which get the engine, and when it is taken back (`applyDarkToPage`).

import { describe, expect, it, vi } from 'vitest'
import { DARK_PROBE_SCRIPT } from '@shared/dark-sites'
import { READABLE_STOP_SCRIPT } from '@shared/readable-engine'
import { defaultSettings, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The shell reaches Electron only when a method runs.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const LIGHT = { samples: [1, 1, 1, 1, 1], bare: false }

/**
 * A window with one tab on `url`, the readable mode on Dark for every site (or as `settings` say), and a page that answers the probe with `answer`
 * (in its readable world), starts the engine with `engine`, and has (or not) the viewer's frame. `now()` is what the page shows: the scheme of
 * the engine running, `inverted` for the way back, '' for its own colours.
 */
function windowOn(url: string, answer: unknown, viewerFrame: boolean, settings: Partial<Settings> = { readableMode: 'dark' }, systemDark = true, engine: unknown = { ok: true }) {
  const base = createInitialState({ now: 0, newId: () => 'x' })
  let state = { ...base, tabs: [{ id: 'tab1', url, title: 'T' }], settings: { ...defaultSettings(), ...settings } }
  const setSettings = (changes: Partial<Settings>) => void (state = { ...state, settings: { ...state.settings, ...changes } })
  const css: string[] = []
  let shown = ''
  const runReadable = vi.fn(async (code: string): Promise<unknown> => {
    if (code === DARK_PROBE_SCRIPT) {
      if (answer instanceof Error) throw answer
      return answer
    }
    if (code === READABLE_STOP_SCRIPT) {
      shown = ''
      return true
    }
    const scheme = /"scheme":"(\w+)"/.exec(code)?.[1] ?? '?'
    if ((engine as { ok?: unknown }).ok === true) shown = scheme
    return engine
  })
  const page = {
    applyCss: (given: string) => {
      css.push(given)
      if (given) shown = 'inverted'
      else if (shown === 'inverted') shown = ''
    },
    runReadable,
    showsPdfViewer: () => viewerFrame
  }
  const fake = fakeBrowser({ store: { get: () => state }, pages: new Map([['tab1', page]]), darkScans: new Map(), appliedDark: new Map(), systemDark })
  const run = async () => {
    shell.applyDarkToPage!.call(fake.self, 'tab1')
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const probes = () => runReadable.mock.calls.filter(([code]) => code === DARK_PROBE_SCRIPT).length
  const starts = () => runReadable.mock.calls.filter(([code]) => code.includes('"start"')).length
  return { run, css, page, setSettings, probes, starts, now: () => shown, scans: fake.self['darkScans'] as Map<string, number> }
}

describe('the readable mode and a PDF', () => {
  it('gives a light page the engine, in the page’s readable world', async () => {
    const w = windowOn('https://example.org/article', LIGHT, false)
    await w.run()
    expect(w.now()).toBe('dark')
    expect(w.starts()).toBe(1)
  })

  it('gives a PDF whose address does not end with .pdf nothing, because the frame of the viewer is in the tab (the page is not even looked at)', async () => {
    const w = windowOn('https://example.org/download?id=3', LIGHT, true)
    await w.run()
    expect(w.page.runReadable).not.toHaveBeenCalled()
    expect(w.now()).toBe('')
  })

  it('gives a PDF nothing when the viewer appears only after the page was looked at', async () => {
    const w = windowOn('https://example.org/download?id=3', LIGHT, false)
    let viewer = false
    w.page.showsPdfViewer = () => viewer
    w.page.runReadable.mockImplementation(async () => {
      viewer = true
      return LIGHT
    })
    await w.run()
    expect(w.starts()).toBe(0)
    expect(w.now()).toBe('')
  })

  it('gives a PDF nothing when the page says it is one by its MIME type, even if no frame of the viewer shows yet', async () => {
    const w = windowOn('https://example.org/download?id=3', { ...LIGHT, pdf: true }, false)
    await w.run()
    expect(w.probes()).toBe(1)
    expect(w.starts()).toBe(0)
  })

  it('takes the engine back from a tab that was light and goes to a PDF', async () => {
    const w = windowOn('https://example.org/download?id=3', LIGHT, false)
    await w.run()
    expect(w.now()).toBe('dark')
    w.page.showsPdfViewer = () => true
    await w.run()
    expect(w.now()).toBe('')
  })
})

const DARK = { samples: [0.01, 0.01, 0.01, 0.01, 0.01], bare: false }
const DARK_BARE = { samples: [0, 0, 0, 0, 0], bare: false, bareDark: true }

describe('what the readable mode does to a page, by the mode of its site and the look of the page', () => {
  const page = 'https://example.org/article'

  it('Dark: recolours a light page dark, and leaves a dark page alone', async () => {
    const light = windowOn(page, LIGHT, false, { readableMode: 'dark' })
    await light.run()
    expect(light.now()).toBe('dark')
    const dark = windowOn(page, DARK, false, { readableMode: 'dark' })
    await dark.run()
    expect([dark.now(), dark.starts()]).toEqual(['', 0])
  })

  it('Light: recolours a dark page light, and leaves a light page alone', async () => {
    const dark = windowOn(page, DARK, false, { readableMode: 'light' })
    await dark.run()
    expect(dark.now()).toBe('light')
    const light = windowOn(page, LIGHT, false, { readableMode: 'light' })
    await light.run()
    expect([light.now(), light.starts()]).toEqual(['', 0])
  })

  it('inverts the page instead when the engine fails on it, with the dark canvas first for a dark page with no background, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const w = windowOn(page, DARK_BARE, false, { readableMode: 'light' }, true, { ok: false, reason: 'the stylesheets took longer than 1500 ms' })
    await w.run()
    expect(w.now()).toBe('inverted')
    expect(w.css.at(-1)).toMatch(/^html \{ background-color: #121212; \}/)
    expect(warn.mock.calls.map(String).join()).toContain('the recolouring failed on tab tab1')
    warn.mockRestore()
  })

  it('costs nothing while every site is on Original: the page is not even counted as scanned', async () => {
    const w = windowOn(page, LIGHT, false, { readableMode: 'original', siteReadableMode: { 'example.org': 'original' } })
    await w.run()
    expect([w.scans.size, w.css, w.page.runReadable.mock.calls.length]).toEqual([0, [], 0])
    // …but a page that has the engine must still be reached when the last site goes back to Original, to take it off.
    w.setSettings({ readableMode: 'dark', siteReadableMode: {} })
    await w.run()
    expect(w.now()).toBe('dark')
    w.setSettings({ readableMode: 'original' })
    await w.run()
    expect(w.now()).toBe('')
  })

  it('Original: gives no page anything, and does not even look at it', async () => {
    const w = windowOn(page, LIGHT, false, { readableMode: 'original' })
    await w.run()
    expect(w.page.runReadable).not.toHaveBeenCalled()
    expect(w.css).toEqual([])
  })

  it('a site of its own mode wins over the default: Original spares a site under Dark, Dark reaches a site under Original', async () => {
    const spared = windowOn(page, LIGHT, false, { readableMode: 'dark', siteReadableMode: { 'example.org': 'original' } })
    await spared.run()
    expect(spared.page.runReadable).not.toHaveBeenCalled()
    const reached = windowOn(page, LIGHT, false, { readableMode: 'original', siteReadableMode: { 'example.org': 'dark' } })
    await reached.run()
    expect(reached.now()).toBe('dark')
  })

  it('Auto: follows the interface — Dark while it is dark, nothing (and no look at the page) while it is light', async () => {
    const night = windowOn(page, LIGHT, false, { readableMode: 'auto' }, true)
    await night.run()
    expect(night.now()).toBe('dark')
    const day = windowOn(page, LIGHT, false, { readableMode: 'auto' }, false)
    await day.run()
    expect(day.page.runReadable).not.toHaveBeenCalled()
    expect(day.css).toEqual([])
  })

  it('takes the engine back when the site goes back to Original, and starts it again when it is Dark again', async () => {
    const w = windowOn(page, LIGHT, false, { readableMode: 'original', siteReadableMode: { 'example.org': 'dark' } })
    await w.run()
    expect(w.now()).toBe('dark')
    w.setSettings({ readableMode: 'original', siteReadableMode: { 'example.org': 'original' } })
    await w.run()
    expect(w.now()).toBe('')
    w.setSettings({ readableMode: 'dark', siteReadableMode: {} })
    await w.run()
    expect(w.now()).toBe('dark')
  })

  it('does not start the engine again on a page that has it already (a refresh of every page after another site changed)', async () => {
    const w = windowOn(page, LIGHT, false, { readableMode: 'dark' })
    await w.run()
    await w.run()
    await w.run()
    expect([w.probes(), w.starts()]).toEqual([3, 1])
  })

  it('reads the page in its readable world: a page without one is left as it is, and the reason is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const w = windowOn(page, LIGHT, false, { readableMode: 'dark' })
    delete (w.page as { runReadable?: unknown }).runReadable
    await w.run()
    expect(w.css).toEqual([])
    expect(warn.mock.calls.map(String).join()).toContain('the page has no readable world')
    warn.mockRestore()
  })

  it('leaves a page that could not be read as it is: the engine it has stays, none is started on one that has none, and the reason is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const recoloured = windowOn(page, LIGHT, false, { readableMode: 'dark' })
    await recoloured.run()
    recoloured.page.runReadable.mockRejectedValue(new Error('blocked'))
    await recoloured.run()
    expect(recoloured.now()).toBe('dark')
    const bare = windowOn(page, LIGHT, false, { readableMode: 'dark' })
    bare.page.runReadable.mockRejectedValue(new Error('blocked'))
    await bare.run()
    expect([bare.now(), bare.css]).toEqual(['', []])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

// The toolbar button « Contraste de la page » does nothing on a PDF the viewer draws, whatever its address (`showsPdf`): the viewer's frame says so, the page is not run.
describe('telling a PDF the viewer draws, for the toolbar button', () => {
  const showsPdf = (w: { fake: Record<string, unknown> }, tabId = 'tab1') => shell.showsPdf!.call(w.fake, tabId) as boolean
  const windowFor = (viewerFrame: boolean) => {
    const w = windowOn('https://example.org/telecharger?id=12', LIGHT, viewerFrame, {})
    return { ...w, fake: fakeBrowser({ store: { get: () => ({}) }, pages: new Map([['tab1', w.page]]), darkScans: new Map(), appliedDark: new Map(), systemDark: true }).self }
  }

  it('says yes for the viewer’s frame, no for a page, and no for a tab with no page, without running anything in the page', () => {
    const viewer = windowFor(true)
    expect(showsPdf(viewer)).toBe(true)
    expect(viewer.page.runReadable).not.toHaveBeenCalled()
    expect(showsPdf(windowFor(false))).toBe(false)
    expect(showsPdf(windowFor(true), 'elsewhere')).toBe(false)
  })
})
