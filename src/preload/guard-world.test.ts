import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { FINGERPRINT_LEVELS, type FingerprintConfig } from '../shared/fingerprint'
import { isConstantValue, type ScriptletCall } from '../shared/scriptlets'
import { YOUTUBE_SCRIPTLETS } from '../shared/youtube-rules'
import { guardWorld } from './guard-world'

// guardWorld is handed to Electron as text and run in the page's main world. Here it is run the same way: its text, in a fresh V8 context that
// holds a small fake of the parts of a window it patches (so the functions it replaces are the context's own, as in a page).

interface Logs {
  warn: string[]
  debug: string[]
}

// The window is a plain object (`win`) the guard receives as `globalThis`, and the page's code runs inside `with (win)`: accessors that throw
// behave as in a page (the global object of a Node vm context swallows what its getters throw).
const BROWSER = `
const win = {};
globalThis.__win = win;
win.window = win; win.console = console; win.JSON = JSON; win.URL = URL; win.location = { href: 'https://www.youtube.com/watch?v=abc' };
win.__timeouts = []; win.__intervals = []; win.__fetched = []; win.__opened = []; win.__listeners = []; win.__removed = [];
win.setTimeout = function setTimeout(fn, ms) { win.__timeouts.push([fn, ms]); return win.__timeouts.length };
win.setInterval = function setInterval(fn, ms) { win.__intervals.push([fn, ms]); return win.__intervals.length };
win.__reply = null;
win.fetch = function fetch(input) { const address = typeof input === 'string' ? input : input.url; win.__fetched.push(address); return win.__reply ? win.__reply(address) : Promise.resolve({ native: true }) };
win.Response = class Response { constructor(body, init) { this.body = body; this.init = init } json() { return Promise.resolve(this.body === '' ? { ads: [1], keep: 1 } : JSON.parse(this.body)) } text() { return Promise.resolve(this.body) } };
win.XMLHttpRequest = class XMLHttpRequest { open(method, url) { this.__url = url } get responseText() { return this.__body } get response() { return this.responseType === 'json' ? JSON.parse(this.__body) : this.__body } };
win.open = function open(url) { win.__opened.push(url); return { native: true } };
win.EventTarget = class EventTarget { addEventListener(type, fn) { win.__listeners.push([type, fn]) } };
win.MutationObserver = class MutationObserver { constructor(cb) { this.cb = cb } observe() { win.__observer = this } };
win.document = {
  currentScript: null, readyState: 'complete', listeners: {},
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) },
  querySelectorAll(selector) { win.__selected = selector; return win.__elements || [] },
  createElement(tag) { return new win.HTMLCanvasElement(0, 0) }
};
function fnv(bytes) { let h = 2166136261; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0 } return h.toString(16) }
win.__hash = fnv;
win.CanvasRenderingContext2D = class CanvasRenderingContext2D {
  constructor(canvas) { this.canvas = canvas }
  getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(this.canvas.pixels.slice(0, w * h * 4)) } }
  drawImage(source) { if (source.tainted) throw new Error('SecurityError: tainted'); this.canvas.pixels = new Uint8ClampedArray(source.pixels) }
  putImageData(image) { this.canvas.pixels = new Uint8ClampedArray(image.data) }
};
win.HTMLCanvasElement = class HTMLCanvasElement {
  constructor(w, h) { this.width = w; this.height = h; this.pixels = new Uint8ClampedArray(w * h * 4) }
  getContext() { return this._context ||= new win.CanvasRenderingContext2D(this) }
  toDataURL() { if (this.tainted) throw new Error('SecurityError: tainted'); return 'data:' + fnv(this.pixels) }
  toBlob(callback) { if (this.tainted) throw new Error('SecurityError: tainted'); callback('data:' + fnv(this.pixels)) }
};
const glMethods = {
  readPixels(x, y, w, h, format, type, buffer) { for (let i = 0; i < buffer.length; i++) buffer[i] = i % 4 === 3 ? 255 : (i * 13) % 251 },
  getParameter(p) { return p === 0x9246 ? 'Apple M2 Pro' : p === 0x9245 ? 'Apple' : 7 }
};
win.WebGLRenderingContext = class WebGLRenderingContext { readPixels(...a) { return glMethods.readPixels(...a) } getParameter(p) { return glMethods.getParameter(p) } };
win.WebGL2RenderingContext = class WebGL2RenderingContext { readPixels(...a) { return glMethods.readPixels(...a) } getParameter(p) { return glMethods.getParameter(p) } };
win.AudioBuffer = class AudioBuffer {
  constructor(n) { this.data = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.5) }
  getChannelData() { return this.data }
  copyFromChannel(destination) { destination.set(this.data.subarray(0, destination.length)) }
};
win.AnalyserNode = class AnalyserNode {
  getFloatFrequencyData(a) { for (let i = 0; i < a.length; i++) a[i] = -80 - i * 0.1 }
  getFloatTimeDomainData(a) { for (let i = 0; i < a.length; i++) a[i] = Math.cos(i / 5) * 0.3 }
};
win.Navigator = class Navigator { get hardwareConcurrency() { return win.__cores } get deviceMemory() { return win.__memory } };
win.navigator = new win.Navigator();
win.Screen = class Screen {
  get width() { return win.__screen[0] } get height() { return win.__screen[1] }
  get availWidth() { return win.__screen[0] } get availHeight() { return win.__screen[1] - 25 }
  get colorDepth() { return 30 } get pixelDepth() { return 30 }
};
win.screen = new win.Screen();
win.queryLocalFonts = function queryLocalFonts() { return Promise.resolve([{ family: 'Helvetica' }]) };
`

