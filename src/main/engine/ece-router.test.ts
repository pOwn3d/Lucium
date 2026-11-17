import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ActiveTabGrants } from '@shared/extension-access'
import { LIBRARY_NATIVE_MESSAGING, NO_TAB, addActionMenuItems, extendActionMenu, extensionMenuItems, extensionOfSender, keepActionIcon, restrictLibraryApis, revokeHandlers, routerOf, updateContextMenuItem, windowFocusOf, wrapHandler, type EceHandler, type EceListener, type EceRouter, type LibraryGuard } from './ece-router'

const handlers = (names: string[]): Map<string, EceHandler> => new Map(names.map((name) => [name, { callback: () => name }]))

describe('routerOf', () => {
  it('finds the router of the extension library', () => {
    const router = { handlers: new Map(), sendEvent: vi.fn() }
    expect(routerOf({ ctx: { router } } as never)).toBe(router)
  })

  it('fails loudly when the library keeps its router somewhere else, instead of leaving what it took away reachable', () => {
    expect(() => routerOf({} as never)).toThrow('changed its internals')
    expect(() => routerOf({ ctx: { router: { handlers: {}, sendEvent: () => {} } } } as never)).toThrow('changed its internals')
    expect(() => routerOf({ ctx: { router: { handlers: new Map() } } } as never)).toThrow('changed its internals')
  })
})

describe('extendActionMenu', () => {
  const libraryWith = (items: string[]) => ({ ctx: { store: { buildMenuItems: vi.fn((_id: string, _type: string) => items) } } })

  it('adds entries after the extension\'s own in the menu of its toolbar icon, and leaves every other menu alone', () => {
    const library = libraryWith(['own'])
    extendActionMenu(library as never, (id) => [`disable ${id}`, `uninstall ${id}`])
    expect(library.ctx.store.buildMenuItems('abc', 'browser_action')).toEqual(['own', 'disable abc', 'uninstall abc'])
    expect(library.ctx.store.buildMenuItems('abc', 'action')).toEqual(['own', 'disable abc', 'uninstall abc'])
    expect(library.ctx.store.buildMenuItems('abc', 'page')).toEqual(['own'])
    expect(library.ctx.store.buildMenuItems('abc', 'selection')).toEqual(['own'])
  })

  it('fails loudly when the library keeps its menu somewhere else, instead of showing a menu without the entries', () => {
    expect(() => extendActionMenu({} as never, () => [])).toThrow('changed its internals')
    expect(() => extendActionMenu({ ctx: { store: {} } } as never, () => [])).toThrow('changed its internals')
  })
})

describe('revokeHandlers', () => {
  it('removes the native messaging of the library and nothing else', () => {
    const router = { handlers: handlers([...LIBRARY_NATIVE_MESSAGING, 'tabs.get', 'runtime.openOptionsPage']) }
    revokeHandlers(router, LIBRARY_NATIVE_MESSAGING)
    expect([...router.handlers.keys()]).toEqual(['tabs.get', 'runtime.openOptionsPage'])
  })

  it('throws when a handler it was told to remove is not there, since the library no longer works the way this was written for', () => {
    expect(() => revokeHandlers({ handlers: handlers(['runtime.connectNative']) }, LIBRARY_NATIVE_MESSAGING)).toThrow('has no "runtime.disconnectNative" handler any more')
  })
})

describe('addActionMenuItems', () => {
  const store = (menus: Record<string, unknown[]>) => ({ ctx: { store: { buildMenuItems: (_id: string, type: string) => menus[type] ?? [] } } })

  it('adds its entries after the extension\'s own, for the menu of the toolbar icon only', () => {
    const library = store({ browser_action: ['own'], page: ['page-entry'] })
    addActionMenuItems(library as never, (id) => [`pin ${id}`])
    const build = library.ctx.store.buildMenuItems
    expect(build(ME, 'browser_action')).toEqual(['own', `pin ${ME}`])
    // The right click on a page asks for another kind of menu: it is the extension's alone.
    expect(build(ME, 'page')).toEqual(['page-entry'])
  })

  it('adds them even when the extension added nothing', () => {
    const library = store({})
    addActionMenuItems(library as never, () => ['pin'])
    expect(library.ctx.store.buildMenuItems(ME, 'browser_action')).toEqual(['pin'])
  })

  it('fails loudly when the library keeps the function somewhere else', () => {
    expect(() => addActionMenuItems({} as never, () => [])).toThrow('changed its internals')
    expect(() => addActionMenuItems({ ctx: { store: {} } } as never, () => [])).toThrow('changed its internals')
  })
})

describe('wrapHandler', () => {
  it('replaces a handler by a function of the original', () => {
    const router = { handlers: new Map<string, EceHandler>([['tabs.create', { callback: (_event, url) => `created ${String(url)}` }]]) }
    wrapHandler(router, 'tabs.create', (original) => (event, url) => original(event, url === 'chrome://newtab' ? 'about:blank' : url))
    expect(router.handlers.get('tabs.create')!.callback({}, 'chrome://newtab')).toBe('created about:blank')
    expect(router.handlers.get('tabs.create')!.callback({}, 'https://a.fr/')).toBe('created https://a.fr/')
  })

  it('throws for a handler that does not exist', () => {
    expect(() => wrapHandler({ handlers: new Map() }, 'tabs.create', (original) => original)).toThrow('has no "tabs.create" handler any more')
  })
})

// ---- restrictLibraryApis: the library as it is (no check of any kind), with the rules in front ----

const ME = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

const TAB = { id: 1, url: 'https://bank.example/account', title: 'My account', favIconUrl: 'https://bank.example/i.png', active: true, windowId: 3, index: 0 }
const COOKIES = [
  { name: 'sid', value: 'secret', domain: 'bank.example', path: '/', secure: true, httpOnly: true },
  { name: 'pref', value: 'dark', domain: 'news.example', path: '/', secure: false, httpOnly: false }
]

/** What the library does, without the checks it lacks: it hands out its cached objects, and loads whatever address it is given. */
function library(answers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = []
  const record = (name: string, given: (...args: unknown[]) => unknown): [string, EceHandler] => {
    const result = answers[name] ?? given
    return [
      name,
      {
        callback: (_event, ...args) => {
          calls.push({ name, args })
          return result(...args)
        }
      }
    ]
  }
  const handlers = new Map<string, EceHandler>([
    record('tabs.get', () => TAB),
    record('tabs.getAllInWindow', () => [TAB]),
    record('tabs.getCurrent', () => TAB),
    record('tabs.create', () => TAB),
    record('tabs.insertCSS', () => undefined),
    record('tabs.query', () => [TAB, { ...TAB, id: 2, url: 'https://news.example/', title: 'News' }]),
    record('tabs.update', () => TAB),
    record('windows.get', () => ({ id: 3, tabs: [TAB] })),
    record('windows.getCurrent', () => ({ id: 3, tabs: [TAB] })),
    record('windows.getLastFocused', () => ({ id: 3, tabs: [TAB] })),
    record('windows.getAll', () => [{ id: 3, tabs: [TAB] }]),
    record('windows.create', () => ({ id: 4, tabs: [TAB] })),
    record('windows.update', () => ({ id: 3, tabs: [TAB] })),
    record('windows.remove', () => undefined),
    record('cookies.get', () => COOKIES[0]),
    record('cookies.getAll', () => COOKIES),
    record('cookies.set', () => COOKIES[0]),
    record('cookies.remove', () => ({ url: 'https://bank.example/', name: 'sid' })),
    record('cookies.getAllCookieStores', () => [{ id: '0', tabIds: [1] }]),
    record('webNavigation.getFrame', () => ({ url: 'https://bank.example/' })),
    record('webNavigation.getAllFrames', () => [{ url: 'https://bank.example/' }]),
    record('contextMenus.create', () => undefined),
    record('contextMenus.remove', () => undefined),
    record('contextMenus.removeAll', () => undefined),
    record('notifications.clear', () => true),
    record('notifications.create', () => 'id'),
    record('notifications.getAll', () => ({})),
    record('notifications.getPermissionLevel', () => 'granted'),
    record('notifications.update', () => true),
    record('permissions.request', () => true),
    record('permissions.contains', () => true),
    record('permissions.getAll', () => ({ permissions: ['everything'], origins: ['<all_urls>'] })),
    record('permissions.remove', () => true),
    // The handlers the library does not need a permission for, and Lucium does not rewrite: they are still served in the name of the caller only.
    record('tabs.remove', () => undefined),
    record('tabs.reload', () => undefined),
    record('tabs.goBack', () => undefined),
    record('tabs.goForward', () => undefined),
    record('windows.remove', () => undefined),
    record('runtime.openOptionsPage', () => undefined),
    record('commands.getAll', () => []),
    record('browserAction.setBadgeText', () => undefined),
    record('browserAction.openPopup', () => undefined),
    record('browserAction.activate', () => undefined),
    record('browserAction.openPopup', () => undefined),
    record('browserAction.getState', () => ({ actions: [] })),
    record('browserAction.addObserver', () => undefined),
    record('browserAction.removeObserver', () => undefined)
  ])
  const sent: Array<{ target: string | undefined; name: string; args: unknown[] }> = []
  // The library records a listener under the extension the message names, whoever sent it.
  const listened: Array<{ listener: EceListener; id: string; name: string }> = []
  const unlistened: Array<{ listener: EceListener; id: string; name: string }> = []
  // As in the library: the receivers of the two messages make the listener (the sender of a page is kept in it, nothing of a worker) and hand it to the router as it is then.
  const made = (event: { type?: unknown; sender?: unknown }, id: string): EceListener => (event.type === 'frame' ? { type: event.type, extensionId: id, host: event.sender } : { type: event.type, extensionId: id })
  const router: EceRouter = {
    handlers,
    sendEvent: (target, name, ...args) => void sent.push({ target, name, args }),
    addListener: (listener, id, name) => void listened.push({ listener, id, name }),
    removeListener: (listener, id, name) => void unlistened.push({ listener, id, name }),
    delegate: { onAddListener: (event, id, name) => router.addListener(made(event, id), id, name), onRemoveListener: (event, id, name) => router.removeListener(made(event, id), id, name) }
  }
  return { router, calls, sent, listened, unlistened }
}

