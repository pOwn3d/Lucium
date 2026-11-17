// The stand-ins a `$redirect=` rule may name: inert files written for Lucium, served in place of a blocked request so that the page that
// asked for it keeps working (a tracker's script that "loads" and does nothing, a 1x1 picture, an empty style sheet). A list only names a
// resource; the bytes are these, never something a list or a server brings. A name that is not here makes the rule a plain block, as before.
//
// Pure: the main process turns an entry into a `data:` address (see `redirectTarget`) and Chromium loads that instead of the request.

export interface RedirectResource {
  /** The media type the page sees. */
  mime: string
  /** Text, or base64 when `binary`. */
  body: string
  binary?: true
}

// Scripts are plain ES5 with no dependency, no network, no timer, no storage: they define the few globals the real file defines, with
// methods that do nothing and call back where the page waits for a callback. A callback of the page that throws is the page's own error:
// it goes to the console (`fail`) and the stand-in carries on, as the real file would not stop the other commands either.
const NOOP_JS = '(function(){})();'

const GPT = `(function(){
  var w = window, noop = function(){};
  var fail = function(e){ if (w.console && w.console.error) w.console.error(e); };
  var chain = typeof Proxy === 'function'
    ? new Proxy(noop, { get: function(t, k){ return k === 'then' ? undefined : k === Symbol.toPrimitive ? function(){ return ''; } : chain; }, apply: function(){ return chain; } })
    : noop;
  var g = w.googletag = w.googletag || {};
  var waiting = Array.isArray(g.cmd) ? g.cmd : [];
  var run = function(){ for (var i = 0; i < arguments.length; i++) { try { if (typeof arguments[i] === 'function') arguments[i].call(g); } catch (e) { fail(e); } } return 0; };
  g.cmd = { push: run };
  g.apiReady = true; g.pubadsReady = true;
  g.defineSlot = function(){ return chain; }; g.defineOutOfPageSlot = function(){ return chain; };
  g.pubads = function(){ return chain; }; g.companionAds = function(){ return chain; }; g.content = function(){ return chain; };
  g.sizeMapping = function(){ return chain; };
  g.enableServices = noop; g.display = noop; g.disablePublisherConsole = noop; g.openConsole = noop;
  g.destroySlots = function(){ return true; }; g.getVersion = function(){ return ''; };
  run.apply(null, waiting);
})();`

const ANALYTICS = `(function(){
  var w = window, noop = function(){};
  var fail = function(e){ if (w.console && w.console.error) w.console.error(e); };
  var tracker = { get: function(){ return undefined; }, set: noop, send: noop };
  var ga = function(){
    var a = arguments, last = a[a.length - 1];
    try {
      if (typeof a[0] === 'function') a[0](tracker);
      else if (last && typeof last === 'object' && typeof last.hitCallback === 'function') last.hitCallback();
    } catch (e) { fail(e); }
  };
  ga.create = function(){ return tracker; }; ga.getByName = function(){ return tracker; }; ga.getAll = function(){ return [tracker]; };
  ga.remove = noop; ga.loaded = true;
  var name = typeof w.GoogleAnalyticsObject === 'string' && w.GoogleAnalyticsObject ? w.GoogleAnalyticsObject : 'ga';
  var queued = w[name] && w[name].q ? w[name].q : [];
  w[name] = ga;
  for (var i = 0; i < queued.length; i++) ga.apply(null, queued[i]);
})();`

const GA_CLASSIC = `(function(){
  var w = window, noop = function(){};
  var fail = function(e){ if (w.console && w.console.error) w.console.error(e); };
  var tracker = typeof Proxy === 'function' ? new Proxy({}, { get: function(){ return noop; } }) : { _trackPageview: noop, _trackEvent: noop, _setAccount: noop };
  var queued = Array.isArray(w._gaq) ? w._gaq : [];
  var run = function(){ for (var i = 0; i < arguments.length; i++) { try { if (typeof arguments[i] === 'function') arguments[i](); } catch (e) { fail(e); } } return 0; };
  w._gaq = { push: run };
  w._gat = { _getTracker: function(){ return tracker; }, _createTracker: function(){ return tracker; }, _anonymizeIp: noop };
  run.apply(null, queued);
})();`

