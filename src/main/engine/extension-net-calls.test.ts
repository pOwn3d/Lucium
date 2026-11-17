// What the engine answers the shims about the request rules of an extension, about a script for a tab the user lent it, and about what it holds
// (chrome.permissions) (the layers electron-engine-bridge.ts, -extensions.ts and -profile.ts), on stand-ins of the engine, the session and the tab.
// The rules themselves: extension-net.test.ts; which tab counts as lent: shared/active-tab-script.test.ts; what a profile grants:
// optional-grants.test.ts; the same in a real Electron: `smokeProbesExt`.

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ActiveTabGrants } from '@shared/extension-access'
import { guardedScript, NO_PAGE_ACCESS, SCRIPT_WORLDS_FROM, ScriptWorlds } from '@shared/active-tab-script'
import { constructEngine, emitApp } from './engine-constructed.test-support'
import { LentAsks } from './lent-asks'
import { inertEngine, madeSessions, type FakeProfileSession } from '../profile-made.test-support'

const tabs = vi.hoisted(() => new Map<number, unknown>())
vi.mock('electron', async () => (await import('./engine-constructed.test-support')).engineElectron({ fromId: (id: number) => tabs.get(id) }))
vi.mock('electron-chrome-extensions', async () => ({ ElectronChromeExtensions: (await import('../profile-made.test-support')).realLibrary() }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { ExtensionNet } = await import('./extension-net')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const folder = mkdtempSync(join(tmpdir(), 'lucium-lent-'))
writeFileSync(join(folder, 'content.js'), 'document.title')
writeFileSync(join(folder, 'second.js'), 'document.cookie')
writeFileSync(join(folder, 'page.css'), 'body { color: red }')
writeFileSync(join(folder, 'touch.js'), 'touched = true; document.title')
// A file that exists, next to the folder of the extension: it must not be reachable from it.
const outside = `${folder}-outside.js`
writeFileSync(outside, 'document.cookie')
afterAll(() => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(outside, { force: true })
})

const EXT = 'abcdefghijklmnopabcdefghijklmnop'

/**
 * A tab at `url`, which keeps what was run in it and inserted into it. `leaves` sends it to another site: as soon as its address has been read
 * once (`'once-read'`: while the engine reads the files of the extension), or as its first script runs (`'as-it-runs'`).
 * `document` is the page the renderer really has when a script gets there, which this process only learns of later (it hears of a navigation once
 * it has committed): with it the stand-in runs what it is given, for real, against a document of that origin (`world` keeps what a script touched).
 */
function tab(id: number, url: string, leaves?: 'once-read' | 'as-it-runs', document?: { origin: string }) {
  const ran: Array<{ world: number | 'main'; code: string }> = []
  const styles: Array<{ css: string; origin: string }> = []
  const removed: string[] = []
  const world: Record<string, unknown> = { document: { title: 'the page', cookie: '' }, touched: false }
  let address = url
  // The page engine reports a script that threw only as this (measured in Electron 45): the message of the exception is not handed on.
  const runHere = (code: string): unknown => {
    world['location'] = { origin: document?.origin }
    try {
      return runInNewContext(code, world)
    } catch {
      throw new Error('Script failed to execute, this normally means an error was thrown. Check the renderer console for the error.')
    }
  }
  const wc = {
    id,
    isDestroyed: () => false,
    getURL: () => {
      const now = address
      if (leaves === 'once-read') address = 'https://bank.example/account'
      return now
    },
    mainFrame: { executeJavaScript: async (code: string) => (ran.push({ world: 'main', code }), document ? runHere(code) : 'from the page') },
    executeJavaScriptInIsolatedWorld: async (inWorld: number, scripts: Array<{ code: string }>) => {
      ran.push({ world: inWorld, code: scripts[0]!.code })
      if (leaves === 'as-it-runs') address = 'https://bank.example/account'
      return document ? runHere(scripts[0]!.code) : 'from its own world'
    },
    on: () => undefined,
    once: () => undefined,
    insertCSS: async (css: string, options: { cssOrigin: string }) => (styles.push({ css, origin: options.cssOrigin }), `key-${styles.length}`),
    removeInsertedCSS: async (key: string) => void removed.push(key)
  }
  tabs.set(id, wc)
  return { wc, ran, styles, removed, world }
}

/**
 * An engine with the extension loaded in the profile `default`, where it declares `permissions`. With `inWork`, the profile `work` holds
 * another version of it, loaded after, which declares those instead (and those hosts).
 */
function engineWith(permissions: string[], inWork?: { permissions: string[]; hosts?: string[] }) {
  const session = {}
  const workSession = {}
  const net = new ExtensionNet({ readRuleset: async () => [], saved: () => undefined, save: () => undefined, siteOf: () => null, changed: () => undefined, send: () => undefined, warn: () => undefined, ruleGivenUp: () => undefined })
  const manifest = { manifest_version: 3, permissions, host_permissions: [] }
  net.add(EXT, folder, manifest)
  const grants = new ActiveTabGrants()
  const handled: unknown[] = []
  // What makes `chrome.runtime` in the world of a script of a lent tab is tested on its own (lent-tabs.test.ts): here it is asked, and answers that it did.
  const lentTabs = { ensure: vi.fn(async () => true) }
  const work = inWork ? { manifest_version: 3, permissions: inWork.permissions, host_permissions: inWork.hosts ?? [] } : undefined
  const engine = Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    manifests: new Map([[`default:${EXT}`, manifest], ...(work ? [[`work:${EXT}`, work] as const] : [])]),
    profiles: new Map([['default', { session }], ['work', { session: workSession }]]),
    extensionNets: new WeakMap([[session, net]]),
    loaded: new Map([[`default:${EXT}`, { id: EXT }], ...(work ? [[`work:${EXT}`, { id: EXT }] as const] : [])]),
    known: new Map([[`default:${EXT}`, { path: folder }]]),
    tabMeta: new Map<number, { profileId: string }>([[7, { profileId: 'default' }], [8, { profileId: 'work' }]]),
    activeTabs: grants,
    scriptWorlds: new ScriptWorlds(),
    lentTabs,
    lentStyles: new Map(),
    shimHandler: async (call: unknown) => void handled.push(call)
  })
  const call = (api: string, method: string, args: unknown[], context = 'worker:1', profileId = 'default', sender?: unknown): Promise<unknown> =>
    Promise.resolve().then(() => methods['dispatchShim']!.call(engine, EXT, profileId, EXT, api, method, args, context, sender))
  return { engine, net, grants, handled, call, session, workSession, lentTabs }
}

/** A profile `p` made by the real `ensureProfile`, on an engine that keeps the tables of the loaded extensions as the real one does. */
function profileMade() {
  madeSessions.clear()
  const order: string[] = []
  const optionalGrants = { effective: vi.fn((_profile: string, _id: string, manifest: object) => ({ ...manifest, granted: true })), forget: vi.fn() }
  const worker = { relays: { close: vi.fn() }, contextGone: vi.fn(), extensionsChanged: vi.fn() }
  const engine = Object.assign(
    Object.create(ElectronEngine.prototype) as Record<string, unknown>,
    inertEngine({
      pages: new Map(),
      extensionNets: new WeakMap(),
      loaded: new Map(),
      manifests: new Map(),
      known: new Map(),
      // The constructor does not run on this engine: the lists it makes are made here.
      forgottenListeners: [],
      extensionPaths: new Set(),
      optionalGrants,
      extensionLedger: () => ({ idOfPath: () => undefined, rememberPath: vi.fn(), netChoices: () => undefined, keepNetChoices: vi.fn() }),
      announceLifecycle: vi.fn(),
      isDisabled: () => false,
      // The scripts of the extension runtime are put in the session by their own steps (extension-runtime.test.ts); here the runtime is already on.
      installShims: () => undefined,
      installPatches: () => undefined,
      extensionNetOf(this: unknown, ses: unknown, profileId: unknown) {
        order.push('net')
        return methods['extensionNetOf']!.call(this, ses, profileId)
      },
      installRequestBlocker: () => void order.push('blocker'),
      ...worker
    })
  )
  methods['ensureProfile']!.call(engine, 'p')
  const ses: FakeProfileSession = [...madeSessions.values()][0]!
  const net = (engine['extensionNets'] as WeakMap<object, InstanceType<typeof ExtensionNet>>).get(ses)!
  return { engine, ses, net, order, optionalGrants, ...worker }
}
const extension = (path = folder) => ({ id: EXT, name: 'Tab Stash', version: '1.0', path, manifest: { manifest_version: 3, permissions: ['declarativeNetRequest'] } })

