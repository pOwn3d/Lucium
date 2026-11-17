import { afterEach, describe, expect, it, vi } from 'vitest'
import { DATA_API_METHODS } from '@shared/extension-data'
import { shimAllowed } from '@shared/chrome-compat'
import { setLanguage } from '@shared/i18n'

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/lucium-test', once: () => {}, on: () => {} },
  BrowserWindow: { getFocusedWindow: () => null }
}))

const { ExtensionShims } = await import('./extension-shims')
const { setLockService } = await import('../lock-service')

afterEach(() => setLockService(null))

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const NOW = Date.now()

/** The history of each profile, as the browser keeps it. */
function rig(settings: Record<string, unknown> = { extensionDataApis: true }) {
  const pages: Record<string, Array<{ url: string; title: string; visitCount: number; lastVisitAt: number }>> = {
    default: [
      { url: 'https://github.com/anthropics', title: 'Anthropic', visitCount: 3, lastVisitAt: NOW - 60_000 },
      { url: 'https://bank.example/account', title: 'My account', visitCount: 1, lastVisitAt: NOW - 120_000 }
    ],
    work: [{ url: 'https://wiki.work.example/', title: 'Work wiki', visitCount: 1, lastVisitAt: NOW - 30_000 }]
  }
  const removedSites: Array<{ profile: string; host: string }> = []
  /** What the shims asked of the history: asking for the whole of it (`search`) at each call was the cost this keeps out. */
  const historyCalls: string[] = []
  const history = {
    of: (profileId: string) => ({
      search: (_query: string, limit = 20) => (historyCalls.push('search'), [...(pages[profileId] ?? [])]).sort((a, b) => b.lastVisitAt - a.lastVisitAt).slice(0, limit),
      get: (url: string) => (historyCalls.push('get'), (pages[profileId] ?? []).find((page) => page.url === url)),
      between: (from: number, to: number) => (historyCalls.push('between'), pages[profileId] ?? []).filter((page) => page.lastVisitAt >= from && page.lastVisitAt < to).sort((a, b) => b.lastVisitAt - a.lastVisitAt),
      removeSite: (host: string) => {
        removedSites.push({ profile: profileId, host })
        return 1
      }
    })
  }
  const state: Record<string, unknown> = {
    settings,
    favorites: [{ id: 'f1', url: 'https://mail.example/', title: 'Mail' }],
    spaces: [
      { id: 's-default', name: 'Maison', emoji: '🏠', profileId: 'default' },
      { id: 's-work', name: 'Travail', emoji: '💼', profileId: 'work' }
    ],
    folders: [{ id: 'd1', spaceId: 's-default', name: 'Dossier banque' }],
    archive: [],
    splits: [],
    sessions: [],
    activeTabBySpace: {},
    tabs: [
      { id: 'p1', spaceId: 's-default', url: 'https://pinned.example/', title: 'Pinned', pinned: true, createdAt: 1 },
      { id: 'p2', spaceId: 's-work', url: 'https://work-pinned.example/', title: 'Work pinned', pinned: true, createdAt: 2 }
    ]
  }
  const erased: Array<{ profileId: string; request: Record<string, unknown> }> = []
  const behaviour = { fail: false }
  const engine = {
    setTabFactsProvider: () => {},
    onTabClosed: () => {},
    onDownload: () => {},
    onContextGone: () => {},
    clearSiteData: vi.fn(async (profileId: string, request: { types: string[] }) => {
      erased.push({ profileId, request })
      return request.types.map((type) => (behaviour.fail ? { type, ok: false, error: 'disk full' } : { type, ok: true }))
    })
  }
  const forgotPages: Array<{ profile: string; host: string; subdomains: boolean }> = []
  const browser = { forgetClosedPages: (profile: string, site: { host: string; subdomains: boolean }) => void forgotPages.push({ profile, ...site }) }
  const shims = new ExtensionShims(browser as never, engine as never, { get: () => state } as never, history as never)
  const call = (api: string, method: string, args: unknown[] = [], profileId = 'default') => shims.handle({ extensionId: EXT, profileId, context: 'worker:1', api, method, args })
  return { call, engine, erased, removedSites, forgotPages, behaviour, historyCalls }
}

