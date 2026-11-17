import { describe, expect, it, vi } from 'vitest'
import { DROPPED_LINKS_MAX, DROPPED_LINKS_TEXT_MAX, DROPPED_LINK_LENGTH_MAX, droppedLinkUrl, droppedLinkUrls } from './dropped-links'
import { isNavigableUrl } from './url'

// What the address of the bar is checked with: the same function must be asked, so that a dropped link and a pasted one pass the same door.
vi.mock('./url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./url')>()
  return { ...actual, isNavigableUrl: vi.fn(actual.isNavigableUrl) }
})

describe('droppedLinkUrl', () => {
  it('gives the address of a web link, written again by the parser', () => {
    expect(droppedLinkUrl('https://example.com/page?q=1#top')).toBe('https://example.com/page?q=1#top')
    expect(droppedLinkUrl('http://localhost:3000')).toBe('http://localhost:3000/')
    expect(droppedLinkUrl('HTTPS://Example.COM/A b'.replace(' ', '%20'))).toBe('https://example.com/A%20b')
  })

  it('asks the check of the address of the bar, and opens nothing that it refuses', () => {
    vi.mocked(isNavigableUrl).mockReturnValueOnce(false)
    expect(droppedLinkUrl('https://example.com/')).toBeNull()
    expect(droppedLinkUrl('https://example.com/')).toBe('https://example.com/')
  })

  it('refuses every scheme but http and https: a script, a document, a file, a blob, an address of Lucium, a page of an extension, a plain address of the web page of the application', () => {
    for (const link of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'blob:https://example.com/3f2a',
      'lucium://open?url=https://example.com/',
      'lucium-ui://extensions/',
      'chrome://extensions',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html',
      'view-source:https://example.com/',
      'about:blank',
      'ftp://example.com/',
      'mailto:jane@example.com'
    ]) {
      expect(droppedLinkUrl(link), link).toBeNull()
    }
  })

  it('refuses an address that has a user name or a password in it, whatever the scheme says', () => {
    for (const link of ['https://user:pass@example.com/', 'https://user@example.com/', 'http://:secret@example.com/', 'https://bank.example@evil.example/', 'https://user:@example.com/']) {
      expect(droppedLinkUrl(link), link).toBeNull()
    }
  })

  it('refuses an address longer than the ceiling, and keeps one of exactly the ceiling', () => {
    const base = 'https://example.com/'
    expect(droppedLinkUrl(base + 'a'.repeat(DROPPED_LINK_LENGTH_MAX - base.length))).not.toBeNull()
    expect(droppedLinkUrl(base + 'a'.repeat(DROPPED_LINK_LENGTH_MAX - base.length + 1))).toBeNull()
  })

  it('refuses a NUL and the control characters, anywhere in the address', () => {
    for (const link of ['https://example.com/\0', '\0https://example.com/', 'https://exam\0ple.com/', 'https://example.com/\u0007', 'https://example.com/\t1', 'https://example.com/\u007f', 'https://example.com/\u0085', 'https://example.com/\u{2028}x']) {
      expect(droppedLinkUrl(link), JSON.stringify(link)).toBeNull()
    }
  })

  it('refuses an address with a blank in it: a sentence that begins with an address', () => {
    for (const link of ['https://example.com/a b', 'https://example.com/ see this', 'https://exa mple.com/', 'https://example.com/ x']) expect(droppedLinkUrl(link), link).toBeNull()
  })

  it('refuses what is not a text, an empty text and a text that is no address', () => {
    for (const value of [undefined, null, 3, {}, ['https://example.com/'], '', 'example.com', 'hello world', 'https://', 'http://exa mple.com']) expect(droppedLinkUrl(value), JSON.stringify(value)).toBeNull()
  })
})

