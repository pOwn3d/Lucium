// The request rules of extensions as Lucium reads and applies them (net-rules.ts): what a rule says, which requests it covers, what the rules
// of one extension make of a request, and how header changes combine. The same rules in a real Electron: `smokeProbesExt`.

import { describe, expect, it, vi } from 'vitest'
import {
  applyHeaderChanges,
  combineOutcomes,
  filterStepBudget,
  filterToken,
  headerRules,
  judge,
  matchFilter,
  netResourceType,
  prepareRequest,
  readNetRule,
  REGEX_FILTER_MAX,
  REGEX_URL_MAX,
  REGEX_URL_MIN,
  redirectTarget,
  ruleCovers,
  RuleIndex,
  type NetRequest,
  type NetRule,
  type RuleOwner,
  type UrlFilter
} from './net-rules'

const siteOf = (address: string): string | null => {
  if (!URL.canParse(address)) return null
  const host = new URL(address).hostname
  return host.split('.').slice(-2).join('.')
}

const rule = (raw: Record<string, unknown>): NetRule => {
  const read = readNetRule({ id: 1, action: { type: 'block' }, ...raw })
  if (typeof read === 'string') throw new Error(`the rule of the test was refused: ${read}`)
  return read
}

const ask = (url: string, more: Partial<NetRequest> = {}) => {
  const prepared = prepareRequest({ url, method: 'GET', type: 'script', initiator: 'https://page.example', tabId: 4, ...more }, siteOf)
  if (!prepared) throw new Error('the request of the test is no address')
  return prepared
}

const owner = (more: Partial<RuleOwner> = {}): RuleOwner => ({ id: 'ext', canAccess: () => true, hostAccessOnly: false, ...more })

describe('reading a rule', () => {
  it('takes the rule the platform takes, with its defaults: priority 1, every type but the navigation of a tab', () => {
    const read = rule({ condition: { urlFilter: '||ads.example^' } })
    expect(read.priority).toBe(1)
    expect(read.types.has('script')).toBe(true)
    expect(read.types.has('main_frame')).toBe(false)
  })

  it('refuses what the platform refuses', () => {
    const refused: unknown[] = [
      null,
      { id: 0, action: { type: 'block' } },
      { id: 1, action: { type: 'explode' } },
      { id: 1, priority: 0, action: { type: 'block' } },
      { id: 1, action: { type: 'block' }, condition: { urlFilter: '' } },
      { id: 1, action: { type: 'block' }, condition: { urlFilter: '||*ads' } },
      { id: 1, action: { type: 'block' }, condition: { urlFilter: 'a', regexFilter: 'a' } },
      { id: 1, action: { type: 'block' }, condition: { requestDomains: [] } },
      { id: 1, action: { type: 'block' }, condition: { resourceTypes: ['script'], excludedResourceTypes: ['image'] } },
      { id: 1, action: { type: 'block' }, condition: { resourceTypes: ['nothing'] } },
      { id: 1, action: { type: 'allowAllRequests' }, condition: { urlFilter: 'a' } },
      { id: 1, action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['script'] } },
      { id: 1, action: { type: 'redirect' } },
      { id: 1, action: { type: 'redirect', redirect: { regexSubstitution: 'https://a.example/\\1' } }, condition: { urlFilter: 'a' } },
      { id: 1, action: { type: 'redirect', redirect: { transform: { scheme: 'javascript' } } } },
      { id: 1, action: { type: 'modifyHeaders' } },
      { id: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x', operation: 'set', value: 'a\r\nb: c' }] } },
      { id: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'bad header', operation: 'remove' }] } }
    ]
    for (const raw of refused) expect(readNetRule(raw), JSON.stringify(raw)).toBe('malformed')
  })

  it('leaves out, and says so, a rule with a condition on the headers of the answer: it is not applied here', () => {
    expect(readNetRule({ id: 1, action: { type: 'block' }, condition: { responseHeaders: [{ header: 'content-type' }] } })).toBe('unsupported')
  })
})

