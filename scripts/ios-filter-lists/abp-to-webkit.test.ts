import { describe, expect, it } from 'vitest'
import { convertList, isWebKitExpression, patternToUrlFilters, selectorProblem, serializeRules, toAsciiDomain, WEBKIT_RULE_LIMIT, type Rule } from './abp-to-webkit'

/** Whether a pattern of the filter syntax matches an address, by running the expressions it converts to (WebKit's subset is a subset of JavaScript's). */
function matches(pattern: string, url: string): boolean {
  const result = patternToUrlFilters(pattern)
  if ('drop' in result) throw new Error(`${pattern}: ${result.drop}`)
  return result.filters.some((filter) => new RegExp(filter, 'i').test(url))
}

const all = (text: string): Rule[] => {
  const converted = convertList(text)
  return [...converted.network, ...converted.cosmetic]
}

describe('patternToUrlFilters', () => {
  it('anchors on a host: the host and its subdomains, followed by a separator, and nothing else', () => {
    expect(matches('||example.com^', 'https://example.com/')).toBe(true)
    expect(matches('||example.com^', 'https://sub.example.com/x?y=1')).toBe(true)
    expect(matches('||example.com^', 'http://example.com:8080/')).toBe(true)
    expect(matches('||example.com^', 'wss://cdn.example.com/socket')).toBe(true)
    expect(matches('||example.com^', 'https://notexample.com/')).toBe(false)
    expect(matches('||example.com^', 'https://example.com.evil.net/')).toBe(false)
    expect(matches('||example.com^', 'https://other.net/example.com/')).toBe(false)
    // Without a separator the filter says "starts with": the syntax means it.
    expect(matches('||example.com', 'https://example.com.evil.net/')).toBe(true)
  })

  it('reads | as the start or the end of the address, and * as anything', () => {
    expect(matches('|https://x.com/a|', 'https://x.com/a')).toBe(true)
    expect(matches('|https://x.com/a|', 'https://x.com/a/b')).toBe(false)
    expect(matches('|https://x.com/a|', 'http://x.com/a')).toBe(false)
    expect(matches('/ads/*.gif', 'https://s.net/ads/top/banner.gif')).toBe(true)
    expect(matches('/ads/*.gif', 'https://s.net/ads/top/banner.png')).toBe(false)
    expect(matches('*banner*', 'https://s.net/a/BANNER/1')).toBe(true)
  })

  it('reads ^ as a separator: not a letter, a digit, or one of _ . % -', () => {
    expect(matches('/ad^x', 'https://s.net/ad/x')).toBe(true)
    expect(matches('/ad^x', 'https://s.net/ad?x')).toBe(true)
    expect(matches('/ad^x', 'https://s.net/adsx')).toBe(false)
    expect(matches('/ad^x', 'https://s.net/ad-x')).toBe(false)
    expect(matches('/ad^x', 'https://s.net/ad.x')).toBe(false)
  })

  it('writes the characters of an address as themselves, never as syntax', () => {
    expect(matches('/a.b+c?d(e)[f]{g}$h', 'https://s.net/a.b+c?d(e)[f]{g}$h')).toBe(true)
    expect(matches('/a.b', 'https://s.net/aXb')).toBe(false)
    expect(matches('/a|b', 'https://s.net/b')).toBe(false)
  })

  it('collapses neighbouring wildcards and drops the ones that say nothing', () => {
    expect(patternToUrlFilters('/a***b')).toEqual({ filters: ['/a.*b'] })
    expect(patternToUrlFilters('*/a/*')).toEqual({ filters: ['/a/'] })
    expect(patternToUrlFilters('*')).toEqual({ filters: ['.*'] })
    expect(patternToUrlFilters('')).toEqual({ filters: ['.*'] })
  })

  it('leaves out what WebKit cannot read, with the reason', () => {
    expect(patternToUrlFilters('/é')).toEqual({ drop: 'pattern:non-ascii' })
    expect(patternToUrlFilters('/a b')).toEqual({ drop: 'pattern:whitespace' })
  })

  it('reads the regular expression filters that WebKit can read, and says which it cannot', () => {
    expect(patternToUrlFilters('/ads[0-9]+\\.js/')).toEqual({ filters: ['ads[0-9]+\\.js'] })
    expect(patternToUrlFilters('/ads\\d+/')).toEqual({ filters: ['ads[0-9]+'] })
    expect(patternToUrlFilters('/[\\w-]+\\.example\\.com/')).toEqual({ filters: ['[a-zA-Z0-9_-]+\\.example\\.com'] })
    // A top-level alternation becomes one expression per branch.
    expect(patternToUrlFilters('/ads\\.js|banner\\.js/')).toEqual({ filters: ['ads\\.js', 'banner\\.js'] })
    for (const refused of ['/(a|b)c/', '/\\bfoo/', '/x{2,3}/', '/(?:a)b/', '/a\\sb/', '/(?=a)b/', '/é/']) {
      expect('drop' in patternToUrlFilters(refused), refused).toBe(true)
    }
    expect(patternToUrlFilters('/a|b|c|d|e|f|g/')).toEqual({ drop: 'regex:too-many-alternatives' })
  })
})