/** What the library hands a handler for a call from a page of the interface: no extension, and a sender in the application's own session. */
const INTERFACE = { session: 'the default session', getURL: () => 'file:///app/index.html' }
/** A page of an extension (a popup, an options page, a tab), as the library sees the sender of its calls. */
const pageOf = (id: string) => ({ getURL: () => `chrome-extension://${id}/popup.html` })
/** The service worker of an extension. */
const workerOf = (id: string) => ({ scope: `chrome-extension://${id}/` })

function guarded(manifests: Record<string, unknown>, shownTab?: number, openChromePage?: (extensionId: string, address: string) => boolean, permissions?: NonNullable<LibraryGuard['permissions']>, answers?: Record<string, (...args: unknown[]) => unknown>, lentStyle?: LibraryGuard['lentStyle']) {
  const lib = library(answers)
  const grants = new ActiveTabGrants()
  const activated: Array<[string, number | undefined]> = []
  const refused: Array<[string, string[]]> = []
  const original = lib.router.sendEvent
  restrictLibraryApis(lib.router, {
    grants,
    refused: (id, asked) => void refused.push([id, asked]),
    tabUrl: (n) => (n === 1 ? TAB.url : undefined),
    manifestOf: (id) => manifests[id],
    extensionIds: () => Object.keys(manifests),
    activated: (id, tab) => void activated.push([id, tab]),
    fromInterface: (sender) => sender === INTERFACE,
    shownTabOfSender: () => shownTab,
    activeTabOfSender: () => shownTab,
    ...(openChromePage ? { openChromePage } : {}),
    ...(permissions ? { permissions } : {}),
    ...(lentStyle ? { lentStyle } : {})
  })
  /** A call from a page of the extension it names. */
  const call = (name: string, id: string, ...args: unknown[]) => lib.router.handlers.get(name)!.callback({ extension: { id, manifest: manifests[id] }, sender: pageOf(id) }, ...args)
  /** A call with the event the library would build: who it names, and who really sent it. */
  const callAs = (name: string, event: { extension?: { id: string; manifest?: unknown }; sender?: unknown }, ...args: unknown[]) => lib.router.handlers.get(name)!.callback(event, ...args)
  return { ...lib, call, callAs, grants, activated, refused, original }
}

const manifest = (permissions: string[] = [], host_permissions: string[] = []) => ({ permissions, host_permissions })

describe('extensionMenuItems', () => {
  /**
   * The library as it builds the menu: it reads `api.contextMenus.menus` and keys the entries by the id the extension gave them, across extensions, so
   * that two entries called "open" come out as the last one twice.
   */
  function fakeLibrary(menus: Record<string, string[]>) {
    const api = { contextMenus: { menus: new Map(Object.entries(menus).map(([extension, ids]) => [extension, new Map(ids.map((id) => [id, { id, title: `${extension}:${id}` }]))])) } }
    const original = api.contextMenus.menus
    const built: string[][] = []
    const extensions = {
      api,
      getContextMenuItems: () => {
        const byId = new Map<string, string>()
        const templates: string[] = []
        for (const items of api.contextMenus.menus.values()) {
          for (const [id, props] of items as Map<string, { id: string; title: string }>) {
            byId.set(id, props.title)
            templates.push(id)
          }
        }
        built.push([...api.contextMenus.menus.keys()])
        return templates.map((id) => ({ label: byId.get(id) }))
      }
    }
    return { extensions: extensions as never, api, original, built }
  }

  it('lists the entries of every extension, each its own, even when two extensions gave their entries the same id', () => {
    const { extensions, built } = fakeLibrary({ ext1: ['open'], ext2: ['open', 'save'] })
    const items = extensionMenuItems<{ label: string }>(extensions, {} as never, {} as never, vi.fn())
    expect(items.map((item) => item.label)).toEqual(['ext1:open', 'ext2:open', 'ext2:save'])
    expect(built).toEqual([['ext1'], ['ext2']])
  })

  it('puts the library\'s own entries back, whatever happened while they were built', () => {
    const { extensions, api, original } = fakeLibrary({ ext1: ['a'], ext2: ['b'] })
    extensionMenuItems(extensions, {} as never, {} as never, vi.fn())
    expect(api.contextMenus.menus).toBe(original)
    const broken = { ...(extensions as object), getContextMenuItems: () => { throw new Error('boom') } } as never
    ;(broken as { api: unknown }).api = api
    extensionMenuItems(broken, {} as never, {} as never, vi.fn())
    expect(api.contextMenus.menus).toBe(original)
  })

  it('keeps the entries of the other extensions when one cannot be built: that one is left out, and the reason is logged', () => {
    const { extensions, api } = fakeLibrary({ ext1: ['a'], ext2: ['b'] })
    const build = (extensions as unknown as { getContextMenuItems: () => unknown[] }).getContextMenuItems
    ;(extensions as unknown as { getContextMenuItems: () => unknown[] }).getContextMenuItems = () => {
      if ((api.contextMenus.menus as Map<string, unknown>).has('ext1')) throw new Error('Invalid menu item type')
      return build()
    }
    const warn = vi.fn()
    const items = extensionMenuItems<{ label: string }>(extensions, {} as never, {} as never, warn)
    expect(items.map((item) => item.label)).toEqual(['ext2:b'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ext1'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid menu item type'))
  })

  it('keeps the menu of the page, and says why the entries are missing, when the library keeps them somewhere else', () => {
    const warn = vi.fn()
    expect(extensionMenuItems({ api: {} } as never, {} as never, {} as never, warn)).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('changed its internals'))
  })
})