describe('which requests a rule covers', () => {
  it('a plain filter is a part of the address, whatever the case unless the rule says otherwise', () => {
    expect(ruleCovers(rule({ condition: { urlFilter: '/Ads/' } }), ask('https://a.example/ads/x.js'))).toBe(true)
    expect(ruleCovers(rule({ condition: { urlFilter: '/Ads/', isUrlFilterCaseSensitive: true } }), ask('https://a.example/ads/x.js'))).toBe(false)
    expect(ruleCovers(rule({ condition: { urlFilter: '/ads/' } }), ask('https://a.example/news/x.js'))).toBe(false)
  })

  it('`||` is the start of a domain or of one of its subdomains, `^` a separator or the end, `|` an end of the address, `*` anything', () => {
    const domain = rule({ condition: { urlFilter: '||ads.example^' } })
    expect(ruleCovers(domain, ask('https://ads.example/x'))).toBe(true)
    expect(ruleCovers(domain, ask('https://cdn.ads.example:8080/x'))).toBe(true)
    expect(ruleCovers(domain, ask('https://notads.example/x'))).toBe(false)
    expect(ruleCovers(domain, ask('https://ads.example.org/x'))).toBe(false)
    expect(ruleCovers(domain, ask('https://a.example/?u=ads.example/'))).toBe(false)
    expect(ruleCovers(rule({ condition: { urlFilter: '|https://a.example/x|' } }), ask('https://a.example/x'))).toBe(true)
    expect(ruleCovers(rule({ condition: { urlFilter: '|https://a.example/x|' } }), ask('https://a.example/xy'))).toBe(false)
    expect(ruleCovers(rule({ condition: { urlFilter: '/a*z.js' } }), ask('https://a.example/a/b/z.js'))).toBe(true)
  })

  it('a regular expression is run on the address, and one that cannot be read leaves the rule out with a word in the journal', () => {
    expect(ruleCovers(rule({ condition: { regexFilter: '^https://[a-z]+\\.example/ad[0-9]+' } }), ask('https://a.example/ad42'))).toBe(true)
    expect(ruleCovers(rule({ condition: { regexFilter: '(?i)/AD[0-9]+', isUrlFilterCaseSensitive: true } }), ask('https://a.example/ad42'))).toBe(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = rule({ id: 77, condition: { regexFilter: '(unclosed' } })
    expect(ruleCovers(broken, ask('https://a.example/(unclosed'))).toBe(false)
    expect(ruleCovers(broken, ask('https://a.example/(unclosed'))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('rule 77')
    warn.mockRestore()
  })

  it('a rule whose regular expression could take forever on some addresses is refused when it is read, with its own reason, and never built', () => {
    const build = vi.spyOn(globalThis, 'RegExp')
    const refused = ['(a+)+$', '^https://x\\.example/(.*/)*ad', '(?i)(A|AA)+$', '^(?=.*ad)', '(a)\\1']
    for (const regexFilter of refused) expect(readNetRule({ id: 1, action: { type: 'block' }, condition: { regexFilter } }), regexFilter).toBe('backtracking')
    // Not one of them reached the engine as an expression of its own (the guard asks it about single characters only).
    for (const regexFilter of refused) expect(build.mock.calls.map((call) => String(call[0])), regexFilter).not.toContain(regexFilter)
    build.mockRestore()
    // The redirect of such a rule goes with it.
    expect(readNetRule({ id: 1, action: { type: 'redirect', redirect: { regexSubstitution: 'https://b.example/\\1' } }, condition: { regexFilter: '^(a+)+$' } })).toBe('backtracking')
    // The expressions rules are made of are read as before, a leading (?i) included.
    for (const regexFilter of ['^https?://([a-z0-9-]+\\.)*example\\.com/ad[0-9]+', '(?i)/AD[0-9]+(\\?.*)?$', '^http://a\\.example/(.*)$']) expect(typeof readNetRule({ id: 1, action: { type: 'block' }, condition: { regexFilter } }), regexFilter).toBe('object')
  })

  it('a regular expression longer than the bound is refused as malformed, whatever it says', () => {
    expect(REGEX_FILTER_MAX).toBe(2048)
    expect(typeof readNetRule({ id: 1, action: { type: 'block' }, condition: { regexFilter: 'a'.repeat(REGEX_FILTER_MAX) } })).toBe('object')
    expect(readNetRule({ id: 1, action: { type: 'block' }, condition: { regexFilter: 'a'.repeat(REGEX_FILTER_MAX + 1) } })).toBe('malformed')
  })

  it('a regular expression is not run on an address longer than 4096 characters', () => {
    expect(ruleCovers(rule({ condition: { regexFilter: 'a' } }), ask(`https://a.example/${'a'.repeat(5000)}`))).toBe(false)
  })

  it('the resource types, the methods, the tabs and the domains narrow it', () => {
    expect(ruleCovers(rule({ condition: { resourceTypes: ['image'] } }), ask('https://a.example/x'))).toBe(false)
    expect(ruleCovers(rule({ condition: { excludedResourceTypes: ['image'] } }), ask('https://a.example/', { type: 'main_frame' }))).toBe(true)
    expect(ruleCovers(rule({ condition: { requestMethods: ['post'] } }), ask('https://a.example/x'))).toBe(false)
    expect(ruleCovers(rule({ condition: { excludedRequestMethods: ['get'] } }), ask('https://a.example/x'))).toBe(false)
    expect(ruleCovers(rule({ condition: { tabIds: [5] } }), ask('https://a.example/x'))).toBe(false)
    expect(ruleCovers(rule({ condition: { excludedTabIds: [4] } }), ask('https://a.example/x'))).toBe(false)
    expect(ruleCovers(rule({ condition: { requestDomains: ['example'] } }), ask('https://a.example/x'))).toBe(true)
    expect(ruleCovers(rule({ condition: { requestDomains: ['b.example'] } }), ask('https://a.example/x'))).toBe(false)
    expect(ruleCovers(rule({ condition: { excludedRequestDomains: ['a.example'] } }), ask('https://a.example/x'))).toBe(false)
    expect(ruleCovers(rule({ condition: { initiatorDomains: ['page.example'] } }), ask('https://a.example/x'))).toBe(true)
    expect(ruleCovers(rule({ condition: { initiatorDomains: ['page.example'] } }), ask('https://a.example/x', { initiator: null }))).toBe(false)
    expect(ruleCovers(rule({ condition: { excludedInitiatorDomains: ['page.example'] } }), ask('https://a.example/x'))).toBe(false)
    // The older names of the two initiator lists.
    expect(ruleCovers(rule({ condition: { domains: ['other.example'] } }), ask('https://a.example/x'))).toBe(false)
  })

  it('`domainType` tells a request to the site of the page from one to another site', () => {
    const third = rule({ condition: { domainType: 'thirdParty' } })
    const first = rule({ condition: { domainType: 'firstParty' } })
    expect(ruleCovers(third, ask('https://cdn.other.org/x'))).toBe(true)
    expect(ruleCovers(third, ask('https://cdn.page.example/x'))).toBe(false)
    expect(ruleCovers(first, ask('https://cdn.page.example/x'))).toBe(true)
    expect(ruleCovers(first, ask('https://cdn.other.org/x'))).toBe(false)
  })
})

describe('the index', () => {
  it('files a rule under a whole word of its filter, never under a part of a word', () => {
    const token = (urlFilter: string) => {
      const read = rule({ condition: { urlFilter } })
      return read.filter ? filterToken(read.filter) : null
    }
    expect(token('||adserver.example^')).toBe('adserver')
    expect(token('/banner/')).toBe('banner')
    // `ads` here may be the end of "loads" and the start of "adsense": no word of the address is promised.
    expect(token('ads')).toBeNull()
    expect(token('*tracker*')).toBeNull()
    expect(token('/pixel*')).toBeNull()
  })

  it('finds every rule that covers a request, whichever way it is filed, and each once', () => {
    const rules = [
      rule({ id: 1, condition: { urlFilter: '||ads.example^' } }),
      rule({ id: 2, condition: { requestDomains: ['example', 'ads.example'] } }),
      rule({ id: 3, condition: { urlFilter: 'ds.exam' } }),
      rule({ id: 4, condition: { regexFilter: 'ads\\.' } }),
      rule({ id: 5, condition: { urlFilter: '||other.example^' } }),
      rule({ id: 6, condition: { resourceTypes: ['script'] } })
    ]
    const index = new RuleIndex(rules)
    expect(index.size).toBe(6)
    expect(index.covering(ask('https://ads.example/x.js')).map((found) => found.id).sort()).toEqual([1, 2, 3, 4, 6])
    // The same answer as asking every rule in turn, for a few other addresses.
    for (const url of ['https://other.example/', 'https://sub.ads.example/a?b=ads.example', 'https://none.test/x']) {
      expect(index.covering(ask(url)).map((found) => found.id).sort(), url).toEqual(rules.filter((each) => ruleCovers(each, ask(url))).map((each) => each.id).sort())
    }
  })

  it('says which hooks its rules need', () => {
    expect(new RuleIndex([rule({})]).requestHeaders).toBe(false)
    const headers = new RuleIndex([rule({ action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x-a', operation: 'set', value: '1' }] } })])
    expect([headers.requestHeaders, headers.responseHeaders]).toEqual([false, true])
    expect(new RuleIndex([rule({ action: { type: 'allowAllRequests' }, condition: { resourceTypes: ['sub_frame'] } })]).frameRules).toHaveLength(1)
  })
})

describe('what the rules of one extension make of a request', () => {
  const request = ask('http://a.example/x.js')

  it('the highest priority wins; at the same priority allow comes before block, block before upgradeScheme, upgradeScheme before redirect', () => {
    const block = rule({ id: 1, priority: 2 })
    const allow = rule({ id: 2, priority: 2, action: { type: 'allow' } })
    const upgrade = rule({ id: 3, priority: 2, action: { type: 'upgradeScheme' } })
    const redirect = rule({ id: 4, priority: 2, action: { type: 'redirect', redirect: { url: 'https://b.example/' } } })
    const strongRedirect = rule({ id: 5, priority: 3, action: { type: 'redirect', redirect: { url: 'https://c.example/' } } })
    expect(judge(owner(), [block, allow], request).outcome).toEqual({ action: 'allow' })
    expect(judge(owner(), [upgrade, block, redirect], request).outcome).toEqual({ action: 'block' })
    expect(judge(owner(), [redirect, upgrade], request).outcome).toEqual({ action: 'redirect', url: 'https://a.example/x.js' })
    expect(judge(owner(), [block, allow, strongRedirect], request).outcome).toEqual({ action: 'redirect', url: 'https://c.example/' })
    expect(judge(owner(), [], request).outcome).toEqual({ action: 'none' })
  })

  it('an allowAllRequests rule on a frame above lets through what a block rule of the same or a lower priority covers, not one of a higher priority', () => {
    const block = rule({ id: 1, priority: 2 })
    expect(judge(owner(), [block], request, 2).outcome).toEqual({ action: 'allow' })
    expect(judge(owner(), [block], request, 3).outcome).toEqual({ action: 'allow' })
    expect(judge(owner(), [block], request, 1).outcome).toEqual({ action: 'block' })
    expect(judge(owner(), [], request, 1)).toEqual({ outcome: { action: 'allow' }, allowPriority: 1 })
  })

  it('a redirect and a header change need host access to the request and to who asks; a block does not, unless the extension only holds the host-access permission', () => {
    const redirect = rule({ action: { type: 'redirect', redirect: { url: 'https://b.example/' } } })
    const block = rule({})
    const elsewhere = owner({ canAccess: (address) => address.startsWith('https://page.example') })
    expect(judge(elsewhere, [redirect], request).outcome).toEqual({ action: 'none' })
    expect(judge(elsewhere, [block], request).outcome).toEqual({ action: 'block' })
    expect(judge({ ...elsewhere, hostAccessOnly: true }, [block], request).outcome).toEqual({ action: 'none' })
    const noInitiator = owner({ canAccess: (address) => address.startsWith('http://a.example') })
    expect(judge(noInitiator, [redirect], request).outcome).toEqual({ action: 'none' })
    expect(judge(noInitiator, [redirect], ask('http://a.example/', { type: 'main_frame' })).outcome).toEqual({ action: 'redirect', url: 'https://b.example/' })
  })

  it('a redirect goes to the web or to a file of the extension that owns the rule, never to a script address, a local file or another extension', () => {
    const to = (redirect: unknown, regexFilter?: string) => redirectTarget(rule({ action: { type: 'redirect', redirect }, ...(regexFilter ? { condition: { regexFilter } } : {}) }), request, 'ext')
    expect(to({ url: 'https://b.example/y' })).toBe('https://b.example/y')
    expect(to({ extensionPath: '/stand-in.js' })).toBe('chrome-extension://ext/stand-in.js')
    expect(to({ url: 'chrome-extension://other/x.js' })).toBeNull()
    expect(to({ url: 'javascript:alert(1)' })).toBeNull()
    expect(to({ url: 'file:///etc/passwd' })).toBeNull()
    expect(to({ url: 'data:text/html,x' })).toBeNull()
    expect(to({ url: 'not an address' })).toBeNull()
    // The address it already has is no redirect: it would never end.
    expect(to({ url: 'http://a.example/x.js' })).toBeNull()
    expect(to({ transform: { scheme: 'https', host: 'b.example', path: '/z', queryTransform: { addOrReplaceParams: [{ key: 'k', value: 'v' }] } } })).toBe('https://b.example/z?k=v')
    expect(to({ regexSubstitution: 'https://b.example/\\1' }, '^http://a\\.example/(.*)$')).toBe('https://b.example/x.js')
    expect(redirectTarget(rule({ action: { type: 'upgradeScheme' } }), ask('https://a.example/x'), 'ext')).toBeNull()
  })

  it('the transform of a redirect removes and replaces the parameters it names', () => {
    const transform = { queryTransform: { removeParams: ['utm_source'], addOrReplaceParams: [{ key: 'a', value: '2' }, { key: 'b', value: '3', replaceOnly: true }] } }
    expect(redirectTarget(rule({ action: { type: 'redirect', redirect: { transform } } }), ask('https://a.example/p?utm_source=x&a=1'), 'ext')).toBe('https://a.example/p?a=2')
  })

  it('the header rules speak the strongest first, and are silent at or below the priority of an allow rule that covers the request', () => {
    const weak = rule({ id: 1, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'X-A', operation: 'set', value: 'weak' }] } })
    const strong = rule({ id: 2, priority: 5, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'X-A', operation: 'set', value: 'strong' }] } })
    const allow = rule({ id: 3, priority: 3, action: { type: 'allow' } })
    const { allowPriority } = judge(owner(), [weak, strong, allow], request)
    expect(allowPriority).toBe(3)
    expect(headerRules(owner(), [weak, strong, allow], request, allowPriority, 'requestHeaders').map((each) => each.id)).toEqual([2])
    expect(headerRules(owner(), [weak, strong], request, 0, 'requestHeaders').map((each) => each.id)).toEqual([2, 1])
    expect(headerRules(owner(), [weak, strong], request, 0, 'responseHeaders')).toEqual([])
    expect(headerRules(owner({ canAccess: () => false }), [weak, strong], request, 0, 'requestHeaders')).toEqual([])
  })
})