describe('isWebKitExpression', () => {
  // Each line was compiled by WebKit while the converter was written (docs/ios.md, section 6.3).
  it.each(['a', 'a.*b', '^https?://([^/]+\\.)?example\\.com[^a-zA-Z0-9_.%-]', '(ab)?', '(ab)+', '(ab)*', '((ab)c)?', 'x$', '[^/]+\\.', 'a.*?b', '\\.js', 'a\\(b', 'a%20b'])('accepts %s', (source) => {
    expect(isWebKitExpression(source)).toBe(true)
  })

  it.each(['a|b', 'a{2}', '\\d+', '\\w', '\\b', 'a^b', 'a$b', 'é', '', '*a', '+', 'a**', '(a', 'a)', '(?:a)', '[a', '[]a]', '\\1'])('refuses %s', (source) => {
    expect(isWebKitExpression(source)).toBe(false)
  })
})

describe('selectorProblem', () => {
  it.each([
    '.ad',
    '#banner > div.slot',
    'a[href*="/ads/"]',
    "a[href^='http://x.com/?a=1;b=2']",
    'div:not(.keep):nth-child(2n+1)',
    'div:has(> .sponsored)',
    ':is(.a, .b) + p',
    'a[data-x="}"]'
  ])('keeps %s', (selector) => {
    expect(selectorProblem(selector)).toBeNull()
  })

  it.each([
    ['div:has-text(Ad)', 'cosmetic:procedural'],
    ['div:-abp-contains(Ad)', 'cosmetic:procedural'],
    ['div:xpath(//a)', 'cosmetic:procedural'],
    ['div:not(:has-text(Ad))', 'cosmetic:procedural'],
    ['.a:upward(2)', 'cosmetic:procedural'],
    ['div::before', 'cosmetic:pseudo-element'],
    ['.a {height: 1px !important}', 'cosmetic:unsafe'],
    ['.a } body { display:none', 'cosmetic:unsafe'],
    ['.a /* x */', 'cosmetic:unsafe'],
    ['a[href="x', 'cosmetic:quotes'],
    ['div:not(.a', 'cosmetic:brackets'],
    ['a[href', 'cosmetic:brackets'],
    ['> .a', 'cosmetic:shape'],
    ['.a >', 'cosmetic:shape'],
    ['.é', 'cosmetic:non-ascii'],
    ['', 'cosmetic:length'],
    [`.${'a'.repeat(1000)}`, 'cosmetic:length']
  ])('leaves out %s (%s)', (selector, reason) => {
    expect(selectorProblem(selector)).toBe(reason)
  })
})

