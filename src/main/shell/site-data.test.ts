import { describe, expect, it, vi } from 'vitest'
import { SITE_DATA_TYPES, allSitesCleared, normalizeSiteDataPrefs, quickClearRequest, type SiteDataBatchRequest, type SiteDataRequest, type SiteDataResult, type SiteDataSiteResult } from '@shared/site-data'
import { OVERLAY_DONE_MS, OVERLAY_FADE_MS, OVERLAY_LOADER_MIN_MS, SITE_DATA_ANIMATION_LABELS, SITE_DATA_ANIMATIONS, clearingOverlayScript, type SiteDataAnimation } from '@shared/site-data-overlay'
import type { SiteDataEngineRequest } from '../engine/types'
import { RELOAD_AFTER_ANSWER_MS, animationPageOf, clearSiteFor, clearSitesFor, clearSitesWithAnimation, runAndTell, withPageAnimation, type RunReport, type RunStage, type SiteDataEnvironment } from './site-data'
import { frenchSpaces } from '@shared/french-typography'

const okAll = (request: SiteDataEngineRequest): SiteDataResult[] => request.types.map((type) => ({ type, ok: true }))

function environment(over: Partial<{ clear: SiteDataEnvironment['clear']; tabs: SiteDataEnvironment['tabs']; activeUrl: string | null; hosts: string[]; removed: number; closedPages: SiteDataEnvironment['closedPages'] }> = {}) {
  const engine: SiteDataEngineRequest[] = []
  const scripts: string[] = []
  const navigation: string[] = []
  const history: Array<[string, boolean]> = []
  const closedPages: Array<[string, boolean]> = []
  const visits: Array<[string, boolean]> = []
  const env: SiteDataEnvironment = {
    clear: over.clear ?? (async (request) => {
      engine.push(request)
      return okAll(request)
    }),
    history: {
      removeSite: (host, subdomains) => {
        history.push([host, subdomains])
        return over.removed ?? 0
      },
      hosts: () => over.hosts ?? []
    },
    closedPages: over.closedPages ?? { removeSite: (host, subdomains) => void closedPages.push([host, subdomains]) },
    visits: { forgetSite: (host, subdomains) => void visits.push([host, subdomains]) },
    tabs: over.tabs ?? [],
    active: over.activeUrl ? { url: over.activeUrl, page: { reload: () => navigation.push('reload'), loadURL: (url) => navigation.push(`load ${url}`) } } : null
  }
  return { env, engine, scripts, navigation, history, closedPages, visits }
}

const request = (over: Partial<SiteDataRequest> = {}): SiteDataRequest => ({ host: 'example.com', types: [...SITE_DATA_TYPES], subdomains: false, http: true, reload: false, ...over })
const tab = (url: string, evaluate = async (_js: string) => 0) => ({ url, page: { evaluate } })

