// The question of a permission asked by a tab of a private window (or of a container) goes to the panel of that window, and its answer can be kept there:
// the engine knows such a page by its id with the context's prefix (`ephemeral:1/<tab id>`), the shell by the tab's own id, and the context hands the
// shell the id it knows (`scopedPermissionPolicy`). Before that, the private window found none of its own pages: the question went to a sheet of
// the system, never remembered (the engine checks of the windows and of the screen share saw no panel). Run on the real permission handler of
// the engine, with stand-ins of the sessions and the page.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { PermissionPolicy } from './types'

type RequestHandler = (contents: unknown, permission: string, answer: (granted: boolean) => void, details: Record<string, unknown>) => void
type CheckHandler = (contents: unknown, permission: string, requestingOrigin: string, details: Record<string, unknown>) => boolean

const holder = vi.hoisted(() => ({ partitions: new Map<string, unknown>() }))
vi.mock('electron', async () =>
  (await import('./electron-page.test-support')).electronStub({
    app: { getPath: (name: string) => `/tmp/lucium-test-${name}` },
    session: { defaultSession: {}, fromPartition: (name: string) => holder.partitions.get(name) }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { scopedPermissionPolicy } = await import('./ephemeral-scope')
const { TabAnswers } = await import('./tab-answers')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

/** A session that keeps the permission handler the engine gives it. */
function fakeSession(persistent: boolean) {
  const held: { request: RequestHandler | null; check: CheckHandler | null } = { request: null, check: null }
  const schemes = new Map<string, (request: Request) => Response | Promise<Response>>()
  return {
    held,
    schemes,
    setPermissionRequestHandler: (handler: RequestHandler) => void (held.request = handler),
    setPermissionCheckHandler: (handler: CheckHandler) => void (held.check = handler),
    isPersistent: () => persistent,
    getStoragePath: () => (persistent ? '/tmp/lucium-test-partition' : null),
    // The scheme of the Extensions page is refused in these sessions (internal-pages.ts).
    protocol: { handle: (scheme: string, handler: (request: Request) => Response | Promise<Response>) => void schemes.set(scheme, handler) }
  }
}

/** The web contents of a tab: no window of its own here, so a question sent to a sheet of the system finds none and is refused. */
const tabContents = { id: 41, opener: null, isDestroyed: () => false, once: () => undefined }

/** An engine with the real permission handler and none of what the constructor builds; the page of the tab is known under `pageId`. */
function engineWithPage(pageId: string): Record<string, unknown> {
  return Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    pages: new Map([[pageId, { webContents: tabContents }]]),
    pageByContents: new Map(),
    scopes: new Map(),
    containerScopes: new Map(),
    scopeCounter: 0,
    popups: { windowOf: () => undefined },
    permissionSessions: new WeakMap(),
    tabAnswers: new TabAnswers(),
    applyProxyTo: () => undefined,
    installDisplayMedia: () => undefined,
    installDownloads: () => undefined,
    installRequestBlocker: () => undefined
  })
}

/** What the window of the shell is asked: it has a panel for its own tab (`tab-a`) and nothing else, and answers yes. */
function shellPolicy() {
  return {
    lookup: vi.fn(() => undefined),
    ask: vi.fn(async () => true),
    hasPanel: vi.fn((pageId: string) => pageId === 'tab-a'),
    screenShareAllowed: () => true
  } satisfies PermissionPolicy
}

async function request(handler: RequestHandler, permission = 'geolocation'): Promise<boolean> {
  return new Promise((resolve) => handler(tabContents, permission, resolve, { requestingUrl: 'http://127.0.0.1:9/geo' }))
}

describe('the question of a permission from a tab of a private window or of a container', () => {
  it('a private window: the window is asked about its own tab, in its panel', async () => {
    const engine = engineWithPage('ephemeral:1/tab-a')
    const ses = fakeSession(false)
    holder.partitions.set('ephemeral-1', ses)
    const scope = methods['openEphemeral']!.call(engine, 'private-1') as { setPermissionPolicy(policy: PermissionPolicy): void }
    const policy = shellPolicy()
    scope.setPermissionPolicy(policy)

    expect(await request(ses.held.request!)).toBe(true)
    expect(policy.hasPanel).toHaveBeenCalledWith('tab-a')
    expect(policy.ask).toHaveBeenCalledWith('http://127.0.0.1:9', 'geolocation', 'tab-a', undefined)
  })

  it('a private window holds no answer for its tab: after a yes, the check of the same tab still says no', async () => {
    const engine = engineWithPage('ephemeral:1/tab-a')
    const ses = fakeSession(false)
    holder.partitions.set('ephemeral-1', ses)
    const scope = methods['openEphemeral']!.call(engine, 'private-1') as { setPermissionPolicy(policy: PermissionPolicy): void }
    scope.setPermissionPolicy(shellPolicy())
    const check = (): boolean => ses.held.check!(tabContents, 'geolocation', 'http://127.0.0.1:9', { requestingUrl: 'http://127.0.0.1:9/geo', isMainFrame: true })

    expect(await request(ses.held.request!)).toBe(true)
    expect(check()).toBe(false)
  })

  it('a container holds it, as a tab of a profile does: its pages are not private', async () => {
    const engine = engineWithPage('container:c1/tab-a')
    const ses = fakeSession(true)
    holder.partitions.set('persist:container-c1', ses)
    const scope = methods['openContainer']!.call(engine, 'c1', 'main') as { setPermissionPolicy(policy: PermissionPolicy): void }
    scope.setPermissionPolicy(shellPolicy())
    const check = (): boolean => ses.held.check!(tabContents, 'geolocation', 'http://127.0.0.1:9', { requestingUrl: 'http://127.0.0.1:9/geo', isMainFrame: true })

    expect(check()).toBe(false)
    expect(await request(ses.held.request!)).toBe(true)
    expect(check()).toBe(true)
  })

  it('a container: the same, under the container’s own prefix', async () => {
    const engine = engineWithPage('container:c1/tab-a')
    const ses = fakeSession(true)
    holder.partitions.set('persist:container-c1', ses)
    const scope = methods['openContainer']!.call(engine, 'c1', 'main') as { setPermissionPolicy(policy: PermissionPolicy): void }
    const policy = shellPolicy()
    scope.setPermissionPolicy(policy)

    expect(await request(ses.held.request!)).toBe(true)
    expect(policy.ask).toHaveBeenCalledWith('http://127.0.0.1:9', 'geolocation', 'tab-a', undefined)
  })
})

describe('scopedPermissionPolicy', () => {
  it('a page of another context is no page of this one: no panel for it, and the question names no page', async () => {
    const policy = shellPolicy()
    const scoped = scopedPermissionPolicy(policy, 'ephemeral:2/')
    expect(scoped.hasPanel?.('ephemeral:1/tab-a')).toBe(false)
    expect(policy.hasPanel).not.toHaveBeenCalled()
    await scoped.ask('https://a.example', 'notifications', 'ephemeral:1/tab-a')
    expect(policy.ask).toHaveBeenCalledWith('https://a.example', 'notifications', undefined, undefined)
  })

  it('a policy without hasPanel keeps none (the engine then asks in the panel), and the rest is passed on as it is', async () => {
    const { hasPanel: _none, ...bare } = shellPolicy()
    const scoped = scopedPermissionPolicy(bare, 'ephemeral:1/')
    expect(scoped.hasPanel).toBeUndefined()
    expect(scoped.screenShareAllowed()).toBe(true)
    expect(scoped.lookup('https://a.example', 'geolocation')).toBeUndefined()
    expect(bare.lookup).toHaveBeenCalledWith('https://a.example', 'geolocation')
  })
})

describe('the Extensions page in a private window and in a container', () => {
  /** A request as the page loading itself would make it: a document navigation of the top frame, with everything in order. */
  const navigation = new Request('lucium-ui://extensions/', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' } })

  // The application knows where the page is, and a session of a profile would serve it: what refuses it here is the session being private or a container's.
  beforeAll(async () => {
    const { setInternalPagesHome } = await import('./internal-pages')
    setInternalPagesHome({ rendererDir: '/app/out/renderer', projectRoot: '/Users/jane/lucium' }, () => ({
      readText: (file) => (file === 'extensions.html' ? '<html></html>' : null),
      has: () => false,
      readBytes: () => new TextEncoder().encode('<html></html>'),
      fetchDev: () => Promise.reject(new Error('no development server'))
    }))
  })

  it('is refused by the session of a private window: whatever asks, nothing is served and no preload is given', async () => {
    const engine = engineWithPage('ephemeral:1/tab-a')
    const ses = fakeSession(false)
    holder.partitions.set('ephemeral-1', ses)
    methods['openEphemeral']!.call(engine, 'private-1')
    expect([...ses.schemes.keys()]).toEqual(['lucium-ui'])
    const answer = await ses.schemes.get('lucium-ui')!(navigation)
    expect(answer.status).toBe(403)
    expect(await answer.text()).toBe('')
  })

  it('is refused by the session of a container: it never opens there either', async () => {
    const engine = engineWithPage('container:c1/tab-a')
    const ses = fakeSession(true)
    holder.partitions.set('persist:container-c1', ses)
    methods['openContainer']!.call(engine, 'c1', 'main')
    expect([...ses.schemes.keys()]).toEqual(['lucium-ui'])
    expect((await ses.schemes.get('lucium-ui')!(navigation)).status).toBe(403)
  })
})
