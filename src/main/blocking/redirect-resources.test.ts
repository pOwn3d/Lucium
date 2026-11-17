import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { redirectResourceNames, redirectResourceOf } from '@shared/redirect-resources'

// Each stand-in script is run in a bare V8 context: no timer, no network, no storage, no DOM. A stub that reached for any of them would throw.
function run(name: string, setup = ''): { win: Record<string, any>; errors: unknown[] } {
  const errors: unknown[] = []
  const context = vm.createContext({ console: { error: (e: unknown) => errors.push(e) } })
  vm.runInContext(`globalThis.window = globalThis; ${setup}`, context)
  vm.runInContext(redirectResourceOf(name)!.body, context)
  return { win: context as Record<string, any>, errors }
}

const scripts = redirectResourceNames().filter((name) => redirectResourceOf(name)!.mime === 'text/javascript')

describe('the stand-in scripts', () => {
  it('run in an empty window without a timer, a request or any API of the browser', () => {
    expect(scripts.length).toBeGreaterThan(8)
    for (const name of scripts) expect(() => run(name), name).not.toThrow()
  })

  it('googletagservices_gpt.js: the commands queued before it are run, later ones too, and the chain of calls never breaks', () => {
    const { win } = run('googletagservices_gpt.js', 'globalThis.ran = []; globalThis.googletag = { cmd: [function () { ran.push("early") }] };')
    expect(win['ran']).toEqual(['early'])
    vm.runInContext('googletag.cmd.push(function () { ran.push("late") })', win as any)
    expect(win['ran']).toEqual(['early', 'late'])
    const chained = vm.runInContext(`(() => {
      const slot = googletag.defineSlot('/1/x', [300, 250], 'div-1').addService(googletag.pubads()).setTargeting('a', 'b').defineSizeMapping(googletag.sizeMapping().addSize([0, 0], []).build());
      googletag.pubads().enableSingleRequest(); googletag.pubads().addEventListener('slotRenderEnded', () => {}); googletag.enableServices(); googletag.display('div-1');
      return [typeof slot, googletag.pubadsReady, googletag.apiReady, googletag.destroySlots(), String(googletag.pubads().getSlots())]
    })()`, win as any)
    expect(chained).toEqual(['function', true, true, true, ''])
  })

  it('googletagservices_gpt.js: a command of the page that throws goes to the console and the others still run', () => {
    const { win, errors } = run('googletagservices_gpt.js', 'globalThis.googletag = { cmd: [function () { throw new Error("page bug") }, function () { globalThis.second = true }] };')
    expect(win['second']).toBe(true)
    expect(String(errors[0])).toMatch(/page bug/)
  })

  it('google-analytics_analytics.js: ga() calls its callbacks and returns a tracker, and replays what the snippet queued', () => {
    const queued = `globalThis.seen = []; globalThis.ga = function () { (ga.q = ga.q || []).push(arguments) }; ga('create', 'UA-1', 'auto'); ga(function (t) { seen.push(typeof t.get) }); ga('send', 'pageview', { hitCallback: function () { seen.push('hit') } });`
    const { win } = run('google-analytics_analytics.js', queued)
    expect(win['seen']).toEqual(['function', 'hit'])
    expect(vm.runInContext(`typeof ga.create('UA-2').send === 'function' && ga.getAll().length === 1 && ga.loaded`, win as any)).toBe(true)
  })

  it('google-analytics_ga.js: _gaq.push runs functions, _gat gives a tracker whatever is asked of it', () => {
    const { win } = run('google-analytics_ga.js', 'globalThis.ran = []; globalThis._gaq = [function () { ran.push(1) }, ["_trackPageview"]];')
    expect(win['ran']).toEqual([1])
    expect(vm.runInContext(`_gaq.push(function () { ran.push(2) }); _gat._getTracker('UA-1')._trackPageview(); _gat._getTracker('UA-1')._anything(); ran.length`, win as any)).toBe(2)
  })

  it('googletagmanager_gtm.js: dataLayer exists, and the eventCallback of an event is called', () => {
    const { win } = run('googletagmanager_gtm.js', 'globalThis.called = []; globalThis.dataLayer = [{ event: "early", eventCallback: function () { called.push("early") } }];')
    vm.runInContext(`dataLayer.push({ event: 'x', eventCallback: function () { called.push('late') } }); dataLayer.push({ event: 'y' })`, win as any)
    expect(win['called']).toEqual(['early', 'late'])
    expect(vm.runInContext('dataLayer.length', win as any)).toBe(3)
    expect(vm.runInContext('typeof google_tag_manager', win as any)).toBe('object')
  })

  it('googlesyndication_adsbygoogle.js: push does nothing and an already loaded one is left alone', () => {
    const { win } = run('googlesyndication_adsbygoogle.js')
    expect(vm.runInContext(`(adsbygoogle = window.adsbygoogle || []).push({}); adsbygoogle.loaded`, win as any)).toBe(true)
    const kept = run('googlesyndication_adsbygoogle.js', 'globalThis.adsbygoogle = { loaded: true, mine: 1 };')
    expect(vm.runInContext('adsbygoogle.mine', kept.win as any)).toBe(1)
  })

  it('amazon_apstag.js, scorecardresearch_beacon.js, chartbeat.js: the objects pages call exist and answer', () => {
    const { win } = run('amazon_apstag.js', 'globalThis.bids = null;')
    vm.runInContext('apstag.init({}); apstag.fetchBids({ slots: [] }, function (b) { bids = b }); apstag.setDisplayBids()', win as any)
    expect(win['bids']).toEqual([])
    expect(vm.runInContext('apstag.targetingKeys()', win as any)).toEqual([])
    expect(vm.runInContext('COMSCORE.beacon({ c1: 2 }); typeof _comscore', run('scorecardresearch_beacon.js').win as any)).toBe('object')
    expect(vm.runInContext('pSUPERFLY.activity(); pSUPERFLY.virtualPage("/x"); 1', run('chartbeat.js').win as any)).toBe(1)
  })

  it('never reach the network, a timer or storage by name', () => {
    for (const name of scripts) {
      const body = redirectResourceOf(name)!.body
      expect(body, name).not.toMatch(/(?<![\w.])(?:fetch\s*\(|XMLHttpRequest|setTimeout|setInterval|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|eval\s*\(|Function\s*\(|import\s*\()|document\.cookie|\.fetch\b/)
    }
  })
})
