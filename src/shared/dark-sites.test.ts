import { describe, expect, it, vi } from 'vitest'
import { composeBoostCss } from './boost'
import { DARK_PAGE_LUMINANCE, DARK_PROBE_SCRIPT, DARK_TINT, applyReadable, invertCss, pageLooksDark, probePage, readableKey, readablePlan, readableStarted, type DarkVerdict, type PageLook, type ReadablePlan } from './dark-sites'
import { READABLE_STOP_SCRIPT } from './readable-engine'
import { READABLE_MODES } from './readable-mode'

describe('the stylesheet', () => {
  it('is the Tweak inversion with a softer contrast, images and videos turned back', () => {
    const css = invertCss()
    expect(css).toContain(composeBoostCss({ css: '', zap: [], invert: true, tint: { ...DARK_TINT } }))
    expect(css).toMatch(/html \{ filter: invert\(1\) hue-rotate\(180deg\) .*contrast\(0\.9\); \}/)
    expect(css).toMatch(/img, video, picture, canvas, svg image \{ filter: invert\(1\) hue-rotate\(180deg\); \}/)
    expect(css).toContain('iframe[src*="youtube.com"]')
    expect(css).not.toContain('background-color')
  })

  it('gives a page with no background the colour of the browser’s canvas first, so that the filter has something to turn', () => {
    expect(invertCss({ canvas: 'light' }).startsWith('html { background-color: #fff; }')).toBe(true)
    expect(invertCss({ canvas: 'dark' }).startsWith('html { background-color: #121212; }')).toBe(true)
    for (const canvas of ['light', 'dark'] as const) expect(invertCss({ canvas })).toContain(invertCss())
  })
})

describe('telling a dark page from a light one', () => {
  it('calls a page dark when most of what is behind the samples is darker than white text can read on at 4.5 : 1', () => {
    expect(DARK_PAGE_LUMINANCE).toBeCloseTo(0.18, 2)
    expect(pageLooksDark([0.01, 0.01, 0.01, 0.01, 0.01])).toBe(true)
    expect(pageLooksDark([1, 1, 1, 1, 1])).toBe(false)
    // The median decides: a dark header over a light page is a light page, a light card on a dark page is a dark page.
    expect(pageLooksDark([1, 0.02, 0.02, 1, 1])).toBe(false)
    expect(pageLooksDark([0.02, 1, 0.02, 0.02, 1])).toBe(true)
  })

  it('does not trust what the page answers: anything unreadable is a light page, never a reason to skip the filter by accident or to crash', () => {
    for (const answer of [undefined, null, 'dark', {}, [], [NaN], [-1], [2], ['0'], new Array(50).fill(0), [0, 0, 'x']]) expect(pageLooksDark(answer), JSON.stringify(answer)).toBe(false)
  })

  it('logs the page it could not read, and leaves it alone', async () => {
    const warn = vi.fn()
    const verdict = await probePage(() => Promise.reject(new Error('Script failed to execute')), warn, 'tab t-1')
    expect(verdict).toEqual({ verdict: 'unknown', bare: false, bareDark: false })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('tab t-1')
    expect(warn.mock.calls[0]![0]).toContain('Script failed to execute')
    expect(await probePage(() => Promise.resolve({ samples: [1, 1, 1, 1, 1], bare: false }), warn, 'tab t-1')).toEqual({ verdict: 'light', bare: false, bareDark: false })
    expect(await probePage(() => Promise.resolve({ samples: [0, 0, 0, 0, 0], bare: false }), warn, 'tab t-1')).toEqual({ verdict: 'dark', bare: false, bareDark: false })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does not take a page’s answer for more than it is: only a real true says the page has no background', async () => {
    const warn = vi.fn()
    expect((await probePage(() => Promise.resolve({ samples: [1, 1, 1, 1, 1], bare: true }), warn, 't')).bare).toBe(true)
    for (const bare of ['true', 1, {}, null]) expect((await probePage(() => Promise.resolve({ samples: [1, 1, 1, 1, 1], bare }), warn, 't')).bare).toBe(false)
    expect(await probePage(() => Promise.resolve('dark'), warn, 't')).toEqual({ verdict: 'light', bare: false, bareDark: false })
    expect(await probePage(() => Promise.resolve(null), warn, 't')).toEqual({ verdict: 'light', bare: false, bareDark: false })
  })

  it('trusts the page’s word that its canvas is dark only for a real true, as for the white one', async () => {
    const warn = vi.fn()
    expect((await probePage(() => Promise.resolve({ samples: [0, 0, 0, 0, 0], bareDark: true }), warn, 't')).bareDark).toBe(true)
    for (const bareDark of ['true', 1, {}, null, false]) expect((await probePage(() => Promise.resolve({ samples: [0, 0, 0, 0, 0], bareDark }), warn, 't')).bareDark).toBe(false)
    expect(await probePage(() => Promise.resolve({ samples: [0, 0, 0, 0, 0], bareDark: true, pdf: true }), warn, 't')).toEqual({ verdict: 'pdf', bare: false, bareDark: false })
  })

  it('tells a PDF by what the page says of its MIME type, and only for a real true', async () => {
    const warn = vi.fn()
    expect(await probePage(() => Promise.resolve({ samples: [1, 1, 1, 1, 1], bare: true, pdf: true }), warn, 't')).toEqual({ verdict: 'pdf', bare: false, bareDark: false })
    for (const pdf of ['true', 1, {}, null, false]) expect((await probePage(() => Promise.resolve({ samples: [1, 1, 1, 1, 1], bare: false, pdf }), warn, 't')).verdict).toBe('light')
  })
})

