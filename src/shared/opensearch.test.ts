import { describe, expect, it } from 'vitest'
import { SEARCH_DISCOVERY_SEEN_MAX, defaultSettings } from './model'
import { DECLARED_SEARCH_SCRIPT, OPENSEARCH_FILE_MAX, cleanDeclaredSearches, discoverableHost, discoveryApplies, discoveryOffer, openSearchTemplate, parseOpenSearch, rememberSearchHost, siteSearchFromDescription, suggestKeyword, type DeclaredSearch } from './opensearch'
import { createInitialState } from './sidebar'
import { SITE_SEARCHES_MAX, cleanSiteSearches } from './state-clean'
import { isSearchTemplate } from './url'

const PAGE = 'https://www.example.org/docs/page.html'
const state = (settings: Partial<ReturnType<typeof defaultSettings>> = {}) => {
  const s = createInitialState({ now: 1, newId: () => 'id' })
  return { ...s, settings: { ...s.settings, searchDiscovery: true, ...settings } }
}
const declared = (href = 'https://www.example.org/opensearch.xml', title = 'Exemple'): DeclaredSearch => ({ title, href })

describe('the script that reads the declarations', () => {
  it('is a valid program that only reads the document', () => {
    // Compiling is enough: the function is built, not called.
    expect(() => new Function(`return ${DECLARED_SEARCH_SCRIPT}`)).not.toThrow()
    expect(DECLARED_SEARCH_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|sendBeacon|Image\(|innerHTML|eval\(|new Function|\.src\s*=/)
  })
})

describe('discoverableHost', () => {
  it('accepts a page on https, or on this machine, and nothing else', () => {
    expect(discoverableHost('https://www.example.org/x')).toBe('www.example.org')
    expect(discoverableHost('http://127.0.0.1:8080/x')).toBe('127.0.0.1')
    expect(discoverableHost('http://localhost:3000/')).toBe('localhost')
    for (const url of ['http://example.org/', 'ftp://example.org/', 'file:///etc/passwd', 'about:blank', 'https://u:p@example.org/', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/a.html', 'not a url', '']) {
      expect(discoverableHost(url), url).toBeNull()
    }
  })
})

describe('cleanDeclaredSearches', () => {
  it('keeps the links whose files sit on the site of the page', () => {
    const out = cleanDeclaredSearches([{ title: ' Mon   site ', href: 'https://www.example.org/opensearch.xml' }, { title: '', href: 'https://search.example.org/os.xml' }], PAGE)
    expect(out).toEqual([{ title: 'Mon site', href: 'https://www.example.org/opensearch.xml' }, { title: '', href: 'https://search.example.org/os.xml' }])
  })

  it('drops a file on another site, over plain http, with credentials or with an address that is no address', () => {
    const out = cleanDeclaredSearches(
      [
        { title: 'A', href: 'https://evil.example/os.xml' },
        { title: 'B', href: 'http://www.example.org/os.xml' },
        { title: 'C', href: 'https://user:pass@www.example.org/os.xml' },
        { title: 'D', href: 'javascript:alert(1)' },
        { title: 'E', href: 'data:text/xml,<x/>' },
        { title: 'F', href: 'not a url' },
        { title: 'G', href: 42 },
        null,
        'x',
        { title: 'H', href: 'https://www.example.org.evil.example/os.xml' },
        { title: 'I', href: `https://www.example.org/${'a'.repeat(2100)}` }
      ],
      PAGE
    )
    expect(out).toEqual([])
  })

  it('keeps a file on this machine for a page of this machine, and not one on another name of this machine', () => {
    const local = 'http://127.0.0.1:8123/page'
    expect(cleanDeclaredSearches([{ title: 'Dev', href: 'http://127.0.0.1:8123/opensearch.xml' }], local)).toEqual([{ title: 'Dev', href: 'http://127.0.0.1:8123/opensearch.xml' }])
    // « localhost » is not « 127.0.0.1 »: not the site's own file.
    expect(cleanDeclaredSearches([{ title: 'Elsewhere', href: 'http://localhost:8123/opensearch.xml' }], local)).toEqual([])
  })

  it('offers the search of a site on this machine, and what the settings keep of it is the same search', () => {
    const local = 'http://127.0.0.1:8123/page'
    const declared = cleanDeclaredSearches([{ title: 'Dev', href: 'http://127.0.0.1:8123/opensearch.xml' }], local)
    const offer = discoveryOffer(state(), local, declared)
    expect(offer).not.toBeNull()
    const description = parseOpenSearch('<OpenSearchDescription><ShortName>Dev OS</ShortName><Url type="text/html" method="get" template="http://127.0.0.1:8123/q?term={searchTerms}"/></OpenSearchDescription>', local)
    const site = siteSearchFromDescription(description!, offer!, '127.0.0.1', [])
    expect(cleanSiteSearches([site])).toEqual([site])
  })

  it('takes at most three, and nothing from what is not a list or a page that cannot be offered', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, href: `https://www.example.org/${i}.xml` }))
    expect(cleanDeclaredSearches(many, PAGE)).toEqual(many.slice(0, 3))
    for (const raw of [undefined, null, 'x', 4, {}]) expect(cleanDeclaredSearches(raw, PAGE)).toEqual([])
    expect(cleanDeclaredSearches(many, 'http://www.example.org/')).toEqual([])
  })

  it('reads only the first five links a page reports: a page that lists thousands is not read to the end', () => {
    const offsite = Array.from({ length: 5 }, (_, i) => ({ title: `o${i}`, href: `https://evil${i}.example/os.xml` }))
    const late = { title: 'late', href: 'https://www.example.org/os.xml' }
    expect(cleanDeclaredSearches([...offsite, late], PAGE)).toEqual([])
    expect(cleanDeclaredSearches([...offsite.slice(0, 4), late], PAGE)).toEqual([late])
  })

  it('strips what is not printable from the title and cuts it', () => {
    const [entry] = cleanDeclaredSearches([{ title: `\u0000a‮b\n${'c'.repeat(100)}`, href: 'https://www.example.org/o.xml' }], PAGE)
    // Each control or format character is a blank, the blanks are one, and the title is cut at 60.
    expect(entry?.title).toBe(`a b ${'c'.repeat(56)}`)
  })
})

