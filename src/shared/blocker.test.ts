import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import { redirectResourceNames, redirectTargetOf } from './redirect-resources'
import { BLOCK_EXCEPTIONS_MAX, REDIRECT_MAX_CHARS, adsBlockingOn, adsBlockingPatch, blockerIsOn, SITE_BLOCK_MODES_MAX, blockModeFor, siteBlockModeOf, withSiteBlockMode, cleanSiteBlockModes, blockedByHosts, checkBlockException, cleanBlockExceptions, cleanBlockingSettings, cleanBlockMode, consentWallCss, cookieBannerCss, hostIn, isBlockingExempt, normalizeBlockHost, safeRedirectTarget, setBlockingExempt, shouldBlock, toRequestKind, withContentSecurityPolicy } from './blocker'
import { frenchSpaces } from './french-typography'

const ads = { ads: true, cookieBanners: false }
const banners = { ads: false, cookieBanners: true }
const request = (url: string, resourceType = 'script') => ({ url, resourceType })

describe('hostIn', () => {
  it('matches a host and its subdomains, not a lookalike', () => {
    expect(hostIn('doubleclick.net', ['doubleclick.net'])).toBe(true)
    expect(hostIn('ads.g.DoubleClick.net', ['doubleclick.net'])).toBe(true)
    expect(hostIn('notdoubleclick.net', ['doubleclick.net'])).toBe(false)
    expect(hostIn('doubleclick.net.evil.example', ['doubleclick.net'])).toBe(false)
  })
})

describe('shouldBlock', () => {
  it('blocks third-party ad and tracker requests when enabled', () => {
    expect(shouldBlock(request('https://securepubads.g.doubleclick.net/tag.js'), 'https://news.example/', ads)).toBe(true)
    expect(shouldBlock(request('https://www.google-analytics.com/collect', 'image'), 'https://news.example/', ads)).toBe(true)
  })

  it('does nothing when both options are off', () => {
    expect(shouldBlock(request('https://ads.doubleclick.net/x'), 'https://news.example/', { ads: false, cookieBanners: false })).toBe(false)
  })

  it('keeps the two lists separate', () => {
    expect(shouldBlock(request('https://cdn.cookielaw.org/otSDKStub.js'), 'https://news.example/', ads)).toBe(false)
    expect(shouldBlock(request('https://cdn.cookielaw.org/otSDKStub.js'), 'https://news.example/', banners)).toBe(true)
    expect(shouldBlock(request('https://ads.doubleclick.net/x'), 'https://news.example/', banners)).toBe(false)
  })

  it('never blocks a navigation, nor a network\'s own site loading its own resources', () => {
    expect(shouldBlock(request('https://ads.doubleclick.net/', 'mainFrame'), null, ads)).toBe(false)
    expect(shouldBlock(request('https://static.doubleclick.net/app.js'), 'https://www.doubleclick.net/', ads)).toBe(false)
  })

  it('still blocks a network embedded in a different network\'s page', () => {
    expect(shouldBlock(request('https://ads.doubleclick.net/x'), 'https://www.criteo.com/', ads)).toBe(true)
  })

  it('ignores anything that is not a web URL', () => {
    expect(shouldBlock(request('chrome-extension://abc/page.js'), 'https://news.example/', ads)).toBe(false)
    expect(shouldBlock(request('data:text/plain,hi'), 'https://news.example/', ads)).toBe(false)
    expect(shouldBlock(request('https://'), 'https://news.example/', ads)).toBe(false)
  })

  it('takes extra hosts into account for ads only', () => {
    expect(shouldBlock(request('http://localhost:8080/x.js'), 'http://127.0.0.1:8080/', ads, ['localhost'])).toBe(true)
    expect(shouldBlock(request('http://localhost:8080/x.js'), 'http://127.0.0.1:8080/', banners, ['localhost'])).toBe(false)
  })
})

describe('cookieBannerCss', () => {
  it('hides known banners and restores scrolling', () => {
    const css = cookieBannerCss()
    expect(css).toContain('#onetrust-banner-sdk')
    expect(css).toContain('display: none !important')
    expect(css).toContain('overflow: auto !important')
  })
})

