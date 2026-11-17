// The identity of the sign-in pages of Google (shared/google-sign-in.ts) in the engine: the application keeps Electron's own user agent for itself while the pages are made a Chrome, and the
// tabs that are on the sign-in hosts get it back, with no preload of Lucium that writes into the page running there. Run on the real engine over a stand-in of Electron
// (engine-constructed.test-support.ts). The real behavior (Google's answer, Chromium reloading a tab whose user agent changes) is for a person with a window.
// In the header hook of the sessions: client-hints-wiring.test.ts.

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromeUserAgent } from '@shared/user-agent'
import { constructEngine, emitApp, world } from './engine-constructed.test-support'
import type { SignInAgents } from './google-sign-in-agent'

vi.mock('electron', async () => (await import('./engine-constructed.test-support')).engineElectron())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined, handleCRXProtocol: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

afterEach(() => {
  delete (process.versions as unknown as Record<string, unknown>)['chrome']
  vi.restoreAllMocks()
})

interface Engine {
  signIn: SignInAgents | null
  mediaBridge: { ensure(session: unknown): void }
  installDialogBridge(session: unknown): void
  installChromeApp(session: unknown): void
  syncPasswordBridge(session: unknown): void
  syncPageGuard(session: unknown, wanted: boolean): void
  syncWorkerGuard(session: unknown, wanted: boolean): void
  passwordBridgeOn: boolean
}

/** The real engine. With `chrome` set, Chromium's version is what Electron's `process.versions` says (Node has none), and the engine presents the pages as a Chrome. */
async function engineWith(chrome: string | undefined) {
  if (chrome !== undefined) Object.defineProperty(process.versions, 'chrome', { value: chrome, configurable: true })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const engine = (await constructEngine()) as unknown as Engine
  return { engine, warn }
}

/** A session as far as preload scripts go: what was registered, in order. */
function sessionTaking() {
  const registered: Array<Record<string, unknown>> = []
  const serviceWorkers = { on: (): void => undefined, removeListener: (): void => undefined, getWorkerFromVersionID: (): undefined => undefined }
  return { registered, serviceWorkers, registerPreloadScript: (script: Record<string, unknown>) => (registered.push(script), String(script['id'])), unregisterPreloadScript: () => undefined }
}

/** Every page preload the engine puts in a session of pages by itself. */
function registerEverything(engine: Engine) {
  const ses = sessionTaking()
  engine.mediaBridge.ensure(ses)
  engine.installDialogBridge(ses)
  engine.installChromeApp(ses)
  engine.passwordBridgeOn = true
  engine.syncPasswordBridge(ses)
  engine.syncPageGuard(ses, true)
  engine.syncWorkerGuard(ses, true)
  return Object.fromEntries(ses.registered.map((script) => [String(script['id']), script])) as Record<string, Record<string, unknown>>
}

/** A web contents as far as the engine's listeners read it: the events, the session, the user agent it was given. */
function contents(id: number) {
  const given: string[] = []
  const session = { name: `session of tab ${id}` }
  const wc = Object.assign(new EventEmitter(), { id, session, debugger: { isAttached: () => false }, isDestroyed: () => false, setUserAgent: (agent: string) => given.push(agent) })
  return { wc, given }
}

const EXCLUDED = ['https://accounts.google.com/*', 'https://accounts.youtube.com/*']
const SIGN_IN = { url: 'https://accounts.google.com/v3/signin/identifier', isMainFrame: true, isSameDocument: false }

// First of the file: it needs the engine to find no usable Chromium version. The engine that follows set Chromium's version, and the agent of the application is kept from then on.
describe('the sign-in pages of Google in the engine, with pages that were not made a Chrome', () => {
  it('there is nothing to change: no identity, no listener on a tab, and the user agent of no tab is touched', async () => {
    const { engine, warn } = await engineWith(undefined)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unexpected Chromium version'))
    expect(engine.signIn).toBeNull()
    const { wc, given } = contents(1)
    emitApp('web-contents-created', wc)
    for (const event of ['will-navigate', 'will-redirect', 'did-start-navigation', 'did-redirect-navigation']) {
      expect(wc.listenerCount(event), event).toBe(0)
      wc.emit(event, SIGN_IN)
    }
    expect(given).toEqual([])
  })
})

