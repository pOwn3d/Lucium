import { describe, expect, it } from 'vitest'
import { featureById, featureDefault } from './features'
import { setLanguage } from './i18n'
import {
  AUTOMATION_ADDRESS_MAX,
  AUTOMATION_COMMANDS,
  AUTOMATION_SCHEME,
  AUTOMATION_QUERY_MAX,
  AUTOMATION_RATE,
  AUTOMATION_URL_MAX,
  AutomationLimiter,
  automationAddress,
  automationQuery,
  automationSearchAddress,
  isAutomationUrl,
  parseAutomationUrl
} from './automation-url'

const parse = (url: string) => parseAutomationUrl(url, true)
const open = (address: string) => `lucium://open?url=${encodeURIComponent(address)}`

describe('the list of commands', () => {
  // A command that reads or erases something has no place on this list without a confirmation in a native box (see the threat model in automation-url.ts).
  it('is exactly open, new-tab and search, each with the parameters it needs', () => {
    expect(AUTOMATION_COMMANDS.map((c) => [c.name, [...c.params]])).toEqual([
      ['open', ['url']],
      ['new-tab', []],
      ['search', ['q']]
    ])
  })

  it('shows an example that each command accepts, written with the scheme shown', () => {
    for (const command of AUTOMATION_COMMANDS) {
      expect(parse(command.example), command.name).toMatchObject({ ok: true })
      expect(command.example.startsWith(`${AUTOMATION_SCHEME}//`), command.name).toBe(true)
    }
  })

  it('searches for words of the reader’s language in the example, encoded as a script must write them', () => {
    const search = () => AUTOMATION_COMMANDS.find((command) => command.name === 'search')!.example
    expect(search()).toBe('lucium://search?q=navigateur%20libre')
    try {
      setLanguage('en')
      expect(search()).toBe('lucium://search?q=open%20source%20browser')
      expect(parse(search())).toEqual({ ok: true, command: { command: 'search', query: 'open source browser' } })
    } finally {
      setLanguage('fr')
    }
  })

  it('refuses the commands that would read or erase, however they are written', () => {
    for (const name of ['clear', 'clear-data', 'history', 'tabs', 'list-tabs', 'get-url', 'current-url', 'read', 'close-all', 'quit', 'export', 'capture', 'cookies', 'eval', 'run', 'settings', 'delete', 'close-tab', 'reload-all', 'screenshot']) {
      expect(parse(`lucium://${name}`), name).toEqual({ ok: false, reason: 'unknown-command' })
      expect(parse(`lucium://${name}?url=https%3A%2F%2Fexample.com%2F`), name).toEqual({ ok: false, reason: 'unknown-command' })
    }
  })
})

