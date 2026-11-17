import { describe, expect, it } from 'vitest'
import { cleanCspPolicy, isRemoveParamName, judgeScriptletSelector, splitScriptletCall } from './extended-rules'
import { STAND_IN_PRIVILEGES, STAND_IN_SCHEME, isStandInAddress, redirectResourceNames, redirectResourceOf, redirectTargetOf, standInServed, withStandInHost } from './redirect-resources'
import { GUARD_ADDRESS_MAX, guardPageUrl } from './page-guard'
import { cleanScriptletCalls, isCheapRegexBody, isNeedle, isPropertyChain, parseScriptletCall, SCRIPTLET_CALLS_MAX, scriptletIdOf, scriptletNames } from './scriptlets'

describe('the names of the scriptlet library', () => {
  it('understands the long names and the aliases of uBlock Origin lists, with or without ".js"', () => {
    expect(scriptletIdOf('set-constant')).toBe('set-constant')
    expect(scriptletIdOf('set')).toBe('set-constant')
    expect(scriptletIdOf('aopr')).toBe('abort-on-property-read')
    expect(scriptletIdOf('abort-on-property-read.js')).toBe('abort-on-property-read')
    expect(scriptletIdOf('acis')).toBe('abort-current-script')
    expect(scriptletIdOf('nostif')).toBe('no-setTimeout-if')
    expect(scriptletIdOf('window.open-defuser')).toBe('no-window-open-if')
  })

  it('refuses a name that is not in the library, however it is spelled', () => {
    for (const name of ['trusted-click-element', 'trusted-set-cookie', 'eval', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', ' ', 'set-constant ; x']) {
      expect(scriptletIdOf(name), name).toBeNull()
    }
  })

  it('maps every spelling to a scriptlet that has a grammar', () => {
    for (const name of scriptletNames()) {
      expect(scriptletIdOf(name), name).not.toBeNull()
      expect(parseScriptletCall(name, ['x'.repeat(300)]).ok, `${name} must refuse a 300-character argument`).toBe(false)
    }
  })
})

describe('the arguments of a scriptlet', () => {
  it('takes a property path, and nothing that reaches the prototype chain or evaluates', () => {
    expect(isPropertyChain('adsbygoogle.loaded')).toBe(true)
    expect(isPropertyChain('navigator.userAgent')).toBe(true)
    expect(isPropertyChain('__proto__.x')).toBe(false)
    expect(isPropertyChain('a.__proto__')).toBe(false)
    // The other way from an object to the prototype of its kind.
    expect(isPropertyChain('document.constructor.prototype.cookie')).toBe(false)
    expect(isPropertyChain('constructor.prototype.x')).toBe(false)
    // A prototype named on purpose is a path like any other.
    expect(isPropertyChain('Object.prototype.adBlockDetected')).toBe(true)
    expect(isPropertyChain('a..b')).toBe(false)
    expect(isPropertyChain('a;b')).toBe(false)
    expect(isPropertyChain('a()')).toBe(false)
    expect(isPropertyChain('a["b"]')).toBe(false)
    expect(isPropertyChain('1a')).toBe(false)
    expect(isPropertyChain('a.b.c.d.e.f.g.h.i')).toBe(false)
    expect(isPropertyChain('a'.repeat(121))).toBe(false)
  })

  it('puts only the constants lists use, never an expression', () => {
    for (const value of ['undefined', 'false', 'true', 'null', 'noopFunc', 'trueFunc', 'falseFunc', 'emptyObj', 'emptyArr', 'yes', 'no', '0', '-1', '12345', "''"]) {
      expect(parseScriptletCall('set-constant', ['adsOn', value]).ok, value).toBe(true)
    }
    for (const value of ['alert(1)', '1+1', 'function(){}', 'window', '123456', '"x"', 'x=1', 'NaN', 'Infinity']) {
      expect(parseScriptletCall('set-constant', ['adsOn', value]).ok, value).toBe(false)
    }
  })

  it('checks the number of arguments of each scriptlet', () => {
    expect(parseScriptletCall('aopr', []).ok).toBe(false)
    expect(parseScriptletCall('aopr', ['a', 'b']).ok).toBe(false)
    expect(parseScriptletCall('set-constant', ['a']).ok).toBe(false)
    expect(parseScriptletCall('acs', ['document.createElement']).ok).toBe(true)
    expect(parseScriptletCall('acs', ['document.createElement', 'adblock', 'x']).ok).toBe(false)
    // A timer scriptlet without a needle would defuse every timer of the page.
    expect(parseScriptletCall('nostif', []).ok).toBe(false)
    expect(parseScriptletCall('nostif', ['']).ok).toBe(false)
    expect(parseScriptletCall('aeld', []).ok).toBe(false)
    expect(parseScriptletCall('aeld', ['', '']).ok).toBe(false)
    expect(parseScriptletCall('aeld', ['click', '']).ok).toBe(true)
    expect(parseScriptletCall('nostif', ['adblock', '2000']).ok).toBe(true)
    expect(parseScriptletCall('nostif', ['adblock', 'soon']).ok).toBe(false)
    expect(parseScriptletCall('aopr', 'not-a-list').ok).toBe(false)
    expect(parseScriptletCall('aopr', [1]).ok).toBe(false)
    expect(parseScriptletCall(null, []).ok).toBe(false)
  })

  it('prune-response takes an address needle and a path list, and nothing else', () => {
    const address = '/^https:\\/\\/www\\.youtube\\.com\\/youtubei\\/v1\\/player(\\?|$)/'
    expect(parseScriptletCall('prune-response', [address, 'adPlacements [].playerResponse.adSlots']).ok).toBe(true)
    expect(parseScriptletCall('prune-response', ['', 'adPlacements']).ok).toBe(false)
    expect(parseScriptletCall('prune-response', [address]).ok).toBe(false)
    expect(parseScriptletCall('prune-response', [address, '']).ok).toBe(false)
    expect(parseScriptletCall('prune-response', [address, 'a;b']).ok).toBe(false)
    expect(parseScriptletCall('prune-response', [address, 'adPlacements', 'x']).ok).toBe(false)
    // A regular expression with a repeated group is refused, as for every needle.
    expect(parseScriptletCall('prune-response', ['/(a+)+$/', 'adPlacements']).ok).toBe(false)
  })

  it('never removes an attribute that protects the page: the sandbox of a frame, the checksum of a script, a nonce, a policy', () => {
    for (const name of ['sandbox', 'integrity', 'nonce', 'csp', 'referrerpolicy', 'SandBox', 'INTEGRITY']) {
      expect(parseScriptletCall('remove-attr', [name]).ok, name).toBe(false)
      expect(parseScriptletCall('ra', [`onclick|${name}`, 'iframe']).ok, name).toBe(false)
      expect(cleanScriptletCalls([{ id: 'remove-attr', args: [name, 'iframe', 'stay'] }]), name).toEqual([])
    }
    // Names that only contain one of them are other attributes, and a class of that name protects nothing.
    expect(parseScriptletCall('ra', ['data-nonce|data-sandbox|onclick']).ok).toBe(true)
    expect(parseScriptletCall('rc', ['sandbox', 'body']).ok).toBe(true)
  })

  it('accepts a path list for json-prune and a selector for remove-attr, and refuses what could close a rule or run', () => {
    expect(parseScriptletCall('json-prune', ['ads adPlacements', 'playerResponse']).ok).toBe(true)
    expect(parseScriptletCall('json-prune', ['a.[].b *.c']).ok).toBe(true)
    expect(parseScriptletCall('json-prune', ['']).ok).toBe(false)
    expect(parseScriptletCall('json-prune', ['a;b']).ok).toBe(false)
    expect(parseScriptletCall('ra', ['onclick|target', 'a.ad[href*="x"]']).ok).toBe(true)
    expect(parseScriptletCall('ra', ['onclick', 'a{color:red}']).ok).toBe(false)
    expect(parseScriptletCall('ra', ['on click']).ok).toBe(false)
    expect(parseScriptletCall('rc', ['blocked', 'body']).ok).toBe(true)
    expect(parseScriptletCall('rc', ['blocked', 'body\\9']).ok).toBe(false)
    expect(parseScriptletCall('no-fetch-if', ['url:/ads/']).ok).toBe(true)
    expect(parseScriptletCall('no-fetch-if', ['method:POST']).ok).toBe(false)
  })

  it('returns trimmed arguments and the canonical id', () => {
    expect(parseScriptletCall('aopr', [' adsbygoogle ']  )).toEqual({ ok: true, call: { id: 'abort-on-property-read', args: ['adsbygoogle'] } })
  })
})

describe('needles that are regular expressions', () => {
  it('accepts the cheap ones lists really use', () => {
    for (const body of ['adblock', '\\.fonts\\.', 'ads?', 'a|b|c', '^https?://', '[a-z]+\\.js$', 'foo.*bar', '(?:foo|bar)baz', 'x{2,5}y', '.*?ad.*']) {
      expect(isCheapRegexBody(body), body).toBe(true)
    }
  })

  it('refuses the ones that freeze a page: repeated groups, back-references, look-around, many unbounded repeats', () => {
    for (const body of ['(a+)+$', '(a*)*', '(a|aa)+', '(.*a){10}', '(a+)*b', '(?=a)', '(?!a)', '(?<=a)', '\\1', 'a**', '*a', 'a.*b.*c.*d', '(((a)))', '(a', 'a)', '[a', '\\u0041', '', 'x'.repeat(121)]) {
      expect(isCheapRegexBody(body), body).toBe(false)
    }
  })

  it('refuses the ones whose work grows as the cube of the text: two repetitions the engine comes back to, bounded or not', () => {
    // Measured before they were refused: `a*a*b` took 8 s on 4 000 characters, five `a{0,99}` and a `b` took 1 s on 80.
    for (const body of ['a*a*b', 'self.+ads.+;', 'a{0,99}a{0,99}b', 'a{0,99}a{0,99}a{0,99}a{0,99}a{0,99}b', '.*a{0,40}b', 'x{5,2}y']) {
      expect(isCheapRegexBody(body), body).toBe(false)
    }
    // One repetition, or a second one that ends the expression (nothing after it can fail): the text is read a bounded number of times.
    for (const body of ['a*b', 'a{0,99}b', 'a{0,40}b', '^ads.*', 'ads.*block.*', 'ads.*block.*?', 'a{3}b{2}.*c']) expect(isCheapRegexBody(body), body).toBe(true)
  })

  it('counts the ways a short repeat or an alternative lets a text be read: two beside a repetition, a thousand without one', () => {
    for (const body of ['ads?.*block', 'x{2,3}y.*z', 'foo|bar.*baz', 'a{0,9}a{0,9}a{0,9}b', 'a|b|c|d|e|f|g|h']) expect(isCheapRegexBody(body), body).toBe(true)
    for (const body of ['x{2,5}y.*z', 'a?b?.*c', 'a|b|c.*d', 'a{0,9}a{0,9}a{0,9}a{0,9}b', 'a{0,20}a{0,20}a{0,20}b']) expect(isCheapRegexBody(body), body).toBe(false)
  })

  it('applies to the needle written between slashes and not to a plain one', () => {
    expect(isNeedle('/adblock/i')).toBe(true)
    expect(isNeedle('/(a+)+$/')).toBe(false)
    expect(isNeedle('plain (text) with + and * chars')).toBe(true)
    expect(isNeedle('x'.repeat(201))).toBe(false)
    expect(isNeedle('a\u0000b')).toBe(false)
  })
})

describe('the calls given to a page', () => {
  it('keeps the well-formed ones, once each, and drops the rest', () => {
    const calls = cleanScriptletCalls([
      { id: 'abort-on-property-read', args: ['a.b'] },
      { id: 'abort-on-property-read', args: ['a.b'] },
      { id: 'set-constant', args: ['x', 'alert(1)'] },
      { id: 'eval', args: ['1'] },
      { id: 'aopr', args: ['a.b'] },
      null,
      'x',
      { id: 'no-window-open-if', args: [] }
    ])
    expect(calls).toEqual([
      { id: 'abort-on-property-read', args: ['a.b'] },
      { id: 'no-window-open-if', args: [] }
    ])
  })

  it('is bounded, and survives anything that is not a list', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: 'abort-on-property-read', args: [`p${i}`] }))
    expect(cleanScriptletCalls(many)).toHaveLength(SCRIPTLET_CALLS_MAX)
    for (const raw of [undefined, null, 3, 'x', {}, [[]], [{ id: 5 }]]) expect(cleanScriptletCalls(raw)).toEqual([])
  })
})