// The probe runs in a page: here it runs against a small stand-in for the DOM, to check how it walks up from an element.
interface FakeNode {
  style: { backgroundColor: string; backgroundImage: string }
  parentElement: FakeNode | null
}
const node = (backgroundColor: string, parentElement: FakeNode | null = null, backgroundImage = 'none'): FakeNode => ({ style: { backgroundColor, backgroundImage }, parentElement })

function probe(hit: (x: number, y: number) => FakeNode | null, colorScheme = 'normal', html = node('rgba(0, 0, 0, 0)'), body = node('rgba(0, 0, 0, 0)'), contentType = 'text/html'): { samples: number[]; bare: boolean; bareDark: boolean; pdf: boolean } {
  const documentElement = { style: { colorScheme, ...html.style } }
  const run = new Function('document', 'window', 'getComputedStyle', `return ${DARK_PROBE_SCRIPT}`)
  return run(
    { documentElement, body, contentType, elementFromPoint: hit },
    { innerWidth: 1000, innerHeight: 800 },
    (el: { style: Record<string, string> }) => ({ colorScheme: 'normal', backgroundImage: 'none', ...el.style })
  ) as { samples: number[]; bare: boolean; bareDark: boolean; pdf: boolean }
}
const runProbe = (hit: (x: number, y: number) => FakeNode | null, colorScheme = 'normal') => probe(hit, colorScheme).samples