describe('parseAutomationUrl', () => {
  it('refuses everything while the setting is off, without reading the address', () => {
    for (const url of [open('https://example.com/'), 'lucium://new-tab', 'lucium://clear', 'not even an address']) {
      expect(parseAutomationUrl(url, false), url).toEqual({ ok: false, reason: 'disabled' })
    }
  })

  it('opens a web address, normalised, from the encoded parameter', () => {
    expect(parse(open('https://example.com'))).toEqual({ ok: true, command: { command: 'open', url: 'https://example.com/' } })
    expect(parse(open('http://localhost:3000/a?b=c#d'))).toEqual({ ok: true, command: { command: 'open', url: 'http://localhost:3000/a?b=c#d' } })
    expect(parse('lucium://open?url=https://example.com/path?x=1')).toMatchObject({ ok: true, command: { url: 'https://example.com/path?x=1' } })
  })

  it('takes the scheme and the command in any case, and a trailing slash', () => {
    expect(parse('LUCIUM://New-Tab/')).toEqual({ ok: true, command: { command: 'new-tab' } })
    expect(parse('Lucium://OPEN/?url=https%3A%2F%2Fexample.com%2F')).toMatchObject({ ok: true, command: { command: 'open' } })
  })

  it('searches for a text, trimmed, with spaces and accents', () => {
    expect(parse('lucium://search?q=%20caf%C3%A9%20au%20lait%20')).toEqual({ ok: true, command: { command: 'search', query: 'café au lait' } })
    expect(parse('lucium://search?q=two words')).toEqual({ ok: true, command: { command: 'search', query: 'two words' } })
  })

  it('opens a new tab with no parameter, and refuses one it was given', () => {
    expect(parse('lucium://new-tab')).toEqual({ ok: true, command: { command: 'new-tab' } })
    expect(parse('lucium://new-tab?url=https%3A%2F%2Fexample.com%2F')).toEqual({ ok: false, reason: 'bad-parameter', command: 'new-tab' })
  })

  it('refuses a missing, an unknown or a repeated parameter', () => {
    expect(parse('lucium://open')).toEqual({ ok: false, reason: 'bad-parameter', command: 'open' })
    expect(parse('lucium://open?q=https%3A%2F%2Fexample.com%2F')).toEqual({ ok: false, reason: 'bad-parameter', command: 'open' })
    expect(parse(`${open('https://example.com/')}&extra=1`)).toEqual({ ok: false, reason: 'bad-parameter', command: 'open' })
    expect(parse(`${open('https://example.com/')}&url=https%3A%2F%2Fevil.example%2F`)).toEqual({ ok: false, reason: 'bad-parameter', command: 'open' })
    expect(parse('lucium://search')).toEqual({ ok: false, reason: 'bad-parameter', command: 'search' })
    expect(parse('lucium://search?q=a&q=b')).toEqual({ ok: false, reason: 'bad-parameter', command: 'search' })
  })

  it('refuses a login, a port, a fragment or a path on the command', () => {
    for (const url of ['lucium://user@open?url=https%3A%2F%2Fexample.com%2F', 'lucium://open:80?url=https%3A%2F%2Fexample.com%2F', `${open('https://example.com/')}#frag`, `lucium://open/more?url=https%3A%2F%2Fexample.com%2F`, 'lucium://new-tab/x']) {
      expect(parse(url), url).toMatchObject({ ok: false, reason: 'malformed' })
    }
  })

  it('refuses addresses that are not for this scheme or not in its form', () => {
    // The URL parser drops tabs and line breaks inside an address: "new-\ttab" would otherwise read as "new-tab".
    const malformed = ['https://example.com/', 'lucium:open?url=https%3A%2F%2Fexample.com%2F', 'lucium:/open', 'lucium:', '', ' lucium://new-tab', 'lucium://new-tab ', 'lucium://new-tab\n', 'lucium://new\u0000-tab', 'lucium://new-\ttab', 'lucium://new-t\nab', 'lucium://open?url=https%3A%2F%2Fexample.com%2F\r\n']
    for (const url of malformed) expect(parse(url), JSON.stringify(url)).toEqual({ ok: false, reason: 'malformed' })
    expect(parse('lucium://')).toEqual({ ok: false, reason: 'unknown-command' })
    for (const raw of [null, undefined, 42, {}, ['lucium://new-tab']]) expect(parseAutomationUrl(raw, true), String(raw)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('refuses what is not a plain web address to open', () => {
    const hostile = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'view-source:https://example.com/',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html',
      'ftp://example.com/',
      'about:blank',
      'lucium://new-tab',
      'lucium://open?url=https%3A%2F%2Fexample.com%2F',
      'https://user:secret@example.com/',
      'https://user@example.com/',
      'example.com',
      '//example.com',
      'https://exa mple.com/',
      'https://example.com/\npath',
      ' https://example.com/',
      'https://example.com/ '
    ]
    for (const address of hostile) expect(parse(open(address)), address).toEqual({ ok: false, reason: 'bad-address', command: 'open' })
  })

  it('refuses an address that is too long, whole or inside, from the first character past its bound', () => {
    const web = (length: number) => `https://example.com/${'a'.repeat(length - 'https://example.com/'.length)}`
    expect(parse(open(web(AUTOMATION_ADDRESS_MAX + 1)))).toEqual({ ok: false, reason: 'bad-address', command: 'open' })
    expect(parse(open(web(AUTOMATION_ADDRESS_MAX)))).toEqual({ ok: true, command: { command: 'open', url: web(AUTOMATION_ADDRESS_MAX) } })
    // The whole address: one character more and it is not read at all; at the bound it is read, and its search is refused for its own length.
    const search = (length: number) => `lucium://search?q=${'a'.repeat(length - 'lucium://search?q='.length)}`
    expect(parse(search(AUTOMATION_URL_MAX + 1))).toEqual({ ok: false, reason: 'malformed' })
    expect(parse(search(AUTOMATION_URL_MAX))).toEqual({ ok: false, reason: 'bad-query', command: 'search' })
  })

  it('refuses a search that is empty, blank, on several lines or too long', () => {
    for (const q of ['', '%20%20', 'a%0Ab', 'a%00b', 'a%09b', 'a%E2%80%A8b', 'a'.repeat(AUTOMATION_QUERY_MAX + 1)]) {
      expect(parse(`lucium://search?q=${q}`), q.slice(0, 20)).toEqual({ ok: false, reason: 'bad-query', command: 'search' })
    }
    expect(parse(`lucium://search?q=${'a'.repeat(AUTOMATION_QUERY_MAX)}`)).toMatchObject({ ok: true })
  })

  it('names the command in a refusal only when it is one of the list, never the parameters', () => {
    expect(parse('lucium://clear?q=secret')).toEqual({ ok: false, reason: 'unknown-command' })
    const refused = parse('lucium://search?q=')
    expect(JSON.stringify(refused)).toBe('{"ok":false,"reason":"bad-query","command":"search"}')
  })

  it('knows its own scheme, in any case, and nothing else', () => {
    expect(AUTOMATION_SCHEME).toBe('lucium:')
    for (const url of ['lucium://new-tab', 'LUCIUM:whatever', 'Lucium://open']) expect(isAutomationUrl(url), url).toBe(true)
    for (const other of ['https://lucium.app/', 'https://lucium.example/', 'luciums://x', 'lucium', 'luc://new-tab', 'browser://new-tab', 'mailto:a@b.c', '', null, 3]) expect(isAutomationUrl(other), String(other)).toBe(false)
  })
})

describe('the one scheme, lucium, in any case', () => {
  it('runs the same three commands whatever the case of the scheme, and none under another scheme', () => {
    for (const scheme of ['browser', 'luciums', 'luc']) expect(parse(`${scheme}://new-tab`), scheme).toEqual({ ok: false, reason: 'malformed' })
    for (const scheme of ['lucium', 'LUCIUM', 'Lucium']) {
      expect(parse(`${scheme}://new-tab`), scheme).toEqual({ ok: true, command: { command: 'new-tab' } })
      expect(parse(`${scheme}://open?url=https%3A%2F%2Fexample.com%2F`), scheme).toEqual({ ok: true, command: { command: 'open', url: 'https://example.com/' } })
      expect(parse(`${scheme}://search?q=caf%C3%A9`), scheme).toEqual({ ok: true, command: { command: 'search', query: 'café' } })
    }
  })

  it('refuses a switched-off application, a malformed address, an unknown command and a command inside a command', () => {
    expect(parseAutomationUrl('lucium://new-tab', false)).toEqual({ ok: false, reason: 'disabled' })
    for (const url of ['lucium:open?url=https%3A%2F%2Fexample.com%2F', 'lucium:/open', 'lucium:', ' lucium://new-tab', 'lucium://new-tab\n', 'lucium://user@open?url=https%3A%2F%2Fexample.com%2F', 'lucium://open/more?url=x']) {
      expect(parse(url), JSON.stringify(url)).toMatchObject({ ok: false, reason: 'malformed' })
    }
    expect(parse('lucium://clear')).toEqual({ ok: false, reason: 'unknown-command' })
    // A command never opens another command.
    for (const inner of ['lucium://new-tab', 'LUCIUM://new-tab']) expect(parse(open(inner)), inner).toEqual({ ok: false, reason: 'bad-address', command: 'open' })
  })
})

describe('automationAddress and automationQuery', () => {
  it('keep what they accept as the browser would write it', () => {
    expect(automationAddress('https://EXAMPLE.com')).toBe('https://example.com/')
    expect(automationQuery('  hello ')).toBe('hello')
  })

  it('refuse what is not a string', () => {
    for (const value of [undefined, null, 5, {}]) {
      expect(automationAddress(value)).toBeNull()
      expect(automationQuery(value)).toBeNull()
    }
  })

  it('puts the text in the search address of the profile, encoded', () => {
    expect(automationSearchAddress('https://search.example/?q=%s', 'a b&c=d')).toBe('https://search.example/?q=a%20b%26c%3Dd')
    // A text that holds what `replace` reads in a replacement string is put in as it is.
    expect(automationSearchAddress('https://search.example/?q=%s', "$& $' $`")).toBe('https://search.example/?q=%24%26%20%24\'%20%24%60')
  })
})

describe('AutomationLimiter', () => {
  it('lets the commands of a burst through up to the limit, then none, until the window has passed', () => {
    const limiter = new AutomationLimiter(3, 1000)
    expect([0, 10, 20, 30].map((t) => limiter.allow(t))).toEqual([true, true, true, false])
    expect(limiter.allow(500)).toBe(false)
    expect(limiter.allow(999)).toBe(false)
    expect(limiter.allow(1000)).toBe(true)
  })

  it('does not count a refused command against the window', () => {
    const limiter = new AutomationLimiter(2, 1000)
    limiter.allow(0)
    limiter.allow(100)
    for (let t = 200; t < 900; t += 100) expect(limiter.allow(t)).toBe(false)
    // The two that were counted leave at 1000 and 1100; the refused ones did not extend the wait.
    expect(limiter.allow(1000)).toBe(true)
    expect(limiter.allow(1050)).toBe(false)
    expect(limiter.allow(1100)).toBe(true)
  })

  it('uses a limit that lets a shortcut open a list of pages', () => {
    const limiter = new AutomationLimiter()
    const passed = Array.from({ length: AUTOMATION_RATE.max + 5 }, (_, i) => limiter.allow(i)).filter(Boolean)
    expect(passed).toHaveLength(AUTOMATION_RATE.max)
    expect(AUTOMATION_RATE.max).toBeGreaterThanOrEqual(10)
  })
})

describe('the switch', () => {
  it('is registered, costs nothing, and is off by default: any application could otherwise send these addresses', () => {
    expect(featureById('applescript')).toMatchObject({ key: 'urlAutomation', group: 'system', cost: ['none'] })
    expect(featureDefault('applescript')).toBe(false)
  })
})
