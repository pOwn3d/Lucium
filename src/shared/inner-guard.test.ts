import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { fingerprintFallback, FINGERPRINT_LEVELS, type FingerprintConfig } from './fingerprint'
import { frameGuardSource, pageOrigin, workerConfig, workerGuardSource, type InnerTable } from './inner-guard'
import { guardWorld } from '../preload/guard-world'

const standard = (seed: number): FingerprintConfig => ({ ...FINGERPRINT_LEVELS.standard, seed })
const strict = (seed: number): FingerprintConfig => ({ ...FINGERPRINT_LEVELS.strict, seed })

// The script is text a document runs before its own: here it is run the same way, in a fresh V8 context that stands for the window of a frame. The
// guard it is given only notes what it was called with.
const RECORDER = '(function (plan) { globalThis.__got = plan })'

interface FrameOptions {
  /** The origins `location.ancestorOrigins` lists, the page's last; none for the page itself. */
  ancestors?: string[]
  guard?: string
}

function runFrame(table: InnerTable, options: FrameOptions = {}): { got: { scriptlets: unknown[]; fingerprint: FingerprintConfig } | undefined; warned: string[] } {
  const warned: string[] = []
  const context = vm.createContext({ console: { warn: (...a: unknown[]) => warned.push(a.join(' ')) } })
  vm.runInContext(`globalThis.location = { ancestorOrigins: ${JSON.stringify(options.ancestors ?? [])} };`, context)
  vm.runInContext(frameGuardSource(options.guard ?? RECORDER, table), context)
  return { got: vm.runInContext('globalThis.__got', context) as never, warned }
}

const table = (current: InnerTable['current']): InnerTable => ({ current, fallback: standard(1000) })

