import { describe, expect, it } from 'vitest'
import { FEED_DEPTH_MAX, FEED_SCAN_MAX, decodeXml, feedDate, parseFeed, parseGithub } from './feed'
import { LIVE_ITEMS_MAX, LIVE_TITLE_MAX } from './live-folders'

const NOW = Date.parse('2026-10-24T12:00:00Z')
const BASE = 'https://blog.example/feed.xml'

const rss = (items: string, channel = '<title>Mon blog</title>') => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${channel}${items}</channel></rss>`
const item = (title: string, link: string, extra = '') => `<item><title>${title}</title><link>${link}</link>${extra}</item>`

describe('parseFeed: RSS', () => {
  it('reads the title of the feed and its items in order, with their dates', () => {
    const out = parseFeed(rss(item('Un', 'https://blog.example/1', '<pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate>') + item('Deux', 'https://blog.example/2')), BASE, NOW)
    expect(out.title).toBe('Mon blog')
    expect(out.items).toEqual([
      { title: 'Un', url: 'https://blog.example/1', at: Date.parse('2026-10-23T10:00:00Z') },
      { title: 'Deux', url: 'https://blog.example/2' }
    ])
  })

  it('decodes the five entities and numeric references, reads CDATA as it is and drops markup inside a title', () => {
    const out = parseFeed(rss(item('Tom &amp; Jerry &#233;t&#xE9; &lt;b&gt;gras&lt;/b&gt;', 'https://blog.example/a?x=1&amp;y=2') + item('<![CDATA[<em>Direct</em> & sûr]]>', 'https://blog.example/b')), BASE, NOW)
    expect(out.items.map((i) => i.title)).toEqual(['Tom & Jerry été gras', 'Direct & sûr'])
    expect(out.items[0]!.url).toBe('https://blog.example/a?x=1&y=2')
  })

  it('resolves a relative link against the address of the feed and falls back on a guid that is an address', () => {
    const out = parseFeed(rss(item('Relatif', '/posts/3') + '<item><title>Guid</title><guid isPermaLink="true">https://blog.example/guid</guid></item><item><title>Guid opaque</title><guid>urn:uuid:1234</guid></item>'), BASE, NOW)
    expect(out.items.map((i) => i.url)).toEqual(['https://blog.example/posts/3', 'https://blog.example/guid'])
  })

  it('leaves out an item with no title or with no web address, whatever scheme it uses', () => {
    const bad = ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'ftp://a.example/x', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.html', 'https://user:secret@a.example/x']
    const out = parseFeed(rss(bad.map((url) => item('Piège', url)).join('') + item('', 'https://blog.example/vide') + item('   ', 'https://blog.example/blanc') + item('Bon', 'https://blog.example/ok')), BASE, NOW)
    expect(out.items.map((i) => i.url)).toEqual(['https://blog.example/ok'])
  })

  it('does not read what is not a direct child of the item: a <source> title, an <author> name, the channel image', () => {
    const feed = rss(
      '<image><title>Logo</title><link>https://blog.example/logo</link></image>' +
        '<item><title>Vrai titre</title><source url="https://autre.example/"><title>Titre de la source</title></source><author><name>Moi</name></author><link>https://blog.example/vrai</link></item>',
      '<title>Canal</title>'
    )
    const out = parseFeed(feed, BASE, NOW)
    expect(out.title).toBe('Canal')
    expect(out.items).toEqual([{ title: 'Vrai titre', url: 'https://blog.example/vrai' }])
  })

  it('keeps the text of the markup inside a title (an XHTML title holds some), and still not that of another element', () => {
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Titre <b>riche</b> et <i>beau</i></div></title><link href="https://x.example/p"/><source><title>Autre</title></source></entry></feed>'
    expect(parseFeed(atom, 'https://x.example/', NOW).items).toEqual([{ title: 'Titre riche et beau', url: 'https://x.example/p' }])
  })

  it('cuts a very long title, drops control characters and keeps at most LIVE_ITEMS_MAX items', () => {
    const many = Array.from({ length: LIVE_ITEMS_MAX + 10 }, (_, i) => item(`T${i}`, `https://blog.example/${i}`)).join('')
    const out = parseFeed(rss(item(`A${'x'.repeat(5000)}\u0000\u001bB`, 'https://blog.example/long') + many), BASE, NOW)
    expect(out.items).toHaveLength(LIVE_ITEMS_MAX)
    expect(out.items[0]!.title).toHaveLength(LIVE_TITLE_MAX)
    expect(out.items[0]!.title).not.toMatch(/\p{Cc}/u)
  })

  it('ignores a date that is not one or lies more than a day ahead', () => {
    const out = parseFeed(rss(item('Futur', 'https://blog.example/f', '<pubDate>Fri, 01 Jan 2100 00:00:00 GMT</pubDate>') + item('Texte', 'https://blog.example/t', '<pubDate>bientôt</pubDate>')), BASE, NOW)
    expect(out.items.map((i) => i.at)).toEqual([undefined, undefined])
    expect(feedDate('2026-10-24T11:00:00Z', NOW)).toBe(Date.parse('2026-10-24T11:00:00Z'))
    expect(feedDate('', NOW)).toBeUndefined()
  })
})