interface World {
  run(plan: { scriptlets?: ScriptletCall[]; fingerprint?: FingerprintConfig | null }): void
  eval<T = unknown>(code: string): T
  logs: Logs
}

function world(options: { cores?: number; memory?: number; screen?: [number, number] } = {}): World {
  const logs: Logs = { warn: [], debug: [] }
  const console = { warn: (...a: unknown[]) => logs.warn.push(a.join(' ')), debug: (...a: unknown[]) => logs.debug.push(a.join(' ')), error: () => {}, log: () => {} }
  const context = vm.createContext({ console, URL })
  vm.runInContext(`${BROWSER}\nwin.__cores = ${options.cores ?? 16}; win.__memory = ${options.memory ?? 8}; win.__screen = ${JSON.stringify(options.screen ?? [2560, 1600])};`, context)
  const inPage = vm.runInContext('(function (win, code) { with (win) { return eval(code) } })', context) as (win: unknown, code: string) => unknown
  const win = vm.runInContext('__win', context) as unknown
  return {
    logs,
    run: (plan) => {
      vm.runInContext(`(function (globalThis) { return (${guardWorld.toString()})(${JSON.stringify({ scriptlets: plan.scriptlets ?? [], fingerprint: plan.fingerprint ?? null })}) })(__win)`, context)
    },
    eval: <T>(code: string) => inPage(win, code) as T
  }
}

const call = (id: ScriptletCall['id'], ...args: string[]): ScriptletCall => ({ id, args })
const standard = (seed = 1234): FingerprintConfig => ({ ...FINGERPRINT_LEVELS.standard, seed })
const strict = (seed = 1234): FingerprintConfig => ({ ...FINGERPRINT_LEVELS.strict, seed })

