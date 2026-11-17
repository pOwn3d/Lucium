import { afterEach, describe, expect, it, vi } from 'vitest'
import { FILTER_ADDRESS_MAX } from '@shared/filter-lists'
import { loadGhosteryBackend, withoutCostlyRules } from './ghostery-engine'

const ghosteryBackend = await loadGhosteryBackend()

const LIST = [
  '||ads.example^$third-party',
  '||collect.example/p$xhr',
  '||only-scripts.example^$script',
  '||redir.example/a.js$script,redirect=noopjs',
  '@@||ads.example/ok.js',
  '||imp.example^$important',
  '@@||imp.example^',
  '||doc.example^$document',
  '||sock.example^$websocket',
  'localhost##.promo',
  '##.generic-ad',
  '###sponsor-box',
  'exemple.org#@#.generic-ad',
  '!#if env_mobile',
  '##.mobile-only',
  '!#endif',
  '!#if env_chromium',
  '##.chromium-only',
  '!#endif'
].join('\n')

const build = () => ghosteryBackend.build([LIST])
const ask = async (url: string, source: string, kind: Parameters<Awaited<ReturnType<typeof build>>['shouldBlock']>[0]['kind']) => (await build()).shouldBlock({ url, sourceUrl: source, kind })

describe('the Ghostery engine', () => {
  it('blocks a third-party request that a rule names, and lets the same site load its own', async () => {
    expect(await ask('https://ads.example/x.js', 'https://news.test/', 'script')).toBe(true)
    expect(await ask('https://ads.example/x.js', 'https://ads.example/', 'script')).toBe(false)
    expect(await ask('https://cdn.test/x.js', 'https://news.test/', 'script')).toBe(false)
  })

  it('honours an exception and an important rule', async () => {
    expect(await ask('https://ads.example/ok.js', 'https://news.test/', 'script')).toBe(false)
    expect(await ask('https://imp.example/a.js', 'https://news.test/', 'script')).toBe(true)
  })

  it('tells request types apart by the names the shell gives them', async () => {
    // These fail if "xhr" or "websocket" reach the engine under a name it does not know.
    expect(await ask('https://collect.example/p', 'https://news.test/', 'xmlhttprequest')).toBe(true)
    expect(await ask('https://collect.example/p', 'https://news.test/', 'script')).toBe(false)
    expect(await ask('https://only-scripts.example/a', 'https://news.test/', 'script')).toBe(true)
    expect(await ask('https://only-scripts.example/a', 'https://news.test/', 'image')).toBe(false)
    expect(await ask('wss://sock.example/s', 'https://news.test/', 'websocket')).toBe(true)
    expect(await ask('https://sock.example/s', 'https://news.test/', 'image')).toBe(false)
  })

  it('cancels a redirect rule outright: there is no neutered resource to hand over', async () => {
    expect(await ask('https://redir.example/a.js', 'https://news.test/', 'script')).toBe(true)
  })

  it('treats an unknown source as first party', async () => {
    expect(await ask('https://ads.example/x.js', '', 'script')).toBe(false)
  })

  it('hides what the rules of a site name, and the generic ones the page calls for', async () => {
    const engine = await build()
    expect(engine.cosmeticCss('http://localhost:8080/')).toContain('.promo')
    expect(engine.cosmeticCss('https://autre.test/')).not.toContain('.promo')
    const generic = engine.cosmeticCss('https://autre.test/', { classes: ['generic-ad', 'article'], ids: ['sponsor-box'], hrefs: [] })
    expect(generic).toContain('.generic-ad')
    expect(generic).toContain('#sponsor-box')
    expect(generic).toContain('display: none !important')
    // Without the page's markup, the class and id rules are not looked up.
    expect(engine.cosmeticCss('https://autre.test/')).not.toContain('.generic-ad')
    // The site that unhides it keeps it.
    expect(engine.cosmeticCss('https://exemple.org/', { classes: ['generic-ad'], ids: [], hrefs: [] })).not.toContain('.generic-ad')
  })

  it('reads "!#if" conditions as a desktop Chromium would', async () => {
    const css = (await build()).cosmeticCss('https://autre.test/')
    expect(css).not.toContain('.mobile-only')
    const withMarkup = (await build()).cosmeticCss('https://autre.test/', { classes: ['chromium-only', 'mobile-only'], ids: [], hrefs: [] })
    expect(withMarkup).toContain('.chromium-only')
    expect(withMarkup).not.toContain('.mobile-only')
  })

  it('gives nothing for an address that is not a web page', async () => {
    expect((await build()).cosmeticCss('about:blank')).toBe('')
  })

  it('comes back from its serialized form with the same answers', async () => {
    const engine = await build()
    const copy = await ghosteryBackend.load(engine.serialize())
    expect(copy.shouldBlock({ url: 'https://ads.example/x.js', sourceUrl: 'https://news.test/', kind: 'script' })).toBe(true)
    expect(copy.shouldBlock({ url: 'https://ads.example/ok.js', sourceUrl: 'https://news.test/', kind: 'script' })).toBe(false)
    expect(copy.cosmeticCss('http://localhost:8080/')).toContain('.promo')
    // The conditions are evaluated again after loading, not carried over blindly.
    expect(copy.cosmeticCss('https://autre.test/', { classes: ['mobile-only', 'chromium-only'], ids: [], hrefs: [] })).not.toContain('.mobile-only')
  })

  it('treats a request to the site of its source as one for third parties alone only when told so', async () => {
    const generic = '||own.example/ads/banner.js'
    const engine = await ghosteryBackend.build([generic])
    const own = { url: 'https://own.example/ads/banner.js', sourceUrl: 'https://own.example/', kind: 'script' as const }
    expect(engine.shouldBlock(own)).toBe(true)
    expect(engine.shouldBlock({ ...own, ownSite: false })).toBe(true)
    expect(engine.shouldBlock({ ...own, ownSite: true })).toBe(false)
  })

  describe('with ownSite (Standard mode): only a rule that names the first party blocks', () => {
    const own = (path: string) => ({ url: `https://own.example${path}`, sourceUrl: 'https://own.example/page', kind: 'script' as const, ownSite: true })
    const lists = [
      '||own.example/ads/generic.js',
      '||own.example/stats/one.js$1p',
      '||own.example/stats/two.js$first-party',
      '||own.example/stats/three.js$~third-party',
      '||own.example/stats/only-third.js$third-party',
      '||own.example/ex/a.js$1p',
      '@@||own.example/ex/a.js'
    ]

    it('lets a rule written for nobody in particular pass, and keeps the three spellings of a first-party rule', async () => {
      const engine = await ghosteryBackend.build([lists.join('\n')])
      expect(engine.shouldBlock(own('/ads/generic.js'))).toBe(false)
      for (const path of ['/stats/one.js', '/stats/two.js', '/stats/three.js']) expect(engine.shouldBlock(own(path)), path).toBe(true)
      // A rule for third parties never applied to the site's own requests; this does not change.
      expect(engine.shouldBlock(own('/stats/only-third.js'))).toBe(false)
      // An exception still wins over a first-party rule.
      expect(engine.shouldBlock(own('/ex/a.js'))).toBe(false)
    })

    it('finds the first-party rule even when another rule is the one that wins', async () => {
      // The engine reports the rule for the whole host (found first), not the narrower one that says $1p: it has to look at the others.
      // Both orders of the list must give the same answer.
      const generic = '||own.example^$script'
      const explicit = '||own.example/dual/banner.js$script,1p'
      for (const text of [[generic, explicit], [explicit, generic]]) {
        const engine = await ghosteryBackend.build([text.join('\n')])
        expect(engine.shouldBlock(own('/dual/banner.js')), text.join(' then ')).toBe(true)
        // The host's other files stay out of it: only the narrower rule names the first party.
        expect(engine.shouldBlock(own('/other.js')), text.join(' then ')).toBe(false)
      }
    })

    it('does not change what a third party gets', async () => {
      const engine = await ghosteryBackend.build([lists.join('\n')])
      const third = { url: 'https://own.example/ads/generic.js', sourceUrl: 'https://news.test/', kind: 'script' as const, ownSite: false }
      expect(engine.shouldBlock(third)).toBe(true)
    })
  })

  it('refuses bytes it did not make', async () => {
    await expect(ghosteryBackend.load(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow()
    await expect(ghosteryBackend.load(new Uint8Array(0))).rejects.toThrow()
  })
})

describe('the engine\'s own verdict on a rule of the user\'s', () => {
  const parses = ghosteryBackend.parses!

  it('says whether the engine understands a rule', () => {
    expect(parses('||ads.example^$third-party')).toBe(true)
    expect(parses('exemple.org##.bandeau')).toBe(true)
    expect(parses('/[/')).toBe(false)
    expect(parses('$$$')).toBe(false)
  })

  it('is the last check of a pasted list: a rule the engine drops silently is counted instead', async () => {
    const { reviewCustomList } = await import('@shared/custom-filter-lists')
    const verdict = reviewCustomList('||ads.example^\n$$$\n/[/\n', parses)
    // `/[/` is a regular expression: left out before the engine is asked; `$$$` is only an AdGuard rule it cannot read.
    expect(verdict).toMatchObject({ ok: true, review: { rules: 1, ignored: 2, invalid: 0 } })
  })

  it('cuts the options of a rule where the review of a list cuts them: an expression followed by options is one for both', async () => {
    const lib = await import('@ghostery/adblocker')
    const { reviewCustomList } = await import('@shared/custom-filter-lists')
    for (const rule of ['/(a+)+b/$3p', '/(a+)+b/$1p', '/(a+)+b/$domain=exa(mple.com', '/(a+)+b/$']) {
      // What the library makes of the line, were it given it: a regular expression run on every address.
      const read = lib.parseFilter(rule)
      expect(read?.isNetworkFilter() && read.isFullRegex(), rule).toBe(true)
      // The review is asked with a parser that says yes to everything: the refusal is its own.
      expect(reviewCustomList(`||garde.example^\n${rule}\n`, () => true), rule).toMatchObject({ ok: true, review: { rules: 1, ignored: 1, invalid: 0 } })
    }
  })

  it('compiles what the review keeps, and counts a rule whose two wildcards can each start anywhere instead of keeping it', async () => {
    const { reviewCustomList } = await import('@shared/custom-filter-lists')
    const verdict = reviewCustomList('/(a+)+$/\n||ads.example/*/ads/*.js\n/banner/*/ads/*.js\n||tracker.example/a*b\n', parses)
    if (!verdict.ok) throw new Error(verdict.reason)
    // The expression is refused by the review. Two wildcards are read once after a host, where the rule starts at one place; with no host
    // the rule is tried from every character, in every pair of places: the engine does not apply it.
    expect(verdict.review).toMatchObject({ rules: 2, ignored: 1, invalid: 1 })
    expect(verdict.review.text).toBe('||ads.example/*/ads/*.js\n||tracker.example/a*b\n')
    const engine = await ghosteryBackend.build([verdict.review.text])
    const longest = `https://ads.example/${'a'.repeat(8000)}/ads/${'a'.repeat(8000)}c`
    expect(engine.shouldBlock({ url: longest, sourceUrl: 'https://news.test/', kind: 'script' })).toBe(false)
    expect(engine.shouldBlock({ url: `https://tracker.example/${'a'.repeat(8000)}c`, sourceUrl: 'https://news.test/', kind: 'script' })).toBe(false)
    expect(engine.shouldBlock({ url: 'https://ads.example/x/ads/y.js', sourceUrl: 'https://news.test/', kind: 'script' })).toBe(true)
  })
})

describe('what one request may cost the main process', () => {
  afterEach(() => vi.restoreAllMocks())

  // Two rules of a public list, as it publishes them: each `*` is a place the matching comes back to, character by character.
  const FOUR_WILDCARDS = '||youtube.com/ptracking?html5=1&video_id=*&cpn=*&ei=*&ptk=youtube_*&pltype=content'
  const THREE_WILDCARDS = '||freehostedscripts.net^*.php?site=*&s=*&h=$third-party'
  const LISTS = [FOUR_WILDCARDS, THREE_WILDCARDS, '/^https?:\\/\\/nested\\.example\\/(a+)+$/', '||ads.example/*/banner.js', '/^https:\\/\\/plain\\.example\\/[a-z]+\\.js$/', '||host.example^', '||params.example^$removeparam=fbclid'].join('\n')
  const news = 'https://news.test/'

  it('leaves out of the engine the rules of a list whose matching can grow as a power of the address, says how many, and keeps the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = await ghosteryBackend.build([LISTS])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('3 rule(s) of the lists left out')
    expect(warn.mock.calls[0]?.[0]).toContain('youtube.com')
    // The addresses the three rules are written for are no longer stopped: the rules are not in the engine.
    expect(engine.shouldBlock({ url: 'https://youtube.com/ptracking?html5=1&video_id=a&cpn=b&ei=c&ptk=youtube_d&pltype=content', sourceUrl: news, kind: 'image' })).toBe(false)
    expect(engine.shouldBlock({ url: 'https://freehostedscripts.net/a.php?site=a&s=b&h=c', sourceUrl: news, kind: 'script' })).toBe(false)
    expect(engine.shouldBlock({ url: 'https://nested.example/aaa', sourceUrl: news, kind: 'script' })).toBe(false)
    // One wildcard, and an expression that reads an address once, stay.
    expect(engine.shouldBlock({ url: 'https://ads.example/2026/banner.js', sourceUrl: news, kind: 'script' })).toBe(true)
    expect(engine.shouldBlock({ url: 'https://plain.example/app.js', sourceUrl: news, kind: 'script' })).toBe(true)
  })

  it('sorts rules by the expression each one compiles to', () => {
    const rule = (source: string | null) => ({ isRegex: () => source !== null, getRegex: () => new RegExp(source ?? ''), toString: () => String(source) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const plain = rule(null)
    const one = rule('\\/ads\\/.*\\.js')
    const kept = withoutCostlyRules([plain, one, rule('&cpn=.*&ei=.*&ptk=.*&pltype='), rule('(a+)+b')])
    expect(kept).toEqual([plain, one])
    expect(warn.mock.calls[0]?.[0]).toContain('2 rule(s)')
    warn.mockClear()
    expect(withoutCostlyRules([plain, one])).toEqual([plain, one])
    expect(warn).not.toHaveBeenCalled()
  })

  it('gives the library the start of a long address only, for a request and for a page', async () => {
    const lib = await import('@ghostery/adblocker')
    const engine = await ghosteryBackend.build([`${LISTS}\nhost.example##.promo\n||host.example^$csp=script-src 'none'`])
    const seen = vi.spyOn(lib.Request, 'fromRawDetails')
    const long = `https://host.example/${'a'.repeat(3 * FILTER_ADDRESS_MAX)}`
    const short = 'https://host.example/a.js'
    // The host is in the start: the rule that names it still stops the request.
    expect(engine.shouldBlock({ url: long, sourceUrl: news, kind: 'script' })).toBe(true)
    expect(engine.decide!({ url: long, sourceUrl: news, kind: 'script' })).toEqual({ action: 'block' })
    expect(engine.cosmeticCss(long)).toContain('.promo')
    expect(engine.cspFor!(long)).toBe("script-src 'none'")
    expect(engine.scriptlets!(long)).toEqual([])
    expect(engine.shouldBlock({ url: short, sourceUrl: news, kind: 'script' })).toBe(true)
    const lengths = seen.mock.calls.flatMap(([details]) => [details.url?.length ?? 0, details.sourceUrl?.length ?? 0])
    expect(lengths.length).toBeGreaterThanOrEqual(12)
    expect(Math.max(...lengths)).toBe(FILTER_ADDRESS_MAX)
    // A short address reaches the library whole.
    expect(seen.mock.calls.at(-1)?.[0].url).toBe(short)
  })

  it('does not clean an address it only saw the start of: the request would lose its end', async () => {
    const engine = await ghosteryBackend.build([LISTS])
    expect(engine.decide!({ url: 'https://params.example/p?fbclid=1&q=2', sourceUrl: news, kind: 'image' })).toEqual({ action: 'rewrite', url: 'https://params.example/p?q=2' })
    expect(engine.decide!({ url: `https://params.example/p?fbclid=1&q=${'a'.repeat(FILTER_ADDRESS_MAX)}`, sourceUrl: news, kind: 'image' })).toEqual({ action: 'pass' })
  })

  it('answers at once the addresses that held the matching for seconds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = await ghosteryBackend.build([LISTS])
    // The bound of this test is its own time limit: before the two guards, the first address alone took 18 seconds.
    for (const url of [`https://youtube.com/ptracking?html5=1&video_id=${'&cpn=&ei=&ptk=youtube_'.repeat(400)}`, `https://freehostedscripts.net/${'.php?site=&s='.repeat(800)}`]) {
      expect(engine.shouldBlock({ url, sourceUrl: news, kind: 'image' })).toBe(false)
    }
  })

  it('names the engine so that one compiled with the costly rules does not come back from the cache', () => {
    expect(ghosteryBackend.id).toMatch(/^ghostery-\d+-r2$/)
  })

  it('tells the review of a list of the user that such a rule is not one it applies', () => {
    expect(ghosteryBackend.parses!(FOUR_WILDCARDS)).toBe(false)
    expect(ghosteryBackend.parses!('||ads.example/*/banner.js')).toBe(true)
  })
})

describe('the extended rules of the Ghostery engine', () => {
  const EXTENDED = [
    '||redir.example/a.js$script,redirect=noopjs',
    '||redir.example/g.js$script,redirect=googletagservices_gpt.js',
    '||redir.example/u.js$script,redirect=unknown-resource.js',
    '||redir.example/n.js$script,redirect=none',
    '||tail.example/pixel.gif$image,redirect-rule=1x1.gif',
    '||tail.example^$image',
    '||params.example^$removeparam=fbclid',
    '||params.example^$removeparam=gclid',
    '@@||params.example/keep^$removeparam=fbclid',
    '||all-params.example^$removeparam=/^utm_/',
    '||doc.example^$csp=script-src \'none\'',
    '@@||nocsp.example^$csp',
    '||nocsp.example^$csp=frame-src \'none\'',
    'news.test##+js(set-constant, adsEnabled, false)',
    'news.test,~sub.news.test##+js(aopr, adBlockDetected)',
    'www.news.test#@#+js(aopr, adBlockDetected)',
    'other.test##+js(acs, document.createElement, /\\.fonts\\./)',
    'other.test##.banner'
  ].join('\n')
  const engine = () => ghosteryBackend.build([EXTENDED])
  const decide = async (url: string, source: string, kind: Parameters<Awaited<ReturnType<typeof build>>['shouldBlock']>[0]['kind'], ownSite?: boolean) =>
    (await engine()).decide!({ url, sourceUrl: source, kind, ...(ownSite !== undefined ? { ownSite } : {}) })

  it('answers a redirect rule with the name of the stand-in, and a plain block with a block', async () => {
    expect(await decide('https://redir.example/a.js', 'https://news.test/', 'script')).toEqual({ action: 'redirect', resource: 'noopjs' })
    expect(await decide('https://redir.example/g.js', 'https://news.test/', 'script')).toEqual({ action: 'redirect', resource: 'googletagservices_gpt.js' })
    // The name is the list's: whether a stand-in exists for it is for the service to say.
    expect(await decide('https://redir.example/u.js', 'https://news.test/', 'script')).toEqual({ action: 'redirect', resource: 'unknown-resource.js' })
    // "redirect=none" is the rule that cancels redirects: it is not a block, and not a stand-in.
    expect(await decide('https://redir.example/n.js', 'https://news.test/', 'script')).toEqual({ action: 'pass' })
    expect(await decide('https://tail.example/other.png', 'https://news.test/', 'image')).toEqual({ action: 'block' })
  })

  it('applies redirect-rule only to a request that is blocked anyway', async () => {
    expect(await decide('https://tail.example/pixel.gif', 'https://news.test/', 'image')).toEqual({ action: 'redirect', resource: '1x1.gif' })
    expect(await decide('https://tail.example/pixel.gif', 'https://news.test/', 'script')).toEqual({ action: 'pass' })
  })

  it('keeps the rule of Standard mode: a request to the site of its own document is left alone', async () => {
    expect(await decide('https://redir.example/a.js', 'https://redir.example/', 'script', true)).toEqual({ action: 'pass' })
    expect(await decide('https://redir.example/a.js', 'https://redir.example/', 'script', false)).toEqual({ action: 'redirect', resource: 'noopjs' })
  })

  it('cleans the address for $removeparam, only the parameters a rule names, and honours the exception', async () => {
    expect(await decide('https://params.example/p?fbclid=1&keep=2&gclid=3', 'https://news.test/', 'xmlhttprequest')).toEqual({ action: 'rewrite', url: 'https://params.example/p?keep=2' })
    expect(await decide('https://params.example/p?keep=2', 'https://news.test/', 'xmlhttprequest')).toEqual({ action: 'pass' })
    // On the page of the exception, fbclid stays and gclid goes.
    expect(await decide('https://params.example/keep?fbclid=1&gclid=3', 'https://news.test/', 'xmlhttprequest')).toEqual({ action: 'rewrite', url: 'https://params.example/keep?fbclid=1' })
    expect(await decide('https://elsewhere.example/p?fbclid=1', 'https://news.test/', 'xmlhttprequest')).toEqual({ action: 'pass' })
    // A navigation is cleaned as well: the rule does not look at the type.
    expect(await decide('https://params.example/article?fbclid=1', '', 'main_frame')).toEqual({ action: 'rewrite', url: 'https://params.example/article' })
  })

  it('answers a request that is blocked with the block, not with a cleaned address', async () => {
    const list = await ghosteryBackend.build(['||both.example^$removeparam=fbclid\n||both.example/x.js$script'])
    expect(list.decide!({ url: 'https://both.example/x.js?fbclid=1', sourceUrl: 'https://news.test/', kind: 'script' })).toEqual({ action: 'block' })
  })

  it('gives the $csp of a main document, minus what an exception takes away', async () => {
    const lists = await engine()
    expect(lists.cspFor!('https://doc.example/')).toBe("script-src 'none'")
    expect(lists.cspFor!('https://other.example/')).toBeUndefined()
    expect(lists.cspFor!('https://nocsp.example/')).toBeUndefined()
  })

  it('lists the scriptlets of a page by name and arguments, without code, and drops what an exception cancels', async () => {
    const lists = await engine()
    expect(lists.scriptlets!('https://news.test/article')).toEqual([{ name: 'set-constant', args: ['adsEnabled', 'false'] }, { name: 'aopr', args: ['adBlockDetected'] }])
    // The exception of one host cancels the rule there and nowhere else; ~sub.news.test leaves one out of the rule.
    expect(lists.scriptlets!('https://www.news.test/')).toEqual([{ name: 'set-constant', args: ['adsEnabled', 'false'] }])
    expect(lists.scriptlets!('https://sub.news.test/')).toEqual([{ name: 'set-constant', args: ['adsEnabled', 'false'] }])
    expect(lists.scriptlets!('https://other.test/')).toEqual([{ name: 'acs', args: ['document.createElement', '/\\.fonts\\./'] }])
    expect(lists.scriptlets!('https://nowhere.test/')).toEqual([])
    expect(lists.scriptlets!('about:blank')).toEqual([])
    expect(lists.scriptlets!('chrome://settings')).toEqual([])
  })

  it('does not ask the stylesheet for scripts: the scriptlet rules never reach the page as code', async () => {
    const lists = await engine()
    expect(lists.cosmeticCss('https://other.test/')).toContain('.banner')
    expect(lists.cosmeticCss('https://news.test/')).not.toMatch(/adsEnabled|aopr|set-constant/)
  })

  it('keeps all of it through the serialized form the cache holds', async () => {
    const built = await engine()
    const restored = await ghosteryBackend.load(built.serialize())
    expect(restored.decide!({ url: 'https://redir.example/a.js', sourceUrl: 'https://news.test/', kind: 'script' })).toEqual({ action: 'redirect', resource: 'noopjs' })
    expect(restored.decide!({ url: 'https://params.example/p?fbclid=1', sourceUrl: 'https://news.test/', kind: 'xmlhttprequest' })).toEqual({ action: 'rewrite', url: 'https://params.example/p' })
    expect(restored.cspFor!('https://doc.example/')).toBe("script-src 'none'")
    expect(restored.scriptlets!('https://news.test/')).toEqual([{ name: 'set-constant', args: ['adsEnabled', 'false'] }, { name: 'aopr', args: ['adBlockDetected'] }])
  })
})