describe('chrome.history', () => {
  it('searches the history of the profile of the extension and of no other', async () => {
    const r = rig()
    const mine = (await r.call('history', 'search', [{ text: '' }])) as Array<{ url: string }>
    expect(mine.map((item) => item.url)).toEqual(['https://github.com/anthropics', 'https://bank.example/account'])
    const work = (await r.call('history', 'search', [{ text: '' }], 'work')) as Array<{ url: string }>
    expect(work.map((item) => item.url)).toEqual(['https://wiki.work.example/'])
    expect(((await r.call('history', 'search', [{ text: 'bank' }])) as unknown[]).length).toBe(1)
    expect(((await r.call('history', 'search', [{ text: 'wiki' }])) as unknown[]).length).toBe(0)
  })

  it('answers getVisits for a page of the profile, and nothing for a page of another profile', async () => {
    const r = rig()
    expect(((await r.call('history', 'getVisits', [{ url: 'https://github.com/anthropics' }])) as unknown[]).length).toBe(1)
    expect(await r.call('history', 'getVisits', [{ url: 'https://wiki.work.example/' }])).toEqual([])
    await expect(r.call('history', 'getVisits', [{ url: 'file:///etc/passwd' }])).rejects.toThrow('valid web address')
  })

  it('asks the history for the pages of the range, or for the page, never for the whole of it', async () => {
    const r = rig()
    await r.call('history', 'search', [{ text: '', startTime: NOW - 90_000, endTime: NOW }])
    await r.call('history', 'getVisits', [{ url: 'https://github.com/anthropics' }])
    expect(r.historyCalls).toEqual(['between', 'get'])
    // The range is applied by the history: a page outside it is not in the answer.
    const recent = (await r.call('history', 'search', [{ text: '', startTime: NOW - 90_000, endTime: NOW }])) as Array<{ url: string }>
    expect(recent.map((item) => item.url)).toEqual(['https://github.com/anthropics'])
  })

  it('rejects a query that is not one, with a message', async () => {
    await expect(rig().call('history', 'search', [undefined])).rejects.toThrow('No matching signature')
    await expect(rig().call('history', 'search', [{ text: 5 }])).rejects.toThrow('No matching signature')
  })

  it('refuses every write, and says why', async () => {
    const r = rig()
    for (const method of ['addUrl', 'deleteUrl', 'deleteRange', 'deleteAll']) await expect(r.call('history', method, [{ url: 'https://github.com/anthropics' }]), method).rejects.toThrow('read-only')
    await expect(r.call('history', 'nonsense')).rejects.toThrow('not supported')
  })
})

describe('chrome.bookmarks', () => {
  it('reads the favourites and the pinned tabs of the profile', async () => {
    const r = rig()
    const [root] = (await r.call('bookmarks', 'getTree')) as Array<{ children: Array<{ id: string; children: Array<{ title: string; children?: Array<{ title: string }> }> }> }>
    expect(root!.children[0]!.children.map((node) => node.title)).toEqual(['Mail'])
    expect(JSON.stringify(root)).toContain('pinned.example')
    expect(JSON.stringify(root)).not.toContain('work-pinned.example')
    const [other] = (await r.call('bookmarks', 'getTree', [], 'work')) as Array<unknown>
    expect(JSON.stringify(other)).toContain('work-pinned.example')
    expect(((await r.call('bookmarks', 'search', ['mail'])) as unknown[]).length).toBe(1)
    expect(((await r.call('bookmarks', 'getChildren', ['1'])) as Array<{ url: string }>).map((node) => node.url)).toEqual(['https://mail.example/'])
    expect(((await r.call('bookmarks', 'get', [['1', '2']])) as unknown[]).length).toBe(2)
  })

  it('gives nothing of a locked space: neither its pinned tabs nor its folders, by the tree, a search or an id', async () => {
    const r = rig()
    expect(JSON.stringify(await r.call('bookmarks', 'getTree'))).toContain('Dossier banque')
    setLockService({ view: () => ({ appLocked: false, lockedSpaces: ['s-default'] }) } as never)
    const tree = JSON.stringify(await r.call('bookmarks', 'getTree'))
    expect(tree).not.toContain('pinned.example')
    expect(tree).not.toContain('Dossier banque')
    // The favourites are not the space's: they stay.
    expect(tree).toContain('mail.example')
    expect(await r.call('bookmarks', 'search', ['pinned'])).toEqual([])
    await expect(r.call('bookmarks', 'get', ['pin-p1'])).rejects.toThrow("Can't find bookmark")
    expect(JSON.stringify(await r.call('bookmarks', 'getRecent', [10]))).not.toContain('pinned.example')
  })

  it('gives nothing while the application is locked, not even the favourites or the names of the spaces', async () => {
    const r = rig()
    setLockService({ view: () => ({ appLocked: true, lockedSpaces: [] }) } as never)
    const tree = JSON.stringify(await r.call('bookmarks', 'getTree'))
    for (const hidden of ['pinned.example', 'mail.example', 'Dossier banque', 'Maison']) expect(tree, hidden).not.toContain(hidden)
  })

  it('fails with the error of chrome.bookmarks for an id it does not have', async () => {
    const r = rig()
    await expect(r.call('bookmarks', 'get', ['nope'])).rejects.toThrow("Can't find bookmark")
    await expect(r.call('bookmarks', 'getChildren', ['nope'])).rejects.toThrow("Can't find bookmark")
    await expect(r.call('bookmarks', 'getSubTree', [3])).rejects.toThrow("Can't find bookmark")
    await expect(r.call('bookmarks', 'getRecent', [0])).rejects.toThrow('positive integer')
  })

  it('refuses every write', async () => {
    const r = rig()
    for (const method of ['create', 'update', 'move', 'remove', 'removeTree']) await expect(r.call('bookmarks', method, ['1', {}]), method).rejects.toThrow('read-only')
  })
})