describe('the scriptlets', () => {
  it('set-constant: the property reads as the constant, and the page cannot change it', () => {
    const page = world()
    page.eval(`window.ads = { enabled: true, fn: function () { return 1 } }`)
    page.run({ scriptlets: [call('set-constant', 'ads.enabled', 'false'), call('set-constant', 'ads.fn', 'noopFunc'), call('set-constant', 'ads.count', '3')] })
    expect(page.eval('ads.enabled')).toBe(false)
    page.eval('ads.enabled = true')
    expect(page.eval('ads.enabled')).toBe(false)
    expect(page.eval('ads.fn()')).toBeUndefined()
    expect(page.eval('ads.count')).toBe(3)
  })

  it('set-constant: waits for an object the page has not made yet, and applies it when it arrives', () => {
    const page = world()
    page.run({ scriptlets: [call('set-constant', 'later.deep.flag', 'true'), call('set-constant', 'emptyOne', 'emptyArr')] })
    expect(page.eval('typeof later')).toBe('undefined')
    page.eval('window.later = { deep: { flag: false, other: 1 } }')
    expect(page.eval('later.deep.flag')).toBe(true)
    expect(page.eval('later.deep.other')).toBe(1)
    expect(page.eval('Array.isArray(emptyOne)')).toBe(true)
  })

  it('set-constant: understands every constant the grammar allows, and never evaluates the text', () => {
    const values = ['undefined', 'false', 'true', 'null', 'noopFunc', 'trueFunc', 'falseFunc', 'emptyObj', 'emptyArr', 'yes', 'no', "''", '0', '-1', '12345']
    for (const value of values) expect(isConstantValue(value), value).toBe(true)
    const page = world()
    page.run({ scriptlets: values.map((value, i) => call('set-constant', `c${i}`, value)) })
    const read = values.map((_, i) => page.eval(`(() => { const v = c${i}; return typeof v === 'function' ? 'fn:' + String(v()) : JSON.stringify(v) === undefined ? 'undefined' : JSON.stringify(v) })()`))
    expect(read).toEqual(['undefined', 'false', 'true', 'null', 'fn:undefined', 'fn:true', 'fn:false', '{}', '[]', '"yes"', '"no"', '""', '0', '-1', '12345'])
  })

  /** The error a script of the page is stopped with: letters and digits drawn each time. The script can catch it, so it must not say which browser stopped it. */
  const STOPPED = /^[a-z0-9]{1,10}$/

  it('stops a script with an error whose message is drawn each time and names nothing', () => {
    const page = world()
    page.run({ scriptlets: [call('abort-on-property-read', 'adsbygoogle')] })
    const caught = [1, 2].map(() => page.eval('(() => { try { adsbygoogle } catch (error) { return error.name + ":" + error.message } })()') as string)
    for (const text of caught) {
      expect(text).toMatch(/^ReferenceError:[a-z0-9]{1,10}$/)
      expect(text).not.toMatch(/lucium/i)
    }
    expect(caught[0]).not.toBe(caught[1])
  })

  it('tells the console of the page what could not be installed without naming the browser', () => {
    const page = world()
    page.eval(`window.locked = Object.freeze({ a: 1 })`)
    page.run({ scriptlets: [call('set-constant', 'locked.a', 'false')] })
    expect(page.logs.warn).toHaveLength(1)
    expect(page.logs.warn[0]).toMatch(/^\[guard\] /)
    expect(page.logs.warn[0]).not.toMatch(/lucium/i)
  })

  it('abort-on-property-read: reading throws, writing does not', () => {
    const page = world()
    page.run({ scriptlets: [call('abort-on-property-read', 'adsbygoogle'), call('abort-on-property-read', 'ads.nested.value')] })
    expect(() => page.eval('adsbygoogle')).toThrow(STOPPED)
    page.eval('window.ads = { nested: { value: 1 } }')
    expect(() => page.eval('ads.nested.value')).toThrow(STOPPED)
    expect(page.eval('ads.nested')).toBeDefined()
  })

  it('abort-on-property-write: writing throws, reading gives the stored value', () => {
    const page = world()
    page.eval('window.detector = 1')
    page.run({ scriptlets: [call('abort-on-property-write', 'detector')] })
    expect(page.eval('detector')).toBe(1)
    expect(() => page.eval('detector = 2')).toThrow(STOPPED)
    expect(page.eval('detector')).toBe(1)
  })

  it('abort-current-script: throws only when the running script contains the needle, and keeps the property working', () => {
    const page = world()
    page.eval('document.createElement = function createElement(tag) { return { tag } }')
    page.run({ scriptlets: [call('abort-current-script', 'document.createElement', 'adblock'), call('abort-current-script', 'document.title', '/track\\w+/')] })
    expect(page.eval(`document.createElement('div').tag`)).toBe('div')
    page.eval(`document.currentScript = { src: '', textContent: 'if (adblock) {}' }`)
    expect(() => page.eval(`document.createElement('div')`)).toThrow(STOPPED)
    page.eval(`document.currentScript = { src: '', textContent: 'harmless()' }`)
    expect(page.eval(`document.createElement('div').tag`)).toBe('div')
    page.eval(`document.currentScript = { src: 'https://x.example/tracker.js', textContent: '' }`)
    expect(() => page.eval('document.title')).toThrow(STOPPED)
    page.eval('document.currentScript = null')
    expect(() => page.eval('document.title')).not.toThrow()
  })

  it('no-setTimeout-if / no-setInterval-if: the callback is replaced by one that does nothing, only when text and delay match', () => {
    const page = world()
    page.run({ scriptlets: [call('no-setTimeout-if', 'adblock', '2000'), call('no-setInterval-if', '/detect\\w+/')] })
    page.eval(`setTimeout(function () { adblock() }, 2000); setTimeout(function () { adblock() }, 100); setTimeout(function () { other() }, 2000)`)
    const timeouts = page.eval<Array<[() => void, number]>>('__timeouts')
    expect(timeouts.map(([fn, ms]) => [String(fn).includes('adblock'), ms])).toEqual([[false, 2000], [true, 100], [false, 2000]])
    page.eval(`setInterval(function () { detectAds() }, 50); setInterval(function () { tick() }, 50)`)
    const intervals = page.eval<Array<[() => void, number]>>('__intervals')
    expect(intervals.map(([fn]) => [String(fn).includes('detectAds'), String(fn).includes('tick')])).toEqual([[false, false], [false, true]])
    expect(page.eval('__timeouts.length')).toBe(3)
  })

  it('no-setTimeout-if: "!" in front of the delay inverts it', () => {
    const page = world()
    page.run({ scriptlets: [call('no-setTimeout-if', 'ads', '!500')] })
    page.eval(`setTimeout(function () { ads() }, 500); setTimeout(function () { ads() }, 900)`)
    expect(page.eval<Array<[unknown, number]>>('__timeouts').map(([fn]) => String(fn).includes('ads'))).toEqual([true, false])
  })

  it('no-fetch-if: a matching request gets an empty answer and never leaves, the others go through', async () => {
    const page = world()
    page.run({ scriptlets: [call('no-fetch-if', 'url:/ads/')] })
    const blocked = await page.eval<Promise<{ body: string }>>(`fetch('https://x.example/ads/banner')`)
    expect(blocked.body).toBe('')
    const passed = await page.eval<Promise<{ native: boolean }>>(`fetch('https://x.example/page')`)
    expect(passed.native).toBe(true)
    expect(page.eval('__fetched')).toEqual(['https://x.example/page'])
  })

  it('json-prune: removes the listed paths from parsed JSON, wildcards and arrays included, only when the needed paths are there', async () => {
    const page = world()
    page.run({ scriptlets: [call('json-prune', 'ads list.[].sponsored *.tracking', 'player'), call('json-prune', 'ads')] })
    const parsed = page.eval<Record<string, unknown>>(`JSON.parse('{"player":1,"ads":{"x":1},"list":[{"sponsored":1,"title":"a"},{"title":"b"}],"meta":{"tracking":1,"id":2}}')`)
    expect(parsed).toEqual({ player: 1, list: [{ title: 'a' }, { title: 'b' }], meta: { id: 2 } })
    // Without the needed path ("player") only the second scriptlet applies.
    const other = page.eval<Record<string, unknown>>(`JSON.parse('{"ads":1,"list":[{"sponsored":1}]}')`)
    expect(other).toEqual({ list: [{ sponsored: 1 }] })
    expect(page.eval('JSON.parse("[1,2]").length')).toBe(2)
    // The same through fetch's Response.json().
    const viaResponse = await page.eval<Promise<Record<string, unknown>>>('new Response("").json()')
    expect(viaResponse).toEqual({ keep: 1 })
  })

  // The page's scripts come after the guard: a global they replace must not be what a scriptlet runs when the page calls a wrapped function.
  it('goes on working, unseen, when the page replaces the functions of the language afterwards', async () => {
    const page = world()
    page.run({ scriptlets: [call('json-prune', 'ads list.[].sponsored *.tracking'), call('no-fetch-if', 'url:/ads/'), call('no-setTimeout-if', 'adblock', '500'), call('set-constant', 'later.flag', 'true')] })
    page.eval(`
      globalThis.__seen = [];
      const spy = (name, answer) => function () { __seen.push(name); return answer };
      Object.hasOwn = spy('Object.hasOwn', false);
      Object.keys = spy('Object.keys', []);
      Array.isArray = spy('Array.isArray', false);
      Array.from = spy('Array.from', []);
      Math.random = spy('Math.random', 0);
      Number.parseInt = spy('Number.parseInt', NaN);
      Promise.resolve = spy('Promise.resolve', 'not a promise');
      const NativeString = String;
      String = function (value) { __seen.push('String'); return NativeString('lie') };
      Number = spy('Number', 7);
      RegExp = spy('RegExp', { test: () => false });
    `)
    const parsed = page.eval<Record<string, unknown>>(`JSON.parse('{"ads":{"x":1},"list":[{"sponsored":1,"title":"a"}],"meta":{"tracking":1,"id":2}}')`)
    expect(parsed).toEqual({ list: [{ title: 'a' }], meta: { id: 2 } })
    const blocked = await page.eval<Promise<{ body: string }>>(`fetch('https://x.example/ads/banner')`)
    expect(blocked.body).toBe('')
    expect(page.eval('__fetched')).toEqual([])
    page.eval(`setTimeout(function () { adblock() }, 500); setTimeout(function fine() { other() }, 500)`)
    expect(page.eval('__timeouts.map(([fn]) => fn.name)')).toEqual(['noopFunc', 'fine'])
    page.eval('later = { flag: false }')
    expect(page.eval('later.flag')).toBe(true)
    // None of the replaced functions was called by the guard: the page learns nothing of what it does.
    expect(page.eval('__seen')).toEqual([])
    expect(page.logs.warn).toEqual([])
  })

  it('the YouTube rules: a player response loses its ad entries, a JSON that is not one is left alone (fictive data, no network)', async () => {
    const page = world()
    page.run({ scriptlets: YOUTUBE_SCRIPTLETS.map((c) => ({ id: c.id, args: [...c.args] })) })
    const player = page.eval<Record<string, unknown>>(
      `JSON.parse('{"videoDetails":{"title":"t"},"adPlacements":[{"x":1}],"playerAds":[{"y":1}],"adSlots":[{"z":1}],"streamingData":{"formats":[]}}')`
    )
    expect(player).toEqual({ videoDetails: { title: 't' }, streamingData: { formats: [] } })
    const otherJson = page.eval<Record<string, unknown>>(`JSON.parse('{"adPlacements":[{"x":1}],"items":[]}')`)
    expect(otherJson).toEqual({ adPlacements: [{ x: 1 }], items: [] })
  })

  describe('prune-response: the answers of the player, through fetch and XHR (fictive answers, no network)', () => {
    const rule = YOUTUBE_SCRIPTLETS.filter((c) => c.id === 'prune-response').map((c) => ({ id: c.id, args: [...c.args] }))
    const ADS = '{ "videoDetails": { "title": "t" }, "adPlacements": [{ "x": 1 }], "playerAds": [{ "y": 1 }], "adSlots": [{ "z": 1 }], "adBreakHeartbeatParams": "h", "streamingData": { "formats": [] } }'
    const PRUNED = { videoDetails: { title: 't' }, streamingData: { formats: [] } }
    /** Every fetch of the page is answered with `text` (a Response of the fake window). */
    const answering = (page: World, text: string): void => {
      page.eval(`__reply = () => Promise.resolve(new Response(${JSON.stringify(text)}, { status: 200 }))`)
    }

    it('fetch().text(): the ad entries of a player answer are removed, the rest of the text is the one the page would have had', async () => {
      const page = world()
      page.run({ scriptlets: rule })
      answering(page, ADS)
      const text = await page.eval<Promise<string>>(`fetch('https://www.youtube.com/youtubei/v1/player?key=k').then((r) => r.text())`)
      expect(JSON.parse(text)).toEqual(PRUNED)
      expect(page.logs.debug).toEqual([])
    })

    it('fetch().json(): the same entries are removed from the parsed answer', async () => {
      const page = world()
      page.run({ scriptlets: rule })
      answering(page, ADS)
      const value = await page.eval<Promise<unknown>>(`fetch('https://m.youtube.com/youtubei/v1/next').then((r) => r.json())`)
      expect(value).toEqual(PRUNED)
    })

    it('an answer with no ad entry is returned as it was, byte for byte (nothing is re-serialised)', async () => {
      const page = world()
      page.run({ scriptlets: rule })
      const plain = '{  "videoDetails" :  {"title":"t"}, "items": [1, 2]  }'
      answering(page, plain)
      expect(await page.eval<Promise<string>>(`fetch('https://www.youtube.com/youtubei/v1/player').then((r) => r.text())`)).toBe(plain)
    })

    it('an HTML answer is returned as it was, without a word (the watch page is HTML, and it is not logged each time)', async () => {
      const page = world()
      page.run({ scriptlets: rule })
      const html = '<html><script>var adPlacements = [1]</script></html>'
      answering(page, html)
      expect(await page.eval<Promise<string>>(`fetch('https://www.youtube.com/watch?v=abc').then((r) => r.text())`)).toBe(html)
      expect(page.logs.debug).toEqual([])
    })

    it('a truncated JSON answer is returned as it was, and the console says so in debug', async () => {
      const page = world()
      page.run({ scriptlets: rule })
      const truncated = '{"videoDetails": {"title": "t"}, "adPlacements": [{"x": 1'
      answering(page, truncated)
      expect(await page.eval<Promise<string>>(`fetch('https://www.youtube.com/youtubei/v1/player').then((r) => r.text())`)).toBe(truncated)
      expect(page.logs.debug.some((line) => line.includes('a response is not JSON'))).toBe(true)
    })

    it('another site, and another path of youtube.com, keep their answers', async () => {
      const page = world()
      page.run({ scriptlets: rule })
      answering(page, ADS)
      for (const address of ['https://news.test/youtubei/v1/player', 'https://www.youtube.com/api/stats/qoe', 'https://evilyoutube.com/watch', 'https://www.youtube.com/watch_fragments']) {
        expect(await page.eval<Promise<string>>(`fetch('${address}').then((r) => r.text())`), address).toBe(ADS)
      }
    })

    it('XMLHttpRequest: a relative address of the player is judged on the page address; responseText and response (json) are pruned', () => {
      const page = world()
      page.run({ scriptlets: rule })
      page.eval(`__xhr = new XMLHttpRequest(); __xhr.open('GET', '/youtubei/v1/player?key=k'); __xhr.__body = ${JSON.stringify(ADS)}`)
      expect(JSON.parse(page.eval<string>('__xhr.responseText'))).toEqual(PRUNED)
      page.eval(`__json = new XMLHttpRequest(); __json.open('POST', 'https://www.youtube.com/youtubei/v1/next'); __json.responseType = 'json'; __json.__body = ${JSON.stringify(ADS)}`)
      expect(page.eval<unknown>('__json.response')).toEqual(PRUNED)
    })

    it('XMLHttpRequest: an answer of another address, or with no ad entry, is left alone', () => {
      const page = world()
      page.run({ scriptlets: rule })
      page.eval(`__other = new XMLHttpRequest(); __other.open('GET', 'https://news.test/youtubei/v1/player'); __other.__body = ${JSON.stringify(ADS)}`)
      expect(page.eval<string>('__other.responseText')).toBe(ADS)
      const plain = '{"items":[1]}'
      page.eval(`__plain = new XMLHttpRequest(); __plain.open('GET', '/youtubei/v1/player'); __plain.__body = ${JSON.stringify(plain)}`)
      expect(page.eval<string>('__plain.responseText')).toBe(plain)
    })
  })

  it('remove-attr / remove-class: strip the names from the elements the selector finds, now and when the page changes', () => {
    const page = world()
    page.eval(`window.__elements = [{ removed: [], removeAttribute(n) { this.removed.push('attr:' + n) }, classList: { remove: (n) => window.__removed.push('class:' + n) } }]`)
    page.run({ scriptlets: [call('remove-attr', 'onclick|target', 'a.ad'), call('remove-class', 'blocked')] })
    expect(page.eval('__elements[0].removed')).toEqual(['attr:onclick', 'attr:target'])
    expect(page.eval('__removed')).toEqual(['class:blocked'])
    // "stay" (the default): later changes of the page run it again, after a short delay.
    expect(page.eval<unknown>('__observer')).toBeDefined()
    page.eval('__observer.cb()')
    expect(page.eval<Array<[() => void, number]>>('__timeouts').length).toBeGreaterThan(0)
    expect(page.eval('__selected')).toBe('.blocked')
  })

  it('prevent-addEventListener: a listener is dropped when its type and its code match', () => {
    const page = world()
    page.run({ scriptlets: [call('prevent-addEventListener', 'click', 'popunder'), call('prevent-addEventListener', '/^(scroll|wheel)$/')] })
    page.eval(`const t = new EventTarget(); t.addEventListener('click', function () { popunder() }); t.addEventListener('click', function () { fine() }); t.addEventListener('scroll', function () {}); t.addEventListener('keydown', function () {})`)
    expect(page.eval<Array<[string, () => void]>>('__listeners').map(([type, fn]) => `${type}:${String(fn).includes('fine')}`)).toEqual(['click:true', 'keydown:false'])
  })

  it('no-window-open-if: a matching popup is replaced by an inert window, the others open', () => {
    const page = world()
    page.run({ scriptlets: [call('no-window-open-if', 'ads.example')] })
    const decoy = page.eval<{ closed: boolean }>(`window.open('https://ads.example/pop')`)
    expect(decoy.closed).toBe(true)
    expect(page.eval(`window.open('https://good.example/').native`)).toBe(true)
    expect(page.eval('__opened')).toEqual(['https://good.example/'])
  })

  it('no-window-open-if with "!": only the addresses that do not match are stopped', () => {
    const page = world()
    page.run({ scriptlets: [call('no-window-open-if', '!good.example')] })
    expect(page.eval(`window.open('https://good.example/').native`)).toBe(true)
    expect(page.eval(`window.open('https://bad.example/').closed`)).toBe(true)
  })

  it('a scriptlet that cannot be installed is told on the console, and the others still run', () => {
    const page = world()
    page.eval(`window.locked = Object.freeze({ a: 1 }); window.fine = 1`)
    page.run({ scriptlets: [call('set-constant', 'locked.a', 'false'), call('set-constant', 'fine', '2')] })
    expect(page.logs.warn.join('\n')).toMatch(/set-constant.*could not be installed/)
    expect(page.eval('fine')).toBe(2)
  })

  it('a pattern that does not compile matches nothing and says so', () => {
    const page = world()
    // Never reaches a page through the grammar; the page side still behaves if it does.
    page.run({ scriptlets: [call('no-setTimeout-if', '/(/')] })
    page.eval(`setTimeout(function () { x() }, 1)`)
    expect(page.eval<Array<[() => void, number]>>('__timeouts').map(([fn]) => String(fn).includes('x()'))).toEqual([true])
    expect(page.logs.warn.join('\n')).toMatch(/pattern/)
  })

  it('looks like the browser\'s own functions: same text, name and length', () => {
    const page = world()
    const before = page.eval<string>('Function.prototype.toString.call(fetch)')
    page.run({ scriptlets: [call('no-fetch-if', 'ads'), call('no-window-open-if', 'x')] })
    expect(page.eval('Function.prototype.toString.call(fetch)')).toBe(before)
    expect(page.eval('fetch.toString()')).toBe(before)
    expect(page.eval('[fetch.name, fetch.length]')).toEqual(['fetch', 1])
    expect(page.eval('Function.prototype.toString.toString()')).toMatch(/^function toString\(\) \{ \[native code\] \}$/)
  })
})