describe('+js(...) as a list writes it', () => {
  it('splits on the commas outside quotes and slashes', () => {
    expect(splitScriptletCall('+js(aopr, adsbygoogle)')).toEqual({ name: 'aopr', args: ['adsbygoogle'] })
    expect(splitScriptletCall(`+js(acs, document.createElement, /a,b/)`)).toEqual({ name: 'acs', args: ['document.createElement', '/a,b/'] })
    expect(splitScriptletCall(`+js(set-constant, "x", 'false')`)).toEqual({ name: 'set-constant', args: ['x', 'false'] })
    expect(splitScriptletCall('+js()')).toEqual({ name: '', args: [] })
    expect(splitScriptletCall('+js(aopr, "unclosed)')).toBeNull()
    expect(splitScriptletCall('.ad')).toBeNull()
  })

  it('judges a selector: a scriptlet of the library with good arguments, or a sentence', () => {
    expect(judgeScriptletSelector('+js(aopr, adsbygoogle)')).toEqual({ ok: true, call: { id: 'abort-on-property-read', args: ['adsbygoogle'] } })
    const unknown = judgeScriptletSelector('+js(trusted-click-element, button)')
    expect(unknown.ok).toBe(false)
    expect(!unknown.ok && unknown.reason.key).toBe('scriptlets.scriptlet-name-inconnu')
    const refused = judgeScriptletSelector('+js(set-constant, a, alert(1))')
    expect(!refused.ok && refused.reason.key).toBe('scriptlets.arguments-refuses-pour-id')
  })
})