describe('toAsciiDomain', () => {
  it('gives lower case ASCII, punycode for the rest, and null for what is not a name', () => {
    expect(toAsciiDomain('example.com')).toBe('example.com')
    expect(toAsciiDomain('bücher.example')).toBe('xn--bcher-kva.example')
    expect(toAsciiDomain('')).toBeNull()
    expect(toAsciiDomain('a..b')).toBeNull()
    expect(toAsciiDomain('exa mple.com')).toBeNull()
    expect(toAsciiDomain('http://[')).toBeNull()
    expect(toAsciiDomain('a@b.com')).toBeNull()
    expect(toAsciiDomain('①.com')).toBeNull()
  })
})

describe('convertList: network filters', () => {
  it('writes a block per filter, case-insensitive unless the filter says match-case', () => {
    const rules = convertList('||ads.example^\n/Banner$match-case').network
    expect(rules[0]).toEqual({ trigger: { 'url-filter': '^[a-z]+://([^/]+\\.)?ads\\.example[^a-zA-Z0-9_.%-]' }, action: { type: 'block' } })
    expect(rules[1]).toEqual({ trigger: { 'url-filter': '/banner', 'url-filter-is-case-sensitive': true }, action: { type: 'block' } })
  })

  it('maps the request types to those of WebKit, and the sub-frames and the page to a document with its context', () => {
    const rule = (text: string): Rule[] => convertList(text).network.filter((entry) => entry.trigger['url-filter'] === '/x')
    expect(rule('/x$script')[0]!.trigger['resource-type']).toEqual(['script'])
    expect(rule('/x$image')[0]!.trigger['resource-type']).toEqual(['image', 'svg-document'])
    expect(rule('/x$xmlhttprequest')[0]!.trigger['resource-type']).toEqual(['raw', 'fetch'])
    expect(rule('/x$xhr,css')[0]!.trigger['resource-type']).toEqual(['raw', 'fetch', 'style-sheet'])
    expect(rule('/x$subdocument')[0]!.trigger).toMatchObject({ 'resource-type': ['document'], 'load-context': ['child-frame'] })
    expect(rule('/x$script,subdocument').map((entry) => entry.trigger['resource-type'])).toEqual([['script'], ['document']])
    expect(rule('/x$popup')[0]!.trigger['resource-type']).toEqual(['popup'])
    expect(rule('/x$document')[0]!.trigger).toMatchObject({ 'resource-type': ['document'], 'load-context': ['top-frame'] })
  })

  it('applies a negated type to every other subresource type', () => {
    const [rule] = convertList('/x$~script').network
    expect(rule!.trigger['resource-type']).not.toContain('script')
    expect(rule!.trigger['resource-type']).toContain('image')
    // `~object` names a type WebKit has no word for: nothing is lost by ignoring it.
    expect(convertList('/x$~object,third-party').network[0]!.trigger['resource-type']).toBeUndefined()
  })

  it('writes `all` as every type, including the page and popups', () => {
    const converted = convertList('||bad.example^$all')
    const types = converted.network.flatMap((rule) => rule.trigger['resource-type'] ?? [])
    expect(types).toEqual(expect.arrayContaining(['script', 'image', 'document', 'popup']))
  })

  it('maps third-party, first-party and the short names of uBlock Origin', () => {
    expect(convertList('/x$third-party').network[0]!.trigger['load-type']).toEqual(['third-party'])
    expect(convertList('/x$3p').network[0]!.trigger['load-type']).toEqual(['third-party'])
    expect(convertList('/x$~third-party').network[0]!.trigger['load-type']).toEqual(['first-party'])
    expect(convertList('/x$1p').network[0]!.trigger['load-type']).toEqual(['first-party'])
  })

  it('maps domain= to if-domain or unless-domain, lower case ASCII with a leading * for the subdomains, and never both', () => {
    expect(convertList('/x$domain=A.com|b.org').network[0]!.trigger['if-domain']).toEqual(['*a.com', '*b.org'])
    expect(convertList('/x$domain=~a.com|~b.org').network[0]!.trigger['unless-domain']).toEqual(['*a.com', '*b.org'])
    expect(convertList('/x$from=a.com').network[0]!.trigger['if-domain']).toEqual(['*a.com'])
    const mixed = convertList('/x$domain=a.com|~b.a.com')
    expect(mixed.stats.dropped).toEqual({ 'domain:mixed': 1 })
    expect(mixed.network.filter((rule) => rule.trigger['if-domain'] || rule.trigger['unless-domain'])).toEqual([])
  })

  it('leaves out, and counts, what WebKit has no word for: a rule written without its option would block more than the list means', () => {
    const lines = [
      '||a.example^$redirect=noopjs',
      '||b.example^$csp=script-src none',
      '||c.example^$removeparam=utm',
      '||d.example^$denyallow=x.com',
      '||e.example^$to=x.com',
      '/x$domain=a.*',
      '/ø',
      '||f.example^$object',
      '/x$~document',
      '/x$bogus=1,script',
      '/x$a=b|/c,d/'
    ]
    const converted = convertList(lines.join('\n'))
    expect(converted.stats.dropped).toEqual({
      'option:redirect': 1,
      'option:csp': 1,
      'option:removeparam': 1,
      'option:denyallow': 1,
      'option:to': 1,
      'domain:wildcard-or-regex': 1,
      'pattern:non-ascii': 1,
      'type:object': 1,
      'type:negated-document': 1,
      'option:bogus': 1,
      'option:unparsed': 1
    })
    // Nothing was written, so there is not even a shield.
    expect(converted.network).toEqual([])
    expect(converted.stats.samples['option:redirect']).toEqual(['||a.example^$redirect=noopjs'])
  })

  it('takes out the filter a $badfilter names, and itself', () => {
    const converted = convertList('||a.example^$third-party\n||a.example^$third-party,badfilter\n||b.example^')
    expect(converted.network).toHaveLength(2)
    expect(converted.network[0]!.trigger['url-filter']).toContain('b\\.example')
    expect(converted.stats.dropped).toEqual({ badfilter: 1 })
  })

  it('orders blocks, exceptions, important blocks, then the shield and the blocks that name the page or popups, then the pages without filtering', () => {
    const converted = convertList(
      ['||doc.example^$document', '@@||ok.example^', '||pop.example^$popup', '||imp.example^$important', '||plain.example^', '@@||site.example^$document'].join('\n')
    )
    const kinds = converted.network.map((rule) => {
      const url = rule.trigger['url-filter']
      if (url === '.*' && rule.trigger['if-domain']) return 'page-exception'
      if (url === '.*') return 'shield'
      return /(doc|ok|pop|imp|plain)\\\.example/.exec(url)![1]
    })
    expect(kinds).toEqual(['plain', 'ok', 'imp', 'shield', 'doc', 'pop', 'page-exception'])
    expect(converted.network.map((rule) => rule.action.type)).toEqual(['block', 'ignore-previous-rules', 'block', 'ignore-previous-rules', 'block', 'block', 'ignore-previous-rules'])
  })

  it('has a shield that spares only the top-level page', () => {
    const shield = convertList('||plain.example^').network.at(-1)!
    expect(shield).toEqual({ trigger: { 'url-filter': '.*', 'resource-type': ['document'], 'load-context': ['top-frame'] }, action: { type: 'ignore-previous-rules' } })
  })

  it('has no shield when there is no block for it to cancel', () => {
    expect(convertList('##.banner\n! nothing else').network).toEqual([])
    expect(convertList('||doc.example^$document').network).toHaveLength(1)
  })

  it('writes a page-level exception as an exception for the page', () => {
    const { network, cosmetic } = convertList('@@||site.example^$document\n@@||other.example/$all\n@@$document,domain=a.example|b.example')
    const pages = network.filter((rule) => rule.trigger['if-domain'])
    expect(pages.map((rule) => rule.trigger['if-domain'])).toEqual([['*site.example'], ['*other.example'], ['*a.example', '*b.example']])
    expect(pages.every((rule) => rule.trigger['url-filter'] === '.*' && rule.action.type === 'ignore-previous-rules' && rule.trigger['resource-type'] === undefined)).toBe(true)
    // The cosmetic file carries them too: WebKit's ignore-previous-rules reaches only the rules of its own list.
    expect(cosmetic.filter((rule) => rule.trigger['if-domain'])).toHaveLength(3)
  })

  it('stops only the element hiding for $elemhide, and only the generic hiding for $generichide', () => {
    const { cosmetic, stats } = convertList('##.a\nsite.example##.b\n@@||x.example^$generichide\n@@||y.example^$elemhide\n@@||z.example/path$elemhide')
    const kinds = cosmetic.map((rule) => (rule.action.type === 'css-display-none' ? `hide:${rule.trigger['if-domain']?.[0] ?? 'generic'}` : `ignore:${rule.trigger['if-domain']![0]}`))
    // generic hides, then the generic-hide exceptions, then the site's hides, then the element-hide exceptions.
    expect(kinds).toEqual(['hide:generic', 'ignore:*x.example', 'hide:*site.example', 'ignore:*y.example'])
    expect(cosmetic[1]!.trigger['resource-type']).toEqual(['document'])
    expect(stats.dropped).toEqual({ 'exception:page-pattern': 1 })
  })
})