describe('what the person allowed an extension to capture, when the extension goes or asks for more', () => {
  const onChange = (world: ReturnType<typeof profileMade>) => {
    const forgotten: Array<[string, string]> = []
    ;(world.engine as unknown as { onExtensionForgotten(listener: (profileId: string, extensionId: string) => void): void }).onExtensionForgotten((profileId, extensionId) => void forgotten.push([profileId, extensionId]))
    return forgotten
  }
  const withPermissions = (permissions: string[], path = folder, id = EXT) => ({ ...extension(path), id, manifest: { manifest_version: 3, permissions } })

  it('is told when a Web Store extension is uninstalled, for the profile it was uninstalled from', async () => {
    const world = profileMade()
    const forgotten = onChange(world)
    world.ses.extensions.emit('extension-loaded', {}, extension())
    Object.assign(world.engine, { webStore: { uninstall: vi.fn(async () => undefined) } })
    await methods['uninstallExtension']!.call(world.engine, 'p', EXT)
    expect(forgotten).toEqual([['p', EXT]])
  })

  it('is told, for every profile that held it, when the folder of an extension is forgotten: and not for another folder', () => {
    const world = profileMade()
    const forgotten = onChange(world)
    world.ses.extensions.emit('extension-loaded', {}, extension())
    const known = world.engine['known'] as Map<string, { path: string; info: { profileId: string; id: string } }>
    known.set(`q:${EXT}`, { ...known.get(`p:${EXT}`)!, info: { ...known.get(`p:${EXT}`)!.info, profileId: 'q' } })
    known.set('p:other', { path: '/Users/jane/elsewhere', info: { profileId: 'p', id: 'other' } })
    methods['forgetExtensionFolder']!.call(world.engine, folder)
    expect(forgotten.sort()).toEqual([['p', EXT], ['q', EXT]])
  })

  it('is told when the folder of an extension is loaded again with other permissions, and not when they are the same: a version or a name that changes is no reason', () => {
    const world = profileMade()
    const forgotten = onChange(world)
    world.ses.extensions.emit('extension-loaded', {}, withPermissions(['activeTab', 'tabCapture']))
    world.ses.extensions.emit('extension-unloaded', {}, withPermissions(['activeTab', 'tabCapture']))
    world.ses.extensions.emit('extension-loaded', {}, { ...withPermissions(['tabCapture', 'activeTab']), version: '1.1', name: 'Renamed' })
    expect(forgotten).toEqual([])
    world.ses.extensions.emit('extension-unloaded', {}, withPermissions(['tabCapture', 'activeTab']))
    world.ses.extensions.emit('extension-loaded', {}, { ...withPermissions(['activeTab', 'tabCapture', 'tabs']), version: '1.2' })
    expect(forgotten).toEqual([['p', EXT]])
  })

  it('is told for the old identifier when a folder comes back under another: the manifest changed its key', () => {
    const world = profileMade()
    const forgotten = onChange(world)
    const NEXT = 'nopqrstuvwxyzabcnopqrstuvwxyzabc'
    world.ses.extensions.emit('extension-loaded', {}, withPermissions(['tabCapture']))
    world.ses.extensions.emit('extension-unloaded', {}, withPermissions(['tabCapture']))
    world.ses.extensions.emit('extension-loaded', {}, withPermissions(['tabCapture'], folder, NEXT))
    expect(forgotten).toEqual([['p', EXT]])
  })

  it('does not tell of the copy of the same folder in another profile: each profile is told of its own', () => {
    const world = profileMade()
    const forgotten = onChange(world)
    const NEXT = 'nopqrstuvwxyzabcnopqrstuvwxyzabc'
    world.ses.extensions.emit('extension-loaded', {}, withPermissions(['tabCapture']))
    const known = world.engine['known'] as Map<string, { path: string; info: { profileId: string; id: string } }>
    known.set('q:oldid', { path: folder, info: { profileId: 'q', id: 'oldid' } })
    world.ses.extensions.emit('extension-unloaded', {}, withPermissions(['tabCapture']))
    world.ses.extensions.emit('extension-loaded', {}, withPermissions(['tabCapture'], folder, NEXT))
    expect(forgotten).toEqual([['p', EXT]])
  })

  it('is not told the first time an extension loads, nor of an extension of the Web Store that is updated (its updates have their own review), nor of another folder', async () => {
    const { STORE_DIR } = await import('./web-store-files')
    const world = profileMade()
    const forgotten = onChange(world)
    world.ses.extensions.emit('extension-loaded', {}, withPermissions(['tabCapture']))
    expect(forgotten).toEqual([])
    // Another folder, another extension: nothing of the first is touched.
    world.ses.extensions.emit('extension-loaded', {}, withPermissions(['tabCapture', 'tabs'], '/Users/jane/another', 'qrstuvwxyzabcdefqrstuvwxyzabcdef'))
    expect(forgotten).toEqual([])
    // An extension of the Web Store that comes back with more is the review of the update's business, not this one's.
    const stored = join('/tmp/lucium-test-userData', STORE_DIR, 'stuvwxyzabcdefghstuvwxyzabcdefgh', '1.0')
    const STORED = 'stuvwxyzabcdefghstuvwxyzabcdefgh'
    world.ses.extensions.emit('extension-loaded', {}, withPermissions(['tabCapture'], stored, STORED))
    world.ses.extensions.emit('extension-unloaded', {}, withPermissions(['tabCapture'], stored, STORED))
    world.ses.extensions.emit('extension-loaded', {}, withPermissions(['tabCapture', 'tabs'], stored, STORED))
    expect(forgotten).toEqual([])
  })

  it('does not stop a listener that fails: the others are told, and the log says it', async () => {
    const world = profileMade()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const forgotten = onChange(world)
    ;(world.engine as unknown as { onExtensionForgotten(listener: () => void): void }).onExtensionForgotten(() => {
      throw new Error('a listener bug')
    })
    ;(world.engine as unknown as { onExtensionForgotten(listener: (profileId: string, extensionId: string) => void): void }).onExtensionForgotten((profileId, extensionId) => void forgotten.push([profileId, extensionId]))
    Object.assign(world.engine, { webStore: { uninstall: vi.fn(async () => undefined) } })
    await methods['uninstallExtension']!.call(world.engine, 'p', EXT)
    expect(forgotten).toEqual([['p', EXT], ['p', EXT]])
    expect(error).toHaveBeenCalledWith(expect.stringContaining('listener of the extensions that left failed'), expect.any(Error))
    error.mockRestore()
  })
})