const GTM = `(function(){
  var w = window;
  var fail = function(e){ if (w.console && w.console.error) w.console.error(e); };
  var layer = w.dataLayer = Array.isArray(w.dataLayer) ? w.dataLayer : [];
  var done = function(item){ try { if (item && typeof item === 'object' && typeof item.eventCallback === 'function') item.eventCallback(); } catch (e) { fail(e); } };
  var push = Array.prototype.push;
  layer.push = function(){ for (var i = 0; i < arguments.length; i++) done(arguments[i]); return push.apply(layer, arguments); };
  for (var i = 0; i < layer.length; i++) done(layer[i]);
  w.google_tag_manager = w.google_tag_manager || {};
})();`

const ADSBYGOOGLE = `(function(){
  var w = window, current = w.adsbygoogle;
  if (current && current.loaded === true) return;
  w.adsbygoogle = { loaded: true, push: function(){ return 0; }, length: 0 };
})();`

const APSTAG = `(function(){
  var w = window, noop = function(){};
  var fail = function(e){ if (w.console && w.console.error) w.console.error(e); };
  w.apstag = {
    _Q: [], init: noop, setDisplayBids: noop, dpa: noop, rpa: noop, upa: noop, deleteId: noop, renewId: noop, updateId: noop,
    targetingKeys: function(){ return []; },
    fetchBids: function(config, callback){ try { if (typeof callback === 'function') callback([]); } catch (e) { fail(e); } }
  };
})();`

const COMSCORE = `(function(){
  var w = window, noop = function(){};
  w.COMSCORE = w.COMSCORE || { beacon: noop, purge: noop };
  w._comscore = Array.isArray(w._comscore) ? w._comscore : [];
})();`

const CHARTBEAT = `(function(){
  var w = window, noop = function(){};
  w.pSUPERFLY = w.pSUPERFLY || { activity: noop, virtualPage: noop };
})();`

// A transparent GIF of one pixel, and transparent PNGs, made for this file (a header, one empty image, an end).
const GIF_1X1 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII='
const PNG_2X2 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVR42mNgQAcAABIAAeRVjecAAAAASUVORK5CYII='
const PNG_3X2 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAC0lEQVR42mNgwAUAABoAAS+Yl6YAAAAASUVORK5CYII='
const PNG_32X32 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII='

/** Canonical name, then the other spellings lists use for it. */
const DEFINITIONS: ReadonlyArray<[names: readonly string[], resource: RedirectResource]> = [
  [['noop.js', 'noopjs'], { mime: 'text/javascript', body: NOOP_JS }],
  [['noop.txt', 'nooptext', 'empty'], { mime: 'text/plain', body: '' }],
  [['noop.css', 'noopcss'], { mime: 'text/css', body: '' }],
  [['noop.html', 'noopframe'], { mime: 'text/html', body: '<!doctype html><meta charset="utf-8"><title></title>' }],
  [['noop.json', 'noopjson'], { mime: 'application/json', body: '{}' }],
  [['1x1.gif', '1x1-transparent.gif'], { mime: 'image/gif', body: GIF_1X1, binary: true }],
  [['1x1.png', '1x1-transparent.png'], { mime: 'image/png', body: PNG_1X1, binary: true }],
  [['2x2.png', '2x2-transparent.png'], { mime: 'image/png', body: PNG_2X2, binary: true }],
  [['3x2.png', '3x2-transparent.png'], { mime: 'image/png', body: PNG_3X2, binary: true }],
  [['32x32.png', '32x32-transparent.png'], { mime: 'image/png', body: PNG_32X32, binary: true }],
  [['googletagservices_gpt.js', 'googletagservices.com/gpt.js', 'googletagservices-gpt'], { mime: 'text/javascript', body: GPT }],
  [['google-analytics_analytics.js', 'google-analytics.com/analytics.js', 'google-analytics'], { mime: 'text/javascript', body: ANALYTICS }],
  [['google-analytics_ga.js', 'google-analytics.com/ga.js'], { mime: 'text/javascript', body: GA_CLASSIC }],
  [['googletagmanager_gtm.js', 'googletagmanager.com/gtm.js'], { mime: 'text/javascript', body: GTM }],
  [['googlesyndication_adsbygoogle.js', 'googlesyndication.com/adsbygoogle.js'], { mime: 'text/javascript', body: ADSBYGOOGLE }],
  [['amazon_apstag.js'], { mime: 'text/javascript', body: APSTAG }],
  [['scorecardresearch_beacon.js', 'scorecardresearch.com/beacon.js'], { mime: 'text/javascript', body: COMSCORE }],
  [['chartbeat.js'], { mime: 'text/javascript', body: CHARTBEAT }]
]

