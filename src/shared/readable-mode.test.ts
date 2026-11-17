import { describe, expect, it } from 'vitest'
import { defaultSettings } from './model'
import {
  DEFAULT_READABLE,
  READABLE_DEFAULTS,
  READABLE_LABELS,
  READABLE_MODES,
  SITE_READABLE_MAX,
  cleanReadableDefault,
  cleanReadableSettings,
  cleanSiteReadable,
  isReadableWebPage,
  newSiteMode,
  readableFollowsSystem,
  readableButtonMode,
  readableFromForcedDark,
  readableInUse,
  readableModeFor,
  readableToggle,
  READABLE_NEXT,
  siteReadableOf,
  takesReadableMode,
  withSiteReadable,
  type ReadableDefault,
  type ReadableMode
} from './readable-mode'
import { categoryResetPlan, isResettable } from './settings-catalog'
import { createInitialState, normalize, reduce, type Ctx } from './sidebar'
import { createPrivateState, inheritedSettings, privateAction } from './private-window'
import type { SidebarState } from './model'

const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `id${++n}` })() }
const choice = (readableMode: ReadableDefault, siteReadableMode: Record<string, ReadableMode> = {}) => ({ readableMode, siteReadableMode })

describe('the readable mode is off unless asked for', () => {
  it('defaults to Original everywhere, with no site of its own', () => {
    const s = defaultSettings()
    expect([s.readableMode, s.siteReadableMode, DEFAULT_READABLE]).toEqual(['original', {}, 'original'])
  })

  it('names every choice in both languages’ catalogue, with a sentence under it', () => {
    for (const value of READABLE_DEFAULTS) {
      expect(READABLE_LABELS[value].name.length, value).toBeGreaterThan(2)
      expect(READABLE_LABELS[value].hint, value).toMatch(/\.$/)
    }
    expect(READABLE_DEFAULTS.map((value) => READABLE_LABELS[value].name)).toEqual(['Original', 'Sombre', 'Clair', 'Automatique'])
  })

  it('gives nothing to any page while every site is on Original, whatever the interface', () => {
    for (const systemDark of [true, false]) expect(readableModeFor(choice('original'), 'https://example.org/', systemDark)).toBe('original')
    expect(readableInUse(choice('original'))).toBe(false)
    expect(readableInUse(choice('original', { 'a.example': 'original' }))).toBe(false)
  })

  it('is in use as soon as the default or one site is something else', () => {
    for (const value of ['dark', 'light', 'auto'] as const) expect(readableInUse(choice(value)), value).toBe(true)
    expect(readableInUse(choice('original', { 'a.example': 'dark' }))).toBe(true)
    expect(readableInUse(choice('original', { 'a.example': 'original', 'b.example': 'light' }))).toBe(true)
  })
})