describe('chrome.browsingData', () => {
  it('erases the named sites in the profile of the extension, by origin', async () => {
    const r = rig()
    await r.call('browsingData', 'remove', [{ origins: ['https://a.example', 'http://a.example'] }, { cookies: true, cache: true }], 'work')
    expect(r.erased).toEqual([{ profileId: 'work', request: { host: 'a.example', origins: ['https://a.example', 'http://a.example'], subdomains: false, types: ['cookies', 'cache'] } }])
  })

  it('does the shortcuts the same way', async () => {
    const r = rig()
    await r.call('browsingData', 'removeLocalStorage', [{ origins: ['https://a.example'] }])
    expect(r.erased[0]!.request).toMatchObject({ types: ['localStorage'], origins: ['https://a.example'] })
  })

  it('forgets the pages of the site in the history of the profile when "history" is asked, without touching the engine for it', async () => {
    const r = rig()
    await r.call('browsingData', 'remove', [{ origins: ['https://github.com'] }, { history: true }])
    expect(r.removedSites).toEqual([{ profile: 'default', host: 'github.com' }])
    expect(r.engine.clearSiteData).not.toHaveBeenCalled()
  })

  it('takes the pages of the site out of the Back lists of the closed tabs of the profile with its history, and not otherwise (F11)', async () => {
    const r = rig()
    await r.call('browsingData', 'remove', [{ origins: ['https://github.com'] }, { history: true }], 'work')
    expect(r.forgotPages).toEqual([{ profile: 'work', host: 'github.com', subdomains: false }])
    const without = rig()
    await without.call('browsingData', 'remove', [{ origins: ['https://github.com'] }, { cookies: true }])
    expect(without.forgotPages).toEqual([])
  })

  it('erases nothing without origins, with a start time, or for a kind of data it does not erase', async () => {
    const r = rig()
    await expect(r.call('browsingData', 'remove', [{}, { cookies: true }])).rejects.toThrow('origins')
    await expect(r.call('browsingData', 'remove', [{ origins: ['https://a.example'], since: Date.now() - 1000 }, { cookies: true }])).rejects.toThrow('since')
    await expect(r.call('browsingData', 'remove', [{ origins: ['https://a.example'] }, { passwords: true }])).rejects.toThrow('does not erase')
    await expect(r.call('browsingData', 'removePasswords', [{ origins: ['https://a.example'] }])).rejects.toThrow('not supported')
    await expect(r.call('browsingData', 'removeCache', [{}])).rejects.toThrow('origins')
    expect(r.engine.clearSiteData).not.toHaveBeenCalled()
    expect(r.removedSites).toEqual([])
  })

  it('tells the extension, and the log, when the engine could not erase something', async () => {
    const r = rig()
    r.behaviour.fail = true
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(r.call('browsingData', 'remove', [{ origins: ['https://a.example'] }, { cookies: true }])).rejects.toThrow('a.example (cookies): disk full')
      expect(logged).toHaveBeenCalledWith('[extensions] chrome.browsingData could not erase everything:', expect.stringContaining('disk full'))
    } finally {
      logged.mockRestore()
    }
  })

  it('answers settings() without erasing anything', async () => {
    const r = rig()
    expect(await r.call('browsingData', 'settings')).toMatchObject({ dataRemovalPermitted: { cookies: true, passwords: false } })
    expect(r.engine.clearSiteData).not.toHaveBeenCalled()
  })
})

describe('the setting that gives these APIs to extensions', () => {
  it('refuses every method of every API while it is off, and reads nothing', async () => {
    const r = rig({ extensionDataApis: false })
    for (const [api, methods] of Object.entries(DATA_API_METHODS)) {
      for (const method of methods) await expect(r.call(api, method, [{ origins: ['https://a.example'] }, { cookies: true }]), `${api}.${method}`).rejects.toThrow('switched off')
    }
    expect(r.engine.clearSiteData).not.toHaveBeenCalled()
    expect(r.removedSites).toEqual([])
  })

  it('says so in English, as the chrome.* APIs do, and names the place of the switch as the interface shows it', async () => {
    const r = rig({ extensionDataApis: false })
    await expect(r.call('history', 'search', [{ text: '' }])).rejects.toThrow('chrome.history is switched off in Lucium (Réglages › Extensions et outils).')
    try {
      setLanguage('en')
      await expect(r.call('history', 'search', [{ text: '' }])).rejects.toThrow('chrome.history is switched off in Lucium (Settings › Extensions and tools).')
    } finally {
      setLanguage('fr')
    }
  })

  it('does not stand between an extension and the other APIs while it is off', async () => {
    const r = rig({ extensionDataApis: false })
    await expect(r.call('identity', 'getAuthToken')).rejects.toThrow('not supported in Lucium')
  })
})

describe('the permission, one level down', () => {
  it('the engine refuses a call before it gets here when the permission is missing (shimAllowed), for every method', () => {
    for (const [api, methods] of Object.entries(DATA_API_METHODS)) {
      for (const method of methods) expect(shimAllowed({ permissions: ['storage'] }, api, method), `${api}.${method}`).toBe(false)
    }
  })
})