describe('discoveryApplies', () => {
  it('looks at a page only with the setting on, in a window that keeps a list, for the tab on screen', () => {
    expect(discoveryApplies({ searchDiscovery: true }, { isPrivate: false, shown: true })).toBe(true)
    expect(discoveryApplies({ searchDiscovery: false }, { isPrivate: false, shown: true })).toBe(false)
    expect(discoveryApplies({ searchDiscovery: true }, { isPrivate: true, shown: true })).toBe(false)
    expect(discoveryApplies({ searchDiscovery: true }, { isPrivate: false, shown: false })).toBe(false)
  })

  it('does not look at a private tab: the site it visits would be recorded in the state file (this fails if the tab is not looked at)', () => {
    expect(discoveryApplies({ searchDiscovery: true }, { isPrivate: false, privateTab: true, shown: true })).toBe(false)
    expect(discoveryApplies({ searchDiscovery: true }, { isPrivate: false, privateTab: false, shown: true })).toBe(true)
  })
})

describe('discoveryOffer', () => {
  it('offers the first declared search of a page once the setting is on', () => {
    expect(discoveryOffer(state(), PAGE, [declared(), declared('https://www.example.org/b.xml')])).toEqual(declared())
  })

  it('offers nothing when the setting is off, whatever the page declares', () => {
    expect(discoveryOffer(state({ searchDiscovery: false }), PAGE, [declared()])).toBeNull()
  })

  it('offers nothing for a site that was offered its search already', () => {
    expect(discoveryOffer(state({ searchDiscoverySeen: ['www.example.org'] }), PAGE, [declared()])).toBeNull()
    expect(discoveryOffer(state({ searchDiscoverySeen: ['other.example'] }), PAGE, [declared()])).not.toBeNull()
  })

  it('offers nothing for a site the user has a search of, nor when the list is full, nor without a declaration or on a page it cannot offer', () => {
    expect(discoveryOffer(state({ siteSearches: [{ keyword: 'ex', name: 'Ex', url: 'https://search.example.org/?q=%s' }] }), PAGE, [declared()])).toBeNull()
    const full = Array.from({ length: SITE_SEARCHES_MAX }, (_, i) => ({ keyword: `k${i}`, name: `N${i}`, url: `https://s${i}.test/?q=%s` }))
    expect(discoveryOffer(state({ siteSearches: full }), PAGE, [declared()])).toBeNull()
    expect(discoveryOffer(state(), PAGE, [])).toBeNull()
    expect(discoveryOffer(state(), 'http://www.example.org/', [declared()])).toBeNull()
  })

  it('keeps offering for a site that the default searches do not cover', () => {
    expect(discoveryOffer(state(), 'https://www.youtube.com/', [declared('https://www.youtube.com/opensearch.xml', 'YouTube')])).toBeNull()
    expect(discoveryOffer(state(), 'https://www.mojeek.com/', [declared('https://www.mojeek.com/os.xml', 'Mojeek')])).not.toBeNull()
  })
})