describe('the mode a page gets, by default and by site, and by the appearance of the interface', () => {
  const page = 'https://example.org/article'
  const modeOf = (settings: ReturnType<typeof choice>, url = page, systemDark = true) => readableModeFor(settings, url, systemDark)

  it('is the default for a site with no choice: Original, Dark or Light, whatever the interface says', () => {
    for (const systemDark of [true, false]) {
      expect(modeOf(choice('original'), page, systemDark)).toBe('original')
      expect(modeOf(choice('dark'), page, systemDark)).toBe('dark')
      expect(modeOf(choice('light'), page, systemDark)).toBe('light')
    }
  })

  // The old « seulement quand l’apparence est sombre »: Dark while the interface is dark, and nothing while it is light (a dark site is not lightened).
  it('follows the interface with the default "auto": Dark while it is dark, Original while it is light', () => {
    expect(modeOf(choice('auto'), page, true)).toBe('dark')
    expect(modeOf(choice('auto'), page, false)).toBe('original')
    expect(readableFollowsSystem(choice('auto'))).toBe(true)
    for (const value of ['original', 'dark', 'light'] as const) expect(readableFollowsSystem(choice(value)), value).toBe(false)
  })

  it('gives a site its own choice over the default, in every combination', () => {
    for (const systemDark of [true, false]) {
      for (const base of READABLE_DEFAULTS) {
        for (const own of READABLE_MODES) expect(modeOf(choice(base, { 'example.org': own }), page, systemDark), `${base} + ${own} (system dark: ${systemDark})`).toBe(own)
      }
    }
  })

  it('does not make a choice of the site follow the interface: a site set to Dark is Dark in a light interface too', () => {
    expect(modeOf(choice('auto', { 'example.org': 'dark' }), page, false)).toBe('dark')
    expect(modeOf(choice('auto', { 'example.org': 'light' }), page, true)).toBe('light')
  })

  it('covers the subdomains of a site and the www form, not its look-alikes, and the nearest choice wins', () => {
    const banque = choice('dark', { 'banque.example': 'original' })
    expect(modeOf(banque, 'https://banque.example/compte')).toBe('original')
    expect(modeOf(banque, 'https://www.banque.example/')).toBe('original')
    expect(modeOf(banque, 'https://espace.banque.example/')).toBe('original')
    expect(modeOf(banque, 'https://mabanque.example/')).toBe('dark')
    expect(modeOf(banque, 'https://banque.example.evil.org/')).toBe('dark')
    const nested = choice('original', { 'example.com': 'dark', 'music.example.com': 'light' })
    expect(modeOf(nested, 'https://music.example.com/')).toBe('light')
    expect(modeOf(nested, 'https://deep.music.example.com/')).toBe('light')
    expect(modeOf(nested, 'https://mail.example.com/')).toBe('dark')
    expect(modeOf(nested, 'https://example.com/')).toBe('dark')
  })

  it('only touches web pages: not the interface’s own pages, files, PDFs or garbage, even with a site set to Dark', () => {
    const everything = choice('dark', { 'example.org': 'light' })
    for (const url of ['file:///tmp/a.html', 'about:blank', 'view-source:https://example.org/', 'chrome-extension://abc/page.html', 'https://example.org/rapport.PDF', 'not a url', '', null, undefined]) {
      expect(readableModeFor(everything, url, true), String(url)).toBe('original')
    }
    expect(modeOf(everything, 'http://localhost:3000/pdf')).toBe('dark')
    expect(isReadableWebPage('https://example.org/')).toBe(true)
    expect(isReadableWebPage('ftp://example.org/')).toBe(false)
  })
})

describe('the mode of a site added by hand', () => {
  it('is the opposite of the default: Sombre where sites are left as they are, Original everywhere else', () => {
    expect(newSiteMode('original')).toBe('dark')
    for (const value of ['dark', 'light', 'auto'] as const) expect(newSiteMode(value), value).toBe('original')
  })
})