describe('convertList: cosmetic filters', () => {
  it('groups the selectors that apply everywhere into rules of a hundred, in a list of selectors', () => {
    const selectors = Array.from({ length: 250 }, (_, index) => `.ad-${index}`)
    const { cosmetic } = convertList(selectors.map((selector) => `##${selector}`).join('\n'))
    expect(cosmetic).toHaveLength(3)
    expect(cosmetic[0]!.action.selector!.split(', ')).toHaveLength(100)
    expect(cosmetic[2]!.action.selector!.split(', ')).toHaveLength(50)
    expect(cosmetic[0]!.trigger).toEqual({ 'url-filter': '.*' })
  })

  it('writes the selectors of one site in one rule for that site and its subdomains', () => {
    const { cosmetic } = convertList('a.example,b.example##.x\na.example##.y')
    expect(cosmetic).toEqual([
      { trigger: { 'url-filter': '.*', 'if-domain': ['*a.example'] }, action: { type: 'css-display-none', selector: '.x, .y' } },
      { trigger: { 'url-filter': '.*', 'if-domain': ['*b.example'] }, action: { type: 'css-display-none', selector: '.x' } }
    ])
  })

  it('applies an exception for one site by excluding the site from the generic rule, and by taking the selector out of the site\'s own rule', () => {
    const { cosmetic, stats } = convertList(['##.ad', '##.keep', 'good.example#@#.ad', 'site.example##.own', 'site.example#@#.own', 'site.example##.other', '##.never', '#@#.never'].join('\n'))
    expect(cosmetic).toEqual([
      { trigger: { 'url-filter': '.*' }, action: { type: 'css-display-none', selector: '.keep' } },
      { trigger: { 'url-filter': '.*', 'unless-domain': ['*good.example'] }, action: { type: 'css-display-none', selector: '.ad' } },
      { trigger: { 'url-filter': '.*', 'if-domain': ['*site.example'] }, action: { type: 'css-display-none', selector: '.other' } }
    ])
    expect(stats.dropped).toEqual({ 'cosmetic:switched-off-by-exception': 2 })
  })

  it('writes ~site##selector as a generic rule that excludes the site', () => {
    const { cosmetic } = convertList('~a.example,~b.example##.x')
    expect(cosmetic).toEqual([{ trigger: { 'url-filter': '.*', 'unless-domain': ['*a.example', '*b.example'] }, action: { type: 'css-display-none', selector: '.x' } }])
  })

  it('leaves out, and counts, scriptlets, procedural selectors, HTML filters, entities, a CSS body in a selector and a site list WebKit cannot say', () => {
    const lines = [
      'site.example##+js(abort-on-property-read, x)',
      'site.example#?#.a:has-text(Ad)',
      'site.example#$#log hello',
      'site.example##^script:has-text(x)',
      'site.example##div:has-text(Ad)',
      'google.*##.x',
      'site.example##.a {height: 1px !important}',
      '~a.example,b.example##.x',
      'a.example#@#.x,.y:has-text(z)',
      '~a.example#@#.x'
    ]
    expect(convertList(lines.join('\n')).stats.dropped).toEqual({
      'cosmetic:scriptlet': 1,
      'cosmetic:procedural': 4,
      'cosmetic:html-filter': 1,
      'cosmetic:domain-wildcard': 1,
      'cosmetic:unsafe': 1,
      'cosmetic:mixed-domains': 1,
      'cosmetic:negated-exception': 1
    })
  })

  it('does not take a network filter that has a # in its address for a cosmetic filter', () => {
    const converted = convertList('/page#section')
    expect(converted.network.length).toBeGreaterThan(0)
    expect(converted.cosmetic).toEqual([])
  })
})