describe('restrictLibraryApis: calls', () => {
  it('refuses the cookies to an extension that only declared storage, and reads none of them', async () => {
    const { call, calls } = guarded({ [ME]: manifest(['storage'], ['<all_urls>']) })
    for (const [name, arg] of [['cookies.getAll', {}], ['cookies.get', { url: 'https://bank.example/', name: 'sid' }], ['cookies.set', { url: 'https://bank.example/', name: 'sid', value: 'x' }], ['cookies.remove', { url: 'https://bank.example/', name: 'sid' }], ['cookies.getAllCookieStores', undefined]] as const) {
      await expect(Promise.resolve().then(() => call(name, ME, arg)), name).rejects.toThrow(/no permission to use chrome\.cookies/)
    }
    expect(calls.filter((c) => c.name.startsWith('cookies.'))).toEqual([])
  })

  it('gives an extension with "cookies" the cookies of the sites it has a host permission for, and no other', async () => {
    const { call } = guarded({ [ME]: manifest(['cookies'], ['https://bank.example/*']) })
    expect(await call('cookies.getAll', ME, {})).toEqual([COOKIES[0]])
    expect(await call('cookies.get', ME, { url: 'https://bank.example/', name: 'sid' })).toEqual(COOKIES[0])
    await expect(Promise.resolve().then(() => call('cookies.get', ME, { url: 'https://news.example/', name: 'pref' }))).rejects.toThrow(/permission to access this host/)
    await expect(Promise.resolve().then(() => call('cookies.getAll', ME, { url: 'https://news.example/' }))).rejects.toThrow(/permission to access this host/)
  })

  it('refuses web navigation, menus and notifications without their permission, and serves them with it', async () => {
    const without = guarded({ [ME]: manifest(['storage']) })
    for (const name of ['webNavigation.getFrame', 'webNavigation.getAllFrames', 'contextMenus.create', 'contextMenus.remove', 'contextMenus.removeAll', 'notifications.create', 'notifications.clear', 'notifications.getAll', 'notifications.update', 'notifications.getPermissionLevel']) {
      await expect(Promise.resolve().then(() => without.call(name, ME, {})), name).rejects.toThrow(/no permission/)
    }
    const withIt = guarded({ [ME]: manifest(['webNavigation', 'contextMenus', 'notifications']) })
    expect(await withIt.call('webNavigation.getAllFrames', ME, { tabId: 1 })).toEqual([{ url: 'https://bank.example/' }])
    expect(await withIt.call('notifications.create', ME, {})).toBe('id')
  })

  it('hides the address and the title of the tabs from an extension with no access to them, whichever call returns them', async () => {
    const { call, calls } = guarded({ [ME]: manifest(['storage']) })
    const stripped = { id: 1, active: true, windowId: 3, index: 0 }
    expect(await call('tabs.get', ME, 1)).toEqual(stripped)
    expect(await call('tabs.getAllInWindow', ME, 3)).toEqual([stripped])
    expect(await call('tabs.getCurrent', ME)).toEqual(stripped)
    expect(await call('tabs.create', ME, { url: 'https://example.com/' })).toEqual(stripped)
    expect(await call('tabs.update', ME, 1, { muted: true })).toEqual(stripped)
    expect(await call('tabs.query', ME, {})).toEqual([stripped, { id: 2, active: true, windowId: 3, index: 0 }])
    expect(await call('windows.getAll', ME)).toEqual([{ id: 3, tabs: [stripped] }])
    expect(await call('windows.getLastFocused', ME)).toEqual({ id: 3, tabs: [stripped] })
    expect(calls.length).toBeGreaterThan(0)
    // The library's cached object was not touched.
    expect(TAB.url).toBe('https://bank.example/account')
  })

  it('shows them to an extension that declared "tabs", and to one with a host permission for the page', async () => {
    expect(await guarded({ [ME]: manifest(['tabs']) }).call('tabs.get', ME, 1)).toBe(TAB)
    const hosted = guarded({ [ME]: manifest([], ['https://bank.example/*']) })
    expect((await hosted.call('tabs.query', ME, {})) as unknown[]).toEqual([TAB, { id: 2, active: true, windowId: 3, index: 0 }])
  })

  it('matches a title or an address in a query only against the tabs the extension may read', async () => {
    const hosted = guarded({ [ME]: manifest([], ['https://bank.example/*']) })
    expect(await hosted.call('tabs.query', ME, { title: 'My *' })).toEqual([{ ...TAB, index: 0 }])
    expect(await hosted.call('tabs.query', ME, { url: '*://news.example/*' })).toEqual([])
    expect(await hosted.call('tabs.query', ME, { url: 'https://bank.example/*' })).toEqual([{ ...TAB, index: 0 }])
    const blind = guarded({ [ME]: manifest(['storage']) })
    expect(await blind.call('tabs.query', ME, { title: 'My *' })).toEqual([])
    // The filter is not handed to the library: it would build a regular expression from it.
    expect(blind.calls.find((c) => c.name === 'tabs.query')!.args[0]).toEqual({})
  })

  it('refuses a tab in a window of another profile, and lets a window of its own profile, or none, through', async () => {
    const lib = library()
    restrictLibraryApis(lib.router, { grants: new ActiveTabGrants(), tabUrl: () => undefined, manifestOf: () => manifest(['tabs']), extensionIds: () => [], activated: () => {}, fromInterface: () => false, ownsWindow: (id) => id === 3 })
    const create = (props: Record<string, unknown>) => lib.router.handlers.get('tabs.create')!.callback({ extension: { id: ME, manifest: manifest(['tabs']) }, sender: pageOf(ME) }, props)
    await expect(create({ url: 'https://example.com/', windowId: 9 })).rejects.toThrow('No window with id: 9')
    expect(lib.calls.filter((c) => c.name === 'tabs.create')).toEqual([])
    await create({ url: 'https://example.com/', windowId: 3 })
    await create({ url: 'https://example.com/' })
    // chrome.windows.WINDOW_ID_CURRENT names no window in particular.
    await create({ url: 'https://example.com/', windowId: -2 })
    expect(lib.calls.filter((c) => c.name === 'tabs.create')).toHaveLength(3)
  })

  it('closes only a window of its own profile with chrome.windows.remove', async () => {
    const lib = library()
    restrictLibraryApis(lib.router, { grants: new ActiveTabGrants(), tabUrl: () => undefined, manifestOf: () => manifest(['tabs']), extensionIds: () => [], activated: () => {}, fromInterface: () => false, ownsWindow: (id) => id === 3 })
    const remove = (id: unknown) => lib.router.handlers.get('windows.remove')!.callback({ extension: { id: ME, manifest: manifest(['tabs']) }, sender: pageOf(ME) }, id)
    await expect(remove(9)).rejects.toThrow('No window with id: 9')
    await expect(remove('3')).rejects.toThrow('No window with id: 3')
    expect(lib.calls.filter((c) => c.name === 'windows.remove')).toEqual([])
    await remove(3)
    expect(lib.calls.filter((c) => c.name === 'windows.remove').map((c) => c.args[0])).toEqual([3])
  })

  it('lists the tabs of the window that had the focus last for currentWindow and lastFocusedWindow, the other windows of the profile for false, and every one for neither', async () => {
    const lib = library()
    // Two windows of one profile: 3 (the one that had the focus last, see windows.getLastFocused below) and 4, each with the tab on screen and one more.
    const tab = (id: number, windowId: number, active: boolean) => ({ id, windowId, active, index: -1, url: `https://site.example/${id}`, title: `T${id}` })
    const asked: unknown[] = []
    lib.router.handlers.get('tabs.query')!.callback = (_event, query) => (asked.push(query), [tab(1, 3, true), tab(2, 3, false), tab(5, 4, true), tab(6, 4, false)].filter((t) => (query as { active?: boolean }).active === undefined || t.active === (query as { active?: boolean }).active))
    restrictLibraryApis(lib.router, { grants: new ActiveTabGrants(), tabUrl: () => undefined, manifestOf: () => manifest(['tabs']), extensionIds: () => [], activated: () => {}, fromInterface: () => false })
    const query = (q: Record<string, unknown>) => lib.router.handlers.get('tabs.query')!.callback({ extension: { id: ME, manifest: manifest(['tabs']) }, sender: pageOf(ME) }, q) as Promise<Array<{ id: number; index: number }>>
    expect((await query({ active: true, currentWindow: true })).map((t) => t.id)).toEqual([1])
    expect((await query({ currentWindow: true })).map((t) => [t.id, t.index])).toEqual([[1, 0], [2, 1]])
    expect((await query({ active: true, lastFocusedWindow: true })).map((t) => t.id)).toEqual([1])
    expect((await query({ active: true, currentWindow: false })).map((t) => t.id)).toEqual([5])
    expect((await query({ active: true })).map((t) => t.id)).toEqual([1, 5])
    // The library is not asked about a filter it does not read.
    expect(asked[0]).toEqual({ active: true })
  })

  it('lists the tabs as it always did when the library has no window that had the focus last (a query with currentWindow does not come back empty)', async () => {
    const lib = library()
    lib.router.handlers.get('windows.getLastFocused')!.callback = () => null
    lib.router.handlers.get('tabs.query')!.callback = () => [{ id: 1, windowId: 3, active: true, index: -1 }]
    restrictLibraryApis(lib.router, { grants: new ActiveTabGrants(), tabUrl: () => undefined, manifestOf: () => manifest(['tabs']), extensionIds: () => [], activated: () => {}, fromInterface: () => false })
    const query = (q: Record<string, unknown>) => lib.router.handlers.get('tabs.query')!.callback({ extension: { id: ME, manifest: manifest(['tabs']) }, sender: pageOf(ME) }, q) as Promise<Array<{ id: number }>>
    expect((await query({ active: true, currentWindow: true })).map((t) => t.id)).toEqual([1])
  })

  it('answers a query by a pattern of stars at once', async () => {
    const { call } = guarded({ [ME]: manifest(['tabs']) })
    const start = performance.now()
    expect(await call('tabs.query', ME, { title: '*a'.repeat(14) + '*b', url: '*a'.repeat(14) + '*b' })).toEqual([])
    expect(performance.now() - start).toBeLessThan(100)
  })

  it('opens in a tab only a web page, the blank page and its own pages', async () => {
    const { call, calls } = guarded({ [ME]: manifest(['tabs']) })
    for (const url of ['file:///etc/passwd', 'data:text/html,<b>x</b>', 'blob:https://a.example/u', 'view-source:https://a.example/', `chrome-extension://${OTHER}/p.html`, 'chrome://settings', 'javascript:alert(1)']) {
      await expect(Promise.resolve().then(() => call('tabs.create', ME, { url })), url).rejects.toThrow('Invalid URL')
      await expect(Promise.resolve().then(() => call('tabs.update', ME, 1, { url })), url).rejects.toThrow('Invalid URL')
      await expect(Promise.resolve().then(() => call('tabs.update', ME, { url })), url).rejects.toThrow('Invalid URL')
    }
    expect(calls.filter((c) => c.name === 'tabs.create' || c.name === 'tabs.update')).toEqual([])
    await call('tabs.create', ME, { url: 'https://example.com/' })
    await call('tabs.create', ME, { url: 'chrome://newtab' })
    await call('tabs.create', ME, { url: 'panel.html' })
    await call('tabs.create', ME, {})
    await call('tabs.update', ME, 1, { url: `chrome-extension://${ME}/panel.html` })
    expect(calls.filter((c) => c.name === 'tabs.create').map((c) => (c.args[0] as { url?: string }).url)).toEqual(['https://example.com/', 'about:blank', `chrome-extension://${ME}/panel.html`, undefined])
  })

  it('opens the page of the browser that stands for chrome://extensions, and makes no tab', async () => {
    const opened: Array<[string, string]> = []
    const { call, calls } = guarded({ [ME]: manifest() }, undefined, (id, address) => {
      opened.push([id, address])
      return address.startsWith('chrome://extensions')
    })
    // No tab: an answer that names none, and nothing handed to the library.
    expect(await call('tabs.create', ME, { url: 'chrome://extensions/shortcuts' })).toEqual(NO_TAB)
    expect(await call('tabs.create', ME, { url: 'chrome://extensions', active: false })).toEqual(NO_TAB)
    expect(calls.filter((c) => c.name === 'tabs.create')).toEqual([])
    expect(opened).toEqual([[ME, 'chrome://extensions/shortcuts'], [ME, 'chrome://extensions']])
    expect((NO_TAB as { id?: number }).id).toBeUndefined()
  })

  it('leaves the tab alone but for its address when an update asks for one of the browser\'s pages: its other properties still apply', async () => {
    const { call, calls } = guarded({ [ME]: manifest(['tabs']) }, undefined, (_id, address) => address === 'chrome://extensions')
    await call('tabs.update', ME, 1, { url: 'chrome://extensions', muted: true })
    await call('tabs.update', ME, { url: 'chrome://extensions', pinned: true })
    expect(calls.filter((c) => c.name === 'tabs.update').map((c) => c.args)).toEqual([[1, { muted: true }], [{ pinned: true }]])
  })

  it('still refuses an address of the browser that nothing stands for, and any other it refused before', async () => {
    const { call, calls } = guarded({ [ME]: manifest(['tabs']) }, undefined, () => false)
    for (const url of ['chrome://nothing-like-this', 'chrome://settings', 'file:///etc/passwd']) {
      await expect(Promise.resolve().then(() => call('tabs.create', ME, { url })), url).rejects.toThrow('Invalid URL')
      await expect(Promise.resolve().then(() => call('tabs.update', ME, 1, { url })), url).rejects.toThrow('Invalid URL')
    }
    expect(calls.filter((c) => c.name === 'tabs.create' || c.name === 'tabs.update')).toEqual([])
  })

  it('hands a web address to the library as before, and opens nothing for a call another extension makes in the name of this one', async () => {
    const asked: string[] = []
    const { call, callAs, calls } = guarded({ [ME]: manifest(), [OTHER]: manifest() }, undefined, (_id, address) => (asked.push(address), address.startsWith('chrome://')))
    await call('tabs.create', ME, { url: 'https://example.com/' })
    expect(calls.filter((c) => c.name === 'tabs.create')).toHaveLength(1)
    // `OTHER` calls in the name of `ME`: refused before the browser is asked to open anything.
    asked.length = 0
    expect(() => callAs('tabs.create', { extension: { id: ME, manifest: manifest() }, sender: pageOf(OTHER) }, { url: 'chrome://extensions' })).toThrow(/in the name of/)
    expect(asked).toEqual([])
  })

  it('opens in a window only what it could open in a tab', async () => {
    const { call, calls } = guarded({ [ME]: manifest() })
    await expect(Promise.resolve().then(() => call('windows.create', ME, { url: 'file:///etc/passwd' }))).rejects.toThrow('Invalid URL')
    await expect(Promise.resolve().then(() => call('windows.create', ME, { url: ['https://a.example/', `chrome-extension://${OTHER}/x.html`] }))).rejects.toThrow('Invalid URL')
    expect(calls.filter((c) => c.name === 'windows.create')).toEqual([])
    await call('windows.create', ME, { url: ['https://a.example/', 'https://b.example/'] })
    await call('windows.create', ME, { type: 'popup' })
    expect(calls.filter((c) => c.name === 'windows.create')).toHaveLength(2)
  })

  it('puts a style in a page only for an extension that has a host permission for it, or was handed the tab', async () => {
    const blind = guarded({ [ME]: manifest(['tabs']) })
    await expect(Promise.resolve().then(() => blind.call('tabs.insertCSS', ME, 1, { code: 'body{display:none}' }))).rejects.toThrow(/permission to access this host/)
    expect(blind.calls.filter((c) => c.name === 'tabs.insertCSS')).toEqual([])
    const hosted = guarded({ [ME]: manifest([], ['https://bank.example/*']) })
    await hosted.call('tabs.insertCSS', ME, 1, { code: 'body{}' })
    expect(hosted.calls.filter((c) => c.name === 'tabs.insertCSS')).toHaveLength(1)
    const handed = guarded({ [ME]: manifest(['activeTab']) })
    handed.grants.grant(ME, 1, TAB.url)
    await handed.call('tabs.insertCSS', ME, 1, { code: 'body{}' })
    expect(handed.calls.filter((c) => c.name === 'tabs.insertCSS')).toHaveLength(1)
  })

  // The library puts the sheet in whatever document the tab has when its message gets there, and judges nothing about it: for the loan of a click the engine does it, and has the document confirm the origin.
  it('has a style sheet for a tab that was lent put in by the engine, which has the document confirm the origin, and not by the library', async () => {
    const lent: Array<[string, number, string]> = []
    const handed = guarded({ [ME]: manifest(['activeTab']) }, undefined, undefined, undefined, undefined, async (id, tab, css) => void lent.push([id, tab, css]))
    handed.grants.grant(ME, 1, TAB.url)
    await handed.call('tabs.insertCSS', ME, 1, { code: 'body{}' })
    expect(lent).toEqual([[ME, 1, 'body{}']])
    expect(handed.calls.filter((c) => c.name === 'tabs.insertCSS')).toEqual([])
    // A refusal of the engine (the tab left the origin that was lent) is the answer of the call.
    const refusing = guarded({ [ME]: manifest(['activeTab']) }, undefined, undefined, undefined, undefined, async () => {
      throw new Error('Cannot access contents of the page.')
    })
    refusing.grants.grant(ME, 1, TAB.url)
    await expect(refusing.call('tabs.insertCSS', ME, 1, { code: 'body{}' })).rejects.toThrow('Cannot access contents of the page.')
  })

  it('leaves the library to put a style in for an extension that holds the host permission of the page: it is not asked for a loan', async () => {
    const lent: unknown[] = []
    const hosted = guarded({ [ME]: manifest(['activeTab'], ['https://bank.example/*']) }, undefined, undefined, undefined, undefined, async (...args) => void lent.push(args))
    hosted.grants.grant(ME, 1, TAB.url)
    await hosted.call('tabs.insertCSS', ME, 1, { code: 'body{}' })
    expect(lent).toEqual([])
    expect(hosted.calls.filter((c) => c.name === 'tabs.insertCSS')).toHaveLength(1)
    // And a tab that was not lent never reaches the engine.
    const blind = guarded({ [ME]: manifest(['activeTab']) }, undefined, undefined, undefined, undefined, async (...args) => void lent.push(args))
    await expect(Promise.resolve().then(() => blind.call('tabs.insertCSS', ME, 1, { code: 'body{}' }))).rejects.toThrow(/permission to access this host/)
    expect(lent).toEqual([])
  })

  it('answers a request for a permission by what the manifest holds', async () => {
    const { call, calls } = guarded({ [ME]: manifest(['tabs']) })
    expect(await call('permissions.request', ME, { permissions: ['cookies'] })).toBe(false)
    expect(await call('permissions.request', ME, { permissions: ['tabs'] })).toBe(true)
    expect(calls.filter((c) => c.name === 'permissions.request')).toEqual([])
  })

  it('says what was refused of a request for optional permissions, for the journal of the extension, and nothing when all of it is held', async () => {
    const { call, refused } = guarded({ [ME]: manifest(['tabs']) })
    await call('permissions.request', ME, { permissions: ['tabs'] })
    expect(refused).toEqual([])
    await call('permissions.request', ME, { permissions: ['tabs', 'cookies'], origins: ['https://*/*'] })
    expect(refused).toEqual([[ME, ['cookies', 'https://*/*']]])
  })

  describe('chrome.permissions, where the profile can ask the person', () => {
    const profile = () => ({
      request: vi.fn(async (_id: string, _request: unknown, _sender: unknown) => true),
      contains: vi.fn((_id: string, _request: unknown) => false),
      getAll: vi.fn((_id: string) => ({ permissions: ['tabs'], origins: [] as string[] })),
      remove: vi.fn((_id: string, _request: unknown) => true)
    })

    it('hands a request to the profile, in the name of the extension that really sent it and with the page that asked; the library grants nothing itself', async () => {
      const permissions = profile()
      const { callAs, calls, refused } = guarded({ [ME]: manifest(['tabs']) }, undefined, undefined, permissions)
      const sender = pageOf(ME)
      const request = { permissions: ['cookies'] }
      expect(await callAs('permissions.request', { extension: { id: ME, manifest: manifest(['tabs']) }, sender }, request)).toBe(true)
      expect(permissions.request).toHaveBeenCalledExactlyOnceWith(ME, request, sender)
      expect(calls.filter((c) => c.name.startsWith('permissions.'))).toEqual([])
      expect(refused).toEqual([])
    })

    it('answers contains, getAll and remove from the profile, never from the table of the library', async () => {
      const permissions = profile()
      const { call, calls } = guarded({ [ME]: manifest(['tabs']) }, undefined, undefined, permissions)
      expect(await call('permissions.contains', ME, { permissions: ['cookies'] })).toBe(false)
      expect(await call('permissions.getAll', ME)).toEqual({ permissions: ['tabs'], origins: [] })
      expect(await call('permissions.remove', ME, { permissions: ['cookies'] })).toBe(true)
      expect(permissions.contains).toHaveBeenCalledExactlyOnceWith(ME, { permissions: ['cookies'] })
      expect(permissions.getAll).toHaveBeenCalledExactlyOnceWith(ME)
      expect(permissions.remove).toHaveBeenCalledExactlyOnceWith(ME, { permissions: ['cookies'] })
      expect(calls.filter((c) => c.name.startsWith('permissions.'))).toEqual([])
    })

    it('refuses a request made in the name of another extension before the profile hears of it', async () => {
      const permissions = profile()
      const { callAs } = guarded({ [ME]: manifest(['tabs']), [OTHER]: manifest() }, undefined, undefined, permissions)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      expect(() => callAs('permissions.request', { extension: { id: ME, manifest: manifest(['tabs']) }, sender: pageOf(OTHER) }, { permissions: ['cookies'] })).toThrow('in the name of')
      expect(permissions.request).not.toHaveBeenCalled()
    })
  })

  it('judges a call on the manifest the profile reads, which holds what the person granted, not on the one of the files', async () => {
    // The library hands the manifest of the files; the profile's has the site and the permission that were granted on request.
    const files = manifest()
    const held: Record<string, unknown> = { [ME]: files }
    const { callAs } = guarded(held)
    const event = { extension: { id: ME, manifest: files }, sender: pageOf(ME) }
    expect(await callAs('tabs.get', event, 1)).not.toHaveProperty('url')
    await expect(callAs('cookies.getAll', event, {})).rejects.toThrow('no permission')
    held[ME] = manifest(['cookies'], ['https://bank.example/*'])
    expect(await callAs('tabs.get', event, 1)).toMatchObject({ url: TAB.url })
    expect(await callAs('cookies.getAll', event, {})).toEqual(COOKIES.filter((cookie) => String(cookie.domain).endsWith('bank.example')))
  })

  it('hands the tab to an extension whose icon was clicked', async () => {
    const { callAs, activated } = guarded({ [ME]: manifest(['activeTab']) })
    // The click is made in the interface: no extension named by the library, a sender of the application's own session.
    await callAs('browserAction.activate', { sender: INTERFACE }, { eventType: 'click', extensionId: ME, tabId: 1 })
    await callAs('browserAction.activate', { sender: INTERFACE }, { eventType: 'click', extensionId: ME, tabId: -1 })
    await callAs('browserAction.activate', { sender: INTERFACE }, { eventType: 'contextmenu', extensionId: ME, tabId: 1 })
    expect(activated).toEqual([[ME, 1], [ME, undefined]])
  })

  it('gives the click the tab on screen in the window of the icon, whether the icon names none or names the tab of another window of the profile', async () => {
    const { callAs, activated, calls } = guarded({ [ME]: manifest(['activeTab']) }, 42)
    await callAs('browserAction.activate', { sender: INTERFACE }, { eventType: 'click', extensionId: ME, tabId: -1 })
    // Two windows on one profile: the icon of this window carries the number of the tab of the other one (the library's state is one per profile).
    await callAs('browserAction.activate', { sender: INTERFACE }, { eventType: 'click', extensionId: ME, tabId: 7 })
    expect(activated).toEqual([[ME, 42], [ME, 42]])
    // What the library receives is what decides the tab it acts on, and the window its popup hangs from.
    expect(calls.filter((c) => c.name === 'browserAction.activate').map((c) => (c.args[0] as { tabId: number }).tabId)).toEqual([42, 42])
  })

  it('keeps the tab the icon names for a window that shows none of the profile (the click is not turned into a new tab there)', async () => {
    const { callAs, activated, calls } = guarded({ [ME]: manifest(['activeTab']) })
    await callAs('browserAction.activate', { sender: INTERFACE }, { eventType: 'click', extensionId: ME, tabId: 7 })
    expect(activated).toEqual([[ME, 7]])
    expect(calls.filter((c) => c.name === 'browserAction.activate').map((c) => (c.args[0] as { tabId: number }).tabId)).toEqual([7])
  })

  it('answers the toolbar of a window with the tab on screen in that window and what the extensions set for it', async () => {
    const lib = library()
    // The library's answer: the tab of the window that had the focus last (10), a badge for every tab and one for each of two tabs.
    lib.router.handlers.get('browserAction.getState')!.callback = () => ({ activeTabId: 10, actions: [{ id: ME, text: 'G', tabs: { '10': { text: '1' }, '20': { text: 'b' } } }] })
    restrictLibraryApis(lib.router, { grants: new ActiveTabGrants(), tabUrl: () => undefined, manifestOf: () => undefined, extensionIds: () => [], activated: () => {}, fromInterface: (sender) => sender === INTERFACE, shownTabOfSender: () => 20 })
    const state = (await lib.router.handlers.get('browserAction.getState')!.callback({ sender: INTERFACE })) as { activeTabId: number; actions: Array<{ text: string }> }
    expect(state.activeTabId).toBe(20)
    expect(state.actions[0]!.text).toBe('b')
  })

  it('leaves the click as it is when the window of the icon shows no tab', async () => {
    const { callAs, activated, calls } = guarded({ [ME]: manifest(['activeTab']) })
    await callAs('browserAction.activate', { sender: INTERFACE }, { eventType: 'click', extensionId: ME, tabId: -1 })
    expect(activated).toEqual([[ME, undefined]])
    expect(calls.filter((c) => c.name === 'browserAction.activate').map((c) => (c.args[0] as { tabId: number }).tabId)).toEqual([-1])
  })

  it('refuses a call that does not come from an extension', async () => {
    const { router } = guarded({ [ME]: manifest(['cookies']) })
    await expect(Promise.resolve().then(() => router.handlers.get('cookies.getAll')!.callback({ sender: {} }, {}))).rejects.toThrow('unknown extension context')
  })
})