describe('consentWallCss', () => {
  it('hides the known consent containers, and gives back the scrolling that Sourcepoint and Didomi lock', () => {
    const css = consentWallCss()
    expect(css).toContain('[id^="sp_message_container"]')
    expect(css).toContain('#didomi-host')
    // The Guardian locks the page with a class on <html> and a fixed body.
    expect(css).toMatch(/html\.sp-message-open body[^{]*\{[^}]*overflow: auto !important[^}]*position: static !important/)
    expect(css).toMatch(/body\.didomi-popup-open/)
  })

  it('does not give the scrolling back to every page: only to the pages that carry a wall class', () => {
    // A blanket "html, body { overflow: auto }" would break pages that hide their own overflow on purpose.
    expect(consentWallCss()).not.toMatch(/(^|\n)html, body \{/)
    expect(cookieBannerCss()).toMatch(/(^|\n)html, body \{ overflow: auto !important; \}/)
  })
})

describe('toRequestKind', () => {
  // The engines know these names, not Electron's: a wrong word makes `$xhr`, `$subdocument` or `$websocket` rules miss.
  it('renames the types Electron reports to the ones the filter engines read', () => {
    expect(toRequestKind('mainFrame')).toBe('main_frame')
    expect(toRequestKind('subFrame')).toBe('sub_frame')
    expect(toRequestKind('xhr')).toBe('xmlhttprequest')
    expect(toRequestKind('cspReport')).toBe('csp_report')
    expect(toRequestKind('webSocket')).toBe('websocket')
    for (const same of ['stylesheet', 'script', 'image', 'font', 'object', 'ping', 'media', 'other'] as const) expect(toRequestKind(same)).toBe(same)
  })

  it('turns a type nobody knows into "other" rather than a guess, whatever its spelling', () => {
    expect(toRequestKind('beacon')).toBe('other')
    expect(toRequestKind('')).toBe('other')
    expect(toRequestKind('__proto__')).toBe('other')
    expect(toRequestKind('toString')).toBe('other')
  })
})

describe('blockedByHosts', () => {
  it('is the host check alone: a navigation and the network\'s own site are spared', () => {
    expect(blockedByHosts(request('https://x.tracker.example/p.js'), 'https://news.example/', ['tracker.example'])).toBe(true)
    expect(blockedByHosts(request('https://x.tracker.example/', 'mainFrame'), null, ['tracker.example'])).toBe(false)
    expect(blockedByHosts(request('https://x.tracker.example/p.js'), 'https://tracker.example/', ['tracker.example'])).toBe(false)
  })
})

describe('sites without blocking', () => {
  it('reads a typed address as a host', () => {
    expect(normalizeBlockHost('https://www.Exemple.org/page?x=1')).toBe('exemple.org')
    expect(normalizeBlockHost('*.exemple.org')).toBe('exemple.org')
    expect(normalizeBlockHost('mail.exemple.org:8080')).toBe('mail.exemple.org')
    expect(normalizeBlockHost('pas un hôte')).toBeNull()
    expect(normalizeBlockHost('javascript:alert(1)')).toBeNull()
    expect(normalizeBlockHost('')).toBeNull()
    expect(normalizeBlockHost(42)).toBeNull()
  })

  it('takes a site reached by its IPv6 address: a local server on [::1] can be left unblocked like one on 127.0.0.1', () => {
    expect(normalizeBlockHost('http://[::1]:3000/page')).toBe('[::1]')
    expect(normalizeBlockHost('[2001:DB8::1]')).toBe('[2001:db8::1]')
    // The parser writes an address one way only, so the same address typed two ways is one entry.
    expect(normalizeBlockHost('[0:0:0:0:0:0:0:1]')).toBe('[::1]')
    for (const bad of ['[::1', '[zz::1]', '::1', '[1.2.3.4]']) expect(normalizeBlockHost(bad), bad).toBeNull()
    const hosts = setBlockingExempt([], 'http://[::1]:3000/page', true)
    expect(hosts).toEqual(['[::1]'])
    expect(isBlockingExempt('http://[::1]:8080/other', hosts)).toBe(true)
    expect(isBlockingExempt('http://[::2]:8080/other', hosts)).toBe(false)
    expect(setBlockingExempt(hosts, '[::1]', false)).toEqual([])
  })

  it('exempts a host and its subdomains, not a lookalike', () => {
    const hosts = ['exemple.org']
    expect(isBlockingExempt('https://exemple.org/a', hosts)).toBe(true)
    expect(isBlockingExempt('https://www.exemple.org/a', hosts)).toBe(true)
    expect(isBlockingExempt('https://mail.exemple.org/a', hosts)).toBe(true)
    expect(isBlockingExempt('https://pasexemple.org/a', hosts)).toBe(false)
    expect(isBlockingExempt('https://exemple.org.evil.test/a', hosts)).toBe(false)
  })

  it('exempts nothing for an empty list or an address that is not one', () => {
    expect(isBlockingExempt('https://exemple.org/', [])).toBe(false)
    expect(isBlockingExempt(null, ['exemple.org'])).toBe(false)
    expect(isBlockingExempt('pas une adresse', ['exemple.org'])).toBe(false)
  })

  it('adds a site once, and a subdomain of a listed site changes nothing', () => {
    expect(setBlockingExempt([], 'https://www.exemple.org/x', true)).toEqual(['exemple.org'])
    expect(setBlockingExempt(['exemple.org'], 'exemple.org', true)).toEqual(['exemple.org'])
    expect(setBlockingExempt(['exemple.org'], 'mail.exemple.org', true)).toEqual(['exemple.org'])
    expect(setBlockingExempt(['exemple.org'], 'pas un hôte', true)).toEqual(['exemple.org'])
  })

  it('takes a site out together with the parent domain that covered it', () => {
    expect(setBlockingExempt(['exemple.org', 'autre.net'], 'mail.exemple.org', false)).toEqual(['autre.net'])
    expect(setBlockingExempt(['exemple.org'], 'autre.net', false)).toEqual(['exemple.org'])
  })

  it('says why a typed site cannot be added', () => {
    expect(checkBlockException('exemple.org', [])).toEqual({ host: 'exemple.org' })
    expect(checkBlockException('///', [])).toHaveProperty('error')
    expect(checkBlockException('exemple.org', ['exemple.org'])).toEqual({ error: 'Ce site est déjà dans la liste.' })
    expect(checkBlockException('mail.exemple.org', ['exemple.org'])).toEqual({ error: frenchSpaces('Ce site est déjà couvert par « exemple.org ».') })
    // A full list takes no more; one place left is enough.
    const full = Array.from({ length: BLOCK_EXCEPTIONS_MAX }, (_, i) => `s${i}.example`)
    expect(checkBlockException('nouveau.example', full)).toEqual({ error: 'La liste est pleine.' })
    expect(checkBlockException('nouveau.example', full.slice(1))).toEqual({ host: 'nouveau.example' })
  })

  it('keeps valid hosts only, once each, from a saved file', () => {
    expect(cleanBlockExceptions(['Exemple.org', 'exemple.org', 'x y', 3, null, 'autre.net'])).toEqual(['exemple.org', 'autre.net'])
    expect(cleanBlockExceptions('exemple.org')).toEqual([])
    expect(cleanBlockExceptions(Array.from({ length: 500 }, (_, i) => `site${i}.test`))).toHaveLength(200)
  })
})

describe('cleanBlockMode', () => {
  it('keeps the two modes and falls back to Standard for anything else', () => {
    expect(cleanBlockMode('standard')).toBe('standard')
    expect(cleanBlockMode('strict')).toBe('strict')
    // Standard is the default of a new profile and of a file that has no mode (written by an older build).
    expect(defaultSettings().blockMode).toBe('standard')
    for (const bad of [undefined, null, '', 'Strict', 'aggressive', 'constructor', 0, true, ['strict'], { mode: 'strict' }]) expect(cleanBlockMode(bad)).toBe('standard')
  })
})

describe('the mode of one site', () => {
  it('keeps the sites with a valid mode, under their host, and drops the rest', () => {
    expect(cleanSiteBlockModes({ 'WWW.YouTube.com': 'strict', 'example.org': 'standard', 'bad.example': 'aggressive', 'not a host': 'strict', 'x.test': 3 })).toEqual({ 'youtube.com': 'strict', 'example.org': 'standard' })
  })

  it('refuses what is not an object of sites, and a prototype key', () => {
    for (const bad of [undefined, null, 'strict', ['youtube.com'], 3]) expect(cleanSiteBlockModes(bad)).toEqual({})
    expect(Object.keys(cleanSiteBlockModes(JSON.parse('{"__proto__":"strict","youtube.com":"strict"}')))).toEqual(['youtube.com'])
  })

  it('bounds the list of a hand-edited file', () => {
    const many = Object.fromEntries(Array.from({ length: SITE_BLOCK_MODES_MAX + 5 }, (_, i) => [`s${i}.example`, 'strict']))
    expect(Object.keys(cleanSiteBlockModes(many))).toHaveLength(SITE_BLOCK_MODES_MAX)
  })

  it('sets and removes a site, without touching the others, and returns a new object', () => {
    const before = { 'example.org': 'strict' as const }
    const added = withSiteBlockMode(before, 'https://www.youtube.com/watch?v=1', 'strict')
    expect(added).toEqual({ 'example.org': 'strict', 'youtube.com': 'strict' })
    expect(before).toEqual({ 'example.org': 'strict' })
    // Giving a site back to the general mode takes out its entry and the entry of a parent domain that covers it, as the exceptions do.
    expect(withSiteBlockMode({ 'youtube.com': 'strict', 'example.org': 'standard' }, 'm.youtube.com', null)).toEqual({ 'example.org': 'standard' })
    // A mode that is not one of the two, a site with no host, and a new site on a full list change nothing.
    expect(withSiteBlockMode(before, 'youtube.com', 'aggressive')).toEqual(before)
    expect(withSiteBlockMode(before, 'pas un site', 'strict')).toEqual(before)
    const full = Object.fromEntries(Array.from({ length: SITE_BLOCK_MODES_MAX }, (_, i) => [`s${i}.example`, 'strict' as const]))
    expect(Object.keys(withSiteBlockMode(full, 'new.example', 'strict'))).toHaveLength(SITE_BLOCK_MODES_MAX)
    expect(withSiteBlockMode(full, 's0.example', 'standard')['s0.example']).toBe('standard')
  })

  it('gives the mode of a page from its host, then from the nearest parent domain that has one', () => {
    const choices = { 'youtube.com': 'strict' as const, 'music.youtube.com': 'standard' as const }
    expect(siteBlockModeOf(choices, 'https://youtube.com/')).toBe('strict')
    expect(siteBlockModeOf(choices, 'https://www.youtube.com/watch')).toBe('strict')
    expect(siteBlockModeOf(choices, 'https://m.youtube.com/')).toBe('strict')
    // The most specific entry wins: music follows its own choice, not the one of youtube.com.
    expect(siteBlockModeOf(choices, 'https://music.youtube.com/')).toBe('standard')
    expect(siteBlockModeOf(choices, 'https://x.music.youtube.com/')).toBe('standard')
    // A lookalike is not a subdomain, and a site without a choice has none.
    expect(siteBlockModeOf(choices, 'https://notyoutube.com/')).toBeNull()
    expect(siteBlockModeOf(choices, 'https://example.org/')).toBeNull()
    expect(siteBlockModeOf(choices, 'about:blank')).toBeNull()
    expect(siteBlockModeOf(choices, null)).toBeNull()
    // Own keys only: a host called like an object property reads nothing.
    expect(siteBlockModeOf({}, 'https://constructor/')).toBeNull()
  })

  it('judges a page with its site mode, else with the general one', () => {
    const settings = { blockMode: 'standard' as const, blockModeSites: { 'youtube.com': 'strict' as const } }
    expect(blockModeFor(settings, 'https://www.youtube.com/')).toBe('strict')
    expect(blockModeFor(settings, 'https://news.example/')).toBe('standard')
    expect(blockModeFor({ blockMode: 'strict' }, 'https://news.example/')).toBe('strict')
    // A site set to Standard stays Standard while the general mode is Strict.
    expect(blockModeFor({ blockMode: 'strict', blockModeSites: { 'news.example': 'standard' } }, 'https://news.example/')).toBe('standard')
  })
})

describe('cleanBlockingSettings', () => {
  const settings = defaultSettings()

  it('keeps what is valid', () => {
    const valid = { ...settings, blockCosmetic: false, filterUpdateDays: 7, disabledFilterLists: ['easylist'], blockExceptions: ['exemple.org'], popupExceptions: ['exemple.net'], blockMode: 'strict' as const }
    expect(cleanBlockingSettings(valid)).toEqual({ blockCosmetic: false, filterUpdateDays: 7, disabledFilterLists: ['easylist'], blockExceptions: ['exemple.org'], popupExceptions: ['exemple.net'], blockMode: 'strict', blockModeSites: {} })
  })

  it('falls back to the defaults for a file written by an older build or edited by hand', () => {
    const broken = { ...settings, blockCosmetic: 'oui', filterUpdateDays: 0, disabledFilterLists: 'easylist', blockExceptions: 'x', popupExceptions: 'y', blockMode: 'agressif' } as unknown as typeof settings
    expect(cleanBlockingSettings(broken)).toEqual({ blockCosmetic: settings.blockCosmetic, filterUpdateDays: settings.filterUpdateDays, disabledFilterLists: [], blockExceptions: [], popupExceptions: [], blockMode: 'standard', blockModeSites: {} })
    const old = { ...settings } as Partial<typeof settings>
    delete old.blockExceptions
    delete old.filterUpdateDays
    delete old.popupExceptions
    expect(cleanBlockingSettings(old as typeof settings)).toMatchObject({ blockExceptions: [], popupExceptions: [], filterUpdateDays: settings.filterUpdateDays })
  })

  it('refuses a delay that is not a whole number of days between 1 and 90', () => {
    for (const bad of [0, -3, 1.5, 91, Number.NaN, '4']) {
      expect(cleanBlockingSettings({ ...settings, filterUpdateDays: bad as unknown as number }).filterUpdateDays).toBe(settings.filterUpdateDays)
    }
    expect(cleanBlockingSettings({ ...settings, filterUpdateDays: 90 }).filterUpdateDays).toBe(90)
    // "Tous les jours" is one of the choices of the settings: it is kept, not read back as the default.
    expect(cleanBlockingSettings({ ...settings, filterUpdateDays: 1 }).filterUpdateDays).toBe(1)
  })

  it('drops list ids that are not plain names, and repeats', () => {
    const cleaned = cleanBlockingSettings({ ...settings, disabledFilterLists: ['easylist', 'easylist', '../x', 7, 'ublock-unbreak'] as unknown as string[] })
    expect(cleaned.disabledFilterLists).toEqual(['easylist', 'ublock-unbreak'])
  })
})

describe('safeRedirectTarget', () => {
  it('accepts a web address and the addresses of the stand-in resources', () => {
    for (const target of ['https://a.example/p?x=1', 'http://a.example/', ...redirectResourceNames().map((name) => redirectTargetOf(name)!)]) {
      expect(safeRedirectTarget(target), target.slice(0, 60)).toBe(target)
    }
  })

  it('refuses everything else: other schemes, other data types, control characters, a huge text, a value that is not text', () => {
    for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome-extension://abc/x.js', 'data:text/html;base64,PHNjcmlwdD4=x', 'data:text/javascript;charset=utf-8,alert(1)', 'data:image/svg+xml,<svg/>', 'lucium-stand-in://resource/unknown.js', 'lucium-stand-in://resource/noop.js?x=1', 'lucium-stand-in://abc123/noop.js', 'ftp://a.example/', '//a.example/', 'https://', 'https://a.example/\nSet-Cookie: x', '', `data:text/plain,${'a'.repeat(REDIRECT_MAX_CHARS)}`]) {
      expect(safeRedirectTarget(target), target.slice(0, 40)).toBeNull()
    }
    for (const target of [undefined, null, 5, {}, ['https://a.example/']]) expect(safeRedirectTarget(target)).toBeNull()
  })

  it('takes a web address up to REDIRECT_MAX_CHARS, and not one character more', () => {
    const at = (length: number) => `https://a.example/?q=${'a'.repeat(length - 'https://a.example/?q='.length)}`
    expect(safeRedirectTarget(at(REDIRECT_MAX_CHARS))).toBe(at(REDIRECT_MAX_CHARS))
    expect(safeRedirectTarget(at(REDIRECT_MAX_CHARS + 1))).toBeNull()
  })
})