describe('the per-site choices of a saved file', () => {
  it('turn a default that is not one of the four into Original', () => {
    for (const value of READABLE_DEFAULTS) expect(cleanReadableDefault(value)).toBe(value)
    for (const junk of ['Dark', 'sombre', '', 1, true, null, undefined, {}, []]) expect(cleanReadableDefault(junk), String(junk)).toBe('original')
  })

  it('are kept by host (lower case, no www, no scheme), with the three modes only', () => {
    expect(cleanSiteReadable({ 'A.com': 'dark', 'https://www.b.org/x': 'light', 'c.net': 'original' })).toEqual({ 'a.com': 'dark', 'b.org': 'light', 'c.net': 'original' })
  })

  it('drop a mode that is not one of the three — "auto" is the default’s, never a site’s — and a key that is not a host', () => {
    expect(cleanSiteReadable({ 'a.com': 'auto', 'b.com': 'sombre', 'c.com': 3, 'd.com': null, 'javascript:alert(1)': 'dark', '': 'dark', 'ok.com': 'dark' })).toEqual({ 'ok.com': 'dark' })
  })

  it('turn anything that is not a record into no choice', () => {
    for (const junk of ['nope', 3, null, undefined, [], ['a.com'], true]) expect(cleanSiteReadable(junk), String(junk)).toEqual({})
  })

  it('never let a prototype key in as a host', () => {
    const parsed = JSON.parse('{ "__proto__": "dark", "constructor": "dark", "ok.com": "light" }') as unknown
    const cleaned = cleanSiteReadable(parsed)
    expect(Object.getPrototypeOf(cleaned)).toBe(Object.prototype)
    expect(Object.hasOwn(cleaned, '__proto__')).toBe(false)
    expect(cleaned['ok.com']).toBe('light')
  })

  it('are bounded, and a site that is already there can still change at the bound', () => {
    const many = Object.fromEntries(Array.from({ length: SITE_READABLE_MAX + 30 }, (_, i) => [`h${i}.example`, 'dark']))
    const cleaned = cleanSiteReadable(many)
    expect(Object.keys(cleaned)).toHaveLength(SITE_READABLE_MAX)
    expect(withSiteReadable(cleaned, 'new.example', 'dark')).toEqual(cleaned)
    expect(withSiteReadable(cleaned, 'h3.example', 'light')['h3.example']).toBe('light')
  })

  it('go through the defaults of a file together', () => {
    expect(cleanReadableSettings({ readableMode: 'light', siteReadableMode: { 'A.com': 'dark', 'b.com': 'x' as ReadableMode } })).toEqual({ readableMode: 'light', siteReadableMode: { 'a.com': 'dark' } })
    expect(cleanReadableSettings({ readableMode: 'Dark' as ReadableDefault, siteReadableMode: 'x' as unknown as Record<string, ReadableMode> })).toEqual({ readableMode: 'original', siteReadableMode: {} })
    expect(cleanReadableSettings({})).toEqual({ readableMode: 'original', siteReadableMode: {} })
  })
})

describe('setting a site’s mode', () => {
  it('adds a site under its host, changes it, and keeps the others', () => {
    expect(withSiteReadable({}, 'https://www.Example.com/page', 'dark')).toEqual({ 'example.com': 'dark' })
    expect(withSiteReadable({ 'example.com': 'dark', 'x.org': 'light' }, 'example.com', 'original')).toEqual({ 'example.com': 'original', 'x.org': 'light' })
  })

  it('gives a site back to the default with null: its own entry and the parent domains’ that cover it, not its siblings', () => {
    const choices = { 'example.com': 'dark', 'api.example.com': 'light', 'other.example.com': 'light', 'x.org': 'dark' } as const
    expect(withSiteReadable(choices, 'api.example.com', null)).toEqual({ 'other.example.com': 'light', 'x.org': 'dark' })
    expect(withSiteReadable({ 'example.com': 'dark', 'x.org': 'dark' }, 'api.example.com', null)).toEqual({ 'x.org': 'dark' })
  })

  it('changes nothing for what is not a host or not a mode, and never touches its argument', () => {
    const choices = { 'a.com': 'dark' } as const
    expect(withSiteReadable(choices, 'not a host', 'dark')).toEqual(choices)
    expect(withSiteReadable(choices, 'b.com', 'auto')).toEqual(choices)
    expect(withSiteReadable(choices, 'b.com', 'Dark')).toEqual(choices)
    expect(withSiteReadable(choices, 'b.com', undefined)).toEqual(choices)
    withSiteReadable(choices, 'a.com', null)
    expect(choices).toEqual({ 'a.com': 'dark' })
  })

  it('finds the choice of a page: its host, else the nearest parent; own keys only', () => {
    expect(siteReadableOf({ 'example.com': 'dark' }, 'https://api.example.com/')).toBe('dark')
    expect(siteReadableOf({ 'example.com': 'dark' }, 'https://example.org/')).toBeNull()
    expect(siteReadableOf({}, 'https://constructor/')).toBeNull()
    expect(siteReadableOf(undefined, 'https://example.com/')).toBeNull()
    expect(siteReadableOf({ 'example.com': 'dark' }, null)).toBeNull()
    expect(siteReadableOf({ 'example.com': 'dark' }, 'garbage')).toBeNull()
  })
})