describe('parseFeed: Atom and RDF', () => {
  it('reads an Atom entry: the alternate link (not self, not enclosure), the updated date', () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Dépôt</title><link rel="self" href="https://x.example/self"/><entry><title type="html">Version 2</title><link rel="enclosure" href="https://x.example/fichier.zip"/><link rel="alternate" href="https://x.example/v2"/><updated>2026-10-20T08:00:00Z</updated><author><name>Moi</name></author></entry><entry><title>Sans rel</title><link href="/v3"/></entry></feed>`
    const out = parseFeed(atom, 'https://x.example/atom', NOW)
    expect(out.title).toBe('Dépôt')
    expect(out.items).toEqual([
      { title: 'Version 2', url: 'https://x.example/v2', at: Date.parse('2026-10-20T08:00:00Z') },
      { title: 'Sans rel', url: 'https://x.example/v3' }
    ])
  })

  it('reads an RSS 1.0 (RDF) item with a prefixed date', () => {
    const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>RDF</title></channel><item rdf:about="https://r.example/1"><title>Un</title><link>https://r.example/1</link><dc:date>2026-10-01T00:00:00Z</dc:date></item></rdf:RDF>`
    expect(parseFeed(rdf, 'https://r.example/', NOW)).toEqual({ title: 'RDF', items: [{ title: 'Un', url: 'https://r.example/1', at: Date.parse('2026-10-01T00:00:00Z') }] })
  })
})

describe('parseFeed: hostile text', () => {
  it('never expands an entity a DOCTYPE declares, internal or external: the text stays as written and nothing is fetched', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY remote SYSTEM "http://evil.example/x">]><rss><channel><title>&lol2;</title><item><title>&xxe; &remote; &lol2;</title><link>https://blog.example/entites</link></item></channel></rss>`
    const out = parseFeed(bomb, BASE, NOW)
    expect(out.items).toEqual([{ title: '&xxe; &remote; &lol2;', url: 'https://blog.example/entites' }])
    expect(out.title).toBe('&lol2;')
    expect(JSON.stringify(out)).not.toContain('root:')
  })

  it('does not stop at a ">" inside the internal subset of a DOCTYPE, and gives nothing when the DOCTYPE never ends', () => {
    const subset = `<!DOCTYPE rss [<!ENTITY a "x>y">]><rss><channel>${item('Après', 'https://blog.example/apres')}</channel></rss>`
    expect(parseFeed(subset, BASE, NOW).items).toHaveLength(1)
    expect(parseFeed(`<!DOCTYPE rss [<!ENTITY a "x"> ${rss(item('Perdu', 'https://blog.example/perdu'))}`, BASE, NOW).items).toEqual([])
  })

  it('stops at the depth it follows and returns what it had read', () => {
    // A literal depth, not the constant: the test must still fail if the bound is made huge.
    const deep = '<a>'.repeat(60) + item('Trop profond', 'https://blog.example/deep')
    expect(parseFeed(rss(item('Avant', 'https://blog.example/avant') + deep), BASE, NOW).items.map((i) => i.title)).toEqual(['Avant'])
  })

  it('has bounds on depth and on the number of items read', () => {
    expect(FEED_DEPTH_MAX).toBeLessThan(100)
    expect(FEED_SCAN_MAX).toBeLessThan(1000)
  })

  it('reads at most FEED_SCAN_MAX items, even when none of them is usable', () => {
    const bad = '<item><title>x</title><link>javascript:1</link></item>'.repeat(300) + item('Trop tard', 'https://blog.example/tard')
    expect(parseFeed(rss(bad), BASE, NOW).items).toEqual([])
  })

  it('reads a file of nothing but tags, unclosed tags and garbage in bounded time, without throwing', () => {
    const started = Date.now()
    const inputs = ['<'.repeat(300_000), '<a '.repeat(100_000), `<item>${'<title>'.repeat(50_000)}`, '<![CDATA['.repeat(10_000), '<!--'.repeat(50_000), '\u0000\u0001\u0002'.repeat(10_000), `<a href="${'>'.repeat(100_000)}`, '<a ">'.repeat(80_000), `${'<x "'.repeat(120_000)}>`, '<a b=\'"'.repeat(60_000), '', 'pas du XML']
    for (const input of inputs) expect(() => parseFeed(input, BASE, NOW), input.slice(0, 20)).not.toThrow()
    // Each of these is half a megabyte, the most a feed is read at; a scan that began again at every `<` would take minutes.
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('keeps a title that closes with a mismatched tag, and still reads the items that follow', () => {
    const out = parseFeed(rss('<item><title>Mal fermé</item>' + item('Suivant', 'https://blog.example/suivant')), BASE, NOW)
    expect(out.items.map((i) => i.title)).toEqual(['Suivant'])
  })

  it('reads the entities of XML only', () => {
    expect(decodeXml('&amp;&lt;&gt;&quot;&apos;&#65;&#x42;&nbsp;&bogus;&#0;&#xD800;&#99999999;')).toBe('&<>"\'AB&nbsp;&bogus;&#0;&#xD800;&#99999999;')
  })
})