describe('header changes', () => {
  const op = (header: string, operation: 'append' | 'set' | 'remove', value = '') => ({ header, operation, value })

  it('sets, appends and removes, whatever the case of the name the request carries', () => {
    const headers = { 'User-Agent': 'x', Accept: 'a', Cookie: 'a=1' }
    const next = applyHeaderChanges(headers, [{ ownerId: 'e', ops: [op('user-agent', 'remove'), op('accept', 'append', 'b'), op('cookie', 'append', 'b=2'), op('x-new', 'set', '1')] }], 'request')
    expect(next).toEqual({ Accept: 'a, b', Cookie: 'a=1; b=2', 'x-new': '1' })
    expect(headers).toEqual({ 'User-Agent': 'x', Accept: 'a', Cookie: 'a=1' })
  })

  it('keeps the headers of an answer as lists, a header coming several times', () => {
    const next = applyHeaderChanges({ 'Set-Cookie': ['a=1'] } as Record<string, string[]>, [{ ownerId: 'e', ops: [op('set-cookie', 'append', 'b=2'), op('x-frame-options', 'set', 'DENY')] }], 'response')
    expect(next).toEqual({ 'Set-Cookie': ['a=1', 'b=2'], 'x-frame-options': ['DENY'] })
  })

  it('a removed header stays removed; a set one may only be appended to by the same extension; an appended one may only be appended to', () => {
    const removed = applyHeaderChanges({ a: '1' }, [{ ownerId: 'e', ops: [op('a', 'remove')] }, { ownerId: 'e', ops: [op('a', 'set', '2'), op('a', 'append', '3')] }], 'request')
    expect(removed).toEqual({})
    const set = applyHeaderChanges({}, [{ ownerId: 'e', ops: [op('a', 'set', '1')] }, { ownerId: 'other', ops: [op('a', 'append', '2')] }, { ownerId: 'e', ops: [op('a', 'append', '3'), op('a', 'set', '4')] }], 'request')
    expect(set).toEqual({ a: '1, 3' })
    const appended = applyHeaderChanges({ a: '0' }, [{ ownerId: 'e', ops: [op('a', 'append', '1')] }, { ownerId: 'other', ops: [op('a', 'remove'), op('a', 'append', '2')] }], 'request')
    expect(appended).toEqual({ a: '0, 1, 2' })
  })

  it('answers the same object when nothing changed', () => {
    const headers = { a: '1' }
    expect(applyHeaderChanges(headers, [], 'request')).toBe(headers)
  })
})