describe('droppedLinkUrls', () => {
  it('lists the addresses of a drop in order, one to a line, as a list of addresses (text/uri-list) is written', () => {
    expect(droppedLinkUrls('https://a.example/\r\nhttp://b.example/x\nhttps://c.example/y\r')).toEqual({ urls: ['https://a.example/', 'http://b.example/x', 'https://c.example/y'], refused: 0 })
  })

  it('reads a single link, with or without a line break at its end, and with blanks around it', () => {
    for (const text of ['https://a.example/', 'https://a.example/\n', '  https://a.example/ \r\n', '\n\nhttps://a.example/\n\n']) expect(droppedLinkUrls(text), JSON.stringify(text)).toEqual({ urls: ['https://a.example/'], refused: 0 })
  })

  it('lets the comments and the blank lines of a list of addresses go, without counting them', () => {
    expect(droppedLinkUrls('# Safari\n\nhttps://a.example/\n# the end\n')).toEqual({ urls: ['https://a.example/'], refused: 0 })
  })

  it('counts the refused addresses and keeps the others: a scheme, a name and a password, a length, a control character, a blank', () => {
    const text = [
      'https://ok.example/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:pass@example.com/',
      `https://example.com/${'a'.repeat(DROPPED_LINK_LENGTH_MAX)}`,
      'https://example.com/\0',
      '\0https://example.com/',
      'https://example.com/a b',
      'http://ok2.example/'
    ].join('\n')
    expect(droppedLinkUrls(text)).toEqual({ urls: ['https://ok.example/', 'http://ok2.example/'], refused: 7 })
  })

  it('opens no more than the ceiling and counts the rest as left aside, whatever order they come in', () => {
    const links = Array.from({ length: DROPPED_LINKS_MAX + 3 }, (_, i) => `https://a.example/${i}`)
    const { urls, refused } = droppedLinkUrls(links.join('\n'))
    expect(urls).toHaveLength(DROPPED_LINKS_MAX)
    expect(urls[0]).toBe('https://a.example/0')
    expect(urls.at(-1)).toBe(`https://a.example/${DROPPED_LINKS_MAX - 1}`)
    expect(refused).toBe(3)
    // A refused address among them takes no place of the ceiling: only the addresses that would have opened do.
    expect(droppedLinkUrls(['javascript:x', ...links.slice(0, DROPPED_LINKS_MAX)].join('\n'))).toEqual({ urls: links.slice(0, DROPPED_LINKS_MAX), refused: 1 })
  })

  it('opens an address once, and does not count its repeats: the same page written two ways is one', () => {
    expect(droppedLinkUrls('https://a.example/\nhttps://a.example/\nHTTPS://A.EXAMPLE')).toEqual({ urls: ['https://a.example/'], refused: 0 })
    // The repeats do not use up the ceiling either.
    const many = Array.from({ length: DROPPED_LINKS_MAX }, (_, i) => `https://a.example/${i}`)
    expect(droppedLinkUrls([...many, ...many].join('\n'))).toEqual({ urls: many, refused: 0 })
    // An address left aside by the ceiling and repeated is counted once.
    expect(droppedLinkUrls([...many, 'https://late.example/', 'https://late.example/'].join('\n'))).toEqual({ urls: many, refused: 1 })
  })

  it('opens nothing for a text longer than 16 KB and counts one refusal: even when its first line is a link, and without reading its lines', () => {
    const long = `https://a.example/\n${'x'.repeat(DROPPED_LINKS_TEXT_MAX)}`
    expect(droppedLinkUrls(long)).toEqual({ urls: [], refused: 1 })
    // The size is in bytes: a few thousand letters that take three bytes each are over it, though they are fewer than 16384 characters.
    const wide = `https://a.example/\n${'€'.repeat(DROPPED_LINKS_TEXT_MAX / 3)}`
    expect(wide.length).toBeLessThan(DROPPED_LINKS_TEXT_MAX)
    expect(droppedLinkUrls(wide)).toEqual({ urls: [], refused: 1 })
  })

  it('keeps a text of exactly 16 KB', () => {
    const link = 'https://a.example/'
    const text = `${link}\n${'#'.repeat(DROPPED_LINKS_TEXT_MAX - link.length - 1)}`
    expect(new TextEncoder().encode(text).length).toBe(DROPPED_LINKS_TEXT_MAX)
    expect(droppedLinkUrls(text)).toEqual({ urls: [link], refused: 0 })
  })

  it('lets any other text go without a word: it was never a link', () => {
    expect(droppedLinkUrls('Some text from another application.\n\nNote: not a link.\nexample.com\nhello')).toEqual({ urls: [], refused: 0 })
    expect(droppedLinkUrls('')).toEqual({ urls: [], refused: 0 })
    // A link in the middle of a sentence is not an entry either.
    expect(droppedLinkUrls('read https://a.example/ today')).toEqual({ urls: [], refused: 0 })
  })

  it('opens nothing for a value that is not a text, and says nothing: the sender is not trusted', () => {
    for (const value of [undefined, null, 3, true, {}, ['https://a.example/'], { toString: () => 'https://a.example/' }, Symbol('https://a.example/')]) {
      expect(droppedLinkUrls(value), String(typeof value)).toEqual({ urls: [], refused: 0 })
    }
  })
})