describe('the calls of the shims about the request rules', () => {
  it('reach the rules of the profile of the extension, never the shell', async () => {
    const { net, handled, call } = engineWith(['declarativeNetRequest', 'webRequest'])
    await call('declarativeNetRequest', 'mirror', [{ session: [{ id: 1, action: { type: 'block' }, condition: { urlFilter: '/ads/' } }], dynamic: [] }])
    expect(net.needs().rules).toBe(true)
    expect(await call('declarativeNetRequest', 'getEnabledRulesets', [])).toEqual([])
    expect(await call('declarativeNetRequest', 'getAvailableStaticRuleCount', [])).toBe(330_000)
    await call('webRequest', 'listen', ['onCompleted', { urls: ['<all_urls>'] }, [], true], 'frame:3')
    expect([...net.needs().events]).toEqual(['onCompleted'])
    await expect(call('declarativeNetRequest', 'updateEnabledRulesets', [{ enableRulesetIds: ['ghost'] }])).rejects.toThrow('Invalid ruleset id: ghost.')
    expect(handled).toEqual([])
  })

  it('are refused to an extension that does not hold the permission', async () => {
    const { net, call } = engineWith(['storage'])
    await expect(call('declarativeNetRequest', 'mirror', [{ session: [], dynamic: [] }])).rejects.toThrow('no permission to use chrome.declarativeNetRequest.mirror')
    await expect(call('webRequest', 'listen', ['onCompleted', { urls: ['<all_urls>'] }, [], true])).rejects.toThrow('no permission')
    expect(net.needs().events.size).toBe(0)
  })

  it('the rules follow the extension: read when it is loaded, gone when it is unloaded, forgotten when it is uninstalled', async () => {
    const world = profileMade()
    const add = vi.spyOn(world.net, 'add')
    const remove = vi.spyOn(world.net, 'remove')
    const forget = vi.spyOn(world.net, 'forget')
    world.ses.extensions.emit('extension-loaded', {}, extension())
    expect(add).toHaveBeenCalledExactlyOnceWith(EXT, folder, extension().manifest)
    expect((world.engine['loaded'] as Map<string, unknown>).has(`p:${EXT}`)).toBe(true)
    world.ses.extensions.emit('extension-unloaded', {}, extension())
    expect(remove).toHaveBeenCalledExactlyOnceWith(EXT)
    // The table of the access rules and the list of the loaded ones forgot it, and so did what the extension relays and what its contexts held.
    expect((world.engine['loaded'] as Map<string, unknown>).has(`p:${EXT}`)).toBe(false)
    expect((world.engine['manifests'] as Map<string, unknown>).has(`p:${EXT}`)).toBe(false)
    expect(world.relays.close).toHaveBeenCalledWith('p', EXT)
    expect(world.contextGone).toHaveBeenCalledWith({ extensionId: EXT, profileId: 'p' })
    Object.assign(world.engine, { webStore: { uninstall: vi.fn(async () => undefined) } })
    await methods['uninstallExtension']!.call(world.engine, 'p', EXT)
    expect(forget).toHaveBeenCalledExactlyOnceWith(EXT)
    expect(world.optionalGrants.forget).toHaveBeenCalledExactlyOnceWith('p', EXT)
  })

  it('has the rules of a profile ready before its hooks are installed: the hooks ask them what the extensions need', () => {
    expect(profileMade().order.slice(0, 2)).toEqual(['net', 'blocker'])
  })

  it('a worker that stops takes its request listeners aside, and is forgotten by the contexts of the extensions', () => {
    const world = profileMade()
    // The scripts of the runtime are put in the session by their steps: the one that listens to the state of the workers is `installShims`.
    methods['installShims']!.call(Object.assign(world.engine, { registerFrameShims: () => undefined }), world.ses, 'p')
    const contextGone = vi.spyOn(world.net, 'contextGone')
    world.ses.serviceWorkers.emit('running-status-changed', { runningStatus: 'stopping', versionId: 5 })
    expect(contextGone).toHaveBeenCalledExactlyOnceWith('worker:5')
    expect(world.contextGone).toHaveBeenCalledWith({ context: 'worker:5' })
  })

  it('a worker that stops ends what the scripts of lent tabs asked it (its listener goes with it), for the extension it belongs to and no other', () => {
    const world = profileMade()
    const workerGone = vi.fn()
    methods['installShims']!.call(Object.assign(world.engine, { registerFrameShims: () => undefined, lentAsks: { workerGone } }), world.ses, 'p')
    world.ses.scopes.set(5, `chrome-extension://${EXT}/`)
    world.ses.scopes.set(6, 'https://site.example/')
    world.ses.serviceWorkers.emit('running-status-changed', { runningStatus: 'stopping', versionId: 5 })
    expect(workerGone).toHaveBeenCalledExactlyOnceWith('p', EXT)
    // The worker of a web site, and one that is already gone, are no extension's.
    world.ses.serviceWorkers.emit('running-status-changed', { runningStatus: 'stopped', versionId: 6 })
    world.ses.serviceWorkers.emit('running-status-changed', { runningStatus: 'stopped', versionId: 7 })
    expect(workerGone).toHaveBeenCalledOnce()
  })

  it('an extension that is unloaded leaves the table of the manifests: its calls are refused, in that profile only', async () => {
    const { engine, call } = engineWith(['declarativeNetRequest'], { permissions: ['declarativeNetRequest'] })
    expect(await call('declarativeNetRequest', 'getEnabledRulesets', [])).toEqual([])
    methods['forgetLoaded']!.call(engine, 'default', EXT)
    expect([...(engine['manifests'] as Map<string, unknown>).keys()]).toEqual([`work:${EXT}`])
    expect([...(engine['loaded'] as Map<string, unknown>).keys()]).toEqual([`work:${EXT}`])
    await expect(call('declarativeNetRequest', 'getEnabledRulesets', [])).rejects.toThrow('no permission to use chrome.declarativeNetRequest.getEnabledRulesets')
  })

  it('a page of an extension that ends takes its request listeners with it', async () => {
    const { engine, net, call } = engineWith(['webRequest'])
    await call('webRequest', 'listen', ['onCompleted', { urls: ['<all_urls>'] }, [], true], 'frame:3')
    Object.assign(engine, { contextGoneListeners: [] })
    methods['contextGone']!.call(engine, { context: 'frame:3' })
    expect(net.needs().events.size).toBe(0)
  })
})