describe('the forced dark mode of an older file becomes the readable mode, with the same effect', () => {
  const migrate = (forceDarkSites: unknown, forceDarkOnlyWhenSystemDark: unknown, forceDarkExceptions: unknown = []) => readableFromForcedDark({ forceDarkSites, forceDarkOnlyWhenSystemDark, forceDarkExceptions })

  it('turns the switch on into Dark, and the switch on with "only when the interface is dark" into Auto', () => {
    expect(migrate(true, false).readableMode).toBe('dark')
    expect(migrate(true, true).readableMode).toBe('auto')
  })

  it('turns the switch off into Original, with or without its option (which was never read while the switch was off)', () => {
    expect(migrate(false, false).readableMode).toBe('original')
    expect(migrate(false, true).readableMode).toBe('original')
  })

  it('reads only a real true: a word or a number is no switch', () => {
    for (const junk of ['true', 'yes', 1, {}, null, undefined]) expect(migrate(junk, true).readableMode, String(junk)).toBe('original')
    for (const junk of ['true', 1, null, undefined]) expect(migrate(true, junk).readableMode, String(junk)).toBe('dark')
  })

  it('gives each excepted site its own Original, so that it keeps its colours under the default', () => {
    expect(migrate(true, false, ['banque.example', 'B.org', 'https://www.c.net/x']).siteReadableMode).toEqual({ 'banque.example': 'original', 'b.org': 'original', 'c.net': 'original' })
    expect(migrate(false, false, ['banque.example']).siteReadableMode).toEqual({ 'banque.example': 'original' })
  })

  it('cleans the exceptions like the list they came from: hosts only, each once, not a list of the wrong kind', () => {
    expect(migrate(true, false, ['a.com', 'A.com', 42, '', 'javascript:alert(1)', null, {}]).siteReadableMode).toEqual({ 'a.com': 'original' })
    for (const junk of ['x', 3, null, undefined, { 'a.com': true }]) expect(migrate(true, false, junk).siteReadableMode, String(junk)).toEqual({})
    const kept = migrate(true, false, Array.from({ length: 200 }, (_, i) => `h${i}.example`)).siteReadableMode
    expect(Object.keys(kept)).toHaveLength(200)
  })

  it('keeps the behaviour of the old settings, page by page, for every old combination', () => {
    // The old rule, written out: the switch, then the option against the interface, then the exception list.
    const oldRule = (on: boolean, onlyDark: boolean, excepted: string[], host: string, systemDark: boolean): 'dark' | 'original' => (!on || (onlyDark && !systemDark) || excepted.includes(host) ? 'original' : 'dark')
    for (const on of [true, false]) {
      for (const onlyDark of [true, false]) {
        for (const systemDark of [true, false]) {
          for (const host of ['banque.example', 'autre.example']) {
            const excepted = ['banque.example']
            const migrated = migrate(on, onlyDark, excepted)
            expect(readableModeFor(migrated, `https://${host}/`, systemDark), `${on} ${onlyDark} ${systemDark} ${host}`).toBe(oldRule(on, onlyDark, excepted, host, systemDark))
          }
        }
      }
    }
  })
})