describe('the probe that runs in the page', () => {
  it('finds the first opaque background above the element under each point', () => {
    const body = node('rgb(255, 255, 255)')
    const card = node('rgba(0, 0, 0, 0)', body)
    expect(runProbe(() => card)).toEqual([1, 1, 1, 1, 1])
    const dark = node('rgb(17, 17, 17)')
    const text = node('rgba(0, 0, 0, 0)', dark)
    const samples = runProbe(() => text)
    expect(samples.every((v) => v > 0 && v < 0.01)).toBe(true)
  })

  it('takes a page with no background at all for the white canvas, and a dark colour scheme for a dark one', () => {
    const bare = node('rgba(0, 0, 0, 0)')
    expect(runProbe(() => bare)).toEqual([1, 1, 1, 1, 1])
    expect(runProbe(() => bare, 'dark')).toEqual([0, 0, 0, 0, 0])
    expect(runProbe(() => null)).toEqual([1, 1, 1, 1, 1])
  })

  it('counts a background image with no colour under it as light, and the colour when there is one', () => {
    expect(runProbe(() => node('rgba(0, 0, 0, 0)', null, 'url(a.png)'))).toEqual([1, 1, 1, 1, 1])
    expect(runProbe(() => node('rgb(0, 0, 0)', null, 'url(a.png)'))).toEqual([0, 0, 0, 0, 0])
  })

  it('takes the background of the body for the canvas when the walk reaches the root (a short body leaves the root under the points)', () => {
    const root = node('rgba(0, 0, 0, 0)')
    const darkBody = node('rgb(16, 16, 24)')
    const found = probe(() => root, 'normal', node('rgba(0, 0, 0, 0)'), darkBody)
    expect(found.samples.every((v) => v < 0.01)).toBe(true)
    expect(found.bare).toBe(false)
    expect(probe(() => root, 'normal', node('rgb(255, 255, 255)'), node('rgba(0, 0, 0, 0)')).bare).toBe(false)
  })

  it('says a page is bare when neither the root nor the body paints anything, and a dark colour scheme is not bare but bare dark', () => {
    const root = node('rgba(0, 0, 0, 0)')
    expect([probe(() => root).bare, probe(() => root).bareDark]).toEqual([true, false])
    expect([probe(() => root, 'dark').bare, probe(() => root, 'dark').bareDark]).toEqual([false, true])
    // A page that paints its own background is neither: its canvas is its background.
    const painted = node('rgb(16, 16, 24)')
    expect([probe(() => painted, 'dark', painted, painted).bare, probe(() => painted, 'dark', painted, painted).bareDark]).toEqual([false, false])
  })

  it('says a document is a PDF by its MIME type, whatever its address, and a page of HTML is not', () => {
    const root = node('rgb(255, 255, 255)')
    expect(probe(() => root).pdf).toBe(false)
    expect(probe(() => root, 'normal', root, root, 'application/pdf').pdf).toBe(true)
    expect(probe(() => root, 'normal', root, root, 'application/pdf-not').pdf).toBe(false)
  })

  it('reads the modern colour syntax too', () => {
    expect(runProbe(() => node('rgb(0 0 0 / 0.9)'))).toEqual([0, 0, 0, 0, 0])
    expect(runProbe(() => node('rgb(0 0 0 / 0.1)'))).toEqual([1, 1, 1, 1, 1])
  })
})

describe('what a mode gives a page (the seam of the readable mode)', () => {
  const look = (verdict: DarkVerdict, canvas: 'white' | 'dark' | 'painted' = 'painted'): PageLook => ({ verdict, bare: canvas === 'white', bareDark: canvas === 'dark' })
  const inverted = invertCss()

  it('gives Original nothing, whatever the page is', () => {
    for (const verdict of ['light', 'dark', 'unknown', 'pdf'] as const) expect(readablePlan('original', look(verdict)), verdict).toBeNull()
  })

  it('recolours a light page dark in Dark, and leaves a dark page alone', () => {
    expect(readablePlan('dark', look('light'))).toEqual({ scheme: 'dark', fallbackCss: inverted })
    expect(readablePlan('dark', look('dark'))).toBeNull()
  })

  it('recolours a dark page light in Light, and leaves a light page alone', () => {
    expect(readablePlan('light', look('dark'))).toEqual({ scheme: 'light', fallbackCss: inverted })
    expect(readablePlan('light', look('light'))).toBeNull()
  })

  it('leaves a PDF and a page that could not be read as they are, in every mode', () => {
    for (const mode of READABLE_MODES) for (const verdict of ['pdf', 'unknown'] as const) expect(readablePlan(mode, look(verdict)), `${mode} ${verdict}`).toBeNull()
  })

  it('gives the way back (the inversion) the colour of the canvas that shows, only for the mode that turns that page', () => {
    expect(readablePlan('dark', look('light', 'white'))?.fallbackCss).toBe(invertCss({ canvas: 'light' }))
    expect(readablePlan('light', look('dark', 'dark'))?.fallbackCss).toBe(invertCss({ canvas: 'dark' }))
    // The canvas flags of the other colour do not leak into a sheet.
    expect(readablePlan('dark', look('light', 'dark'))?.fallbackCss).toBe(inverted)
    expect(readablePlan('light', look('dark', 'white'))?.fallbackCss).toBe(inverted)
  })

  it('remembers a plan by its scheme and its way back, and nothing as the empty key', () => {
    expect(readableKey(null)).toBe('')
    const dark = readablePlan('dark', look('light'))
    expect(readableKey(dark)).toBe(readableKey(readablePlan('dark', look('light'))))
    expect(readableKey(dark)).not.toBe(readableKey(readablePlan('dark', look('light', 'white'))))
    expect(readableKey(dark)).not.toBe(readableKey(readablePlan('light', look('dark'))))
  })
})