describe('a script for a tab the user lent with a click', () => {
  it('is refused, in the browser\'s own words, until the user lends the tab; then it runs in the world of the extension in that page', async () => {
    const { grants, call, lentTabs } = engineWith(['activeTab', 'scripting'])
    const page = tab(7, 'https://site.example/page')
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: '() => document.title', args: [] }])).rejects.toThrow(NO_PAGE_ACCESS)
    expect(page.ran).toEqual([])
    expect(lentTabs.ensure).not.toHaveBeenCalled()
    grants.grant(EXT, 7, 'https://site.example/page')
    expect(await call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: '(a) => a', args: ['x'] }])).toEqual([{ frameId: 0, result: 'from its own world' }])
    expect(page.ran).toEqual([{ world: SCRIPT_WORLDS_FROM, code: guardedScript('https://site.example', '((a) => a)(...["x"])') }])
    // The world of the extension is given its runtime first (chrome.runtime, chrome.storage, the messages), for the profile the tab is in; the page's own world is given none.
    expect(lentTabs.ensure).toHaveBeenCalledExactlyOnceWith(7, EXT, 'default')
    expect(await call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: '() => 1', world: 'MAIN' }])).toEqual([{ frameId: 0, result: 'from the page' }])
    expect(lentTabs.ensure).toHaveBeenCalledOnce()
  })

  it('is refused once the tab has gone to another site, for a tab of another profile, and for an extension that is not loaded in the profile', async () => {
    const { engine, grants, call } = engineWith(['activeTab', 'scripting'])
    const moved = tab(7, 'https://elsewhere.example/')
    grants.grant(EXT, 7, 'https://site.example/page')
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: '() => 1' }])).rejects.toThrow(NO_PAGE_ACCESS)
    const other = tab(8, 'https://site.example/page')
    grants.grant(EXT, 8, 'https://site.example/page')
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 8 }, func: '() => 1' }])).rejects.toThrow(NO_PAGE_ACCESS)
    tab(7, 'https://site.example/page')
    ;(engine['loaded'] as Map<string, unknown>).clear()
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: '() => 1' }])).rejects.toThrow(NO_PAGE_ACCESS)
    expect([...moved.ran, ...other.ran]).toEqual([])
  })

  it('runs a file of the extension, and refuses a file outside its folder or that is not there', async () => {
    const { grants, call } = engineWith(['activeTab', 'scripting'])
    const page = tab(7, 'https://site.example/page')
    grants.grant(EXT, 7, 'https://site.example/page')
    await call('scripting', 'executeScript', [{ target: { tabId: 7 }, files: ['content.js'] }])
    expect(page.ran.map((each) => each.code)).toEqual([guardedScript('https://site.example', 'document.title')])
    const climbing = `../${outside.split('/').pop()}`
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, files: [climbing] }])).rejects.toThrow(`Could not load file: '${climbing}'.`)
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, files: ['missing.js'] }])).rejects.toThrow("Could not load file: 'missing.js'.")
    expect(page.ran).toHaveLength(1)
  })

  // Reading the files takes time, and so does each script: the tab can be somewhere else by the time the next thing would be done in it.
  it('is not run in the page the tab went to while the files of the extension were being read', async () => {
    const { grants, call } = engineWith(['activeTab', 'scripting'])
    const page = tab(7, 'https://site.example/page', 'once-read')
    grants.grant(EXT, 7, 'https://site.example/page')
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, files: ['content.js'] }])).rejects.toThrow(NO_PAGE_ACCESS)
    expect(page.ran).toEqual([])
    const styled = tab(7, 'https://site.example/page', 'once-read')
    await expect(call('scripting', 'insertCSS', [{ target: { tabId: 7 }, files: ['page.css'] }])).rejects.toThrow(NO_PAGE_ACCESS)
    expect(styled.styles).toEqual([])
  })

  it('does not give the page the runtime of the extension when the tab left its site since the loan was last looked at: the loan is asked again just before, and nothing is sent', async () => {
    const { grants, call, lentTabs } = engineWith(['activeTab', 'scripting'])
    const page = tab(7, 'https://site.example/page', 'once-read')
    grants.grant(EXT, 7, 'https://site.example/page')
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: '() => 1' }])).rejects.toThrow(NO_PAGE_ACCESS)
    expect(lentTabs.ensure).not.toHaveBeenCalled()
    expect(page.ran).toEqual([])
  })

  it('stops between two files when the first one sent the tab to another site', async () => {
    const { grants, call } = engineWith(['activeTab', 'scripting'])
    const page = tab(7, 'https://site.example/page', 'as-it-runs')
    grants.grant(EXT, 7, 'https://site.example/page')
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, files: ['content.js', 'second.js'] }])).rejects.toThrow(NO_PAGE_ACCESS)
    expect(page.ran.map((each) => each.code)).toEqual([guardedScript('https://site.example', 'document.title')])
  })

  // The browser process hears of a navigation when it has committed; a script that left it before that reaches the renderer after the commit.
  // What this process judged is then another page than the one the script runs in: the document says whose it is, before the first line.
  describe('when the tab shows another origin than the one this process last heard of', () => {
    const foreign = { origin: 'https://bank.example' }
    const TOUCH = '() => { touched = true; return document.title }'

    it.each([
      ['a function, in the world of the extension', { target: { tabId: 7 }, func: TOUCH }],
      ['a function, in the world of the page', { target: { tabId: 7 }, func: TOUCH, world: 'MAIN' }],
      ['a file, in the world of the extension', { target: { tabId: 7 }, files: ['touch.js'] }],
      ['a file, in the world of the page', { target: { tabId: 7 }, files: ['touch.js'], world: 'MAIN' }]
    ])("refuses %s, in the browser's words, and the script does not run", async (_name, injection) => {
      const { grants, call } = engineWith(['activeTab', 'scripting'])
      const page = tab(7, 'https://site.example/page', undefined, foreign)
      grants.grant(EXT, 7, 'https://site.example/page')
      await expect(call('scripting', 'executeScript', [injection])).rejects.toThrow(new Error(NO_PAGE_ACCESS))
      // The script, which the document refused, and the question of where the document is.
      expect(page.ran.map((each) => each.code)).toEqual([expect.stringContaining('location.origin !=='), 'location.origin'])
      expect(page.world['touched']).toBe(false)
    })

    it('runs the same calls in a document of the origin that was lent, which is what the checks above refuse the others for', async () => {
      const { grants, call } = engineWith(['activeTab', 'scripting'])
      const page = tab(7, 'https://site.example/page', undefined, { origin: 'https://site.example' })
      grants.grant(EXT, 7, 'https://site.example/page')
      expect(await call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: TOUCH }])).toEqual([{ frameId: 0, result: 'the page' }])
      expect(await call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: TOUCH, world: 'MAIN' }])).toEqual([{ frameId: 0, result: 'the page' }])
      expect(await call('scripting', 'executeScript', [{ target: { tabId: 7 }, files: ['touch.js'] }])).toEqual([{ frameId: 0, result: 'the page' }])
      expect(page.world['touched']).toBe(true)
    })

    it('refuses the second file when the document changed while the first one ran: each script is judged by the document that runs it', async () => {
      const { grants, call } = engineWith(['activeTab', 'scripting'])
      const document = { origin: 'https://site.example' }
      const page = tab(7, 'https://site.example/page', undefined, document)
      grants.grant(EXT, 7, 'https://site.example/page')
      // The first file ends by sending the tab away, and nothing tells this process before the second script is sent.
      const first = page.wc.executeJavaScriptInIsolatedWorld
      page.wc.executeJavaScriptInIsolatedWorld = async (inWorld, scripts) => {
        const answer = await first(inWorld, scripts)
        document.origin = 'https://bank.example'
        return answer
      }
      await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, files: ['content.js', 'touch.js'] }])).rejects.toThrow(new Error(NO_PAGE_ACCESS))
      expect(page.ran).toHaveLength(3)
      expect(page.ran.at(-1)?.code).toBe('location.origin')
      expect(page.world['touched']).toBe(false)
    })

    it('passes the refusal on whatever words the page engine wraps around it', async () => {
      const { grants, call } = engineWith(['activeTab', 'scripting'])
      const page = tab(7, 'https://site.example/page')
      grants.grant(EXT, 7, 'https://site.example/page')
      page.wc.executeJavaScriptInIsolatedWorld = async () => {
        throw new Error(`Uncaught Error: ${NO_PAGE_ACCESS}`)
      }
      await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: TOUCH }])).rejects.toThrow(new Error(NO_PAGE_ACCESS))
    })

    // What the page engine says of a script that threw does not tell its own guard from a bug of the script: the document is asked where it is.
    it('tells the refusal of the document from a failure of the script itself, which goes on unchanged, in both worlds', async () => {
      const { grants, call } = engineWith(['activeTab', 'scripting'])
      const page = tab(7, 'https://site.example/page', undefined, { origin: 'https://site.example' })
      grants.grant(EXT, 7, 'https://site.example/page')
      for (const world of [undefined, 'MAIN'] as const) {
        await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: '() => { throw new Error("the script is wrong") }', world }])).rejects.toThrow('Script failed to execute')
      }
      expect(page.ran.map((each) => each.code.includes('location.origin !==') || each.code === 'location.origin')).toEqual([true, true, true, true])
    })

    it('says in the log when the document cannot be asked where it is, and hands on the failure of the script', async () => {
      const { grants, call } = engineWith(['activeTab', 'scripting'])
      const page = tab(7, 'https://site.example/page')
      grants.grant(EXT, 7, 'https://site.example/page')
      page.wc.executeJavaScriptInIsolatedWorld = async () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: TOUCH }])).rejects.toThrow('Render frame was disposed')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`cannot ask the page of a tab lent to ${EXT} where it is`), expect.any(Error))
      warn.mockRestore()
    })

    it('has a style sheet taken out again, and refuses the call, when the document that holds it is not of the origin that was lent', async () => {
      const { engine, grants, call } = engineWith(['activeTab', 'scripting'])
      const page = tab(7, 'https://site.example/page', undefined, foreign)
      grants.grant(EXT, 7, 'https://site.example/page')
      await expect(call('scripting', 'insertCSS', [{ target: { tabId: 7 }, css: 'a{}', origin: 'USER' }])).rejects.toThrow(new Error(NO_PAGE_ACCESS))
      expect(page.styles).toEqual([{ css: 'a{}', origin: 'user' }])
      expect(page.removed).toEqual(['key-1'])
      // It is not kept as inserted: the same call, later, is made again and refused again.
      expect((engine['lentStyles'] as Map<string, string>).size).toBe(0)
      await expect(call('scripting', 'insertCSS', [{ target: { tabId: 7 }, files: ['page.css'] }])).rejects.toThrow(new Error(NO_PAGE_ACCESS))
      expect(page.removed).toEqual(['key-1', 'key-2'])
    })

    it('says so in the log when the sheet cannot be taken out either, and still refuses', async () => {
      const { grants, call } = engineWith(['activeTab', 'scripting'])
      const page = tab(7, 'https://site.example/page', undefined, foreign)
      grants.grant(EXT, 7, 'https://site.example/page')
      page.wc.removeInsertedCSS = async () => {
        throw new Error('no such sheet')
      }
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      await expect(call('scripting', 'insertCSS', [{ target: { tabId: 7 }, css: 'a{}' }])).rejects.toThrow(new Error(NO_PAGE_ACCESS))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`cannot take a style sheet of ${EXT} out of tab 7`), expect.any(Error))
      warn.mockRestore()
    })
  })

  it('serves chrome.tabs.insertCSS for a tab that was lent to an extension that has activeTab and not "scripting", the same way and with the same checks', async () => {
    const { grants, call, engine } = engineWith(['activeTab'])
    const ownDocument = { origin: 'https://site.example' }
    const page = tab(7, 'https://site.example/page', undefined, ownDocument)
    grants.grant(EXT, 7, 'https://site.example/page')
    const viaTabs = (): Promise<unknown> => methods['scriptLentTab']!.call(engine, 'default', EXT, 'insertCSS', { target: { tabId: 7 }, css: 'a{}' }, true) as Promise<unknown>
    // The API of chrome.scripting stays closed to it, as before.
    await expect(call('scripting', 'insertCSS', [{ target: { tabId: 7 }, css: 'a{}' }])).rejects.toThrow('no permission to use chrome.scripting.insertCSS')
    await viaTabs()
    expect(page.styles).toEqual([{ css: 'a{}', origin: 'author' }])
    // The tab is somewhere else than this process last heard: the sheet is taken out again and the call refused.
    ownDocument.origin = 'https://bank.example'
    methods['forgetLentStyles']!.call(engine, 7)
    await expect(viaTabs()).rejects.toThrow(new Error(NO_PAGE_ACCESS))
    expect(page.removed).toEqual(['key-2'])
    // And a tab that is not lent is refused here too.
    grants.revoke(EXT, 7)
    await expect(viaTabs()).rejects.toThrow(new Error(NO_PAGE_ACCESS))
    expect(page.styles).toHaveLength(2)
  })

  it("forgets the keys of the style sheets of a tab that shows a new document, and only that tab's: a key of the last document takes nothing out of this one", async () => {
    const { engine, grants, call } = engineWith(['activeTab', 'scripting'])
    const page = tab(7, 'https://site.example/page', undefined, { origin: 'https://site.example' })
    const other = tab(9, 'https://site.example/other', undefined, { origin: 'https://site.example' })
    ;(engine['tabMeta'] as Map<number, { profileId: string }>).set(9, { profileId: 'default' })
    grants.grant(EXT, 7, 'https://site.example/page')
    grants.grant(EXT, 9, 'https://site.example/other')
    await call('scripting', 'insertCSS', [{ target: { tabId: 7 }, css: 'a:b{}' }])
    await call('scripting', 'insertCSS', [{ target: { tabId: 9 }, css: 'a{}' }])
    expect(page.styles).toHaveLength(1)
    methods['forgetLentStyles']!.call(engine, 7)
    // The same sheet is put in again (the new document has none), and the old key is not used to take anything out of it.
    await call('scripting', 'insertCSS', [{ target: { tabId: 7 }, css: 'a:b{}' }])
    expect(page.styles).toHaveLength(2)
    await call('scripting', 'removeCSS', [{ target: { tabId: 9 }, css: 'a{}' }])
    expect(other.removed).toEqual(['key-1'])
    methods['forgetLentStyles']!.call(engine, 7)
    await call('scripting', 'removeCSS', [{ target: { tabId: 7 }, css: 'a:b{}' }])
    expect(page.removed).toEqual([])
  })

  it('inserts a style sheet once, and removes the one it inserted', async () => {
    const { grants, call } = engineWith(['activeTab', 'scripting'])
    const page = tab(7, 'https://site.example/page')
    grants.grant(EXT, 7, 'https://site.example/page')
    await call('scripting', 'insertCSS', [{ target: { tabId: 7 }, css: 'a{}', origin: 'USER' }])
    await call('scripting', 'insertCSS', [{ target: { tabId: 7 }, css: 'a{}', origin: 'USER' }])
    await call('scripting', 'insertCSS', [{ target: { tabId: 7 }, files: ['page.css'] }])
    expect(page.styles).toEqual([{ css: 'a{}', origin: 'user' }, { css: 'body { color: red }', origin: 'author' }])
    await call('scripting', 'removeCSS', [{ target: { tabId: 7 }, css: 'a{}', origin: 'USER' }])
    await call('scripting', 'removeCSS', [{ target: { tabId: 7 }, css: 'never-inserted{}' }])
    expect(page.removed).toEqual(['key-1'])
  })

  it('is not served at all to an extension without activeTab: its calls stay the browser\'s', async () => {
    const { grants, call } = engineWith(['scripting'])
    tab(7, 'https://site.example/page')
    grants.grant(EXT, 7, 'https://site.example/page')
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: '() => 1' }])).rejects.toThrow('no permission to use chrome.scripting.executeScript')
  })
})