describe('the fingerprint protection: canvas', () => {
  const draw = `window.canvas = new HTMLCanvasElement(64, 32); for (let i = 0; i < canvas.pixels.length; i++) canvas.pixels[i] = i % 4 === 3 ? 255 : (i * 7 + 3) % 256`

  it('changes what toDataURL reads, the same way each time, and leaves the canvas itself alone', () => {
    const page = world()
    page.eval(draw)
    const original = page.eval<string>('canvas.toDataURL()')
    const pixels = page.eval<string>('__hash(canvas.pixels)')
    page.run({ fingerprint: standard() })
    const first = page.eval<string>('canvas.toDataURL()')
    expect(first).not.toBe(original)
    expect(page.eval('canvas.toDataURL()')).toBe(first)
    expect(page.eval('__hash(canvas.pixels)')).toBe(pixels)
  })

  it('gives another site another reading, and the same site the same one in a new document', () => {
    const readings = [1234, 1234, 99].map((seed) => {
      const page = world()
      page.eval(draw)
      page.run({ fingerprint: standard(seed) })
      return page.eval<string>('canvas.toDataURL()')
    })
    expect(readings[0]).toBe(readings[1])
    expect(readings[2]).not.toBe(readings[0])
  })

  it('alters a handful of pixels by one unit in one channel, never the alpha', () => {
    const page = world()
    page.eval(draw)
    const before = page.eval<number[]>('Array.from(canvas.pixels)')
    page.run({ fingerprint: standard() })
    const image = page.eval<{ data: number[] }>(`(() => { const d = canvas.getContext('2d').getImageData(0, 0, 64, 32); return { data: Array.from(d.data) } })()`)
    const changed = image.data.flatMap((v, i) => (v !== before[i] ? [i] : []))
    expect(changed.length).toBeGreaterThanOrEqual(4)
    expect(changed.length).toBeLessThanOrEqual(64 * 32 / 256 + 4)
    for (const i of changed) {
      expect(Math.abs(image.data[i]! - before[i]!), `byte ${i}`).toBe(1)
      expect(i % 4, `byte ${i} is an alpha`).not.toBe(3)
    }
    // Read twice: the same pixels.
    const again = page.eval<number[]>(`Array.from(canvas.getContext('2d').getImageData(0, 0, 64, 32).data)`)
    expect(again).toEqual(image.data)
  })

  it('never touches a pixel with no alpha, and finds the visible ones among many transparent ones', () => {
    const page = world()
    // Three quarters transparent: a canvas with a little drawing on it.
    page.eval(`window.sparse = new HTMLCanvasElement(64, 32); for (let p = 0; p < 64 * 32; p++) { const visible = p % 4 === 0; const i = p * 4; sparse.pixels[i] = visible ? 200 : 0; sparse.pixels[i + 1] = visible ? 100 : 0; sparse.pixels[i + 2] = visible ? 50 : 0; sparse.pixels[i + 3] = visible ? 255 : 0 }`)
    const before = page.eval<number[]>('Array.from(sparse.pixels)')
    page.run({ fingerprint: standard() })
    const after = page.eval<number[]>(`Array.from(sparse.getContext('2d').getImageData(0, 0, 64, 32).data)`)
    const changed = after.flatMap((v, i) => (v !== before[i] ? [i] : []))
    expect(changed.length).toBeGreaterThanOrEqual(4)
    for (const i of changed) {
      expect(before[Math.floor(i / 4) * 4 + 3], `byte ${i} belongs to a transparent pixel`).toBe(255)
      expect(i % 4, `byte ${i} is an alpha`).not.toBe(3)
    }
  })

  it('uses the functions the browser had when the guard was installed: a page that replaces document.createElement or a canvas method later cannot steer it', () => {
    const page = world()
    page.eval(draw)
    page.run({ fingerprint: standard() })
    const noised = page.eval<string>('canvas.toDataURL()')
    page.eval(`document.createElement = function () { throw new Error('the page took over createElement') }; CanvasRenderingContext2D.prototype.putImageData = function () { throw new Error('the page took over putImageData') }; HTMLCanvasElement.prototype.getContext = function () { throw new Error('the page took over getContext') }`)
    expect(page.eval('canvas.toDataURL()')).toBe(noised)
    expect(page.logs.debug.join('\n')).not.toMatch(/read as it is/)
  })

  it('goes through toBlob as well', () => {
    const page = world()
    page.eval(draw)
    const original = page.eval<string>('canvas.toDataURL()')
    page.run({ fingerprint: standard() })
    const viaBlob = page.eval<string>(`(() => { let got; canvas.toBlob((b) => { got = b }); return got })()`)
    expect(viaBlob).not.toBe(original)
    expect(viaBlob).toBe(page.eval('canvas.toDataURL()'))
  })

  it('leaves an empty (transparent) canvas empty', () => {
    const page = world()
    page.eval('window.blank = new HTMLCanvasElement(16, 16)')
    const original = page.eval<string>('blank.toDataURL()')
    page.run({ fingerprint: standard() })
    expect(page.eval('blank.toDataURL()')).toBe(original)
  })

  // A canvas above the limit of the standard strength is more than a million pixels, read four times and noised once in the stand-in for a page:
  // two seconds of processor, which a machine with every core taken stretches past the 5 s default.
  it('reads a canvas above the size limit as it is in the standard strength, and noised in the strict one', { timeout: 30_000 }, () => {
    const big = `window.big = new HTMLCanvasElement(1100, 1000); big.pixels.fill(200)`
    const plain = world()
    plain.eval(big)
    const original = plain.eval<string>('big.toDataURL()')
    plain.run({ fingerprint: standard() })
    expect(plain.eval('big.toDataURL()')).toBe(original)
    const hard = world()
    hard.eval(big)
    hard.run({ fingerprint: strict() })
    expect(hard.eval('big.toDataURL()')).not.toBe(original)
  })

  it('lets a tainted canvas fail the way it does without the guard, on the canvas itself', () => {
    const page = world()
    page.eval(`${draw}; canvas.tainted = true`)
    page.run({ fingerprint: standard() })
    expect(() => page.eval('canvas.toDataURL()')).toThrow(/tainted/)
    expect(page.logs.debug.join('\n')).toMatch(/read as it is/)
  })

  it('is a stronger noise in the strict strength', () => {
    const count = (config: FingerprintConfig): number => {
      const page = world()
      page.eval(draw)
      const before = page.eval<number[]>('Array.from(canvas.pixels)')
      page.run({ fingerprint: config })
      const after = page.eval<number[]>(`Array.from(canvas.getContext('2d').getImageData(0, 0, 64, 32).data)`)
      return after.filter((v, i) => v !== before[i]).length
    }
    expect(count(strict())).toBeGreaterThan(count(standard()))
  })
})