describe('withContentSecurityPolicy', () => {
  it('adds the policy as a header of its own, or next to the one the server sent, whatever its spelling', () => {
    expect(withContentSecurityPolicy({ 'Content-Type': ['text/html'] }, "script-src 'none'")).toEqual({ 'Content-Type': ['text/html'], 'Content-Security-Policy': ["script-src 'none'"] })
    expect(withContentSecurityPolicy({ 'content-security-policy': ["default-src 'self'"] }, "script-src 'none'")).toEqual({ 'content-security-policy': ["default-src 'self'", "script-src 'none'"] })
  })

  it('does not touch the headers it was given, and returns them as they were when there is nothing to add', () => {
    const headers = { 'Content-Security-Policy': ["default-src 'self'"] }
    withContentSecurityPolicy(headers, "script-src 'none'")
    expect(headers).toEqual({ 'Content-Security-Policy': ["default-src 'self'"] })
    expect(withContentSecurityPolicy(headers, null)).toBe(headers)
    expect(withContentSecurityPolicy(headers, '')).toBe(headers)
  })
})

// The gate of the blocker: the ads and trackers switch (`blockAds` or its alias `blockTrackers`) and the cookie switch. Every place that decides
// whether the blocker filters (request filter, engine set-up, cosmetic hiding, guard, counters, panels) reads these, so they are pinned for every combination.
describe('the gate of the blocker: which switch filters what', () => {
  const combinations = [false, true].flatMap((blockAds) => [false, true].flatMap((blockTrackers) => [false, true].map((blockCookieBanners) => ({ blockAds, blockTrackers, blockCookieBanners }))))

  it.each(combinations)('blockAds $blockAds, blockTrackers $blockTrackers, banners $blockCookieBanners: the ads and trackers lists apply when either of the pair is on, the whole blocker when anything is', (settings) => {
    expect(adsBlockingOn(settings)).toBe(settings.blockAds || settings.blockTrackers)
    expect(blockerIsOn(settings)).toBe(settings.blockAds || settings.blockTrackers || settings.blockCookieBanners)
  })

  it('reads the alias on its own: an older state file that holds only blockTrackers, and a settings object without it', () => {
    expect(adsBlockingOn({ blockAds: false, blockTrackers: true })).toBe(true)
    expect(blockerIsOn({ blockAds: false, blockTrackers: true, blockCookieBanners: false })).toBe(true)
    expect(adsBlockingOn({ blockAds: false })).toBe(false)
    expect(blockerIsOn({ blockAds: false, blockCookieBanners: false })).toBe(false)
    expect(blockerIsOn({ blockAds: false, blockCookieBanners: true })).toBe(true)
  })

  it('has the default settings on, and the one patch of the switch writes the pair together so that off is off', () => {
    expect(adsBlockingOn(defaultSettings())).toBe(true)
    expect(adsBlockingPatch(false)).toEqual({ blockAds: false, blockTrackers: false })
    expect(adsBlockingPatch(true)).toEqual({ blockAds: true, blockTrackers: true })
    expect(blockerIsOn({ ...defaultSettings(), ...adsBlockingPatch(false), blockCookieBanners: false })).toBe(false)
  })
})