// One extension in two profiles is two installs: an update can be accepted in one and still wait in the other, and they do not declare the same.
describe('an extension that two profiles hold in two versions', () => {
  const wide = { permissions: ['declarativeNetRequest', 'activeTab', 'scripting', 'downloads'], hosts: ['<all_urls>'] }

  it('is served in each profile for what its version there declares, not for what the version loaded last does', async () => {
    const { net, grants, call } = engineWith(['storage'], wide)
    await expect(call('declarativeNetRequest', 'mirror', [{ session: [], dynamic: [] }])).rejects.toThrow('no permission to use chrome.declarativeNetRequest.mirror')
    expect(net.needs().rules).toBe(false)
    const page = tab(7, 'https://site.example/page')
    grants.grant(EXT, 7, 'https://site.example/page')
    await expect(call('scripting', 'executeScript', [{ target: { tabId: 7 }, func: '() => 1' }])).rejects.toThrow('no permission to use chrome.scripting.executeScript')
    expect(page.ran).toEqual([])
    // In the profile whose version declares it, the same call passes the permission check (it then stops for want of rules in that stand-in).
    await expect(call('declarativeNetRequest', 'mirror', [{ session: [], dynamic: [] }], 'worker:2', 'work')).rejects.toThrow('The extension is not loaded in a profile.')
  })

  it('may act on a tab, or capture it, by what it declares in the profile of that tab', () => {
    const { engine } = engineWith(['storage'], wide)
    tab(7, 'https://site.example/page')
    tab(8, 'https://site.example/page')
    expect(methods['mayActOnTab']!.call(engine, EXT, 7)).toBe(false)
    expect(methods['mayCaptureTab']!.call(engine, EXT, 7)).toBe(false)
    expect(methods['mayActOnTab']!.call(engine, EXT, 8)).toBe(true)
    expect(methods['mayCaptureTab']!.call(engine, EXT, 8)).toBe(true)
  })

  it('may read the address of a tab by what it declares in the profile of that tab, and the address of the Extensions page with "tabs" only', () => {
    const reading = engineWith(['storage'], { permissions: ['tabs'], hosts: ['<all_urls>'] })
    tab(7, 'https://site.example/page')
    tab(8, 'https://site.example/page')
    expect(methods['mayReadTab']!.call(reading.engine, EXT, 7)).toBe(false)
    expect(methods['mayReadTab']!.call(reading.engine, EXT, 8)).toBe(true)
    const page = engineWith(['storage'], { permissions: ['tabs'], hosts: ['<all_urls>'] })
    tab(7, 'lucium-ui://extensions/')
    tab(8, 'lucium-ui://extensions/')
    expect(methods['mayReadTab']!.call(page.engine, EXT, 7)).toBe(false)
    expect(methods['mayReadTab']!.call(page.engine, EXT, 8)).toBe(true)
    // Every site declared reads no address of it: it is not a page of the web.
    const wideOnly = engineWith(['storage'], { permissions: ['activeTab'], hosts: ['<all_urls>'] })
    tab(8, 'lucium-ui://extensions/')
    expect(methods['mayReadTab']!.call(wideOnly.engine, EXT, 8)).toBe(false)
    // A number that is no tab of ours is read by nobody.
    expect(methods['mayReadTab']!.call(page.engine, EXT, 99)).toBe(false)
  })

  it('hears an event in the profiles where its version declared the API, and not in the others', () => {
    const { engine, session, workSession } = engineWith(['storage'], wide)
    const worker = (profileId: string) => ({ isDestroyed: () => false, scope: `chrome-extension://${EXT}/`, send: vi.fn(), profileId })
    const [plain, declared] = [worker('default'), worker('work')]
    const frame = (ses: object) => ({ isDestroyed: () => false, getURL: () => `chrome-extension://${EXT}/panel.html`, session: ses, send: vi.fn() })
    const [plainPanel, declaredPanel] = [frame(session), frame(workSession)]
    Object.assign(engine, { extensionWorkers: new Set([plain, declared]), workerProfile: new WeakMap([[plain, 'default'], [declared, 'work']]), extensionFrames: new Set([plainPanel, declaredPanel]) })
    methods['emitShimEvent']!.call(engine, EXT, 'downloads', 'onCreated', [{ id: 1 }])
    methods['emitShimEvent']!.call(engine, EXT, 'downloads', 'onChanged', [{ id: 1 }], 'default')
    expect(plain.send).not.toHaveBeenCalled()
    expect(plainPanel.send).not.toHaveBeenCalled()
    expect(declared.send).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'downloads', 'onCreated', [{ id: 1 }])
    expect(declaredPanel.send).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'downloads', 'onCreated', [{ id: 1 }])
  })

  it('has its manifest recorded under the profile that loaded it, with what the person granted it there', () => {
    const world = profileMade()
    world.ses.extensions.emit('extension-loaded', {}, extension())
    expect(world.optionalGrants.effective).toHaveBeenCalledExactlyOnceWith('p', EXT, extension().manifest)
    expect([...(world.engine['manifests'] as Map<string, unknown>)]).toEqual([[`p:${EXT}`, { ...extension().manifest, granted: true }]])
  })
})