describe('giving a page its plan', () => {
  const plan: ReadablePlan = { scheme: 'dark', fallbackCss: invertCss() }
  /** A page that answers the engine's start with `answer` (or throws it), and records its stylesheet slot and the scripts it ran. */
  function target(answer: unknown | Error) {
    const css: string[] = []
    const ran: string[] = []
    return {
      css,
      ran,
      applyCss: (text: string) => void css.push(text),
      run: async (code: string) => {
        ran.push(code)
        if (code === READABLE_STOP_SCRIPT) return true
        if (answer instanceof Error) throw answer
        return answer
      }
    }
  }
  const options = (warn = vi.fn(), current = () => true, had = false) => ({ had, current, warn, context: 'tab t-1' })

  it('starts the engine in the page for the scheme of the plan, with its way back, and gives no inversion while the engine runs', async () => {
    const page = target({ ok: true, startMs: 4 })
    expect(await applyReadable(page, plan, options())).toBe('engine')
    expect(page.ran).toHaveLength(1)
    expect(page.ran[0]).toContain('"start"')
    expect(page.ran[0]).toContain('"scheme":"dark"')
    expect(page.ran[0]).toContain(JSON.stringify(plan.fallbackCss))
    expect(page.css).toEqual([''])
  })

  it('inverts the page instead when the engine fails there, and says why in the log', async () => {
    for (const answer of [{ ok: false, reason: 'the stylesheets took longer than 1500 ms' }, undefined, { ok: 'true' }, 'ok', new Error('Script failed to execute')]) {
      const warn = vi.fn()
      const page = target(answer)
      expect(await applyReadable(page, plan, options(warn))).toBe('inverted')
      expect(page.css.at(-1)).toBe(plan.fallbackCss)
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]![0]).toContain('tab t-1')
      expect(warn.mock.calls[0]![0]).toContain('inverted instead')
    }
    const warn = vi.fn()
    await applyReadable(target({ ok: false, reason: 'the stylesheets took longer than 1500 ms' }), plan, options(warn))
    expect(warn.mock.calls[0]![0]).toContain('(the stylesheets took longer than 1500 ms)')
    // A page's answer is not trusted for its length: the line of the log keeps 200 characters of it.
    const long = vi.fn()
    await applyReadable(target({ ok: false, reason: 'x'.repeat(5000) }), plan, options(long))
    expect(long.mock.calls[0]![0]).toContain(`(${'x'.repeat(200)})`)
    expect(long.mock.calls[0]![0]).not.toContain('x'.repeat(201))
  })

  it('does nothing with an answer that comes after a newer call for the page (the inversion of an old plan never lands)', async () => {
    const page = target({ ok: false, reason: 'slow' })
    const warn = vi.fn()
    expect(await applyReadable(page, plan, options(warn, () => false))).toBe('stale')
    expect(page.css).toEqual([''])
    expect(warn).not.toHaveBeenCalled()
  })

  it('takes everything back for no plan: the stylesheet slot emptied, and the engine stopped only on a page that had something', async () => {
    const had = target({ ok: true })
    expect(await applyReadable(had, null, options(vi.fn(), () => true, true))).toBe('none')
    expect([had.css, had.ran]).toEqual([[''], [READABLE_STOP_SCRIPT]])
    const fresh = target({ ok: true })
    await applyReadable(fresh, null, options())
    expect(fresh.ran).toEqual([])
  })

  it('logs a page whose engine cannot be stopped (it went away), and goes on', async () => {
    const warn = vi.fn()
    const page = { applyCss: () => undefined, run: () => Promise.reject(new Error('the page is gone')) }
    expect(await applyReadable(page, null, options(warn, () => true, true))).toBe('none')
    expect(warn.mock.calls[0]![0]).toContain('cannot take the recolouring off tab t-1: the page is gone')
  })

  it('takes only a real `ok: true` for a start', () => {
    expect(readableStarted({ ok: true })).toBe(true)
    for (const answer of [null, undefined, true, { ok: 1 }, { ok: 'true' }, [], 'ok']) expect(readableStarted(answer), JSON.stringify(answer)).toBe(false)
  })
})