describe('restrictLibraryApis: who is calling', () => {
  const manifests = { [ME]: manifest(['tabs', 'cookies', 'activeTab'], ['<all_urls>']), [OTHER]: manifest(['storage']) }
  let warn: MockInstance<typeof console.warn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())
  const every = (router: EceRouter): string[] => [...router.handlers.keys()].filter((name) => !name.startsWith('browserAction.') || name === 'browserAction.setBadgeText' || name === 'browserAction.openPopup')

  it('serves no call in the name of an extension that another extension\'s page makes, whichever handler it is', async () => {
    const { router, callAs, calls } = guarded(manifests)
    // A page of OTHER announcing ME: the library would resolve the caller from the id in the message and give OTHER the manifest of ME.
    for (const name of every(router)) {
      await expect(Promise.resolve().then(() => callAs(name, { extension: { id: ME, manifest: manifests[ME] }, sender: pageOf(OTHER) }, {})), name).rejects.toThrow(`called in the name of ${ME} by the extension ${OTHER}`)
    }
    expect(calls).toEqual([])
    // The calls the library serves without a permission, from the extension's own page, go through.
    const open = ['tabs.remove', 'tabs.reload', 'tabs.goBack', 'tabs.goForward', 'windows.remove', 'runtime.openOptionsPage', 'commands.getAll', 'browserAction.setBadgeText', 'browserAction.openPopup']
    for (const name of open) await callAs(name, { extension: { id: ME, manifest: manifests[ME] }, sender: pageOf(ME) }, {})
    expect(calls.map((c) => c.name)).toEqual(open)
  })

  it('judges a service worker by its scope, and a page that is not an extension\'s, a destroyed one and a missing sender as strangers', async () => {
    const { callAs, calls } = guarded(manifests)
    const as = (sender: unknown, id = ME) => callAs('tabs.remove', { extension: { id, manifest: manifests[id as keyof typeof manifests] }, sender }, 1)
    await expect(Promise.resolve().then(() => as(workerOf(OTHER)))).rejects.toThrow('by the extension')
    await expect(Promise.resolve().then(() => as({ getURL: () => 'https://evil.example/' }))).rejects.toThrow('a page that is not an extension')
    await expect(Promise.resolve().then(() => as({ getURL: () => 'file:///etc/passwd' }))).rejects.toThrow('a page that is not an extension')
    await expect(Promise.resolve().then(() => as({ getURL: () => '' }))).rejects.toThrow('a page that is not an extension')
    await expect(Promise.resolve().then(() => as(undefined))).rejects.toThrow('a page that is not an extension')
    await expect(Promise.resolve().then(() => as({}))).rejects.toThrow('a page that is not an extension')
    expect(calls).toEqual([])
    await as(workerOf(ME))
    expect(calls).toHaveLength(1)
  })

  it('says so in the journal when it refuses, and when it cannot tell where a call came from', async () => {
    const { callAs } = guarded(manifests)
    const destroyed = {
      getURL: () => {
        throw new Error('Object has been destroyed')
      }
    }
    await expect(Promise.resolve().then(() => callAs('tabs.reload', { extension: { id: ME, manifest: manifests[ME] }, sender: destroyed }))).rejects.toThrow('a page that is not an extension')
    expect(warn.mock.calls.map((c) => c.join(' '))).toEqual([
      expect.stringContaining('cannot tell where a call to the extension library came from: Object has been destroyed'),
      expect.stringContaining(`tabs.reload was called in the name of ${ME}`)
    ])
  })

  it('lets only the interface click an icon, read the toolbar and watch it: an extension\'s own page, announcing itself or not, gets nothing', async () => {
    const { callAs, activated, calls } = guarded(manifests)
    const click = { eventType: 'click', extensionId: OTHER, tabId: 1 }
    for (const name of ['browserAction.activate', 'browserAction.getState', 'browserAction.addObserver', 'browserAction.removeObserver']) {
      for (const sender of [pageOf(ME), workerOf(ME), { getURL: () => 'https://evil.example/' }, undefined]) {
        for (const extension of [undefined, { id: ME, manifest: manifests[ME] }]) {
          await expect(Promise.resolve().then(() => callAs(name, { extension, sender }, click)), name).rejects.toThrow('for the interface of the application only')
        }
      }
      await callAs(name, { sender: INTERFACE }, click)
    }
    // Only the interface's four calls got through, and only its click handed OTHER the tab.
    expect(calls.map((c) => c.name)).toEqual(['browserAction.activate', 'browserAction.getState', 'browserAction.addObserver', 'browserAction.removeObserver'])
    expect(activated).toEqual([[OTHER, 1]])
  })

  // `window.electron.addExtensionListener(id, …)` names any extension, and the library records the page under it.
  it('lets a page listen to the events of its own extension only', () => {
    const { router, listened } = guarded(manifests)
    // A page of OTHER asking for the events of ME (which may read every tab and cookie), a site, a page that cannot say what it is, a kind the library does not send to.
    router.addListener({ type: 'frame', extensionId: ME, host: pageOf(OTHER) }, ME, 'tabs.onUpdated')
    router.addListener({ type: 'frame', extensionId: ME, host: { getURL: () => 'https://evil.example/' } }, ME, 'cookies.onChanged')
    router.addListener({ type: 'frame', extensionId: ME, host: undefined }, ME, 'tabs.onUpdated')
    router.addListener({ type: 'unknown', extensionId: ME, host: pageOf(ME) }, ME, 'tabs.onUpdated')
    expect(listened).toEqual([])
    expect(warn.mock.calls.map((c) => c.join(' '))).toContain(`[extensions] refused a listener of tabs.onUpdated in the name of ${ME} from the extension ${OTHER}`)
    router.addListener({ type: 'frame', extensionId: ME, host: pageOf(ME) }, ME, 'tabs.onUpdated')
    expect(listened.map((l) => [l.listener.type, l.id, l.name])).toEqual([['frame', ME, 'tabs.onUpdated']])
  })

  // The message of a worker names any extension too, and the listener the library makes of it keeps nothing of the worker that sent it.
  it('lets a worker listen to the events of its own extension only, and take away its own listeners only', () => {
    const { router, listened, unlistened } = guarded(manifests)
    const fromWorker = (id: string) => ({ type: 'service-worker', serviceWorker: workerOf(id) })
    // The worker of OTHER names ME: recorded, the listener would start the worker of ME at each event; taken away, ME would hear nothing more.
    router.delegate.onAddListener(fromWorker(OTHER), ME, 'tabs.onUpdated')
    router.delegate.onRemoveListener(fromWorker(OTHER), ME, 'tabs.onUpdated')
    // A worker that cannot say what it is, and a listener of a worker that came by another way than its message.
    router.delegate.onAddListener({ type: 'service-worker', serviceWorker: { scope: 'https://evil.example/' } }, ME, 'cookies.onChanged')
    router.addListener({ type: 'service-worker', extensionId: ME }, ME, 'tabs.onUpdated')
    expect(listened).toEqual([])
    expect(unlistened).toEqual([])
    const lines = warn.mock.calls.map((c) => c.join(' '))
    expect(lines).toContain(`[extensions] refused a listener of tabs.onUpdated in the name of ${ME} from the extension ${OTHER}`)
    expect(lines).toContain(`[extensions] refused the removal of a listener of tabs.onUpdated in the name of ${ME} from the extension ${OTHER}`)
    expect(lines).toContain(`[extensions] refused a listener of cookies.onChanged in the name of ${ME} from a page that is not an extension`)
    router.delegate.onAddListener(fromWorker(ME), ME, 'tabs.onUpdated')
    router.delegate.onRemoveListener(fromWorker(ME), ME, 'tabs.onUpdated')
    expect(listened.map((l) => [l.listener.type, l.id, l.name])).toEqual([['service-worker', ME, 'tabs.onUpdated']])
    expect(unlistened.map((l) => [l.listener.type, l.id, l.name])).toEqual([['service-worker', ME, 'tabs.onUpdated']])
    // The name of the worker lasts as long as its message: the next listener that comes without one is refused again.
    router.addListener({ type: 'service-worker', extensionId: ME }, ME, 'tabs.onCreated')
    expect(listened).toHaveLength(1)
  })

  // The worker of an extension just taken out of the profile can still send its listeners: the library throws from its message handler, and
  // nothing caught it (an uncaught exception of the main process). The late message is dropped and said; any other error still goes on.
  it('drops, and says, a listener that comes after its extension left the profile, and lets any other error through', () => {
    const gone = new Error(`extension not registered in session [extensionId:${ME}]`)
    const inner = { add: (): void => { throw gone }, remove: (): void => { throw gone } }
    const lib = library()
    lib.router.addListener = () => inner.add()
    lib.router.removeListener = () => inner.remove()
    restrictLibraryApis(lib.router, { grants: new ActiveTabGrants(), tabUrl: () => undefined, manifestOf: (id) => (manifests as Record<string, unknown>)[id], extensionIds: () => Object.keys(manifests), activated: () => {}, fromInterface: () => false })
    const fromWorker = { type: 'service-worker', serviceWorker: workerOf(ME) }
    expect(() => lib.router.delegate.onAddListener(fromWorker, ME, 'tabs.onUpdated')).not.toThrow()
    expect(() => lib.router.delegate.onRemoveListener(fromWorker, ME, 'tabs.onUpdated')).not.toThrow()
    const lines = warn.mock.calls.map((c) => c.join(' '))
    expect(lines).toContain(`[extensions] ignored a listener of tabs.onUpdated for ${ME}: the extension is no longer loaded in this profile`)
    expect(lines).toContain(`[extensions] ignored the removal of a listener of tabs.onUpdated for ${ME}: the extension is no longer loaded in this profile`)
    inner.add = () => { throw new Error('something else') }
    expect(() => lib.router.delegate.onAddListener(fromWorker, ME, 'tabs.onUpdated')).toThrow('something else')
  })

  it('fails loudly when the library records its listeners some other way, instead of leaving them unguarded', () => {
    const { router } = library()
    const { addListener: _gone, ...without } = router
    const rules = { grants: new ActiveTabGrants(), tabUrl: () => undefined, manifestOf: () => undefined, extensionIds: () => [], activated: () => {}, fromInterface: () => false }
    expect(() => restrictLibraryApis(without as EceRouter, rules)).toThrow('changed its internals')
    // The same when the messages of the workers are received some other way: their sender could no longer be read.
    expect(() => restrictLibraryApis({ ...library().router, delegate: {} } as unknown as EceRouter, rules)).toThrow('changed its internals')
  })
})