describe('chrome.permissions of a profile', () => {
  it('is answered by what the person granted in that profile: the four calls of the library go to the grants of the profile', async () => {
    const optional = { request: vi.fn(async () => true), contains: vi.fn(() => true), getAll: vi.fn(() => ({ permissions: [], origins: [] })), remove: vi.fn(() => true) }
    const engine = { optionalGrants: optional, profileOfTab: () => undefined, loaded: new Map(), manifests: new Map(), activeTabs: new ActiveTabGrants() }
    const permissions = (methods['libraryRules']!.call(engine, 'work') as { permissions: Record<string, (...args: unknown[]) => unknown> }).permissions
    const sender = { id: 3 }
    await permissions['request']!(EXT, { permissions: ['bookmarks'] }, sender)
    permissions['contains']!(EXT, { permissions: ['bookmarks'] })
    permissions['getAll']!(EXT)
    permissions['remove']!(EXT, { permissions: ['bookmarks'] })
    expect(optional.request).toHaveBeenCalledWith('work', EXT, { permissions: ['bookmarks'] }, sender)
    expect(optional.contains).toHaveBeenCalledWith('work', EXT, { permissions: ['bookmarks'] })
    expect(optional.getAll).toHaveBeenCalledWith('work', EXT)
    expect(optional.remove).toHaveBeenCalledWith('work', EXT, { permissions: ['bookmarks'] })
  })

  /** The engine as `main()` makes it, with an extension of the profile `p` that lists `bookmarks` as facultative, a ledger in memory, and a sheet the person agrees to. */
  async function engineWithOptional(optional = ['bookmarks']) {
    const engine = (await constructEngine()) as unknown as Record<string, unknown> & { optionalGrants: { request(profile: string, id: string, request: unknown, sender: unknown): Promise<boolean> }; onExtensionReview(handler: () => Promise<boolean>): void }
    const manifest = { manifest_version: 3, name: 'Tab Stash', version: '1.0', optional_permissions: optional }
    const kept: { value: string | undefined } = { value: undefined }
    Object.assign(engine, {
      ledger: { optionalGrant: () => kept.value, keepOptionalGrant: (_profile: string, _id: string, value: string | undefined) => void (kept.value = value) },
      webStore: { uninstall: async () => undefined }
    })
    ;(engine['known'] as Map<string, unknown>).set(`p:${EXT}`, { info: { id: EXT, name: 'Tab Stash', version: '1.0', profileId: 'p' }, path: folder, manifest })
    ;(engine['loaded'] as Map<string, unknown>).set(`p:${EXT}`, { id: EXT })
    ;(engine['manifests'] as Map<string, unknown>).set(`p:${EXT}`, manifest)
    engine.onExtensionReview(async () => true)
    const permissionsNow = (): unknown => (engine['manifests'] as Map<string, { permissions?: string[] }>).get(`p:${EXT}`)?.permissions
    return { engine, kept, permissionsNow }
  }
  /** A real click of the user, anywhere in the application: a web contents is born, and gets a mouse down. */
  const click = (): void => {
    const contents = Object.assign(new EventEmitter(), { debugger: { isAttached: () => false } })
    emitApp('web-contents-created', contents)
    contents.emit('input-event', {}, { type: 'mouseDown' })
  }

  it('counts a grant from the next call on: the table the access rules read is written again when a grant changes', async () => {
    const { engine, permissionsNow } = await engineWithOptional()
    expect(permissionsNow()).toBeUndefined()
    click()
    expect(await engine.optionalGrants.request('p', EXT, { permissions: ['bookmarks'] }, undefined)).toBe(true)
    expect(permissionsNow()).toContain('bookmarks')
  })

  describe('an optional tabCapture that is taken back', () => {
    /** The engine, with `tabCapture` granted; what the engine reads of the extension each time it is asked whether a running capture may go on. */
    async function grantedCapture() {
      const world = await engineWithOptional(['tabCapture'])
      const seen: Array<string[] | undefined> = []
      const captures = (world.engine as unknown as { tabCaptures: { reconsider(): void } }).tabCaptures
      vi.spyOn(captures, 'reconsider').mockImplementation(() => void seen.push(world.permissionsNow() as string[] | undefined))
      click()
      expect(await world.engine.optionalGrants.request('p', EXT, { permissions: ['tabCapture'] }, undefined)).toBe(true)
      seen.length = 0
      return { ...world, seen, captures }
    }

    it('makes the captures judged again, on the table as it stands once the permission is gone, when the extension gives it back', async () => {
      const { engine, permissionsNow, seen } = await grantedCapture()
      expect(permissionsNow()).toContain('tabCapture')
      expect((engine.optionalGrants as unknown as { remove(profile: string, id: string, request: unknown): boolean }).remove('p', EXT, { permissions: ['tabCapture'] })).toBe(true)
      expect(seen).toHaveLength(1)
      expect(seen[0] ?? []).not.toContain('tabCapture')
    })

    it('does so when the person takes it back from the Extensions page', async () => {
      const { engine, seen } = await grantedCapture()
      expect((engine.optionalGrants as unknown as { revoke(profile: string, id: string, name: string): boolean }).revoke('p', EXT, 'tabCapture')).toBe(true)
      expect(seen).toHaveLength(1)
      expect(seen[0] ?? []).not.toContain('tabCapture')
    })
  })

  it('asks only after a click or a key, and forgets the grants of an extension that is uninstalled', async () => {
    const { engine, kept, permissionsNow } = await engineWithOptional()
    await expect(engine.optionalGrants.request('p', EXT, { permissions: ['bookmarks'] }, undefined)).rejects.toThrow('This function must be called during a user gesture')
    expect(permissionsNow()).toBeUndefined()
    click()
    await engine.optionalGrants.request('p', EXT, { permissions: ['bookmarks'] }, undefined)
    expect(kept.value).toBeDefined()
    await (engine as unknown as { uninstallExtension(profile: string, id: string): Promise<void> }).uninstallExtension('p', EXT)
    expect(kept.value).toBeUndefined()
  })

  it('holds every folder it loads to the bound of the review sheet', async () => {
    const loadExtension = vi.fn(async () => ({ id: EXT, name: 'Tab Stash', version: '1.0', path: folder, manifest: { manifest_version: 3 } }))
    const wide = mkdtempSync(join(tmpdir(), 'lucium-wide-'))
    writeFileSync(join(wide, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Wide', version: '1', host_permissions: Array.from({ length: 600 }, (_, n) => `https://site-${n}.example/*`) }))
    const narrow = mkdtempSync(join(tmpdir(), 'lucium-narrow-'))
    writeFileSync(join(narrow, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Narrow', version: '1', host_permissions: ['https://site.example/*'] }))
    const failed = vi.fn()
    const engine = Object.assign(Object.create(ElectronEngine.prototype) as object, {
      profiles: new Map([['p', { runtime: { activate: vi.fn() } }]]),
      extensionTools: { failed, loaded: vi.fn() },
      extensionLedger: () => ({ idOfPath: () => undefined }),
      registerLoaded: (_profile: string, extension: unknown) => extension
    })
    const load = (path: string): Promise<unknown> => methods['loadInto']!.call(engine, 'p', { extensions: { loadExtension } }, path) as Promise<unknown>
    try {
      await expect(load(wide)).rejects.toThrow()
      expect(loadExtension).not.toHaveBeenCalled()
      expect(failed).toHaveBeenCalledWith('p', wide, undefined, expect.any(Error))
      await load(narrow)
      expect(loadExtension).toHaveBeenCalledExactlyOnceWith(narrow, { allowFileAccess: false })
    } finally {
      rmSync(wide, { recursive: true, force: true })
      rmSync(narrow, { recursive: true, force: true })
    }
  })
})

describe('the calls of the shims about chrome.permissions', () => {
  it('reach what the profile grants, for an extension that holds no permission at all, and hand the refusal back to the extension', async () => {
    const { engine, handled, call } = engineWith([])
    const optional = {
      request: vi.fn(async () => {
        throw new Error('This function must be called during a user gesture')
      }),
      contains: vi.fn(() => false),
      getAll: vi.fn(() => ({ permissions: [], origins: [] })),
      remove: vi.fn(() => true)
    }
    engine['optionalGrants'] = optional
    const page = { id: 3 }
    await expect(call('permissions', 'request', [{ permissions: ['bookmarks'] }], 'frame:3', 'default', page)).rejects.toThrow('This function must be called during a user gesture')
    // The page that asked is handed over: the sheet belongs to its window.
    expect(optional.request).toHaveBeenCalledWith('default', EXT, { permissions: ['bookmarks'] }, page)
    expect(await call('permissions', 'contains', [{ permissions: ['bookmarks'] }])).toBe(false)
    expect(await call('permissions', 'getAll', [])).toEqual({ permissions: [], origins: [] })
    expect(await call('permissions', 'remove', [{ permissions: ['bookmarks'] }])).toBe(true)
    await expect(call('permissions', 'update', [])).rejects.toThrow('no permission to use chrome.permissions.update')
    expect(handled).toEqual([])
  })
})

describe('what the workers of an extension answer for the scripts it runs in lent tabs', () => {
  const LENT = 'https://site.example/page'
  /**
   * An engine with a worker that can be asked: what it is asked is kept, and the runtime of the lent tabs and the asks are the real ones, over the tables of the engine. The page of the tab takes the
   * runtime at once, and `attach` gives the token it was handed.
   */
  function lentEngine(permissions = ['activeTab', 'scripting', 'storage'], inWork?: { permissions: string[] }) {
    const made = engineWith(permissions, inWork)
    const asked: unknown[][] = []
    const deliverToWorker = vi.fn(async (...args: unknown[]) => void asked.push(args))
    const asks = new LentAsks((profileId, extensionId, id, op, payload) => deliverToWorker(extensionId, profileId, 'lentTab', 'ask', [id, op, payload]))
    Object.assign(made.engine, { deliverToWorker, lentAsks: asks, tabClosedListeners: [], contextGoneListeners: [] })
    const lents = methods['makeLentTabs']!.call(made.engine) as { call(event: unknown, world: unknown, token: unknown, op: unknown, payload: unknown): Promise<string>; toTab: (...args: unknown[]) => Promise<unknown>; ensure(tab: number, extensionId: string, profileId: string): Promise<boolean>; attachedBy(event: unknown, nonce: unknown, ok: unknown, reason: unknown): void }
    ;(made.engine as Record<string, unknown>)['lentTabs'] = lents
    const world = (made.engine['scriptWorlds'] as ScriptWorlds).of(EXT)
    const page = tab(7, LENT)
    const frame = Object.assign(page.wc.mainFrame, { url: LENT })
    const fromTab = { sender: { id: 7, mainFrame: frame }, senderFrame: frame }
    let token = ''
    const attaches: unknown[][] = []
    // The page takes what the main process sends it, as its preload does, and says so.
    ;(frame as unknown as Record<string, unknown>)['send'] = (_channel: string, nonce: string, ...rest: unknown[]) => {
      attaches.push(rest)
      token = (rest[1] as { token: string }).token
      queueMicrotask(() => lents.attachedBy(fromTab, nonce, true, undefined))
    }
    const attach = async (): Promise<string> => {
      await lents.ensure(7, EXT, 'default')
      return token
    }
    return { ...made, asked, asks, lents, world, page, fromTab, attach, attaches }
  }
  const idOf = (asked: unknown[][]): string => (asked[0]![4] as unknown[])[0] as string
  const send = JSON.stringify({ message: { type: 'ping' } })
  const later = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2))

  it('asks the worker of the extension, started if need be, for what the script of a lent tab writes, and hands the script what the worker answers', async () => {
    const { lents, world, fromTab, grants, asked, call, attach } = lentEngine()
    grants.grant(EXT, 7, LENT)
    const token = await attach()
    const pending = lents.call(fromTab, world, token, 'send', send)
    await later()
    expect(asked).toEqual([[EXT, 'default', 'lentTab', 'ask', [expect.any(String), 'message', { tabId: 7, sender: expect.objectContaining({ id: EXT, url: LENT, origin: 'https://site.example', frameId: 0 }), message: { type: 'ping' } }]]])
    await call('lentTab', 'answer', [idOf(asked), { ok: true, value: 'pong' }], 'worker:3')
    expect(JSON.parse(await pending)).toEqual({ ok: true, value: 'pong' })
  })

  it('does not ask for a tab that is not lent to the extension, for a world that is not its own, or for an extension that is not loaded in the profile of the tab', async () => {
    const { engine, lents, world, fromTab, grants, asked, attach } = lentEngine()
    grants.grant(EXT, 7, LENT)
    const token = await attach()
    await expect(lents.call(fromTab, world + 1, token, 'send', send)).rejects.toThrow('Extension context invalidated.')
    ;(engine['loaded'] as Map<string, unknown>).clear()
    await expect(lents.call(fromTab, world, token, 'send', send)).rejects.toThrow('Extension context invalidated.')
    expect(asked).toEqual([])
  })

  it('does not give the runtime to a tab that is not lent, and gives it once it is', async () => {
    const { lents, grants, attaches, attach } = lentEngine()
    expect(await lents.ensure(7, EXT, 'default')).toBe(false)
    expect(attaches).toEqual([])
    grants.grant(EXT, 7, LENT)
    await attach()
    expect(attaches).toHaveLength(1)
  })

  it('takes an answer only from a worker of the extension that was asked, in the profile it was asked in, and once', async () => {
    // The extension is loaded in the profile `work` too: a call that is allowed there is still no answer to what was asked in `default`.
    const { lents, world, fromTab, grants, asked, call, attach } = lentEngine(undefined, { permissions: ['activeTab', 'scripting'] })
    grants.grant(EXT, 7, LENT)
    const token = await attach()
    let answer: string | undefined
    void lents.call(fromTab, world, token, 'send', send).then((text) => (answer = text))
    await later()
    const id = idOf(asked)
    // A page of the extension, another profile, an unknown request: no one's answer.
    await call('lentTab', 'answer', [id, { ok: true, value: 'from a page' }], 'frame:3')
    await call('lentTab', 'answer', [id, { ok: true, value: 'from another profile' }], 'worker:3', 'work')
    await call('lentTab', 'answer', ['no such request', { ok: true, value: 'x' }], 'worker:3')
    await call('lentTab', 'answer', [5, { ok: true, value: 'x' }], 'worker:3')
    await later()
    expect(answer).toBeUndefined()
    await call('lentTab', 'answer', [id, { ok: true, value: 'from the worker' }], 'worker:3')
    await call('lentTab', 'answer', [id, { ok: true, value: 'again' }], 'worker:3')
    await later()
    expect(JSON.parse(answer!)).toEqual({ ok: true, value: 'from the worker' })
  })

  // A worker may answer anything: a string of 150 MiB, an array of twenty million items. It is received whole; what is not done is writing it out, copying it and handing it to the page.
  it('replaces an answer of the worker that is longer than is handed over by an error, without writing it out: the value is measured, not copied', async () => {
    const { lents, world, fromTab, grants, asked, call, attach, asks } = lentEngine()
    grants.grant(EXT, 7, LENT)
    const token = await attach()
    const answers: string[] = []
    for (let i = 0; i < 3; i++) void lents.call(fromTab, world, token, 'send', send).then((text) => answers.push(text))
    await later()
    const ids = asked.map((each) => (each[4] as unknown[])[0] as string)
    const write = vi.spyOn(JSON, 'stringify')
    let written: unknown[] = []
    try {
      await call('lentTab', 'answer', [ids[0], { ok: true, value: 'x'.repeat(17 * 1024 * 1024) }], 'worker:3')
      await call('lentTab', 'answer', [ids[1], { ok: true, value: { big: new Array(20_000_000).fill(1) } }], 'worker:3')
      await call('lentTab', 'answer', [ids[2], { ok: true, value: { big: new Uint8Array(3_000_000) } }], 'worker:3')
      await later()
      written = write.mock.calls.map(([value]) => value)
    } finally {
      write.mockRestore()
    }
    // Nothing of what the worker sent was written out: only the three errors were.
    for (const value of written) expect(JSON.stringify(value ?? null).length).toBeLessThan(1000)
    expect(answers.map((text) => JSON.parse(text))).toEqual([1, 2, 3].map(() => ({ ok: false, error: 'The text handed over is too long.' })))
    expect(asks.size).toBe(0)
  })

  it('tells the script so, and keeps nothing waiting, when the worker does not start', async () => {
    const { engine, lents, world, fromTab, grants, asks, attach } = lentEngine()
    grants.grant(EXT, 7, LENT)
    const token = await attach()
    ;(engine['deliverToWorker'] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(`The worker of ${EXT} did not start`))
    expect(JSON.parse(await lents.call(fromTab, world, token, 'send', send))).toEqual({ ok: false, error: `The worker of ${EXT} did not start` })
    expect(asks.size).toBe(0)
  })

  it('ends what a tab asked when it closes, and what an extension was asked when it is unloaded from the profile or when its worker stops', async () => {
    const { engine, lents, world, fromTab, grants, asks, attach } = lentEngine()
    grants.grant(EXT, 7, LENT)
    const token = await attach()
    const ask = async (): Promise<string> => lents.call(fromTab, world, token, 'send', send)
    const first = ask()
    await later()
    expect(asks.size).toBe(1)
    // The tab closes: the engine tells the runtime of the lent tabs, which tells the asks.
    for (const listener of engine['tabClosedListeners'] as Array<(tab: number) => void>) listener(7)
    expect(JSON.parse(await first)).toEqual({ ok: false, error: 'The message port closed before a response was received.' })
    expect(asks.size).toBe(0)
    // The extension leaves the profile: the engine says so to whoever listens to the contexts that go.
    const token2 = await attach()
    const second = lents.call(fromTab, world, token2, 'send', send)
    await later()
    expect(asks.size).toBe(1)
    for (const listener of engine['contextGoneListeners'] as Array<(gone: unknown) => void>) listener({ extensionId: EXT, profileId: 'default' })
    expect(JSON.parse(await second)).toEqual({ ok: false, error: 'The message port closed before a response was received.' })
    expect(asks.size).toBe(0)
  })

  it('hands a message of the extension for a tab to the runtime of the lent tabs, and a change of the storage, as the worker or a page of the extension reports them', async () => {
    const { engine, call } = lentEngine()
    const toTab = vi.fn(async () => 'delivered')
    const changed = vi.fn()
    Object.assign(engine['lentTabs'] as unknown as object, { toTab, changed })
    expect(await call('lentTab', 'toTab', [7, { a: 1 }, { frameId: 0 }, `chrome-extension://${EXT}/background.js`], 'frame:3')).toBe('delivered')
    expect(toTab).toHaveBeenCalledWith('default', EXT, 7, { a: 1 }, `chrome-extension://${EXT}/background.js`, 0)
    await call('lentTab', 'toTab', [7, 'text'])
    expect(toTab).toHaveBeenLastCalledWith('default', EXT, 7, 'text', undefined, undefined)
    await expect(call('lentTab', 'toTab', ['seven', 1])).rejects.toThrow('No tab with id: seven.')
    await call('lentTab', 'changed', [{ k: { newValue: 1 } }, 'local'])
    expect(changed).toHaveBeenCalledWith('default', EXT, 'local', { k: { newValue: 1 } })
  })

  it('is served only to an extension that can be lent a tab, and only these three calls', async () => {
    for (const permissions of [['activeTab'], ['scripting'], ['storage'], []]) {
      const { call } = engineWith(permissions)
      for (const method of ['answer', 'toTab', 'changed']) await expect(call('lentTab', method, [0, {}]), `${permissions.join()} ${method}`).rejects.toThrow(`no permission to use chrome.lentTab.${method}`)
    }
    const { call } = lentEngine()
    for (const method of ['ask', 'ensure', 'deliver']) await expect(call('lentTab', method, [])).rejects.toThrow(`no permission to use chrome.lentTab.${method}`)
  })

  it('forgets a tab that is closed', () => {
    const { engine } = lentEngine()
    const listeners = engine['tabClosedListeners'] as Array<(tab: number) => void>
    expect(listeners).toHaveLength(1)
    const gone = vi.spyOn(engine['lentTabs'] as unknown as { tabGone(tab: number): void }, 'tabGone')
    listeners[0]!(7)
    expect(gone).toHaveBeenCalledWith(7)
  })
})