describe('rememberSearchHost', () => {
  it('appends a host once and forgets the oldest past the limit', () => {
    expect(rememberSearchHost(['a.test'], 'b.test')).toEqual(['a.test', 'b.test'])
    expect(rememberSearchHost(['a.test', 'b.test'], 'a.test')).toEqual(['b.test', 'a.test'])
    const full = Array.from({ length: SEARCH_DISCOVERY_SEEN_MAX }, (_, i) => `h${i}.test`)
    const out = rememberSearchHost(full, 'new.test')
    expect(out).toHaveLength(SEARCH_DISCOVERY_SEEN_MAX)
    expect(out[0]).toBe('h1.test')
    expect(out.at(-1)).toBe('new.test')
  })
})

describe('openSearchTemplate', () => {
  it('turns {searchTerms} into %s, and fills or drops the other parameters', () => {
    expect(openSearchTemplate('https://www.example.org/search?q={searchTerms}', PAGE)).toBe('https://www.example.org/search?q=%s')
    expect(openSearchTemplate('https://www.example.org/s?q={searchTerms}&p={startPage?}&e={inputEncoding}&l={language}&n={count?}&x={moz:unknown?}', PAGE)).toBe('https://www.example.org/s?q=%s&p=1&e=UTF-8&l=*&n=10&x=')
    expect(openSearchTemplate('https://www.example.org/find/{searchTerms?}', PAGE)).toBe('https://www.example.org/find/%s')
    expect(openSearchTemplate('https://www.example.org/s?q={os:searchTerms}', PAGE)).toBe('https://www.example.org/s?q=%s')
  })

  it('decodes the XML entities of the attribute', () => {
    expect(openSearchTemplate('https://www.example.org/s?a=1&amp;q={searchTerms}&amp;b=&#50;', PAGE)).toBe('https://www.example.org/s?a=1&q=%s&b=2')
  })

  it('accepts a search of the page on its own subdomain, and over http on this machine', () => {
    expect(openSearchTemplate('https://search.example.org/?q={searchTerms}', PAGE)).toBe('https://search.example.org/?q=%s')
    expect(openSearchTemplate('http://127.0.0.1:8123/s?q={searchTerms}', 'http://127.0.0.1:8123/page')).toBe('http://127.0.0.1:8123/s?q=%s')
  })

  it('refuses a template it could not fill or that would be ambiguous', () => {
    for (const template of [
      'https://www.example.org/s?q=',
      'https://www.example.org/s?q={searchTerms}&r={searchTerms}',
      'https://www.example.org/s?q={required}',
      'https://www.example.org/s?q={searchTerms}&x={required}',
      'https://www.example.org/s?q={searchTerms}{',
      'https://www.example.org/s?q={searchTerms',
      'https://www.example.org/s?q={}',
      'https://www.example.org/s?q={searchTerms}&x=%s',
      'https://www.example.org/s?q={searchTerms}\u0000',
      'https://www.example.org/s?q={searchTerms}\n&x=1',
      ''
    ]) {
      expect(openSearchTemplate(template, PAGE), JSON.stringify(template)).toBeNull()
    }
    expect(openSearchTemplate(`https://www.example.org/${'a'.repeat(2100)}?q={searchTerms}`, PAGE)).toBeNull()
  })

  it('refuses a template that leaves the site, is not on https or carries credentials', () => {
    for (const template of [
      'https://evil.example/s?q={searchTerms}',
      'https://www.example.org.evil.example/s?q={searchTerms}',
      'http://www.example.org/s?q={searchTerms}',
      'https://user:pw@www.example.org/s?q={searchTerms}',
      'javascript:alert({searchTerms})',
      'data:text/html,{searchTerms}',
      'file:///etc/{searchTerms}',
      '//www.example.org/s?q={searchTerms}',
      '/s?q={searchTerms}'
    ]) {
      expect(openSearchTemplate(template, PAGE), template).toBeNull()
    }
  })

  it('gives a template the settings accept', () => {
    const template = openSearchTemplate('https://www.example.org/search?q={searchTerms}', PAGE)
    expect(isSearchTemplate(template)).toBe(true)
  })
})