describe('extensionOfSender', () => {
  it('reads the extension from the address of a web contents or the scope of a worker, and nothing from anything else', () => {
    expect(extensionOfSender({ getURL: () => `chrome-extension://${ME}/popup.html?x=1#y` })).toBe(ME)
    expect(extensionOfSender({ scope: `chrome-extension://${ME}/` })).toBe(ME)
    // A web contents is judged by its address even when it also has a scope.
    expect(extensionOfSender({ getURL: () => 'https://evil.example/', scope: `chrome-extension://${ME}/` })).toBeUndefined()
    for (const sender of [undefined, null, {}, 'chrome-extension://x/', { getURL: () => 5 }, { getURL: () => 'not a url' }, { getURL: () => `https://${ME}.example/` }, { getURL: () => `chrome://${ME}/` }, { scope: 7 }]) {
      expect(extensionOfSender(sender), JSON.stringify(sender)).toBeUndefined()
    }
  })
})

describe('restrictLibraryApis: events', () => {
  const eventsTo = (sent: Array<{ target: string | undefined; name: string; args: unknown[] }>, id: string) => sent.filter((e) => e.target === id)

  it('sends an event to each extension in its own version, and not to the one that did not declare its API', () => {
    const { router, sent } = guarded({ [ME]: manifest(['tabs', 'webNavigation', 'cookies'], ['https://bank.example/*']), [OTHER]: manifest(['storage']) })
    router.sendEvent(undefined, 'tabs.onCreated', TAB)
    router.sendEvent(undefined, 'webNavigation.onCommitted', { url: 'https://bank.example/' })
    router.sendEvent(undefined, 'cookies.onChanged', { removed: false, cookie: COOKIES[0] })
    router.sendEvent(undefined, 'tabs.onRemoved', 1, { windowId: 3 })
    expect(eventsTo(sent, ME).map((e) => e.name)).toEqual(['tabs.onCreated', 'webNavigation.onCommitted', 'cookies.onChanged', 'tabs.onRemoved'])
    expect(eventsTo(sent, ME)[0]!.args[0]).toBe(TAB)
    expect(eventsTo(sent, OTHER).map((e) => e.name)).toEqual(['tabs.onCreated', 'tabs.onRemoved'])
    expect(eventsTo(sent, OTHER)[0]!.args[0]).toEqual({ id: 1, active: true, windowId: 3, index: 0 })
  })

  it('tells an extension that cannot read a tab nothing of a change of its address', () => {
    const { router, sent } = guarded({ [OTHER]: manifest(['storage']) })
    router.sendEvent(undefined, 'tabs.onUpdated', 1, { url: TAB.url, title: TAB.title }, TAB)
    router.sendEvent(undefined, 'tabs.onUpdated', 1, { status: 'loading', url: TAB.url }, TAB)
    expect(sent.map((e) => e.args[1])).toEqual([{ status: 'loading' }])
  })

  it('sends an event addressed to one extension to that one only, and nothing to an extension it does not know', () => {
    const { router, sent } = guarded({ [ME]: manifest(['tabs']), [OTHER]: manifest(['tabs']) })
    router.sendEvent(ME, 'commands.onCommand', 'run', TAB)
    router.sendEvent('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'commands.onCommand', 'run', TAB)
    expect(sent.map((e) => e.target)).toEqual([ME])
  })
})

describe('keepActionIcon', () => {
  const IMAGE = 'data:image/png;base64,iVBOR'
  /** The library's handler for setIcon: it keeps what it is given, and an icon with nothing in it is what blanks the toolbar button. */
  const setup = () => {
    const kept: unknown[][] = []
    const router = { handlers: new Map<string, EceHandler>([['browserAction.setIcon', { callback: (_event, ...args) => void kept.push(args) }]]) }
    keepActionIcon(router)
    const setIcon = (details: unknown) => router.handlers.get('browserAction.setIcon')!.callback({}, details)
    return { kept, setIcon }
  }

  it('turns the pictures the shims hand over in `path` back into the `imageData` the library draws the icon from, with the tab they are for', () => {
    const { kept, setIcon } = setup()
    setIcon({ tabId: 4, path: { 16: IMAGE, 32: IMAGE } })
    expect(kept).toEqual([[{ tabId: 4, imageData: { 16: IMAGE, 32: IMAGE } }]])
  })

  it('takes a single picture in `path` for the size of the toolbar button', () => {
    const { kept, setIcon } = setup()
    setIcon({ path: IMAGE })
    expect(kept).toEqual([[{ imageData: { 19: IMAGE } }]])
  })

  it('passes the files of the extension, and the images the library already holds, as they are', () => {
    const { kept, setIcon } = setup()
    setIcon({ path: { 16: 'icons/16.png' } })
    setIcon({ path: 'icons/on.png', tabId: 2 })
    setIcon({ imageData: { 16: IMAGE } })
    expect(kept).toEqual([[{ path: { 16: 'icons/16.png' } }], [{ path: 'icons/on.png', tabId: 2 }], [{ imageData: { 16: IMAGE } }]])
  })

  it('does not hand the library a call with nothing to draw: that is what blanked the icon of an extension that draws its own', () => {
    const { kept, setIcon } = setup()
    // What the library's preload sends for `setIcon({ imageData })` in Manifest V3, once it has thrown the picture away.
    setIcon({ imageData: undefined, tabId: 3 })
    setIcon({ tabId: 3 })
    setIcon(undefined)
    expect(kept).toEqual([])
  })

  it('drops the sizes that are not pictures, rather than drawing an address as an icon', () => {
    const { kept, setIcon } = setup()
    setIcon({ path: { 16: IMAGE, 32: 'https://evil.example/x.png', 48: 7 } })
    expect(kept).toEqual([[{ imageData: { 16: IMAGE } }]])
  })

  it('throws when the library no longer has the handler, since the icons would be blanked again without a word', () => {
    expect(() => keepActionIcon({ handlers: new Map() })).toThrow('has no "browserAction.setIcon" handler any more')
  })
})

describe('updateContextMenuItem', () => {
  /** The library keeps the items of each extension in a map by id, in the order they were made. */
  const library = () => {
    const menus = new Map([[ME, new Map<unknown, Record<string, unknown>>([['first', { id: 'first', title: 'One', contexts: ['page'] }], ['second', { id: 'second', title: 'Two' }]])], [OTHER, new Map([['first', { id: 'first', title: 'Not yours' }]])]])
    return { menus, extensions: { api: { contextMenus: { menus } } } as never }
  }

  it('changes the item where it is: what is given replaces, what is not stays, and the order of the menu stays', () => {
    const { menus, extensions } = library()
    updateContextMenuItem(extensions, ME, 'first', { title: 'Saved', enabled: false })
    expect([...menus.get(ME)!.values()]).toEqual([{ id: 'first', title: 'Saved', contexts: ['page'], enabled: false }, { id: 'second', title: 'Two' }])
  })

  it('changes nothing it was not meant to: neither the id, nor the owner, nor another extension\'s item of the same id', () => {
    const { menus, extensions } = library()
    updateContextMenuItem(extensions, ME, 'first', { id: 'stolen', onclick: 'x', title: 'Renamed', extensionId: OTHER })
    expect(menus.get(ME)!.get('first')).toEqual({ id: 'first', title: 'Renamed', contexts: ['page'] })
    expect(menus.get(OTHER)!.get('first')).toEqual({ id: 'first', title: 'Not yours' })
  })

  it('ignores a property given as undefined, as the API does', () => {
    const { menus, extensions } = library()
    updateContextMenuItem(extensions, ME, 'first', { title: undefined, visible: false })
    expect(menus.get(ME)!.get('first')).toEqual({ id: 'first', title: 'One', contexts: ['page'], visible: false })
  })

  it('fails as the API does for an item the extension does not have, or an extension with none', () => {
    const { extensions } = library()
    expect(() => updateContextMenuItem(extensions, ME, 'missing', {})).toThrow('Cannot find menu item with id missing')
    expect(() => updateContextMenuItem(extensions, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'first', {})).toThrow('Cannot find menu item with id first')
  })

  it('fails loudly when the library keeps its menus somewhere else, instead of answering that the item is gone', () => {
    expect(() => updateContextMenuItem({} as never, ME, 'first', {})).toThrow('changed its internals')
    expect(() => updateContextMenuItem({ api: { contextMenus: { menus: {} } } } as never, ME, 'first', {})).toThrow('changed its internals')
  })
})

// ---- a click on an extension's icon, with three windows side by side on one profile (Dashlane clicked in the middle window used to open its popup in the right one) ----

/**
 * The library as it decides where a popup hangs (`activateClick`): the tab it is given, or with none the tab on screen in the window it last saw take the focus; the popup hangs
 * from the window that tab was added with. Windows 11 (left), 12 (middle) and 13 (right) all show a tab of one profile, and the library last saw the right one take the focus.
 */
function sideBySide(over: { shown?: Record<number, number | undefined>; openFails?: boolean; claims?: Record<number, number> } = {}) {
  const windowOfTab = new Map<number, number>([
    [101, 11],
    [102, 12],
    [103, 13]
  ])
  const shown: Record<number, number | undefined> = { 11: 101, 12: 102, 13: 103, ...over.shown }
  const libraryFocus = 13
  const popups: Array<{ tab: number; window: number }> = []
  const opened: Array<{ tab: number; window: number }> = []
  const lib = library()
  lib.router.handlers.get('browserAction.activate')!.callback = (_event, details) => {
    const asked = (details as { tabId: number }).tabId
    const tab = asked >= 0 ? asked : shown[libraryFocus]!
    const window = windowOfTab.get(tab)
    if (window === undefined) throw new Error('Unable to get active tab')
    popups.push({ tab, window })
    return undefined
  }
  type Sender = { session: string; getURL: () => string; window: number }
  const sender = (window: number): Sender => ({ session: 'the default session', getURL: () => 'file:///app/index.html', window })
  restrictLibraryApis(lib.router, {
    grants: new ActiveTabGrants(),
    tabUrl: () => undefined,
    manifestOf: () => undefined,
    extensionIds: () => [],
    activated: () => {},
    fromInterface: (s) => (s as Sender).session === 'the default session',
    shownTabOfSender: (s) => over.claims?.[(s as Sender).window] ?? shown[(s as Sender).window],
    tabInWindowOfSender: (s, tab) => windowOfTab.get(tab) === (s as Sender).window,
    activeTabOfSender: (s) => {
      if (over.openFails) return undefined
      const tab = 200 + opened.length
      windowOfTab.set(tab, (s as Sender).window)
      shown[(s as Sender).window] = tab
      opened.push({ tab, window: (s as Sender).window })
      return tab
    }
  })
  /** A click on the icon of an extension in a window; every icon carries what the library's one state says: the tab on screen in the window it saw last (103), or what the test gives. */
  const click = (window: number, carries: number = shown[libraryFocus]!) =>
    lib.router.handlers.get('browserAction.activate')!.callback({ sender: sender(window) }, { eventType: 'click', extensionId: ME, tabId: carries, alignment: 'bottom left', anchorRect: { x: 10, y: 10, width: 24, height: 24 } })
  return { click, popups, opened, windowOfTab, shown }
}

describe('a click on an extension icon, three windows on one profile', () => {
  it('hangs the popup from the window that was clicked, whichever one the library saw take the focus last', async () => {
    const world = sideBySide()
    for (const window of [11, 12, 13, 12]) await world.click(window)
    expect(world.popups.map((p) => p.window)).toEqual([11, 12, 13, 12])
    expect(world.popups.map((p) => p.tab)).toEqual([101, 102, 103, 102])
  })

  it('gives a window that shows no tab a new one, and hangs the popup from that window, whether its icons carry a tab of another window, none, or a tab that is gone', async () => {
    for (const carries of [103, -1, 999]) {
      const world = sideBySide({ shown: { 12: undefined } })
      await world.click(12, carries)
      expect(world.opened, `icon carrying ${carries}`).toEqual([{ tab: 200, window: 12 }])
      expect(world.popups, `icon carrying ${carries}`).toEqual([{ tab: 200, window: 12 }])
    }
  })

  it('keeps the tab the icon carries for a window that shows none when that tab is in the window, without opening another', async () => {
    const world = sideBySide({ shown: { 12: undefined } })
    world.windowOfTab.set(104, 12)
    await world.click(12, 104)
    expect(world.opened).toEqual([])
    expect(world.popups).toEqual([{ tab: 104, window: 12 }])
  })

  it('opens nothing, rather than a popup in another window, when the window has no tab to give and none can be opened', async () => {
    const world = sideBySide({ shown: { 12: undefined }, openFails: true })
    await expect(world.click(12, 103)).rejects.toThrow('not in the window of the icon')
    expect(world.popups).toEqual([])
  })

  it('opens nothing when the tab it would hand over is in another window than the one clicked', async () => {
    // The window claims the tab of the right one as its own: whatever the reason, the library would hang the popup from the right window.
    const world = sideBySide({ claims: { 12: 103 } })
    await expect(world.click(12)).rejects.toThrow('not in the window of the icon')
    expect(world.popups).toEqual([])
    // The window that really shows it is not affected.
    await world.click(13)
    expect(world.popups).toEqual([{ tab: 103, window: 13 }])
  })
})

describe('the window the user is in, for the library', () => {
  /** The pieces of the library `windowFocusOf` reaches: the windows it knows, and the call that makes one the last focused. */
  const library = (known: number[]) => {
    const told: number[] = []
    const extensions = { ctx: { store: { getWindowById: (id: number) => (known.includes(id) ? { id } : undefined) } }, api: { windows: { onFocusChanged: (id: number) => void told.push(id) } } }
    return { extensions: extensions as never, told, known }
  }

  it('tells the library which window the user is in when the library knows that window', () => {
    const { extensions, told } = library([11, 12, 13])
    const focus = windowFocusOf(extensions)
    focus.follow(12)
    focus.follow(13)
    expect(told).toEqual([12, 13])
  })

  it('says nothing for a window the profile has no page in, and tells the library once that window has one', () => {
    const { extensions, told, known } = library([11, 13])
    const focus = windowFocusOf(extensions)
    focus.follow(12)
    expect(told).toEqual([])
    known.push(12)
    focus.follow(12)
    expect(told).toEqual([12])
  })

  it('fails loudly when the library keeps the windows or the focus somewhere else', () => {
    expect(() => windowFocusOf({} as never)).toThrow('changed its internals')
    expect(() => windowFocusOf({ ctx: { store: {} }, api: { windows: { onFocusChanged: () => {} } } } as never)).toThrow('changed its internals')
    expect(() => windowFocusOf({ ctx: { store: { getWindowById: () => undefined } }, api: { windows: {} } } as never)).toThrow('changed its internals')
  })
})

describe('"the current window" named by an extension', () => {
  it('leaves WINDOW_ID_CURRENT out of tabs.create, so that the tab opens in the window the user is in and not in the first window', async () => {
    const { call, calls } = guarded({ [ME]: manifest(['tabs']) })
    await call('tabs.create', ME, { url: 'https://example.com/', windowId: -2, active: true })
    await call('tabs.create', ME, { url: 'https://example.com/', windowId: 3 })
    const given = calls.filter((c) => c.name === 'tabs.create').map((c) => c.args[0] as Record<string, unknown>)
    expect(given[0]).toEqual({ url: 'https://example.com/', active: true })
    expect(given[1]).toEqual({ url: 'https://example.com/', windowId: 3 })
  })

  it('leaves WINDOW_ID_CURRENT out of action.openPopup, which the library takes for a window that does not exist', async () => {
    const { call, calls } = guarded({ [ME]: manifest() })
    await call('browserAction.openPopup', ME, { windowId: -2 })
    await call('browserAction.openPopup', ME, { windowId: 3 })
    await call('browserAction.openPopup', ME)
    const given = calls.filter((c) => c.name === 'browserAction.openPopup').map((c) => c.args[0])
    expect(given).toEqual([{}, { windowId: 3 }, undefined])
  })
})

// The Extensions page is at `lucium-ui://extensions/`, and chrome://extensions to those who may be told: the library's navigation events and frame answers carry the
// address of the frame as it is, so they go through the same rule as the tabs (shared/extension-access.ts `visibleNavigation`).
describe('restrictLibraryApis: the Extensions page in the navigation of a tab', () => {
  const PAGE = 'lucium-ui://extensions/'
  const THIRD = 'qrstuvwxyzabcdefqrstuvwxyzabcdef'
  const NAVIGATION = ['onBeforeNavigate', 'onCommitted', 'onCompleted', 'onDOMContentLoaded', 'onHistoryStateUpdated', 'onCreatedNavigationTarget', 'onErrorOccurred', 'onReferenceFragmentUpdated']

  it('tells an extension that may read tabs the address of Chrome’s, to another nothing of it, and a page of the web to both as it was', () => {
    const { router, sent } = guarded({ [ME]: manifest(['tabs', 'webNavigation']), [OTHER]: manifest(['webNavigation'], ['<all_urls>']), [THIRD]: manifest(['tabs']) })
    for (const name of NAVIGATION) router.sendEvent(undefined, `webNavigation.${name}`, { tabId: 1, frameId: 0, url: `${PAGE}?id=${ME}`, timeStamp: 5 })
    router.sendEvent(undefined, 'webNavigation.onCommitted', { tabId: 2, frameId: 0, url: 'https://news.example/', timeStamp: 6 })
    const told = (id: string) => sent.filter((e) => e.target === id).map((e) => [e.name, (e.args[0] as { url: string }).url])
    expect(told(ME)).toEqual([...NAVIGATION.map((name) => [`webNavigation.${name}`, `chrome://extensions/?id=${ME}`]), ['webNavigation.onCommitted', 'https://news.example/']])
    // No "tabs": the navigation of the page is not told at all (the host permission covers no address of it); the web is.
    expect(told(OTHER)).toEqual([['webNavigation.onCommitted', 'https://news.example/']])
    // Without the permission of the API the event never reaches the extension, whatever its address.
    expect(told(THIRD)).toEqual([])
    expect(JSON.stringify(sent)).not.toContain('lucium-ui')
  })

  it('keeps what else the details carry, and does not change the details it was given', () => {
    const { router, sent } = guarded({ [ME]: manifest(['tabs', 'webNavigation']) })
    const details = { tabId: 1, frameId: 0, parentFrameId: -1, processId: 4, documentLifecycle: 'active', url: PAGE, timeStamp: 5 }
    router.sendEvent(undefined, 'webNavigation.onCompleted', details)
    expect(sent[0]!.args[0]).toEqual({ ...details, url: 'chrome://extensions/' })
    expect(details.url).toBe(PAGE)
  })

  it('answers getFrame and getAllFrames the same way: Chrome’s address, or the answer for a frame that is not there', async () => {
    const answers = { 'webNavigation.getFrame': () => ({ url: PAGE, frameId: 0, parentFrameId: -1 }), 'webNavigation.getAllFrames': () => [{ url: PAGE, frameId: 0 }, { url: 'https://news.example/embed', frameId: 5 }] }
    const seen = guarded({ [ME]: manifest(['tabs', 'webNavigation']) }, undefined, undefined, undefined, answers)
    expect(await seen.call('webNavigation.getFrame', ME, { tabId: 1, frameId: 0 })).toEqual({ url: 'chrome://extensions/', frameId: 0, parentFrameId: -1 })
    expect(await seen.call('webNavigation.getAllFrames', ME, { tabId: 1 })).toEqual([{ url: 'chrome://extensions/', frameId: 0 }, { url: 'https://news.example/embed', frameId: 5 }])
    const blind = guarded({ [ME]: manifest(['webNavigation'], ['<all_urls>']) }, undefined, undefined, undefined, answers)
    expect(await blind.call('webNavigation.getFrame', ME, { tabId: 1, frameId: 0 })).toBeNull()
    expect(await blind.call('webNavigation.getAllFrames', ME, { tabId: 1 })).toEqual([{ url: 'https://news.example/embed', frameId: 5 }])
  })
})