describe('convertList: what is written is what WebKit reads', () => {
  const messy = [
    '||example.com^$script,third-party,domain=a.com|b.com',
    '@@||example.com/ok$image',
    '/ads\\d+\\.js/$important',
    '||x.example^$all',
    '||Bücher.example^',
    '##.a, .b:not(.c)',
    'Site.Example##a[href*="x;y"]',
    '@@||site.example^$generichide',
    '/a$domain=~b.com',
    '||y.example/path|'
  ].join('\n')

  it('writes only expressions of the subset, domains in lower case ASCII, and never two conditions on domains', () => {
    for (const rule of all(messy)) {
      expect(isWebKitExpression(rule.trigger['url-filter']), rule.trigger['url-filter']).toBe(true)
      for (const domain of [...(rule.trigger['if-domain'] ?? []), ...(rule.trigger['unless-domain'] ?? [])]) expect(domain).toMatch(/^\*[a-z0-9][a-z0-9.-]*$/)
      expect(rule.trigger['if-domain'] && rule.trigger['unless-domain']).toBeFalsy()
      if (rule.action.type === 'css-display-none') for (const selector of rule.action.selector!.split(', ')) expect(selectorProblem(selector), selector).toBeNull()
    }
  })

  it('writes JSON that reads back as the same rules', () => {
    const rules = all(messy)
    expect(JSON.parse(serializeRules(rules))).toEqual(rules)
  })

  it('counts the filters and the rules', () => {
    const { stats } = convertList(`! comment\n[Adblock Plus 2.0]\n\n${messy}`)
    expect(stats.filters).toBe(10)
    expect(stats.rules).toBe(stats.networkRules + stats.cosmeticRules)
    expect(stats.lines).toBe(13)
  })
})

describe('convertList: the limit of a list', () => {
  it('keeps a file under the limit, leaves out the end of the blocks, keeps the shield and the exceptions at the end, and says so', () => {
    const text = [...Array.from({ length: 20 }, (_, index) => `||h${index}.example^`), '@@||site.example^$document'].join('\n')
    const { network, stats } = convertList(text, { limit: 10 })
    expect(network).toHaveLength(10)
    expect(network.slice(0, 8).map((rule) => rule.action.type)).toEqual(new Array(8).fill('block'))
    expect(network[8]!.trigger['url-filter']).toBe('.*')
    expect(network[9]!.trigger['if-domain']).toEqual(['*site.example'])
    expect(stats.dropped['over-limit:network']).toBe(12)
    expect(stats.networkRules).toBe(10)
  })

  it('leaves a list that fits alone, and takes WebKit\'s limit as the default', () => {
    expect(WEBKIT_RULE_LIMIT).toBe(150_000)
    expect(convertList('||a.example^').stats.dropped).toEqual({})
  })
})