describe('the sign-in pages of Google in the engine', () => {
  it('has the user agent Electron had before the pages were made a plain Chrome, and the Chrome of the pages to go back to', async () => {
    const { engine } = await engineWith('156.0.8078.48')
    expect(engine.signIn?.identity).toEqual({ agent: 'Lucium Electron/45', pageAgent: chromeUserAgent('156.0.8078.48', process.platform) })
  })

  it('keeps the preloads that write into a page out of the sign-in hosts: the media bridge, the dialogs, window.chrome.app and the state of the permissions, the page guard and the same guard in the workers', async () => {
    const { engine } = await engineWith('156.0.8078.48')
    const scripts = registerEverything(engine)
    expect(Object.keys(scripts).sort()).toEqual(['lucium-chrome-app', 'lucium-dialog-bridge', 'lucium-media-bridge', 'lucium-page-guard', 'lucium-page-guard-sw', 'lucium-password-bridge'])
    for (const id of ['lucium-media-bridge', 'lucium-dialog-bridge', 'lucium-chrome-app', 'lucium-page-guard', 'lucium-page-guard-sw']) expect(scripts[id], id).toMatchObject({ excludeMatches: EXCLUDED })
    // The password bridge keeps to the isolated world of the page: the page cannot see it, and it is left as it was.
    expect(Object.keys(scripts['lucium-password-bridge']!).sort()).toEqual(['filePath', 'id', 'type'])
  })

  it('follows every web contents from its birth: the tab gets Electron’s agent on the sign-in host and the agent of the pages back when it leaves', async () => {
    const { engine } = await engineWith('156.0.8078.48')
    const { wc, given } = contents(5)
    emitApp('web-contents-created', wc)
    wc.emit('did-start-navigation', SIGN_IN)
    expect(given).toEqual(['Lucium Electron/45'])
    expect(engine.signIn!.has(5)).toBe(true)
    wc.emit('did-start-navigation', { url: 'https://mail.google.com/mail/u/0/', isMainFrame: true, isSameDocument: false })
    expect(given).toEqual(['Lucium Electron/45', engine.signIn!.identity.pageAgent])
    expect(engine.signIn!.has(5)).toBe(false)
  })

  it('tells the engine the session of a tab each time it goes onto the hosts, so that the header hook of that session sees the requests of the tab', async () => {
    const { engine } = await engineWith('156.0.8078.48')
    const watch = vi.spyOn(engine as unknown as { watchSignInPages(session: unknown): void }, 'watchSignInPages').mockImplementation(() => undefined)
    const { wc } = contents(8)
    emitApp('web-contents-created', wc)
    wc.emit('did-start-navigation', { url: 'https://site.example/', isMainFrame: true, isSameDocument: false })
    expect(watch).not.toHaveBeenCalled()
    wc.emit('did-start-navigation', SIGN_IN)
    expect(watch).toHaveBeenCalledTimes(1)
    expect(watch).toHaveBeenCalledWith(wc.session)
  })

  it('a tab that never goes to the sign-in hosts is given nothing', async () => {
    await engineWith('156.0.8078.48')
    const { wc, given } = contents(6)
    emitApp('web-contents-created', wc)
    for (const url of ['https://mail.google.com/', 'https://accounts.google.com.example/', 'https://site.example/']) wc.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false })
    expect(given).toEqual([])
  })

  it('adds no listener of its own on the application: the one that notes the gestures of the user follows the tabs too', async () => {
    await engineWith('156.0.8078.48')
    expect(world.appListeners.get('web-contents-created')).toHaveLength(1)
  })
})