describe('a saved file from before the readable mode', () => {
  const fresh = createInitialState(ctx)
  /** A file as the previous build wrote it: revision 1, the three settings of the forced dark mode, none of the new ones. */
  const oldFile = (revision: number | undefined, forced: Record<string, unknown>): SidebarState => {
    const { readableMode: _mode, siteReadableMode: _sites, ...settings } = fresh.settings
    const { revision: _revision, ...rest } = fresh
    return { ...rest, ...(revision === undefined ? {} : { revision }), settings: { ...settings, ...forced } } as unknown as SidebarState
  }

  it('is migrated once, at the load: the switch, the option and the exceptions become the default and the sites', () => {
    const loaded = normalize(oldFile(1, { forceDarkSites: true, forceDarkOnlyWhenSystemDark: true, forceDarkExceptions: ['banque.example'] }))
    expect([loaded.settings.readableMode, loaded.settings.siteReadableMode]).toEqual(['auto', { 'banque.example': 'original' }])
    expect(loaded.revision).toBeGreaterThanOrEqual(2)
    expect(Object.keys(loaded.settings)).not.toContain('forceDarkSites')
    expect(Object.keys(loaded.settings)).not.toContain('forceDarkOnlyWhenSystemDark')
    expect(Object.keys(loaded.settings)).not.toContain('forceDarkExceptions')
  })

  it('is migrated also when the file has no revision at all (written before revisions existed)', () => {
    const loaded = normalize(oldFile(undefined, { forceDarkSites: true, forceDarkOnlyWhenSystemDark: false, forceDarkExceptions: [] }))
    expect([loaded.settings.readableMode, loaded.settings.siteReadableMode]).toEqual(['dark', {}])
  })

  it('stays off for a file whose switch was off, and keeps the exceptions it held (they only matter once a default is chosen)', () => {
    const loaded = normalize(oldFile(1, { forceDarkSites: false, forceDarkOnlyWhenSystemDark: false, forceDarkExceptions: ['banque.example'] }))
    expect([loaded.settings.readableMode, loaded.settings.siteReadableMode]).toEqual(['original', { 'banque.example': 'original' }])
  })

  it('keeps what a file of an earlier revision says of the readable mode when it holds none of the old settings (nothing to carry over, so nothing is overwritten)', () => {
    const { revision: _revision, ...rest } = fresh
    const mixed = { ...rest, revision: 1, settings: { ...fresh.settings, readableMode: 'light', siteReadableMode: { 'a.example': 'dark' } } } as unknown as SidebarState
    const loaded = normalize(mixed)
    expect([loaded.settings.readableMode, loaded.settings.siteReadableMode]).toEqual(['light', { 'a.example': 'dark' }])
  })

  it('gets the defaults when it held none of the three', () => {
    const loaded = normalize(oldFile(1, {}))
    expect([loaded.settings.readableMode, loaded.settings.siteReadableMode]).toEqual(['original', {}])
  })

  it('is not migrated again: a file already at this revision keeps what the user chose since, and the old keys it still holds are dropped', () => {
    const current = oldFile(2, { forceDarkSites: true, forceDarkExceptions: ['banque.example'] })
    const loaded = normalize({ ...current, settings: { ...current.settings, readableMode: 'light', siteReadableMode: { 'a.example': 'dark' } } } as SidebarState)
    expect([loaded.settings.readableMode, loaded.settings.siteReadableMode]).toEqual(['light', { 'a.example': 'dark' }])
    // …and a file at this revision with only the old keys has nothing to migrate from: they were dropped when it was saved.
    const bare = normalize(oldFile(2, { forceDarkSites: true }))
    expect(bare.settings.readableMode).toBe('original')
  })

  it('is loaded as it is saved, over and over, without drift', () => {
    const once = normalize(oldFile(1, { forceDarkSites: true, forceDarkOnlyWhenSystemDark: true, forceDarkExceptions: ['b.example', 'a.example'] }))
    expect(normalize(JSON.parse(JSON.stringify(once)) as SidebarState)).toEqual(once)
  })
})