describe('parseGithub', () => {
  const repo = 'owner/repo'
  const json = (value: unknown) => JSON.stringify(value)

  it('reads releases (a draft is not one), tags, commits, issues and pull requests, with addresses on the repository', () => {
    expect(parseGithub(json([{ name: 'Version 2', tag_name: 'v2', html_url: 'https://github.com/owner/repo/releases/tag/v2', published_at: '2026-10-20T08:00:00Z' }, { name: 'Brouillon', draft: true, html_url: 'https://github.com/owner/repo/releases/tag/d' }, { name: null, tag_name: 'v1', html_url: 'https://github.com/owner/repo/releases/tag/v1' }]), repo, 'releases', NOW)).toEqual([
      { title: 'Version 2', url: 'https://github.com/owner/repo/releases/tag/v2', at: Date.parse('2026-10-20T08:00:00Z') },
      { title: 'v1', url: 'https://github.com/owner/repo/releases/tag/v1' }
    ])
    expect(parseGithub(json([{ name: 'v1.2/beta 1' }, { name: '' }, {}]), repo, 'tags', NOW)).toEqual([{ title: 'v1.2/beta 1', url: 'https://github.com/owner/repo/releases/tag/v1.2%2Fbeta%201' }])
    expect(parseGithub(json([{ sha: 'abc', html_url: 'https://github.com/owner/repo/commit/abc', commit: { message: 'Corrige un bug\n\nLong texte', author: { date: '2026-10-19T00:00:00Z' } } }]), repo, 'commits', NOW)).toEqual([{ title: 'Corrige un bug', url: 'https://github.com/owner/repo/commit/abc', at: Date.parse('2026-10-19T00:00:00Z') }])
    const tickets = [
      { number: 7, title: 'Un ticket', html_url: 'https://github.com/owner/repo/issues/7', updated_at: '2026-10-18T00:00:00Z' },
      { number: 8, title: 'Une demande', html_url: 'https://github.com/owner/repo/pull/8', pull_request: {} }
    ]
    expect(parseGithub(json(tickets), repo, 'issues', NOW).map((i) => i.title)).toEqual(['#7 Un ticket'])
    expect(parseGithub(json(tickets), repo, 'pulls', NOW).map((i) => i.title)).toEqual(['#7 Un ticket', '#8 Une demande'])
  })

  it('refuses an address that is not on the repository, whatever the answer says', () => {
    const hostile = [
      { name: 'Ailleurs', html_url: 'https://evil.example/owner/repo/' },
      { name: 'Autre dépôt', html_url: 'https://github.com/owner/other/releases/tag/v1' },
      { name: 'Préfixe', html_url: 'https://github.com/owner/repository/releases/tag/v1' },
      { name: 'Schéma', html_url: 'javascript://github.com/owner/repo/%0aalert(1)' },
      { name: 'Login', html_url: 'https://user:pass@github.com/owner/repo/x' },
      { name: 'Bon', html_url: 'https://github.com/owner/repo/releases/tag/ok' }
    ]
    expect(parseGithub(json(hostile), repo, 'releases', NOW).map((i) => i.title)).toEqual(['Bon'])
  })

  it('gives nothing for an answer that is not a list, not JSON, or for a repository name that is not one', () => {
    for (const text of ['{"message":"Not Found"}', 'pas du JSON', '', 'null', '"x"', '[null, 3, "x"]']) expect(parseGithub(text, repo, 'releases', NOW), text).toEqual([])
    expect(parseGithub(json([{ name: 'x', html_url: 'https://github.com/a/b/x' }]), '../etc', 'releases', NOW)).toEqual([])
  })

  it('keeps at most LIVE_ITEMS_MAX items and bounds every title', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ name: `v${i}`.padEnd(LIVE_TITLE_MAX + 50, 'x'), html_url: `https://github.com/owner/repo/releases/tag/v${i}` }))
    const out = parseGithub(json(many), repo, 'releases', NOW)
    expect(out).toHaveLength(LIVE_ITEMS_MAX)
    expect(out.every((i) => i.title.length === LIVE_TITLE_MAX)).toBe(true)
  })
})

describe('parseGithub, an address that begins like the repository', () => {
  it('is compared once normalised: dot segments, written plainly or encoded, do not lead out of the repository', () => {
    const answer = JSON.stringify([
      { name: 'Sortie', html_url: 'https://github.com/owner/repo/../../autre/page' },
      { name: 'Encodée', html_url: 'https://github.com/owner/repo/%2e%2e/%2E%2E/autre/page' },
      { name: 'Antislash', html_url: 'https://github.com/owner/repo/..\\..\\autre/page' },
      { name: 'Dedans', html_url: 'https://github.com/owner/repo/releases/../releases/tag/v1' }
    ])
    expect(parseGithub(answer, 'owner/repo', 'releases', Date.UTC(2026, 9, 28))).toEqual([{ title: 'Dedans', url: 'https://github.com/owner/repo/releases/tag/v1' }])
  })
})