const FILE = (extra = '', url = '<Url type="text/html" method="get" template="https://www.example.org/search?q={searchTerms}"/>') =>
  `<?xml version="1.0" encoding="UTF-8"?><OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Exemple &amp; Cie</ShortName>${extra}${url}</OpenSearchDescription>`

describe('parseOpenSearch', () => {
  it('reads the name and the web search of a description file', () => {
    expect(parseOpenSearch(FILE(), PAGE)).toEqual({ name: 'Exemple & Cie', template: 'https://www.example.org/search?q=%s' })
  })

  it('takes the web search among the others (suggestions, other methods, namespaces, single quotes)', () => {
    const file = FILE(
      '',
      `<Url type="application/x-suggestions+json" template="https://www.example.org/suggest?q={searchTerms}"/>
       <Url type="text/html" method="post" template="https://www.example.org/post"/>
       <os:Url type='application/xhtml+xml' template='https://www.example.org/x?q={searchTerms}'></os:Url>`
    )
    expect(parseOpenSearch(file, PAGE)?.template).toBe('https://www.example.org/x?q=%s')
    expect(parseOpenSearch(FILE('', '<Url template="https://www.example.org/d?q={searchTerms}"/>'), PAGE)?.template).toBe('https://www.example.org/d?q=%s')
  })

  it('has no name when the file gives none', () => {
    expect(parseOpenSearch('<OpenSearchDescription><Url type="text/html" template="https://www.example.org/s?q={searchTerms}"/></OpenSearchDescription>', PAGE)).toEqual({ name: null, template: 'https://www.example.org/s?q=%s' })
  })

  it('answers null for a file without a usable search', () => {
    for (const file of [
      '',
      'not xml at all',
      '<OpenSearchDescription></OpenSearchDescription>',
      FILE('', '<Url type="text/html" method="post" template="https://www.example.org/s?q={searchTerms}"/>'),
      FILE('', '<Url type="application/rss+xml" template="https://www.example.org/s?q={searchTerms}"/>'),
      FILE('', '<Url type="text/html" template="https://elsewhere.example/s?q={searchTerms}"/>'),
      FILE('', '<Url type="text/html" template="javascript:alert({searchTerms})"/>'),
      FILE('', '<Url type="text/html"/>'),
      FILE('', '<Url type="text/html" template=""/>')
    ]) {
      expect(parseOpenSearch(file, PAGE), file.slice(0, 80)).toBeNull()
    }
  })

  it('looks at the first twenty Url elements only', () => {
    const noise = '<Url type="application/rss+xml" template="https://www.example.org/rss?q={searchTerms}"/>'.repeat(20)
    expect(parseOpenSearch(FILE('', `${noise}<Url type="text/html" template="https://www.example.org/late?q={searchTerms}"/>`), PAGE)).toBeNull()
    expect(parseOpenSearch(FILE('', `${noise.slice(0, noise.length - noise.length / 20)}<Url type="text/html" template="https://www.example.org/late?q={searchTerms}"/>`), PAGE)?.template).toBe('https://www.example.org/late?q=%s')
  })

  it('tolerates the spaces around the address of the template', () => {
    expect(parseOpenSearch(FILE('', '<Url type="text/html" template=" https://www.example.org/s?q={searchTerms}\n"/>'), PAGE)?.template).toBe('https://www.example.org/s?q=%s')
  })

  it('refuses a file over the size it reads', () => {
    expect(parseOpenSearch(FILE() + ' '.repeat(OPENSEARCH_FILE_MAX), PAGE)).toBeNull()
  })

  it('cuts a hostile name', () => {
    const name = parseOpenSearch(FILE('').replace('Exemple &amp; Cie', `\u0000${'x'.repeat(500)}`), PAGE)?.name
    expect(name?.length).toBeGreaterThan(10)
    expect(name?.length).toBeLessThanOrEqual(60)
    expect(name).not.toMatch(/\u0000/)
  })

  it('does not run away on a file built to make its patterns backtrack', () => {
    const hostile = [
      '<Url ' + 'a="'.repeat(20000),
      '<Url '.repeat(12000),
      '<Url' + ' x'.repeat(30000),
      '<ShortName>' + '<'.repeat(30000),
      '<Url a=' + '"'.repeat(30000),
      `<Url type="text/html" template="${'&amp;'.repeat(12000)}"/>`
    ]
    const started = Date.now()
    for (const file of hostile) expect(parseOpenSearch(file.slice(0, OPENSEARCH_FILE_MAX), PAGE)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('suggestKeyword', () => {
  it('names the site: the first label of its domain, at most ten letters or digits', () => {
    expect(suggestKeyword('www.mojeek.com', [])).toBe('mojeek')
    expect(suggestKeyword('search.codeberg.org', [])).toBe('codeberg')
    expect(suggestKeyword('www.bbc.co.uk', [])).toBe('bbc')
    expect(suggestKeyword('un-nom-de-domaine-vraiment-long.fr', [])).toBe('unnomdedom')
  })

  it('avoids the keywords already used, the fixed list and the default searches', () => {
    expect(suggestKeyword('mojeek.com', ['mojeek'])).toBe('mojeek2')
    expect(suggestKeyword('mojeek.com', ['mojeek', 'mojeek2'])).toBe('mojeek3')
    expect(suggestKeyword('www.npm.com', [])).toBe('npm2')
    expect(suggestKeyword('hn.example', [])).toBe('hn2')
    expect(suggestKeyword('mojeek.com', ['MOJEEK'])).toBe('mojeek2')
  })

  it('has one for an address or a machine name, and for a name that starts with a digit', () => {
    expect(suggestKeyword('127.0.0.1', [])).toBe('site')
    expect(suggestKeyword('localhost', [])).toBe('localhost')
    expect(suggestKeyword('123abc.example', [])).toBe('site')
    expect(suggestKeyword('127.0.0.1', ['site'])).toBe('site2')
  })

  it('always answers something unique that the settings accept', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 150; i++) {
      const keyword = suggestKeyword('mojeek.com', taken)
      expect(keyword).toMatch(/^[a-z][a-z0-9]{0,11}$/)
      expect(taken.has(keyword)).toBe(false)
      taken.add(keyword)
    }
  })
})

describe('siteSearchFromDescription', () => {
  it('names the search after the file, then the link, then the host', () => {
    const description = { name: 'Nom du fichier', template: 'https://www.example.org/s?q=%s' }
    expect(siteSearchFromDescription(description, declared(), 'www.example.org', [])).toEqual({ keyword: 'example', name: 'Nom du fichier', url: 'https://www.example.org/s?q=%s' })
    expect(siteSearchFromDescription({ ...description, name: null }, declared(), 'www.example.org', []).name).toBe('Exemple')
    expect(siteSearchFromDescription({ ...description, name: null }, { title: '', href: 'https://www.example.org/o.xml' }, 'www.example.org', []).name).toBe('www.example.org')
  })
})