describe('the readable mode in the state', () => {
  const start = createInitialState(ctx)
  const withTab = (url: string, extra: Partial<SidebarState['tabs'][number]> = {}) => reduce(start, { type: 'tab/open', url, ...(extra.private === true ? { private: true } : {}) }, ctx)
  const act = (state: SidebarState, mode: ReadableMode | null, site = 'https://www.example.com/page', tabId?: string) => reduce(state, { type: 'readable/site', site, mode, ...(tabId ? { tabId } : {}) }, ctx)

  it('keeps a site’s choice under its host, changes it, and gives it back to the default', () => {
    const dark = act(start, 'dark')
    expect(dark.settings.siteReadableMode).toEqual({ 'example.com': 'dark' })
    expect(act(dark, 'light', 'example.com').settings.siteReadableMode).toEqual({ 'example.com': 'light' })
    expect(act(dark, null, 'example.com').settings.siteReadableMode).toEqual({})
  })

  it('returns the very same state for a choice that changes nothing', () => {
    const dark = act(start, 'dark')
    expect(act(dark, 'dark', 'example.com')).toBe(dark)
    expect(act(start, null, 'example.com')).toBe(start)
    expect(act(start, 'dark', 'pas un hôte')).toBe(start)
    expect(reduce(start, { type: 'readable/site', site: 'example.com', mode: 'auto' as unknown as ReadableMode }, ctx)).toBe(start)
  })

  it('refuses a choice made from a private tab: its site is not written to the settings', () => {
    const priv = withTab('https://www.example.com/page', { private: true })
    const tabId = priv.tabs[0]!.id
    expect(priv.tabs[0]!.private).toBe(true)
    expect(act(priv, 'dark', 'https://www.example.com/page', tabId)).toBe(priv)
    // …while a normal tab, or no tab at all, is let through.
    const normal = withTab('https://www.example.com/page')
    expect(act(normal, 'dark', 'https://www.example.com/page', normal.tabs[0]!.id).settings.siteReadableMode).toEqual({ 'example.com': 'dark' })
  })

  it('cleans the settings it is given through an update, and when a file is loaded', () => {
    const updated = reduce(start, { type: 'settings/update', patch: { readableMode: 'light', siteReadableMode: { 'B.org': 'dark', 'b.org': 'light', 'oops!!': 'dark', 'c.org': 'sombre' as ReadableMode } } }, ctx)
    expect(updated.settings.readableMode).toBe('light')
    expect(updated.settings.siteReadableMode).toEqual({ 'b.org': 'light' })
    const loaded = normalize({ ...start, settings: { ...start.settings, readableMode: 'on' as unknown as ReadableDefault } })
    expect(loaded.settings.readableMode).toBe('original')
  })
})

describe('the readable mode and "Rétablir"', () => {
  it('puts the default back to Original but never empties the list of sites, which the user built', () => {
    expect(isResettable('readableMode')).toBe(true)
    expect(isResettable('siteReadableMode')).toBe(false)
    const settings = { ...defaultSettings(), readableMode: 'dark' as const, siteReadableMode: { 'banque.example': 'original' as const } }
    const plan = categoryResetPlan('appearance', settings)
    expect(plan?.patch.readableMode).toBe('original')
    expect(plan?.keys).not.toContain('siteReadableMode')
    expect(Object.keys(plan?.patch ?? {})).not.toContain('siteReadableMode')
  })
})

describe('the readable mode and the private window', () => {
  it('refuses a site’s choice and a change of the settings made in a private window: it follows the main window', () => {
    expect(privateAction({ type: 'readable/site', site: 'example.org', mode: 'dark' })).toBeNull()
    expect(privateAction({ type: 'settings/update', patch: { readableMode: 'dark' } })).toBeNull()
    expect(privateAction({ type: 'settings/update', patch: { siteReadableMode: { 'example.org': 'dark' } } })).toBeNull()
  })

  it('starts with the main window’s mode and sites, and follows them', () => {
    const main = reduce(createInitialState(ctx), { type: 'settings/update', patch: { readableMode: 'light', siteReadableMode: { 'example.org': 'dark' } } }, ctx)
    const started = createPrivateState(main, ctx)
    expect([started.settings.readableMode, started.settings.siteReadableMode]).toEqual(['light', { 'example.org': 'dark' }])
    expect(inheritedSettings(main.settings)).toMatchObject({ readableMode: 'light', siteReadableMode: { 'example.org': 'dark' } })
  })
})