describe('$csp', () => {
  it('keeps policies made of the restricting directives and sources of the list', () => {
    expect(cleanCspPolicy("script-src 'none'")).toBe("script-src 'none'")
    expect(cleanCspPolicy("script-src 'self' https://cdn.example.com; frame-src 'none';")).toBe("script-src 'self' https://cdn.example.com; frame-src 'none'")
    expect(cleanCspPolicy('SCRIPT-SRC data:')).toBe('script-src data:')
    expect(cleanCspPolicy('sandbox allow-scripts allow-same-origin')).toBe('sandbox allow-scripts allow-same-origin')
  })

  it('refuses a directive that would send something to a third party, one that is unknown, and anything odd', () => {
    for (const policy of ['report-uri https://t.example/r', 'report-to x', "script-src 'none'; report-uri https://t.example", 'upgrade-insecure-requests', 'script-src', "script-src 'none' ; ;x", '', 'script-src {x}', "script-src 'nonce-abc'", 'x'.repeat(301), "script-src 'none'\n"]) {
      expect(cleanCspPolicy(policy), policy).toBeNull()
    }
    expect(cleanCspPolicy(5)).toBeNull()
  })
})

describe('$removeparam', () => {
  it('accepts the name of one parameter', () => {
    expect(isRemoveParamName('fbclid')).toBe(true)
    expect(isRemoveParamName('utm_source')).toBe(true)
    expect(isRemoveParamName('a.b-c')).toBe(true)
  })
  it('refuses a regular expression, the inversion, a name with a separator, and an empty name', () => {
    for (const name of ['/^utm_/', '~keep', 'a=b', 'a&b', '', 'x'.repeat(65), 'a b']) expect(isRemoveParamName(name), name).toBe(false)
  })
})