describe('the fingerprint protection: WebGL, audio, navigator, screen, fonts', () => {
  it('noises the RGBA bytes readPixels returns, and only those', () => {
    const page = world()
    const read = (format: number, type: number): number[] => page.eval(`(() => { const gl = new WebGLRenderingContext(); const b = new Uint8Array(16 * 16 * 4); gl.readPixels(0, 0, 16, 16, ${format}, ${type}, b); return Array.from(b) })()`)
    const original = read(0x1908, 0x1401)
    page.run({ fingerprint: standard() })
    const noised = read(0x1908, 0x1401)
    const diff = noised.flatMap((v, i) => (v !== original[i] ? [i] : []))
    expect(diff.length).toBeGreaterThanOrEqual(4)
    for (const i of diff) expect(Math.abs(noised[i]! - original[i]!)).toBe(1)
    expect(read(0x1908, 0x1401)).toEqual(noised)
    // Not RGBA bytes: left alone.
    expect(read(0x1903, 0x1401)).toEqual(original)
    expect(read(0x1908, 0x1406)).toEqual(original)
    const gl2 = page.eval<number[]>(`(() => { const gl = new WebGL2RenderingContext(); const b = new Uint8Array(16 * 16 * 4); gl.readPixels(0, 0, 16, 16, 0x1908, 0x1401, b); return Array.from(b) })()`)
    expect(gl2).toEqual(noised)
  })

  it('names the graphics card only in the strict strength', () => {
    const named = (config: FingerprintConfig): unknown[] => {
      const page = world()
      page.run({ fingerprint: config })
      return page.eval(`(() => { const gl = new WebGLRenderingContext(); return [gl.getParameter(0x9245), gl.getParameter(0x9246), gl.getParameter(3)] })()`)
    }
    expect(named(standard())).toEqual(['Apple', 'Apple M2 Pro', 7])
    expect(named(strict())).toEqual(['Google Inc.', 'ANGLE (Generic GPU)', 7])
  })

  it('moves audio samples by a hair, once per buffer, the same for the same seed', () => {
    const run = (seed: number): { first: number[]; again: number[]; original: number[]; copy: number[] } => {
      const page = world()
      const original = page.eval<number[]>('Array.from(new AudioBuffer(2000).getChannelData(0))')
      page.run({ fingerprint: standard(seed) })
      return {
        original,
        first: page.eval(`(() => { window.buffer = new AudioBuffer(2000); return Array.from(buffer.getChannelData(0)) })()`),
        again: page.eval('Array.from(buffer.getChannelData(0))'),
        copy: page.eval(`(() => { const d = new Float32Array(2000); buffer.copyFromChannel(d, 0); return Array.from(d) })()`)
      }
    }
    const a = run(5)
    expect(a.first).not.toEqual(a.original)
    // The buffer is noised the first time it is read, not again each time (that would drift).
    expect(a.again).toEqual(a.first)
    for (let i = 0; i < a.original.length; i++) expect(Math.abs(a.first[i]! - a.original[i]!)).toBeLessThanOrEqual(Math.abs(a.original[i]!) * 2e-7 + 1e-12)
    expect(run(5).first).toEqual(a.first)
    expect(run(6).first).not.toEqual(a.first)
    expect(a.copy).not.toEqual(a.original)
    const analysed = world()
    const raw = analysed.eval<number[]>(`(() => { const a = new Float32Array(64); new AnalyserNode().getFloatFrequencyData(a); return Array.from(a) })()`)
    analysed.run({ fingerprint: standard() })
    const noisy = analysed.eval<number[]>(`(() => { const a = new Float32Array(64); new AnalyserNode().getFloatFrequencyData(a); return Array.from(a) })()`)
    expect(noisy).not.toEqual(raw)
  })

  it('announces at most 8 cores and 8 GB, or 4 and 4 in the strict strength, and never more than there are', () => {
    const read = (options: { cores: number; memory: number }, config: FingerprintConfig): number[] => {
      const page = world(options)
      page.run({ fingerprint: config })
      return page.eval('[navigator.hardwareConcurrency, navigator.deviceMemory]')
    }
    expect(read({ cores: 16, memory: 8 }, standard())).toEqual([8, 8])
    expect(read({ cores: 4, memory: 2 }, standard())).toEqual([4, 2])
    expect(read({ cores: 16, memory: 8 }, strict())).toEqual([4, 4])
    expect(read({ cores: 2, memory: 0.5 }, strict())).toEqual([2, 0.5])
  })

  it('takes the shared worker away in the strict strength only, where nothing of ours could run before its script, and leaves it in the standard one', () => {
    const page = world()
    page.eval('window.SharedWorker = function SharedWorker() {}')
    page.run({ scriptlets: [call('set-constant', 'a', 'true')] })
    expect(page.eval('typeof SharedWorker')).toBe('function')
    // The standard strength: a site that needs a shared worker keeps it, and the rest of the protection is there.
    page.run({ fingerprint: standard() })
    expect(page.eval('[typeof window.SharedWorker, "SharedWorker" in window]')).toEqual(['function', true])
    expect(page.eval('navigator.hardwareConcurrency')).toBe(8)
    const hardened = world()
    hardened.eval('window.SharedWorker = function SharedWorker() {}')
    hardened.run({ fingerprint: strict() })
    expect(hardened.eval('[typeof window.SharedWorker, "SharedWorker" in window]')).toEqual(['undefined', false])
    expect([...page.logs.warn, ...hardened.logs.warn]).toEqual([])
  })

  it('says so when the shared worker cannot be taken away, and goes on', () => {
    const page = world({ cores: 16 })
    page.eval('Object.defineProperty(window, "SharedWorker", { value: function SharedWorker() {}, configurable: false })')
    page.run({ fingerprint: strict() })
    expect(page.logs.warn.join('\n')).toContain('[guard] the shared worker protection could not be installed')
    expect(page.eval('navigator.hardwareConcurrency')).toBe(4)
  })

  it('keeps the real figures when the protection is not asked for', () => {
    const page = world({ cores: 16 })
    page.run({})
    expect(page.eval('navigator.hardwareConcurrency')).toBe(16)
  })

  it('rounds the screen in the strict strength only: the largest common size that fits', () => {
    const read = (screen: [number, number], config: FingerprintConfig | null): number[] => {
      const page = world({ screen })
      page.run({ fingerprint: config })
      return page.eval('[screen.width, screen.height, screen.availWidth, screen.availHeight, screen.colorDepth, screen.pixelDepth]')
    }
    expect(read([2560, 1600], strict())).toEqual([2560, 1440, 2560, 1440, 24, 24])
    expect(read([1920, 1200], strict())).toEqual([1920, 1080, 1920, 1080, 24, 24])
    expect(read([1512, 982], strict())).toEqual([1440, 900, 1440, 900, 24, 24])
    // A screen smaller than every common size keeps its figures.
    expect(read([1024, 768], strict()).slice(0, 2)).toEqual([1024, 768])
    expect(read([2560, 1600], standard())).toEqual([2560, 1600, 2560, 1575, 30, 30])
    expect(read([2560, 1600], null)).toEqual([2560, 1600, 2560, 1575, 30, 30])
  })

  it('answers an empty list to queryLocalFonts in the strict strength only', async () => {
    const strictPage = world()
    strictPage.run({ fingerprint: strict() })
    expect(await strictPage.eval<Promise<unknown[]>>('queryLocalFonts()')).toEqual([])
    const plain = world()
    plain.run({ fingerprint: standard() })
    expect(await plain.eval<Promise<unknown[]>>('queryLocalFonts()')).toHaveLength(1)
  })

  it('patches only what it announces: with nothing asked, the window is exactly as it was', () => {
    const page = world()
    const snapshot = `JSON.stringify([fetch === window.__fetchBefore, Function.prototype.toString === window.__toStringBefore, HTMLCanvasElement.prototype.toDataURL === window.__toDataBefore, Object.getOwnPropertyNames(window).length === window.__namesBefore])`
    page.eval(`window.__fetchBefore = fetch; window.__toStringBefore = Function.prototype.toString; window.__toDataBefore = HTMLCanvasElement.prototype.toDataURL; window.__namesBefore = 0; window.__namesBefore = Object.getOwnPropertyNames(window).length`)
    page.run({ scriptlets: [], fingerprint: null })
    expect(page.eval(snapshot)).toBe('[true,true,true,true]')
  })

  it('tells the console, and goes on, when a part of the protection cannot be installed', () => {
    const page = world()
    // A frozen prototype refuses the patch.
    page.eval('Object.freeze(HTMLCanvasElement.prototype); Object.freeze(AudioBuffer.prototype)')
    page.run({ fingerprint: standard() })
    expect(page.logs.warn.join('\n')).toMatch(/canvas protection could not be installed/)
    expect(page.logs.warn.join('\n')).toMatch(/audio protection could not be installed/)
    // The rest still works.
    expect(page.eval('navigator.hardwareConcurrency')).toBe(8)
  })
})