describe('the button « Contraste de la page » of the toolbar', () => {
  const page = { url: 'https://example.org/article' }
  const settings = (readableMode: ReadableDefault, siteReadableMode: Record<string, ReadableMode> = {}, readableToolbarButton = true) => ({ readableMode, siteReadableMode, readableToolbarButton })
  const modeOf = (config: ReturnType<typeof settings>, tab: Parameters<typeof readableButtonMode>[1] = page, privateWindow = false, systemDark = true) => readableButtonMode(config, tab, privateWindow, systemDark)

  it('is on by default', () => {
    expect(defaultSettings().readableToolbarButton).toBe(true)
  })

  it('shows the mode the page has: its site’s own choice over the default, the default of a site with none', () => {
    expect(modeOf(settings('original'))).toBe('original')
    expect(modeOf(settings('dark'))).toBe('dark')
    expect(modeOf(settings('light'))).toBe('light')
    expect(modeOf(settings('original', { 'example.org': 'dark' }))).toBe('dark')
    expect(modeOf(settings('dark', { 'example.org': 'original' }))).toBe('original')
    expect(modeOf(settings('dark', { 'example.org': 'light' }), { url: 'https://www.example.org/' })).toBe('light')
    expect(modeOf(settings('dark', { 'other.org': 'light' }))).toBe('dark')
  })

  it('shows what Automatic comes to: Dark while the interface is dark, Original while it is light', () => {
    expect(modeOf(settings('auto'), page, false, true)).toBe('dark')
    expect(modeOf(settings('auto'), page, false, false)).toBe('original')
    expect(modeOf(settings('auto', { 'example.org': 'light' }), page, false, true)).toBe('light')
  })

  it('is hidden by its own setting, whatever the page and the modes', () => {
    expect(modeOf(settings('dark', { 'example.org': 'light' }, false))).toBeNull()
    expect(modeOf(settings('original', {}, false))).toBeNull()
  })

  it('is not there in a private window', () => {
    expect(modeOf(settings('dark'), page, true)).toBeNull()
  })

  it('is not there for a private tab, nor with no tab', () => {
    expect(modeOf(settings('dark'), { url: 'https://example.org/', private: true })).toBeNull()
    expect(modeOf(settings('dark'), { url: 'https://example.org/', private: false })).toBe('dark')
    expect(readableButtonMode(settings('dark'), undefined, false, true)).toBeNull()
  })

  it('is only there for a web page that is not a PDF: not the interface’s pages, files, garbage, nor a PDF', () => {
    for (const url of ['about:blank', 'file:///tmp/a.html', 'chrome-extension://abc/page.html', 'view-source:https://example.org/', 'not a url', '', 'https://example.org/rapport.pdf', 'https://example.org/Rapport.PDF']) {
      expect(modeOf(settings('dark'), { url }), url).toBeNull()
    }
    expect(modeOf(settings('dark'), { url: 'http://localhost:3000/pdf' })).toBe('dark')
    // The path decides, as it does for the mode itself: a PDF with a query is a PDF, and a page whose query mentions a PDF is a page.
    expect(modeOf(settings('dark'), { url: 'https://example.org/doc.pdf?page=2' })).toBeNull()
    expect(modeOf(settings('dark'), { url: 'https://example.org/viewer?file=doc.pdf' })).toBe('dark')
  })

  it('asks for the same pages as the mode itself: a page that takes no mode gets none, and the others are told alike', () => {
    expect(takesReadableMode('https://example.org/')).toBe(true)
    expect(takesReadableMode('https://example.org/a.pdf')).toBe(false)
    expect(takesReadableMode('about:blank')).toBe(false)
    expect(takesReadableMode(undefined)).toBe(false)
    expect(takesReadableMode(null)).toBe(false)
  })
})