const BY_NAME = new Map<string, RedirectResource>()
/** The first name of each definition: what the stand-in's address carries. */
const BY_CANONICAL = new Map<string, RedirectResource>()
const CANONICAL_OF = new Map<RedirectResource, string>()
for (const [names, resource] of DEFINITIONS) {
  for (const name of names) BY_NAME.set(name, resource)
  BY_CANONICAL.set(names[0]!, resource)
  CANONICAL_OF.set(resource, names[0]!)
}

/** The stand-in a list's `redirect=` value stands for, or null (a name this library does not have, `none`, anything else). */
export function redirectResourceOf(name: unknown): RedirectResource | null {
  return typeof name === 'string' ? (BY_NAME.get(name.trim()) ?? null) : null
}

/** Every name a list may use, for the documentation and the tests. */
export function redirectResourceNames(): string[] {
  return [...BY_NAME.keys()]
}

// ---------- where a request is sent ----------
//
// Chromium refuses a redirect from a web address to a `data:` address (measured in Electron 45: net::ERR_ABORTED for a script and a picture,
// same site or not), and follows one to a custom scheme that the session serves itself (measured: the script loads and runs). So a stand-in is
// served under the scheme below by the engine (`session.protocol.handle`, see engine/electron-engine.ts), at an address whose host is a random
// word drawn at launch: a page cannot ask for a stand-in by itself, and so cannot tell from the answer that the extended rules are on.

/** The scheme the stand-ins are served under. */
export const STAND_IN_SCHEME = 'lucium-stand-in'
/**
 * What the scheme is declared with at start: `secure` and nothing else, so that a page on https may load it (no mixed content) and no page can
 * fetch it with CORS, register a service worker on it, or have it bypass its Content-Security-Policy.
 */
export const STAND_IN_PRIVILEGES = { secure: true } as const
/** The host of the addresses the blocker hands out; the engine puts its own word in place before the request leaves. */
const PLACEHOLDER_HOST = 'resource'
// The name is whatever follows the host: only a name of the table is ever served, so anything else (a path, a query) finds nothing.
const STAND_IN_ADDRESS = new RegExp(`^${STAND_IN_SCHEME}://([0-9a-z]{1,64})/(.+)$`)

/** The address of the stand-in a rule's `redirect=` names, with the placeholder host; null when the library has no such stand-in. */
export function redirectTargetOf(name: unknown): string | null {
  const resource = redirectResourceOf(name)
  return resource ? `${STAND_IN_SCHEME}://${PLACEHOLDER_HOST}/${CANONICAL_OF.get(resource)!}` : null
}

/** Whether an address is exactly one the blocker hands out: a stand-in of the library, under the placeholder host. */
export function isStandInAddress(address: unknown): boolean {
  return typeof address === 'string' && standInIn(address, PLACEHOLDER_HOST) !== null
}

/** The same address under another host (the word of this launch). Null for an address that is not a stand-in's. */
export function withStandInHost(address: string, host: string): string | null {
  const found = STAND_IN_ADDRESS.exec(address)
  return found && /^[0-9a-z]{1,64}$/.test(host) && BY_CANONICAL.has(found[2]!) ? `${STAND_IN_SCHEME}://${host}/${found[2]!}` : null
}

function standInIn(address: string, host: string): RedirectResource | null {
  const found = STAND_IN_ADDRESS.exec(address)
  return found && found[1] === host ? (BY_CANONICAL.get(found[2]!) ?? null) : null
}

/** What to answer to a request for `address`: the stand-in, only when the address carries this launch's host. */
export function standInServed(address: unknown, host: string): RedirectResource | null {
  return typeof address === 'string' ? standInIn(address, host) : null
}