describe('several extensions', () => {
  it('a block wins, then the redirect of the extension loaded last, and an allow changes nothing', () => {
    expect(combineOutcomes([{ action: 'redirect', url: 'https://a.example/' }, { action: 'block' }, { action: 'allow' }])).toEqual({ action: 'block' })
    expect(combineOutcomes([{ action: 'redirect', url: 'https://a.example/' }, { action: 'allow' }, { action: 'redirect', url: 'https://b.example/' }])).toEqual({ action: 'redirect', url: 'https://b.example/' })
    expect(combineOutcomes([{ action: 'allow' }, { action: 'none' }])).toEqual({ action: 'none' })
  })
})

describe('the names of the resource types', () => {
  it('gives each type of Electron the name the extension platform uses', () => {
    expect(['mainFrame', 'subFrame', 'xhr', 'cspReport', 'webSocket', 'image', 'unknown-kind'].map(netResourceType)).toEqual(['main_frame', 'sub_frame', 'xmlhttprequest', 'csp_report', 'websocket', 'image', 'other'])
  })
})

describe('the time a rule may take on an address a page chose', () => {
  const filterOf = (urlFilter: string): UrlFilter => rule({ condition: { urlFilter } }).filter as UrlFilter

  /** The same filter as the regular expression it stands for: what `matchFilter` must agree with, on texts short enough for it to be quick. */
  const asExpression = (filter: UrlFilter, text: string): boolean => {
    let source = filter.left === '||' ? '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^/?#]*\\.)?' : filter.left === '|' ? '^' : ''
    for (const char of filter.body) source += char === '*' ? '.*' : char === '^' ? '(?:[^a-zA-Z0-9_.%-]|$)' : char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    return new RegExp(filter.right ? `${source}$` : source).test(text)
  }

  it('a filter says of an address what the regular expression it stands for says, whatever its wildcards, separators and anchors', () => {
    // A fixed sequence of draws: the same filters and addresses at every run.
    let seed = 20261111
    const draw = (below: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return Math.floor((seed / 2147483648) * below)
    }
    const word = (letters: string, longest: number): string => Array.from({ length: draw(longest + 1) }, () => letters[draw(letters.length)]).join('')
    let covered = 0
    for (let round = 0; round < 6000; round++) {
      const filter: UrlFilter = { body: word('ab/.*^^*', 7), left: (['', '', '|', '||'] as const)[draw(4)] ?? '', right: draw(4) === 0, plain: false }
      const text = `${['', 'http://', 'x-y+z://'][draw(3)]}${word('ab/.?#', 9)}`
      const expected = asExpression(filter, text)
      if (expected) covered += 1
      expect(matchFilter(filter, text).matched, `${filter.left}${filter.body}${filter.right ? '|' : ''} on ${text}`).toBe(expected)
    }
    // The draws are worth something: a fair share of them match, and a fair share do not.
    expect(covered).toBeGreaterThan(600)
    expect(covered).toBeLessThan(5400)
  })

  it('`^` at the end of the address matches without taking a character, alone, repeated, or after a `*`', () => {
    for (const [urlFilter, url, expected] of [
      ['/x^', 'https://a.example/x', true],
      ['/x^^', 'https://a.example/x?', true],
      ['/x^^^', 'https://a.example/x?', true],
      ['/x^y', 'https://a.example/x', false],
      ['a.example*^|', 'https://a.example/x', true],
      ['/x^*^', 'https://a.example/x', true],
      ['||example^|', 'https://a.example', true],
      ['||example^|', 'https://a.example/', true],
      ['||example^|', 'https://a.example/x', false]
    ] as const) {
      expect(ruleCovers(rule({ condition: { urlFilter } }), ask(url)), `${urlFilter} on ${url}`).toBe(expected)
    }
  })

  it('a filter with several `*` is judged in a number of steps that follows the lengths, on the address made to slow it down', () => {
    // The address repeats the parts of the filter and never ends the way the filter asks: an expression made of `.*` tries every combination.
    for (const length of [400, 1000, 30_000]) {
      const filter = filterOf('/ad*/ad*/ad*/ad*.gif')
      const address = `https://a.example${'/ad'.repeat(length)}`
      const match = matchFilter(filter, address)
      expect(match, String(length)).toMatchObject({ matched: false, exhausted: false })
      // Each character of the address is looked at a few times at most, however many `*` the filter has.
      expect(match.steps, String(length)).toBeLessThan(3 * address.length)
    }
    // Anchored at both ends, with a separator: the same holds.
    const anchored = matchFilter(filterOf('||a.example/*ad*ad*ad*ad*ad^zz|'), `https://a.example${'/ad'.repeat(1000)}`)
    expect(anchored).toMatchObject({ matched: false, exhausted: false })
    expect(anchored.steps).toBeLessThan(3 * 3100)
    const started = performance.now()
    expect(ruleCovers(rule({ condition: { urlFilter: '/ad*/ad*/ad*.gif' } }), ask(`https://a.example${'/ad'.repeat(400)}`))).toBe(false)
    // A wide bound: the regular expression of the first filter takes seconds on this address, the steps above a fraction of a millisecond.
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('a filter that would need more steps than it is given is given up, does not cover the request, and says so once', () => {
    // Each place of the address fits most of the part before failing: the one shape whose cost is the product of the two lengths.
    const slow = rule({ id: 12, condition: { urlFilter: `x*${'a'.repeat(200)}b` } })
    const address = `https://a.example/x${'a'.repeat(20_000)}`
    const match = matchFilter(slow.filter as UrlFilter, address)
    const budget = filterStepBudget(202, address.length)
    expect(match).toMatchObject({ matched: false, exhausted: true })
    // It stops at the budget, give or take the part it was comparing.
    expect(match.steps).toBeGreaterThan(budget)
    expect(match.steps).toBeLessThan(budget + 400)
    expect(budget).toBeLessThan(40 * address.length)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(ruleCovers(slow, ask(address))).toBe(false)
    expect(ruleCovers(slow, ask(address))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('rule 12')
    expect(String(warn.mock.calls[0]?.[0])).toContain(`${address.length} characters`)
    warn.mockRestore()
    // The same filter on an address it does match within its steps still covers it.
    expect(ruleCovers(slow, ask(`https://a.example/x/${'a'.repeat(200)}b`))).toBe(true)
  })

  // A rule its budget keeps from a request stopped covering it without a word to the extension's journal: the listener is how the engine hears of it.
  it('tells its listener the first time a rule is given up, once per rule: a filter out of steps, and an address too long for an expression', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const heard: Array<[number, string, number]> = []
    const listener = (given: NetRule, why: string, length: number): void => void heard.push([given.id, why, length])
    const slow = rule({ id: 12, condition: { urlFilter: `x*${'a'.repeat(200)}b` } })
    const address = `https://a.example/x${'a'.repeat(20_000)}`
    expect(ruleCovers(slow, ask(address), listener)).toBe(false)
    expect(ruleCovers(slow, ask(address), listener)).toBe(false)
    expect(heard).toEqual([[12, 'steps', address.length]])
    // Two repetitions one after the other: the expression is run on a few hundred characters only.
    const two = rule({ id: 13, condition: { regexFilter: 'x.*x.*y' } })
    const limit = two.regexUrlMax as number
    expect(limit).toBeLessThan(REGEX_URL_MAX)
    const long = `https://a.example/x${'a'.repeat(limit)}xy`
    expect(ruleCovers(two, ask(long), listener)).toBe(false)
    expect(ruleCovers(two, ask(`${long}z`), listener)).toBe(false)
    expect(heard).toEqual([[12, 'steps', address.length], [13, 'length', long.length]])
    // A short address is tried, and nothing is said of a rule that simply does not match or that another condition keeps away.
    expect(ruleCovers(two, ask('https://a.example/xxy'), listener)).toBe(true)
    expect(ruleCovers(rule({ id: 14, condition: { regexFilter: 'x.*x.*y', requestDomains: ['other.example'] } }), ask(long), listener)).toBe(false)
    expect(ruleCovers(rule({ id: 15, condition: { urlFilter: '/never/' } }), ask(address), listener)).toBe(false)
    expect(heard).toHaveLength(2)
    // Through the index of an extension's rules too, which is where a request meets them.
    const filed = rule({ id: 16, condition: { regexFilter: 'x.*x.*y' } })
    expect(new RuleIndex([filed]).covering(ask(long), listener)).toEqual([])
    expect(heard[2]).toEqual([16, 'length', long.length])
    warn.mockRestore()
  })

  it('a regular expression with repetitions one after the other is run only on an address short enough for it, and left out when none is', () => {
    // Four repetitions and no tie to the start: no real address is short enough.
    expect(readNetRule({ id: 1, action: { type: 'block' }, condition: { regexFilter: 'x.*x.*x.*x.*y' } })).toBe('backtracking')
    const two = rule({ condition: { regexFilter: 'x.*x.*y' } })
    expect(two.regexUrlMax).toBeGreaterThanOrEqual(REGEX_URL_MIN)
    expect(two.regexUrlMax).toBeLessThan(400)
    expect(ruleCovers(two, ask('https://a.example/x/x/y'))).toBe(true)
    // Past its bound the expression is not run: on this address it would take seconds to say no.
    const started = performance.now()
    const long = ask(`https://a.example/${'x'.repeat(3000)}`)
    expect(ruleCovers(two, long)).toBe(false)
    // The redirect of such a rule is not worked out either.
    const redirect = rule({ action: { type: 'redirect', redirect: { regexSubstitution: 'https://b.example/\\1' } }, condition: { regexFilter: 'x(.*)x.*y' } })
    expect(redirectTarget(redirect, long, 'ext')).toBeNull()
    expect(performance.now() - started).toBeLessThan(500)
    // An expression that cannot be slow keeps the bound of them all.
    expect(rule({ condition: { regexFilter: '^https://[a-z]+\\.example/ad[0-9]+' } }).regexUrlMax).toBe(REGEX_URL_MAX)
  })
})