describe('the stand-ins of $redirect', () => {
  it('knows the generic resources and the usual spellings', () => {
    for (const name of ['noopjs', 'noop.js', 'nooptext', '1x1.gif', '1x1-transparent.gif', '2x2.png', '32x32.png', 'noopcss', 'noopframe', 'googletagservices_gpt.js', 'googletagmanager.com/gtm.js']) {
      expect(redirectResourceOf(name), name).not.toBeNull()
    }
  })

  it('has nothing for a name it does not know, for "none", or for anything that is not a name', () => {
    for (const name of ['none', 'unknown.js', '', '__proto__', 'constructor', 'toString', null, 5, undefined]) expect(redirectResourceOf(name), String(name)).toBeNull()
    expect(redirectTargetOf('none')).toBeNull()
  })

  it('serves images that are really images of the size the name says', () => {
    const bytes = (name: string) => Uint8Array.from(atob(redirectResourceOf(name)!.body), (c) => c.charCodeAt(0))
    const hex = (data: Uint8Array) => Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('')
    for (const [name, w, h] of [['1x1.png', 1, 1], ['2x2.png', 2, 2], ['3x2.png', 3, 2], ['32x32.png', 32, 32]] as const) {
      const data = bytes(name)
      const view = new DataView(data.buffer)
      expect(hex(data.subarray(0, 8)), name).toBe('89504e470d0a1a0a')
      expect([view.getUint32(16), view.getUint32(20)], name).toEqual([w, h])
    }
    const gif = bytes('1x1.gif')
    const view = new DataView(gif.buffer)
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe('GIF89a')
    expect([view.getUint16(6, true), view.getUint16(8, true)]).toEqual([1, 1])
  })

  it('sends a request to an address of the scheme the engine serves, never a data: one (Chromium aborts a redirect to it), whatever the spelling asked for', () => {
    for (const name of redirectResourceNames()) {
      const target = redirectTargetOf(name)!
      expect(target, name).toMatch(new RegExp(`^${STAND_IN_SCHEME}://resource/[A-Za-z0-9_.-]+$`))
      expect(isStandInAddress(target), name).toBe(true)
    }
    expect(redirectTargetOf('noopjs')).toBe('lucium-stand-in://resource/noop.js')
    expect(redirectTargetOf('noop.js')).toBe(redirectTargetOf('noopjs'))
    expect(redirectTargetOf('googletagservices.com/gpt.js')).toBe('lucium-stand-in://resource/googletagservices_gpt.js')
  })

  it('puts the word of the launch in the address, and serves the stand-in only to an address that carries it', () => {
    const target = redirectTargetOf('1x1.gif')!
    const real = withStandInHost(target, 'a1b2c3d4e5f60718')!
    expect(real).toBe('lucium-stand-in://a1b2c3d4e5f60718/1x1.gif')
    expect(standInServed(real, 'a1b2c3d4e5f60718')).toBe(redirectResourceOf('1x1.gif'))
    // A page that guesses the address, or reads one from an older launch, is told nothing.
    expect(standInServed(target, 'a1b2c3d4e5f60718')).toBeNull()
    expect(standInServed(real, 'ffffffffffffffff')).toBeNull()
    expect(standInServed('lucium-stand-in://a1b2c3d4e5f60718/not-a-resource.js', 'a1b2c3d4e5f60718')).toBeNull()
  })

  it('declares the scheme with the one privilege that lets https pages load it, and none that would let a page do more with it', () => {
    expect(STAND_IN_PRIVILEGES).toEqual({ secure: true })
    expect(STAND_IN_SCHEME).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('refuses addresses that only look like a stand-in\'s', () => {
    for (const bad of ['lucium-stand-in://resource/noop.js?x=1', 'lucium-stand-in://resource/noop.js#x', 'lucium-stand-in://resource/a/b', 'lucium-stand-in://resource/', 'lucium-stand-in://re source/noop.js', 'lucium-stand-in://Resource/noop.js', 'lucium-stand-in:resource/noop.js', 'https://resource/noop.js', 'data:text/javascript,1', 'lucium-stand-in://resource/unknown.js', 'lucium-stand-in://resource/googletagservices.com%2Fgpt.js']) {
      expect(isStandInAddress(bad), bad).toBe(false)
      expect(withStandInHost(bad, 'abc123'), bad).toBeNull()
      expect(standInServed(bad, 'resource'), bad).toBeNull()
    }
    expect(withStandInHost(redirectTargetOf('noop.js')!, 'not a host')).toBeNull()
    expect(withStandInHost(redirectTargetOf('noop.js')!, '')).toBeNull()
    for (const notText of [null, undefined, 5, {}]) {
      expect(isStandInAddress(notText)).toBe(false)
      expect(standInServed(notText, 'resource')).toBeNull()
    }
  })
})

describe('the address a document is given its plan for', () => {
  it('is the address the preload read from its own document, a web address; the frame\'s is the fallback', () => {
    expect(guardPageUrl('https://new.test/a', 'https://old.test/')).toBe('https://new.test/a')
    expect(guardPageUrl('', 'https://old.test/')).toBe('https://old.test/')
    expect(guardPageUrl(undefined, 'http://old.test/')).toBe('http://old.test/')
    expect(guardPageUrl('about:blank', 'https://old.test/')).toBe('https://old.test/')
    expect(guardPageUrl('file:///tmp/a.html', 'chrome-extension://abc/x.html')).toBe('')
  })

  it('is the address of the opener for the blank window a page opens to write into', () => {
    expect(guardPageUrl('about:blank', '', 'https://opener.test/page')).toBe('https://opener.test/page')
    expect(guardPageUrl('about:blank#x', 'about:blank', 'https://opener.test/page')).toBe('https://opener.test/page')
    // A blank document nobody opened, or whose opener is not a web page, has no address.
    expect(guardPageUrl('about:blank', '', undefined)).toBe('')
    expect(guardPageUrl('about:blank', '', 'file:///tmp/a.html')).toBe('')
    // The opener speaks for a blank document only: a local file or an extension page a site opened gets nothing of the site's.
    expect(guardPageUrl('file:///tmp/a.html', '', 'https://opener.test/page')).toBe('')
    expect(guardPageUrl('chrome-extension://abc/x.html', '', 'https://opener.test/page')).toBe('')
    expect(guardPageUrl('about:blankety', '', 'https://opener.test/page')).toBe('')
    // A document with an address of its own keeps it.
    expect(guardPageUrl('https://new.test/a', '', 'https://opener.test/page')).toBe('https://new.test/a')
  })

  it('is nothing for what is not a web address, is too long, or is not text', () => {
    for (const bad of [null, 5, {}, 'javascript:alert(1)', 'https://', `https://a.test/${'x'.repeat(GUARD_ADDRESS_MAX)}`]) expect(guardPageUrl(bad, bad), String(bad).slice(0, 30)).toBe('')
  })
})