describe('clearSiteFor', () => {
  it('asks the engine for the engine types only, on the https and http origins of the site, and answers every type in order', async () => {
    const { env, engine } = environment()
    const results = await clearSiteFor(env, request())
    expect(engine).toEqual([
      { origins: ['https://example.com', 'http://example.com'], host: 'example.com', subdomains: false, types: ['cache', 'cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'cacheStorage'] }
    ])
    expect(results.map((r) => r.type)).toEqual([...SITE_DATA_TYPES])
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('shows the line the engine answers for the licences of protected video, after the types asked, and counts its failure (this fails if the line is dropped)', async () => {
    const withLicences = (ok: boolean): SiteDataEnvironment['clear'] => async (asked) => [...okAll(asked), { type: 'mediaLicenses', ok, ...(ok ? {} : { error: 'storage busy' }) }]
    const erased = await clearSiteFor(environment({ clear: withLicences(true) }).env, request())
    expect(erased.map((r) => r.type)).toEqual([...SITE_DATA_TYPES, 'mediaLicenses'])
    const { env, navigation } = environment({ clear: withLicences(false), activeUrl: 'https://example.com/deep' })
    const kept = await clearSiteFor(env, request({ reload: true }))
    expect(kept.at(-1)).toEqual({ type: 'mediaLicenses', ok: false, error: 'storage busy' })
    // A failure of the licences is a failure of the run: the tab stays where the user can read it.
    expect(navigation).toEqual([])
  })

  it('shows the line the engine answers for the subdomains that hold storage, last, and a list that could not be read keeps the tab where it is', async () => {
    const withSubdomains = (line: object): SiteDataEnvironment['clear'] => async (asked) => [...okAll(asked), { type: 'mediaLicenses', ok: true }, { type: 'subdomains', ...line } as never]
    const found = await clearSiteFor(environment({ clear: withSubdomains({ ok: true, count: 2 }) }).env, request({ subdomains: true }))
    expect(found.map((r) => r.type)).toEqual([...SITE_DATA_TYPES, 'mediaLicenses', 'subdomains'])
    expect(found.at(-1)).toEqual({ type: 'subdomains', ok: true, count: 2 })
    const { env, navigation } = environment({ clear: withSubdomains({ ok: false, error: 'unread' }), activeUrl: 'https://example.com/deep' })
    const partial = await clearSiteFor(env, request({ subdomains: true, reload: true }))
    expect(partial.at(-1)).toEqual({ type: 'subdomains', ok: false, error: 'unread' })
    expect(navigation).toEqual([])
  })

  it('forgets the translations of the session with the data of a site, whatever is erased', async () => {
    const { sessionTranslations } = await import('../translate/memory')
    sessionTranslations.set('https://example.com\u0001bergamot:fr-en@1', 'Bonjour', 'Hello')
    await clearSiteFor(environment().env, request({ types: ['cookies'] }))
    expect(sessionTranslations.size).toBe(0)
  })

  it('refuses an invalid host without touching the engine, the pages or the history', async () => {
    const { env, engine, history } = environment({ tabs: [tab('https://example.com/')] })
    await expect(clearSiteFor(env, request({ host: 'example.com/../x' }))).rejects.toThrow(/Invalid site/)
    expect(engine).toEqual([])
    expect(history).toEqual([])
  })

  it('does not call the engine when no engine type is asked for', async () => {
    const { env, engine } = environment({ removed: 4 })
    const results = await clearSiteFor(env, request({ types: ['history'] }))
    expect(engine).toEqual([])
    expect(results).toEqual([{ type: 'history', ok: true, count: 4 }])
  })

  it('forgets the history of the site only when asked', async () => {
    const without = environment()
    await clearSiteFor(without.env, request({ types: ['cookies'] }))
    expect(without.history).toEqual([])
    const withHistory = environment()
    await clearSiteFor(withHistory.env, request({ types: ['history'], subdomains: true }))
    expect(withHistory.history).toEqual([['example.com', true]])
  })

  it('takes the pages of the site out of the Back lists of the closed tabs with its history, for the same site and subdomains, and not otherwise (F11)', async () => {
    const without = environment()
    await clearSiteFor(without.env, request({ types: ['cookies', 'localStorage', 'cache'] }))
    expect(without.closedPages).toEqual([])
    const withHistory = environment()
    await clearSiteFor(withHistory.env, request({ types: ['history'], subdomains: true }))
    expect(withHistory.closedPages).toEqual([['example.com', true]])
    const plain = environment()
    await clearSiteFor(plain.env, request({ types: ['history'] }))
    expect(plain.closedPages).toEqual([['example.com', false]])
  })

  it('does it once for each site of a batch, with that site’s host', async () => {
    const { env, closedPages } = environment()
    await clearSitesFor(env, { hosts: ['a.example', 'b.example'], types: ['history'], subdomains: false, http: true, reload: false, detached: false })
    expect(closedPages.map(([host]) => host)).toEqual(['a.example', 'b.example'])
  })

  it('tells the history was not fully erased when the Back lists of the closed tabs could not be, and the visits are forgotten all the same', async () => {
    const { env, history } = environment({
      closedPages: {
        removeSite: () => {
          throw new Error('copies unreadable')
        }
      }
    })
    const results = await clearSiteFor(env, request({ types: ['history'] }))
    expect(history).toEqual([['example.com', false]])
    expect(results).toEqual([{ type: 'history', ok: false, error: 'copies unreadable' }])
  })

  it('forgets the day of last visit of the site with its history, and only when the history is asked for (this fails if the call is dropped)', async () => {
    const withHistory = environment()
    await clearSiteFor(withHistory.env, request({ types: ['history'], subdomains: true }))
    expect(withHistory.visits).toEqual([['example.com', true]])
    const without = environment()
    await clearSiteFor(without.env, request({ types: ['cookies'] }))
    expect(without.visits).toEqual([])
  })

  it('still takes the pages out of the Back lists when the visit history could not be erased', async () => {
    const { env, closedPages } = environment()
    env.history.removeSite = () => {
      throw new Error('history locked')
    }
    const results = await clearSiteFor(env, request({ types: ['history'] }))
    expect(closedPages).toEqual([['example.com', false]])
    expect(results).toEqual([{ type: 'history', ok: false, error: 'history locked' }])
  })

  it('empties sessionStorage in the open tabs that are on the site, and only those', async () => {
    const ran: string[] = []
    const run = (name: string, count: number) => async (js: string) => {
      ran.push(name)
      expect(js).toContain('https://example.com')
      return count
    }
    const { env } = environment({
      tabs: [tab('https://example.com/a', run('a', 2)), tab('http://example.com/b', run('b', 1)), tab('https://www.example.com/', run('sub', 9)), tab('https://other.org/', run('other', 9)), tab('about:blank', run('blank', 9))]
    })
    const results = await clearSiteFor(env, request({ types: ['sessionStorage'] }))
    expect(ran).toEqual(['a', 'b'])
    expect(results).toEqual([{ type: 'sessionStorage', ok: true, count: 3 }])
  })

  it('leaves the pages alone when sessionStorage is not ticked', async () => {
    let touched = 0
    const { env } = environment({ tabs: [tab('https://example.com/', async () => (touched++, 1))] })
    const results = await clearSiteFor(env, request({ types: ['cookies', 'localStorage'] }))
    expect(touched).toBe(0)
    expect(results.map((r) => r.type)).toEqual(['cookies', 'localStorage'])
  })

  it('includes the tabs of known subdomains when asked', async () => {
    const ran: string[] = []
    const run = (name: string) => async () => (ran.push(name), 1)
    const { env } = environment({ tabs: [tab('https://example.com/', run('root')), tab('https://www.example.com/', run('www')), tab('https://badexample.com/', run('bad'))] })
    await clearSiteFor(env, request({ types: ['sessionStorage'], subdomains: true }))
    expect(ran).toEqual(['root', 'www'])
  })

  it('asks the engine for the https origins only when « Inclure HTTP » is off, and for both when it is on', async () => {
    const off = environment()
    await clearSiteFor(off.env, request({ types: ['localStorage'], http: false }))
    expect(off.engine[0]!.origins).toEqual(['https://example.com'])
    const on = environment()
    await clearSiteFor(on.env, request({ types: ['localStorage'], http: true }))
    expect(on.engine[0]!.origins).toEqual(['https://example.com', 'http://example.com'])
  })

  it('keeps the known subdomains and the open tabs to the schemes asked: an http page is left alone without « Inclure HTTP »', async () => {
    const ran: string[] = []
    const run = (name: string) => async () => (ran.push(name), 1)
    const { env, engine } = environment({ tabs: [tab('https://example.com/', run('https')), tab('http://example.com/', run('http')), tab('https://app.example.com/', run('sub'))] })
    await clearSiteFor(env, request({ types: ['localStorage', 'sessionStorage'], subdomains: true, http: false }))
    expect(engine[0]!.origins).toEqual(['https://example.com', 'https://app.example.com'])
    expect(ran).toEqual(['https', 'sub'])
  })

  it('passes the subdomains known from tabs and history to the engine, only when asked', async () => {
    const setup = () => environment({ tabs: [tab('https://app.example.com/x')], hosts: ['api.example.com', 'example.org', 'localhost:3000'] })
    const off = setup()
    await clearSiteFor(off.env, request({ types: ['localStorage'] }))
    expect(off.engine[0]!.origins).toEqual(['https://example.com', 'http://example.com'])
    const on = setup()
    await clearSiteFor(on.env, request({ types: ['localStorage'], subdomains: true }))
    expect(on.engine[0]!.subdomains).toBe(true)
    expect(on.engine[0]!.origins).toEqual(['https://example.com', 'http://example.com', 'https://api.example.com', 'http://api.example.com', 'https://app.example.com', 'http://app.example.com'])
  })

  it('reports a failing sessionStorage on its own line and still erases the rest', async () => {
    const { env } = environment({ tabs: [tab('https://example.com/', async () => { throw new Error('denied') })] })
    const results = await clearSiteFor(env, request({ types: ['cookies', 'sessionStorage'] }))
    expect(results).toEqual([{ type: 'cookies', ok: true }, { type: 'sessionStorage', ok: false, error: 'denied' }])
  })

  it('shows an engine refusal on every engine line, and leaves the other types to run', async () => {
    const { env } = environment({
      clear: async () => {
        throw new Error('Refusing to clear site data without an origin')
      },
      removed: 1
    })
    const results = await clearSiteFor(env, request({ types: ['cookies', 'cache', 'history'] }))
    expect(results).toEqual([
      { type: 'cache', ok: false, error: 'Refusing to clear site data without an origin' },
      { type: 'cookies', ok: false, error: 'Refusing to clear site data without an origin' },
      { type: 'history', ok: true, count: 1 }
    ])
  })

  it('reports a type the engine forgot to answer as a failure instead of crashing', async () => {
    const { env } = environment({ clear: async () => [] })
    expect(await clearSiteFor(env, request({ types: ['cache'] }))).toEqual([{ type: 'cache', ok: false, error: 'Pas de réponse du moteur' }])
  })
})

describe('clearSiteFor, the reload', () => {
  it('sends the tab back to the root of the site when asked', async () => {
    const { env, navigation } = environment({ activeUrl: 'https://example.com/wp-admin/users?x=1' })
    await clearSiteFor(env, request({ reload: true, types: ['cookies'] }))
    expect(navigation).toEqual(['load https://example.com/'])
  })

  it('just reloads a tab that is already at the root', async () => {
    const { env, navigation } = environment({ activeUrl: 'https://example.com/' })
    await clearSiteFor(env, request({ reload: true, types: ['cookies'] }))
    expect(navigation).toEqual(['reload'])
  })

  it('does not touch the tab when reloading was not asked', async () => {
    const { env, navigation } = environment({ activeUrl: 'https://example.com/deep' })
    await clearSiteFor(env, request({ reload: false }))
    expect(navigation).toEqual([])
  })

  it('does not touch a tab that is on another site, or on a subdomain unless subdomains were asked', async () => {
    const other = environment({ activeUrl: 'https://other.org/deep' })
    await clearSiteFor(other.env, request({ reload: true }))
    expect(other.navigation).toEqual([])
    const sub = environment({ activeUrl: 'https://www.example.com/deep' })
    await clearSiteFor(sub.env, request({ reload: true }))
    expect(sub.navigation).toEqual([])
    const subOn = environment({ activeUrl: 'https://www.example.com/deep' })
    await clearSiteFor(subOn.env, request({ reload: true, subdomains: true }))
    expect(subOn.navigation).toEqual(['load https://www.example.com/'])
  })

  it('leaves the tab as it is when something failed, so the user can read the failure and try again', async () => {
    const { env, navigation } = environment({ activeUrl: 'https://example.com/deep', clear: async (r) => r.types.map((type) => ({ type, ok: type !== 'cache', ...(type === 'cache' ? { error: 'x' } : {}) })) })
    await clearSiteFor(env, request({ reload: true }))
    expect(navigation).toEqual([])
  })

  it('does nothing when there is no tab on a page', async () => {
    const { env } = environment()
    await expect(clearSiteFor(env, request({ reload: true }))).resolves.toHaveLength(SITE_DATA_TYPES.length)
  })
})

describe('clearSitesFor', () => {
  const batch = (over: Partial<SiteDataBatchRequest> = {}): SiteDataBatchRequest => ({ hosts: ['a.example', 'b.example'], types: ['cookies', 'localStorage'], subdomains: false, http: true, reload: false, detached: false, ...over })

  it('hands « Inclure HTTP » and « Sous-domaines » to the run of every site', async () => {
    const { env, engine } = environment()
    await clearSitesFor(env, batch({ hosts: ['a.example', 'localhost:3000'], http: false, subdomains: true }))
    expect(engine.map((r) => [r.origins, r.subdomains])).toEqual([
      [['https://a.example'], true],
      [['https://localhost:3000'], true]
    ])
  })

  it('asks the engine once per site, each time for the origins of that site only', async () => {
    const { env, engine } = environment()
    const sites = await clearSitesFor(env, batch({ hosts: ['a.example', 'localhost:3000'] }))
    expect(engine.map((r) => r.origins)).toEqual([
      ['https://a.example', 'http://a.example'],
      ['https://localhost:3000', 'http://localhost:3000']
    ])
    expect(sites.map((s) => s.host)).toEqual(['a.example', 'localhost:3000'])
    expect(sites.every((s) => s.results.length === 2 && s.results.every((r) => r.ok))).toBe(true)
  })

  it('never reaches a site that is not named, whatever the number of sites asked for', async () => {
    const { env, engine, history } = environment()
    await clearSitesFor(env, batch({ hosts: ['a.example', 'b.example'], types: ['cookies', 'history'] }))
    const touched = engine.flatMap((r) => r.origins).concat(history.map(([host]) => `https://${host}`))
    expect(touched.filter((origin) => !/\/\/(a|b)\.example/.test(origin))).toEqual([])
    expect(engine.every((r) => r.origins.length > 0)).toBe(true)
  })

  it('refuses the whole run when a site is not valid, before erasing anything for the others', async () => {
    const { env, engine, history, navigation } = environment({ activeUrl: 'https://a.example/deep' })
    await expect(clearSitesFor(env, batch({ hosts: ['a.example', 'b c'], types: [...SITE_DATA_TYPES], reload: true }))).rejects.toThrow(/Invalid site: b c/)
    expect(engine).toEqual([])
    expect(history).toEqual([])
    expect(navigation).toEqual([])
  })

  it('keeps going when a site could not even be run, and shows that site with every type failed', async () => {
    const { env, engine } = environment()
    // The known hosts are read before anything is erased: the first run fails there as a whole, the second one still goes.
    let reads = 0
    const flaky: SiteDataEnvironment = {
      ...env,
      history: {
        removeSite: env.history.removeSite,
        hosts: () => {
          if (reads++ === 0) throw new Error('history unreadable')
          return []
        }
      }
    }
    const sites = await clearSitesFor(flaky, batch())
    expect(sites[0]).toEqual({ host: 'a.example', results: [{ type: 'cookies', ok: false, error: 'history unreadable' }, { type: 'localStorage', ok: false, error: 'history unreadable' }] })
    expect(sites[1]!.results.every((r) => r.ok)).toBe(true)
    expect(engine.map((r) => r.host)).toEqual(['b.example'])
  })

  it('reloads the tab once, at the end, when it is on one of the sites and everything went through', async () => {
    const { env, navigation } = environment({ activeUrl: 'https://b.example/wp-admin?x=1' })
    await clearSitesFor(env, batch({ reload: true }))
    expect(navigation).toEqual(['load https://b.example/'])
  })

  it('does not touch the tab when it is on another site, or when reloading was not asked', async () => {
    const other = environment({ activeUrl: 'https://c.example/deep' })
    await clearSitesFor(other.env, batch({ reload: true }))
    expect(other.navigation).toEqual([])
    const off = environment({ activeUrl: 'https://a.example/deep' })
    await clearSitesFor(off.env, batch({ reload: false }))
    expect(off.navigation).toEqual([])
  })

  it('leaves the tab as it is when any operation of any site failed, so the failure can be read', async () => {
    const { env, navigation } = environment({
      activeUrl: 'https://a.example/deep',
      clear: async (request) => request.types.map((type) => ({ type, ok: request.host !== 'b.example', ...(request.host === 'b.example' ? { error: 'denied' } : {}) }))
    })
    const sites = await clearSitesFor(env, batch({ reload: true }))
    expect(sites.map((s) => s.results.every((r) => r.ok))).toEqual([true, false])
    expect(navigation).toEqual([])
  })

  it('does not reload for each site: a tab on a site and its subdomain moves once', async () => {
    const { env, navigation } = environment({ activeUrl: 'https://www.a.example/deep' })
    await clearSitesFor(env, batch({ hosts: ['a.example', 'www.a.example'], reload: true, subdomains: true }))
    expect(navigation).toEqual(['load https://www.a.example/'])
  })
})

describe('runAndTell', () => {
  const siteResult = (host: string, ok = true): SiteDataSiteResult => ({ host, results: [{ type: 'cookies', ok }] })

  function report(over: Partial<RunReport> & { notifyOn?: boolean } = {}) {
    const notices: Array<{ title: string; body: string }> = []
    const toasts: string[] = []
    const value: RunReport = {
      run: over.run ?? (async (request) => request.hosts.map((host) => siteResult(host))),
      notify: () => over.notifyOn ?? true,
      private: over.private ?? false,
      notice: over.notice ?? ((notice) => (notices.push(notice), true)),
      toast: (message) => toasts.push(message)
    }
    return { value, notices, toasts }
  }
  const request: SiteDataBatchRequest = { hosts: ['a.example', 'b.example'], types: ['cookies'], subdomains: false, http: true, reload: false, detached: false }

  it('tells the sites that were cleared in a system notice', async () => {
    const { value, notices, toasts } = report()
    await runAndTell(value, request)
    expect(notices).toEqual([{ title: 'Données effacées', body: frenchSpaces('2 sites : a.example, b.example') }])
    expect(toasts).toEqual([])
  })

  it('says nothing when notices are off, but still runs', async () => {
    const run = vi.fn(async () => [siteResult('a.example')])
    const { value, notices, toasts } = report({ notifyOn: false, run })
    await runAndTell(value, request)
    expect(run).toHaveBeenCalledTimes(1)
    expect(notices).toEqual([])
    expect(toasts).toEqual([])
  })

  // The setting is about the end of a run that went well: a run that failed leaves data behind, and the user must always be told.
  it('tells a failure in the window even when notices are off, without using the system notice', async () => {
    const { value, notices, toasts } = report({ notifyOn: false, run: async () => [siteResult('a.example'), siteResult('b.example', false)] })
    await runAndTell(value, request)
    expect(toasts).toEqual([frenchSpaces('Effacement incomplet : Échec pour b.example')])
    expect(notices).toEqual([])
  })

  it('tells a run that could not start even when notices are off, and logs why', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { value, notices, toasts } = report({
      notifyOn: false,
      run: async () => {
        throw new Error('engine gone')
      }
    })
    await runAndTell(value, request)
    expect(toasts).toEqual([frenchSpaces('Effacement incomplet : Échec pour a.example, b.example')])
    expect(notices).toEqual([])
    expect(log).toHaveBeenCalledWith('[site] cannot clear site data:', expect.any(Error))
    log.mockRestore()
  })

  it('counts a site with no result at all as a failure when notices are off', async () => {
    const { value, toasts } = report({ notifyOn: false, run: async () => [{ host: 'a.example', results: [] }] })
    await runAndTell(value, request)
    expect(toasts).toEqual([frenchSpaces('Effacement incomplet : Échec pour a.example')])
  })

  it('does not name the sites of a private window in the failure it tells with notices off', async () => {
    const { value, toasts, notices } = report({ notifyOn: false, private: true, run: async () => [siteResult('a.example', false)] })
    await runAndTell(value, request)
    expect(toasts).toEqual([frenchSpaces('Effacement incomplet : Fenêtre privée')])
    expect(JSON.stringify([toasts, notices])).not.toContain('example')
  })

  it('reads the setting when the run is over, not when it started', async () => {
    let on = true
    const notices: string[] = []
    await runAndTell(
      { run: async () => ((on = false), [siteResult('a.example')]), notify: () => on, private: false, notice: (n) => (notices.push(n.title), true), toast: () => {} },
      request
    )
    expect(notices).toEqual([])
  })

  it('tells a failure as a failure, naming only the sites that failed', async () => {
    const { value, notices } = report({ run: async () => [siteResult('a.example'), siteResult('b.example', false)] })
    await runAndTell(value, request)
    expect(notices).toEqual([{ title: 'Effacement incomplet', body: 'Échec pour b.example' }])
  })

  it('tells a run that could not start as a failure of every site, and logs why', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { value, notices } = report({
      run: async () => {
        throw new Error('engine gone')
      }
    })
    await runAndTell(value, request)
    expect(notices).toEqual([{ title: 'Effacement incomplet', body: 'Échec pour a.example, b.example' }])
    expect(log).toHaveBeenCalledWith('[site] cannot clear site data:', expect.any(Error))
    log.mockRestore()
  })

  it('falls back to the toast of the window with the same words when the system takes no notice', async () => {
    const { value, toasts } = report({ notice: () => false })
    await runAndTell(value, request)
    expect(toasts).toEqual([frenchSpaces('Données effacées : 2 sites : a.example, b.example')])
  })

  it('does not name the sites of a private window, in the notice or in the toast', async () => {
    const refusing = report({ private: true, notice: () => false })
    await runAndTell(refusing.value, request)
    const accepting = report({ private: true })
    await runAndTell(accepting.value, request)
    expect(JSON.stringify([refusing.toasts, accepting.notices])).not.toContain('example')
    expect(accepting.notices).toEqual([{ title: 'Données effacées', body: 'Fenêtre privée' }])
  })
})

describe('the shortcut, and the notice it gives', () => {
  const prefs = (over: Record<string, unknown> = {}) => normalizeSiteDataPrefs({ siteDataTypes: ['cookies', 'localStorage'], ...over })
  const report = (notifyOn: boolean) => {
    const notices: Array<{ title: string; body: string }> = []
    const asked: SiteDataBatchRequest[] = []
    const value: RunReport = {
      run: async (request) => (asked.push(request), request.hosts.map((host) => ({ host, results: request.types.map((type) => ({ type, ok: true })) }))),
      notify: () => notifyOn,
      private: false,
      notice: (notice) => (notices.push(notice), true),
      toast: () => undefined
    }
    return { value, notices, asked }
  }

  it('clears the site of the page with the remembered choices, http included for a page served over http, and tells it in a system notice', async () => {
    const { value, notices, asked } = report(true)
    await runAndTell(value, quickClearRequest('http://localhost:3000/admin', prefs(), { private: false })!)
    expect(asked).toEqual([{ hosts: ['localhost:3000'], types: ['cookies', 'localStorage'], subdomains: false, http: true, reload: true, detached: false }])
    expect(notices).toEqual([{ title: 'Données effacées', body: 'localhost:3000' }])
  })

  it('says nothing of a run that went well when « Notifier au raccourci » is off', async () => {
    const { value, notices, asked } = report(false)
    await runAndTell(value, quickClearRequest('https://example.com/', prefs(), { private: false })!)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.http).toBe(false)
    expect(notices).toEqual([])
  })
})

describe('the animation on the page', () => {
  /** A page that records the scripts it is given, and may refuse them. */
  function page(refuse = false) {
    const drawn: string[] = []
    return {
      drawn,
      runClearOverlay: async (code: string) => {
        drawn.push(code)
        if (refuse) throw new Error('the page is gone')
        return true
      }
    }
  }
  const sites = (ok: boolean): SiteDataSiteResult[] => [{ host: 'a.example', results: [{ type: 'cookies', ok }] }]
  const kind = (code: string) => (code.includes('replaceChildren') ? (code.includes('done ok') ? 'tick' : 'cross') : code.includes(SITE_DATA_ANIMATION_LABELS.pacman.text) ? 'pacman' : 'loader')
  /** No real waiting: the clock of the tests answers at once. */
  const instant = { wait: async () => undefined }

  it('draws the chosen loader as the run starts, then a tick when everything went through', async () => {
    const target = page()
    const order: string[] = []
    const result = await withPageAnimation(target, 'pacman', async () => (order.push(`run after ${target.drawn.length}`), sites(true)), allSitesCleared, instant)
    expect(result).toEqual(sites(true))
    expect(order).toEqual(['run after 1'])
    expect(target.drawn.map(kind)).toEqual(['pacman', 'tick'])
  })

  it('ends with a cross when a type failed, and when the run throws (the error goes on)', async () => {
    const failed = page()
    await withPageAnimation(failed, 'spinner', async () => sites(false), allSitesCleared, instant)
    expect(failed.drawn.map(kind)).toEqual(['loader', 'cross'])
    const thrown = page()
    await expect(withPageAnimation(thrown, 'spinner', async () => Promise.reject(new Error('engine down')), allSitesCleared, instant)).rejects.toThrow('engine down')
    expect(thrown.drawn.map(kind)).toEqual(['loader', 'cross'])
  })

  it('draws nothing with « Aucune » (what reduced motion gives) or without a page, and runs all the same', async () => {
    const none = page()
    expect(await withPageAnimation(none, 'none', async () => sites(true), allSitesCleared)).toEqual(sites(true))
    expect(none.drawn).toEqual([])
    expect(await withPageAnimation(null, 'fire', async () => sites(true), allSitesCleared)).toEqual(sites(true))
  })

  it('logs a page that refuses the drawing, and the run goes on as if it had been drawn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refusing = page(true)
    expect(await withPageAnimation(refusing, 'bounce', async () => sites(true), allSitesCleared, instant)).toEqual(sites(true))
    expect(refusing.drawn).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith('[site] cannot draw the start of the clearing animation on the page:', 'the page is gone')
    expect(warn).toHaveBeenCalledWith('[site] cannot draw the end of the clearing animation on the page:', 'the page is gone')
    warn.mockRestore()
  })

  it('is drawn on a web page only: never on a start page, the settings, a file or an extension’s page', () => {
    const target = page()
    expect(animationPageOf('https://example.com/a', target)).not.toBeNull()
    expect(animationPageOf('http://localhost:3000/', target)).not.toBeNull()
    for (const url of ['about:blank', 'lucium://settings', 'file:///Users/moi/a.html', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/p.html', '']) expect(animationPageOf(url, target), url).toBeNull()
    expect(animationPageOf(undefined, target)).toBeNull()
    expect(animationPageOf('https://example.com/', undefined)).toBeNull()
    expect(animationPageOf('https://example.com/', {})).toBeNull()
  })

  it('hands the script to the page it was found on', async () => {
    const target = page()
    await animationPageOf('https://example.com/', target)!.runClearOverlay('draw()')
    expect(target.drawn).toEqual(['draw()'])
  })
})

describe('the order of a run with an animation on the page', () => {
  const batch = (over: Partial<SiteDataBatchRequest> = {}): SiteDataBatchRequest => ({ hosts: ['a.example'], types: ['cookies'], subdomains: false, http: true, reload: true, detached: false, ...over })
  const kindOf = (code: string) => (code.includes('replaceChildren') ? (code.includes('done ok') ? 'tick' : 'cross') : 'loader')

  /**
   * A run whose every step is written in one log: the sheet stepping aside and coming back, what is drawn on the page, the erasure, the waits, the
   * navigation of the tab. The clock answers at once, except for the wait that holds the reload back, which is let go by hand.
   */
  function run(over: { animation?: SiteDataAnimation; activeUrl?: string | null; ok?: boolean; refuse?: boolean; throws?: boolean; request?: Partial<SiteDataBatchRequest>; active?: RunStage['active']; aside?: boolean } = {}) {
    const log: string[] = []
    const drawn: string[] = []
    const held: Array<() => void> = []
    const { env } = environment({
      activeUrl: over.activeUrl === undefined ? 'https://a.example/deep/page' : over.activeUrl,
      clear: async (r) => {
        log.push('erase')
        if (over.throws) throw new Error('engine down')
        return r.types.map((type) => ({ type, ok: over.ok !== false, ...(over.ok === false ? { error: 'x' } : {}) }))
      }
    })
    if (env.active) env.active = { url: env.active.url, page: { reload: () => log.push('navigate reload'), loadURL: (url) => log.push(`navigate ${url}`) } }
    const stage: RunStage = {
      page: {
        runClearOverlay: async (code) => {
          drawn.push(code)
          log.push(`draw ${kindOf(code)}`)
          if (over.refuse) throw new Error('the page is gone')
          return true
        }
      },
      animation: over.animation ?? 'fire',
      ...(over.aside === false ? {} : { stepAside: () => (log.push('sheet aside'), () => void log.push('sheet back')) }),
      ...(over.active ? { active: over.active } : {}),
      wait: (ms) => {
        // The wait that holds the reload back is asked for before the answer is out, and waited for after it: only what is waited for in the order is logged.
        if (ms === RELOAD_AFTER_ANSWER_MS) return new Promise<void>((resolve) => held.push(resolve))
        log.push(`wait ${ms}`)
        return Promise.resolve()
      }
    }
    const done = clearSitesWithAnimation(env, batch(over.request), stage).then(
      (sites) => (log.push('answer'), sites),
      (error: unknown) => (log.push('error'), Promise.reject(error))
    )
    /** Lets the reload through, once the answer is out. */
    const release = async () => {
      held.splice(0).forEach((resolve) => resolve())
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return { done, log, drawn, release }
  }

  it('steps the sheet aside, draws the loader, erases, keeps the loader long enough, draws the tick, waits for it, brings the sheet back, answers, and only then reloads the tab to the root', async () => {
    const { done, log, release } = run()
    const sites = await done
    expect(sites).toEqual([{ host: 'a.example', results: [{ type: 'cookies', ok: true }] }])
    expect(log).toEqual([
      'sheet aside',
      'draw loader',
      'erase',
      `wait ${OVERLAY_LOADER_MIN_MS}`,
      'draw tick',
      `wait ${OVERLAY_DONE_MS + OVERLAY_FADE_MS}`,
      'sheet back',
      'answer'
    ])
    // The tab has not moved yet: the answer is on screen first.
    expect(log.some((entry) => entry.startsWith('navigate'))).toBe(false)
    await release()
    expect(log.at(-1)).toBe('navigate https://a.example/')
  })

  it('never reloads before the animation is over: the erasure itself is asked not to reload', async () => {
    const { done, log, release } = run({ activeUrl: 'https://a.example/' })
    await done
    expect(log.indexOf('draw tick')).toBeGreaterThan(-1)
    expect(log.some((entry) => entry === 'navigate reload')).toBe(false)
    await release()
    expect(log.indexOf('navigate reload')).toBeGreaterThan(log.indexOf('sheet back'))
  })

  it('draws the animation that was chosen, whichever it is', async () => {
    for (const animation of SITE_DATA_ANIMATIONS.filter((name) => name !== 'none')) {
      const { done, drawn } = run({ animation: animation as SiteDataAnimation })
      await done
      expect(drawn[0], animation).toBe(clearingOverlayScript(animation as Exclude<SiteDataAnimation, 'none'>))
    }
  })

  it('draws nothing, hides nothing, waits for nothing and reloads at once with « Aucune » or when reduced motion gives it, as it did before', async () => {
    const { done, log } = run({ animation: 'none' })
    await done
    expect(log).toEqual(['erase', 'navigate https://a.example/', 'answer'])
  })

  it('does the same when the tab has no page to draw on', async () => {
    const log: string[] = []
    const { env } = environment({ activeUrl: 'https://a.example/deep', clear: async (r) => (log.push('erase'), r.types.map((type) => ({ type, ok: true }))) })
    env.active = { url: 'https://a.example/deep', page: { reload: () => log.push('reload'), loadURL: (url) => log.push(`load ${url}`) } }
    await clearSitesWithAnimation(env, batch(), { page: null, animation: 'fire', stepAside: () => (log.push('sheet aside'), () => undefined) })
    expect(log).toEqual(['erase', 'load https://a.example/'])
  })

  it('draws a cross, brings the sheet back and leaves the tab alone when a type failed', async () => {
    const { done, log, release } = run({ ok: false })
    await done
    expect(log).toEqual(['sheet aside', 'draw loader', 'erase', `wait ${OVERLAY_LOADER_MIN_MS}`, 'draw cross', `wait ${OVERLAY_DONE_MS + OVERLAY_FADE_MS}`, 'sheet back', 'answer'])
    await release()
    expect(log.some((entry) => entry.startsWith('navigate'))).toBe(false)
  })

  it('brings the sheet back, and passes the error on, when the run throws: no tick, no reload', async () => {
    // `clearSitesFor` turns an engine refusal into failed lines; what throws is the batch itself (a host that is not valid).
    const { done, log, release } = run({ request: { hosts: ['b c'] } })
    await expect(done).rejects.toThrow('Invalid site: b c')
    expect(log).toEqual(['sheet aside', 'draw loader', `wait ${OVERLAY_LOADER_MIN_MS}`, 'draw cross', `wait ${OVERLAY_DONE_MS + OVERLAY_FADE_MS}`, 'sheet back', 'error'])
    await release()
    expect(log.some((entry) => entry.startsWith('navigate'))).toBe(false)
  })

  it('does not reload when reloading was not asked, and does not touch the sheet when none is there to step aside', async () => {
    const { done, log, release } = run({ request: { reload: false }, aside: false })
    await done
    await release()
    expect(log).toEqual(['draw loader', 'erase', `wait ${OVERLAY_LOADER_MIN_MS}`, 'draw tick', `wait ${OVERLAY_DONE_MS + OVERLAY_FADE_MS}`, 'answer'])
  })

  it('does not wait on a page that refuses the drawing, and the sheet still comes back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { done, log } = run({ refuse: true })
    await done
    expect(log).toEqual(['sheet aside', 'draw loader', 'erase', 'draw tick', 'sheet back', 'answer'])
    warn.mockRestore()
  })

  it('sends back to the root the tab of the moment, not the one the run started on: a tab the user left meanwhile is not touched', async () => {
    const moved: string[] = []
    const elsewhere = { url: 'https://other.org/', page: { reload: () => moved.push('reload'), loadURL: (url: string) => moved.push(url) } }
    const { done, log, release } = run({ active: () => elsewhere })
    await done
    await release()
    expect(moved).toEqual([])
    expect(log.some((entry) => entry.startsWith('navigate'))).toBe(false)
    const still = { url: 'https://a.example/else', page: { reload: () => moved.push('reload'), loadURL: (url: string) => moved.push(url) } }
    const again = run({ active: () => still })
    await again.done
    await again.release()
    expect(moved).toEqual(['https://a.example/'])
  })

  it('logs a tab that cannot be sent back, instead of failing the answer it has already given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = { url: 'https://a.example/else', page: { reload: () => undefined, loadURL: () => { throw new Error('Object has been destroyed') } } }
    const { done, release } = run({ active: () => broken })
    await expect(done).resolves.toHaveLength(1)
    await release()
    expect(warn).toHaveBeenCalledWith('[site] cannot send the tab back to the root of the site after the animation:', 'Object has been destroyed')
    warn.mockRestore()
  })
})
