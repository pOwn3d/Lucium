import { describe, expect, it } from 'vitest'
import { MAX_PLIST_CHARS, parsePlist } from './plist'

const wrap = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${body}\n</plist>\n`

describe('parsePlist', () => {
  it('reads dictionaries, arrays, strings, numbers and booleans', () => {
    const xml = wrap(`<dict>
      <key>Title</key><string>Barre &amp; menu &lt;1&gt;</string>
      <key>Count</key><integer>3</integer>
      <key>Ratio</key><real>0.5</real>
      <key>On</key><true/>
      <key>Off</key><false/>
      <key>Empty</key><string></string>
      <key>Short</key><string/>
      <key>Children</key><array><dict><key>URLString</key><string>https://a.example/</string></dict><string>x</string></array>
      <key>None</key><array/>
      <key>Nothing</key><dict/>
    </dict>`)
    expect(parsePlist(xml)).toEqual({
      Title: 'Barre & menu <1>',
      Count: 3,
      Ratio: 0.5,
      On: true,
      Off: false,
      Empty: '',
      Short: '',
      Children: [{ URLString: 'https://a.example/' }, 'x'],
      None: [],
      Nothing: {}
    })
  })

  it('decodes numeric entities and keeps dates and data usable', () => {
    const xml = wrap(`<dict><key>A</key><string>&#233;&#x1F600;</string><key>D</key><date>2024-01-02T03:04:05Z</date><key>B</key><data>
      AAEC
      AwQF</data></dict>`)
    const parsed = parsePlist(xml) as Record<string, unknown>
    expect(parsed['A']).toBe('é😀')
    expect((parsed['D'] as Date).toISOString()).toBe('2024-01-02T03:04:05.000Z')
    expect(parsed['B']).toBe('AAECAwQF')
  })

  it('refuses what is not a property list rather than guessing', () => {
    for (const bad of ['', 'hello', wrap('<dict><key>A</key></dict>'), wrap('<dict><string>x</string></dict>'), wrap('<array><string>x</string>'), wrap('<widget/>'), wrap('<integer>abc</integer>')]) {
      expect(() => parsePlist(bad), bad).toThrow(/Invalid property list/)
    }
  })

  it('refuses nesting deeper than it is willing to follow', () => {
    const deep = `${'<array>'.repeat(200)}${'</array>'.repeat(200)}`
    expect(() => parsePlist(wrap(deep))).toThrow(/too deep/)
  })

  it('skips comments, processing instructions and a doctype wherever they stand', () => {
    const xml = `<?xml version="1.0"?><!-- a <b> comment with > and <dict> inside -->\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "x.dtd"><plist><!-- c --><dict><?pi data?><key>A</key><!--x--><string>1</string></dict></plist>`
    expect(parsePlist(xml)).toEqual({ A: '1' })
  })
})

describe('parsePlist on hostile files', () => {
  // These sizes took 7 to 35 seconds with the regular expression that cut the text into tags (a lazy match re-scanned from each opening
  // to the end of the file). One pass takes milliseconds; the margin is for a slow machine.
  const LIMIT_MS = 1500
  for (const unit of ['<!--', '<?', '<!DOCTYPE ', '<a ', '<dict ']) {
    it(`refuses 100 000 unterminated ${JSON.stringify(unit)} at once, without re-reading the file for each`, () => {
      const started = performance.now()
      expect(() => parsePlist(unit.repeat(100_000))).toThrow(/Invalid property list/)
      expect(performance.now() - started).toBeLessThan(LIMIT_MS)
    })
  }

  it('reads a big valid list in time proportional to its size', () => {
    const entries = Array.from({ length: 100_000 }, (_, i) => `<!-- ${i} --><dict><key>URLString</key><string>https://a.example/${i}</string></dict>`).join('')
    const started = performance.now()
    const value = parsePlist(wrap(`<array>${entries}</array>`)) as unknown[]
    expect(value).toHaveLength(100_000)
    expect(performance.now() - started).toBeLessThan(LIMIT_MS * 2)
  })

  it('names what is wrong with an opening that never closes', () => {
    expect(() => parsePlist('<plist><!-- never closed <dict/></plist>')).toThrow(/unterminated comment/)
    expect(() => parsePlist('<plist><?php never closed </plist>')).toThrow(/unterminated processing instruction/)
    expect(() => parsePlist('<plist><dict')).toThrow(/unterminated tag/)
    expect(() => parsePlist('<plist><dict/<array></plist>')).toThrow(/malformed tag/)
  })

  it('refuses a text larger than it will hold, before reading it', () => {
    expect(() => parsePlist(' '.repeat(MAX_PLIST_CHARS + 1))).toThrow(/too large/)
  })

  it('keeps a key named __proto__ as a key, not as the prototype of its dictionary', () => {
    const value = parsePlist(wrap('<dict><key>__proto__</key><dict><key>WebBookmarkType</key><string>x</string></dict></dict>')) as Record<string, unknown>
    expect(Object.keys(value)).toEqual(['__proto__'])
    expect(value['WebBookmarkType']).toBeUndefined()
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  })
})