describe('the script a frame runs before its own', () => {
  it('gives a frame what its page gets, whatever the site of the frame: the origin of the page is the last of its ancestors', () => {
    const { got } = runFrame(table({ origin: 'https://news.test', config: strict(7) }), { ancestors: ['https://ads.example', 'https://news.test'] })
    expect(got).toEqual({ scriptlets: [], fingerprint: strict(7) })
  })

  it('does nothing in the page itself, which has no ancestor and which the preload serves: the guard is not run twice on one window', () => {
    expect(runFrame(table({ origin: 'https://news.test', config: strict(7) }), { ancestors: [] }).got).toBeUndefined()
    expect(runFrame(table(null), { ancestors: [] }).got).toBeUndefined()
  })

  it('gives nothing to the frames of a site left out', () => {
    expect(runFrame(table({ origin: 'https://skip.test', config: null }), { ancestors: ['https://skip.test'] }).got).toBeUndefined()
  })

  it('never leaves a frame unprotected because its page is not the one the table knows: it gets the strength of the moment, with a seed of that page', () => {
    const read = (ancestors: string[], current: InnerTable['current'] = { origin: 'https://old.test', config: null }) => runFrame(table(current), { ancestors }).got?.fingerprint
    const a = read(['https://new.test'])
    expect(a).toMatchObject({ level: 'standard', maxCores: 8 })
    // The same page gives the same seed, another page another one, and neither is the salt itself.
    expect(read(['https://frame.example', 'https://new.test'])!.seed).toBe(a!.seed)
    expect(read(['https://other.test'])!.seed).not.toBe(a!.seed)
    expect(a!.seed).not.toBe(1000)
    expect(Number.isInteger(a!.seed) && a!.seed >= 0 && a!.seed <= 0xffffffff).toBe(true)
    // Before the first page of a tab is known, too.
    expect(read(['https://new.test'], null)).toEqual(a)
  })

  it('gives nothing to a frame of a page that is not a web page, and what the tab shows to a frame of a page with an opaque origin', () => {
    for (const top of ['file://', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', '']) expect(runFrame(table({ origin: '', config: null }), { ancestors: [top] }).got, top).toBeUndefined()
    expect(runFrame(table({ origin: 'https://news.test', config: strict(7) }), { ancestors: ['null'] }).got?.fingerprint).toEqual(strict(7))
    expect(runFrame(table({ origin: '', config: null }), { ancestors: ['null'] }).got).toBeUndefined()
    expect(runFrame(table(null), { ancestors: ['null'] }).got).toBeUndefined()
  })

  it('tells the console of the frame, without naming the browser, when the guard throws, and lets the frame go on', () => {
    const { warned } = runFrame(table({ origin: 'https://news.test', config: strict(7) }), { ancestors: ['https://news.test'], guard: '(function () { throw new Error("no canvas here") })' })
    expect(warned).toEqual(['[guard] the protection of a frame could not be installed: no canvas here'])
  })

  it('runs as text where the bundle is not: a build that keeps function names wraps inner functions in a helper the document does not have', () => {
    const named = '(function (plan) { const note = __name((p) => { globalThis.__got = p }, "note"); note(plan) })'
    expect(runFrame(table({ origin: 'https://news.test', config: strict(7) }), { ancestors: ['https://news.test'], guard: named }).got?.fingerprint).toEqual(strict(7))
  })
})

describe('what a worker evaluates before its own script', () => {
  // A worker has no window, no document, no screen and no canvas element: only what a `WorkerGlobalScope` has.
  const WORKER = `
    globalThis.console = { warn: (...a) => __warned.push(a.join(' ')), debug() {} };
    class WorkerNavigator { get hardwareConcurrency() { return 16 } get deviceMemory() { return 32 } }
    globalThis.WorkerNavigator = WorkerNavigator; globalThis.navigator = new WorkerNavigator();
    class OffscreenCanvasRenderingContext2D { constructor(c) { this.canvas = c } getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(this.canvas.pixels.slice(0, w * h * 4)) } } drawImage(s) { this.canvas.pixels = new Uint8ClampedArray(s.pixels) } putImageData(i) { this.canvas.pixels = new Uint8ClampedArray(i.data) } }
    class OffscreenCanvas { constructor(w, h) { this.width = w; this.height = h; this.pixels = new Uint8ClampedArray(w * h * 4).fill(200) } getContext() { return this._c ||= new OffscreenCanvasRenderingContext2D(this) } convertToBlob() { return Array.from(this.pixels).join(',') } }
    globalThis.OffscreenCanvas = OffscreenCanvas; globalThis.OffscreenCanvasRenderingContext2D = OffscreenCanvasRenderingContext2D;
    class WebGL2RenderingContext { getParameter(p) { return p === 0x9246 ? 'Apple M2 Pro' : 7 } readPixels(x, y, w, h, f, t, buffer) { buffer.fill(200) } }
    globalThis.WebGL2RenderingContext = WebGL2RenderingContext;
  `
  function worker(config: FingerprintConfig | null): { eval<T>(code: string): T; warned: string[] } {
    const warned: string[] = []
    const context = vm.createContext({ __warned: warned })
    vm.runInContext(WORKER, context)
    if (config) vm.runInContext(workerGuardSource(String(guardWorld), config), context)
    return { eval: <T>(code: string) => vm.runInContext(code, context) as T, warned }
  }
  const READS = `[navigator.hardwareConcurrency, navigator.deviceMemory, new WebGL2RenderingContext().getParameter(0x9246), new OffscreenCanvas(8, 8).getContext().getImageData(0, 0, 8, 8).data.join(','), (() => { const b = new Uint8Array(256); new WebGL2RenderingContext().readPixels(0, 0, 8, 8, 0x1908, 0x1401, b); return b.join(',') })()]`

  it('is the guard of the page, run in a world that has no window: the figures of the machine, the canvas and WebGL read there are those a page reads', () => {
    const raw = worker(null).eval<unknown[]>(READS)
    expect(raw.slice(0, 3)).toEqual([16, 32, 'Apple M2 Pro'])
    const guarded = worker(strict(42))
    const read = guarded.eval<unknown[]>(READS)
    expect(read.slice(0, 3)).toEqual([4, 4, 'ANGLE (Generic GPU)'])
    // The pixels of an OffscreenCanvas and of WebGL carry the noise, the same at each reading for one seed.
    expect(read[3]).not.toBe(raw[3])
    expect(read[4]).not.toBe(raw[4])
    expect(guarded.eval<unknown[]>(READS)).toEqual(read)
    expect(worker(strict(43)).eval<unknown[]>(READS)[3]).not.toBe(read[3])
    // Nothing a worker lacks was reported as a failure.
    expect(guarded.warned).toEqual([])
  })

  it('gives the standard strength its own ceilings', () => {
    expect(worker(standard(1)).eval<unknown[]>(READS).slice(0, 3)).toEqual([8, 8, 'Apple M2 Pro'])
  })

  it('gets what the page gets, nothing on a site left out, and the strength of the moment while no page is known', () => {
    expect(workerConfig({ current: { origin: 'https://news.test', config: strict(7) }, fallback: standard(1000) })).toEqual(strict(7))
    expect(workerConfig({ current: { origin: 'https://skip.test', config: null }, fallback: standard(1000) })).toBeNull()
    expect(workerConfig({ current: null, fallback: standard(1000) })).toEqual(standard(1000))
  })
})

describe('the strength of the moment, for a page nobody heard of yet', () => {
  it('is the level of the settings with the salt as its seed, and nothing while the protection is off', () => {
    expect(fingerprintFallback({ reduceFingerprint: false, fingerprintStrict: true }, 5)).toBeNull()
    expect(fingerprintFallback({ reduceFingerprint: true, fingerprintStrict: false }, 5)).toEqual(standard(5))
    expect(fingerprintFallback({ reduceFingerprint: true, fingerprintStrict: true }, 5)).toEqual(strict(5))
  })

  it('never carries a seed that is not an unsigned 32-bit integer', () => {
    for (const salt of [-1, 1.5, 2 ** 32, Number.NaN]) expect(fingerprintFallback({ reduceFingerprint: true, fingerprintStrict: false }, salt)!.seed, String(salt)).toBe(0)
  })
})

describe('the origin a frame reads of its page', () => {
  it('is the origin of the address, and nothing for an address that has none', () => {
    expect(pageOrigin('https://news.test:8443/a/b?c#d')).toBe('https://news.test:8443')
    expect(pageOrigin('')).toBe('')
    expect(pageOrigin('not an address')).toBe('')
  })
})