describe('what a click on the toolbar button sets', () => {
  const page = 'https://example.org/article'
  /** The site entries are keyed by host. */
  const toggle = (readableMode: ReadableDefault, siteReadableMode: Record<string, ReadableMode>, url = page, systemDark = false) => readableToggle(choice(readableMode, siteReadableMode), url, systemDark)

  it('moves a page through the three modes in turn: Original, Dark, Light, then Original again', () => {
    expect(READABLE_NEXT).toEqual({ original: 'dark', dark: 'light', light: 'original' })
    expect(toggle('original', {})).toEqual({ mode: 'dark' })
    expect(toggle('original', { 'example.org': 'dark' })).toEqual({ mode: 'light' })
    expect(toggle('original', { 'example.org': 'light' })).toEqual({ mode: null })
  })

  it('takes the site’s own entry out, rather than writing what the default says', () => {
    expect(toggle('original', { 'example.org': 'light' })).toEqual({ mode: null })
    expect(toggle('dark', { 'example.org': 'original' })).toEqual({ mode: null })
    expect(toggle('light', { 'example.org': 'dark' })).toEqual({ mode: null })
    // Automatic is Original in a light interface and Dark in a dark one.
    expect(toggle('auto', { 'example.org': 'light' }, page, false)).toEqual({ mode: null })
    expect(toggle('auto', { 'example.org': 'original' }, page, true)).toEqual({ mode: null })
    // Not when the default gives another mode: the site then gets its own.
    expect(toggle('dark', { 'example.org': 'light' })).toEqual({ mode: 'original' })
    expect(toggle('light', { 'example.org': 'original' })).toEqual({ mode: 'dark' })
  })

  it('starts from the default for a site with no entry, Automatic by the appearance of the interface', () => {
    expect(toggle('dark', {})).toEqual({ mode: 'light' })
    expect(toggle('light', {})).toEqual({ mode: 'original' })
    expect(toggle('auto', {}, page, true)).toEqual({ mode: 'light' })
    expect(toggle('auto', {}, page, false)).toEqual({ mode: 'dark' })
  })

  it('reads a site by its host as the entries are keyed: www and the case of the address do not matter', () => {
    expect(toggle('original', { 'example.org': 'light' }, 'https://www.example.org/')).toEqual({ mode: null })
    expect(toggle('original', { 'example.org': 'light' }, 'https://WWW.Example.ORG/Page')).toEqual({ mode: null })
  })

  it('does not take out the entry of a parent domain, which covers other sites: the subdomain gets a mode of its own', () => {
    expect(toggle('original', { 'example.org': 'light' }, 'https://blog.example.org/')).toEqual({ mode: 'original' })
    // Two entries cover it, its own and its parent’s: taking its own out would let the parent’s back in.
    expect(toggle('original', { 'blog.example.org': 'light', 'example.org': 'dark' }, 'https://blog.example.org/')).toEqual({ mode: 'original' })
    // An entry of a look-alike or of a child does not cover it.
    expect(toggle('original', { 'blog.example.org': 'dark', 'xexample.org': 'light', 'example.org': 'light' }, page)).toEqual({ mode: null })
    // A host that merely ends with the domain (“myexample.org” and “example.org”) is not under it: its own entry is the only one that covers it.
    expect(toggle('original', { 'myexample.org': 'light', 'example.org': 'dark' }, 'https://myexample.org/')).toEqual({ mode: null })
  })

  it('does nothing for a page that takes no mode: not a web page, a PDF, garbage', () => {
    for (const url of ['about:blank', 'file:///tmp/a.html', 'view-source:https://example.org/', 'https://example.org/rapport.pdf', 'not a url', '', null, undefined]) {
      expect(readableToggle(choice('dark', { 'example.org': 'light' }), url, false), String(url)).toBeNull()
    }
  })

  // What the click is for, whatever the settings: the page ends in the next mode, and the list holds no entry that only says what the default says.
  it('always leaves the page in the next mode, with no entry the default says already', () => {
    const entries: Array<Record<string, ReadableMode>> = [{}, { 'example.org': 'original' }, { 'example.org': 'dark' }, { 'example.org': 'light' }]
    for (const readableMode of READABLE_DEFAULTS) {
      for (const own of entries) {
        for (const systemDark of [true, false]) {
          const settings = choice(readableMode, own)
          const expected = READABLE_NEXT[readableModeFor(settings, page, systemDark)]
          const result = readableToggle(settings, page, systemDark)
          const label = `${readableMode} + ${JSON.stringify(own)}, interface ${systemDark ? 'dark' : 'light'}`
          expect(result, label).not.toBeNull()
          const after = choice(readableMode, withSiteReadable(own, 'example.org', result!.mode))
          expect(readableModeFor(after, page, systemDark), label).toBe(expected)
          // No entry that equals the default: either the entry is gone, or it says something the default does not.
          const byDefault = readableModeFor(choice(readableMode, {}), page, systemDark)
          expect(after.siteReadableMode['example.org'], label).not.toBe(byDefault)
          if (result!.mode === null) expect(byDefault, label).toBe(expected)
        }
      }
    }
  })
})
