// The refusals of the engine's real permission handlers (electron-engine-permissions.ts), run with stand-ins of the session and of the page: the page
// of a sign-in flow or of a hidden view is given nothing, by the question as by the check; a device is never granted by a question; the screen is
// shared only when the setting allows it and a click explains it; and nothing is granted while no window answers. The same mark stops a download.
// The rules alone are in shared/permissions.test.ts and share-gesture.test.ts; before this file only engine checks ran these lines.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { frenchSpaces } from '@shared/french-typography'
import type { PermissionPolicy } from './types'

type RequestHandler = (contents: unknown, permission: string, answer: (granted: boolean) => void, details: Record<string, unknown>) => void
type CheckHandler = (contents: unknown, permission: string, requestingOrigin: string, details: Record<string, unknown>) => boolean
type DownloadListener = (event: { preventDefault(): void }, item: unknown, source: unknown) => void

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub({ app: { getPath: (name: string) => `/tmp/lucium-test-${name}` }, session: { defaultSession: {} } }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const { isAuthContents, markHiddenContents } = await import('./web-auth')
const { TabAnswers } = await import('./tab-answers')
const methods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const SITE = 'https://site.example'
/** The web contents of a tab of the window, and of a page nobody sees (a sign-in flow, a page read for a watch). */
const tab = { id: 41, opener: null, isDestroyed: () => false, once: () => undefined }
const hidden = { id: 77, opener: null, isDestroyed: () => false, once: () => undefined }

/** A window that has a panel for the tab, remembers `remembered`, and answers yes to what it is asked. */
function shellPolicy(over: { screenShare?: boolean; remembered?: 'allow' | 'deny' } = {}) {
  return {
    lookup: vi.fn(() => over.remembered),
    ask: vi.fn(async () => true),
    hasPanel: vi.fn(() => true),
    screenShareAllowed: () => over.screenShare ?? true
  } satisfies PermissionPolicy
}

/** The real handlers of the engine on a session, over a tab whose page has (or has not) a click to explain a share of the screen. */
function installed(options: { policy?: PermissionPolicy | null; gesture?: boolean; hardware?: boolean; privateContext?: boolean } = {}) {
  const held: { request?: RequestHandler; check?: CheckHandler; download?: DownloadListener } = {}
  const ses = {
    setPermissionRequestHandler: (handler: RequestHandler) => void (held.request = handler),
    setPermissionCheckHandler: (handler: CheckHandler) => void (held.check = handler),
    on: (name: string, listener: DownloadListener) => void (name === 'will-download' && (held.download = listener)),
    extensions: { getExtension: () => null }
  }
  const page = { webContents: tab, noteCapture: vi.fn(), takeShareGesture: vi.fn(() => options.gesture ?? true) }
  const policy = options.policy === undefined ? shellPolicy() : options.policy
  const hardwareAsked = vi.fn(() => options.hardware ?? true)
  const engine = Object.assign(Object.create(ElectronEngine.prototype) as Record<string, unknown>, {
    pages: new Map([['tab-a', page]]),
    pageByContents: new Map([[tab.id, 'tab-a']]),
    popups: { windowOf: () => undefined, ownerKeyOf: () => undefined },
    hardware: { mayRequest: hardwareAsked },
    downloadListeners: new Set(),
    downloadCounter: 0,
    permissionSessions: new WeakMap(),
    tabAnswers: new TabAnswers(),
    // The captures of the sound of a tab: no helper page exists here, so no page holds the screen on their account (tab-capture-wiring.test.ts has the ones that do).
    profiles: new Map(),
    tabCaptures: { mayShare: () => false }
  })
  // A private context passes no profile: it is never given a device. Nor does it hold an answer for a tab.
  methods['installPermissions']!.call(engine, ses, () => policy, ...(options.privateContext ? [undefined, false] : ['main']))
  methods['installDownloads']!.call(engine, ses, 'main')
  const request = (contents: unknown, permission: string, details: Record<string, unknown> = { requestingUrl: `${SITE}/page` }): Promise<boolean> => new Promise((resolve) => held.request!(contents, permission, resolve, details))
  const check = (contents: unknown, permission: string, details: Record<string, unknown> = { requestingUrl: `${SITE}/page`, isMainFrame: true }): boolean => held.check!(contents, permission, SITE, details)
  /** The page of a tab asks whether a permission was ever answered for its site (the synchronous message of src/preload/permission-state.ts). */
  const undecided = (contents: { id: number }, name: unknown, over: { url?: string; frame?: 'main' | 'inner' } = {}): unknown => {
    const mainFrame = { url: over.url ?? `${SITE}/page` }
    const event: Record<string, unknown> = { sender: { ...contents, session: ses, mainFrame }, senderFrame: over.frame === 'inner' ? { url: `${SITE}/frame` } : mainFrame }
    methods['permissionUndecided']!.call(engine, event, name)
    return event['returnValue']
  }
  return { request, check, undecided, engine, ses, policy, page, hardwareAsked, download: held.download! }
}

let unmark: (() => void) | undefined
afterEach(() => {
  unmark?.()
  unmark = undefined
  vi.restoreAllMocks()
})

describe('the mark of a page nobody sees', () => {
  it('is on from `markHiddenContents` until the call it returns, for that web contents only', () => {
    expect(isAuthContents(hidden as never)).toBe(false)
    unmark = markHiddenContents(hidden.id)
    expect(isAuthContents(hidden as never)).toBe(true)
    expect(isAuthContents(tab as never)).toBe(false)
    expect(isAuthContents(null)).toBe(false)
    unmark()
    expect(isAuthContents(hidden as never)).toBe(false)
  })
})

describe('a permission asked by the page of a sign-in flow or of a hidden view', () => {
  it('is refused, even one that any tab is granted without a question, and the window is asked nothing', async () => {
    const world = installed()
    unmark = markHiddenContents(hidden.id)
    for (const permission of ['fullscreen', 'pointerLock', 'notifications', 'geolocation', 'media', 'display-capture']) expect(await world.request(hidden, permission), permission).toBe(false)
    expect(world.policy!.ask).not.toHaveBeenCalled()
    expect(world.policy!.lookup).not.toHaveBeenCalled()
    // The same request from a tab is granted: the refusal above is the mark's.
    expect(await world.request(tab, 'fullscreen')).toBe(true)
  })

  it('is refused by the check too: an answer remembered for the site does not go to a page without an address bar', () => {
    const world = installed({ policy: shellPolicy({ remembered: 'allow' }) })
    expect(world.check(tab, 'geolocation')).toBe(true)
    expect(world.check(tab, 'fullscreen')).toBe(true)
    unmark = markHiddenContents(hidden.id)
    expect(world.check(hidden, 'geolocation')).toBe(false)
    expect(world.check(hidden, 'fullscreen')).toBe(false)
    expect(world.check(hidden, 'hid')).toBe(false)
    expect(world.hardwareAsked).not.toHaveBeenCalled()
  })

  it('starts no download', () => {
    const world = installed()
    unmark = markHiddenContents(hidden.id)
    const event = { preventDefault: vi.fn() }
    // The item is not even read: a download of a hidden page is stopped before it has a name or a place.
    world.download(event, new Proxy({}, { get: () => expect.unreachable('the item of a refused download was read') }), hidden)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })
})

describe('a permission asked by a tab', () => {
  it('is asked to the window, in the panel of the tab, when nothing decides before', async () => {
    const world = installed()
    expect(await world.request(tab, 'geolocation')).toBe(true)
    expect(world.policy!.ask).toHaveBeenCalledWith(SITE, 'geolocation', 'tab-a', undefined)
  })

  it('is refused for a device (HID, USB, serial): a device is picked in the list of the hardware service, never granted by a question', async () => {
    const world = installed({ policy: shellPolicy({ remembered: 'allow' }) })
    for (const permission of ['hid', 'usb', 'serial']) expect(await world.request(tab, permission), permission).toBe(false)
    expect(world.policy!.ask).not.toHaveBeenCalled()
    expect(world.policy!.lookup).not.toHaveBeenCalled()
  })

  it('is refused for an address that is no site (file:, data:, an address that is not one), whatever was remembered', async () => {
    const world = installed({ policy: shellPolicy({ remembered: 'allow' }) })
    for (const requestingUrl of ['file:///Users/x/page.html', 'data:text/html,x', 'not an address', 'about:blank']) expect(await world.request(tab, 'geolocation', { requestingUrl }), requestingUrl).toBe(false)
    expect(world.policy!.ask).not.toHaveBeenCalled()
    expect(world.check(tab, 'geolocation', { requestingUrl: 'file:///Users/x/page.html', isMainFrame: true })).toBe(false)
  })

  it('is refused while no window answers the questions of the session', async () => {
    const world = installed({ policy: null })
    expect(await world.request(tab, 'geolocation')).toBe(false)
    expect(world.check(tab, 'geolocation')).toBe(false)
  })

  it('follows a remembered answer without asking again, a refusal as well as an agreement', async () => {
    const denied = installed({ policy: shellPolicy({ remembered: 'deny' }) })
    expect(await denied.request(tab, 'geolocation')).toBe(false)
    expect(denied.check(tab, 'geolocation')).toBe(false)
    expect(denied.policy!.ask).not.toHaveBeenCalled()
    const allowed = installed({ policy: shellPolicy({ remembered: 'allow' }) })
    expect(await allowed.request(tab, 'geolocation')).toBe(true)
    expect(allowed.policy!.ask).not.toHaveBeenCalled()
  })

  it('is asked again each time for opening another application, whatever an older version remembered', async () => {
    const world = installed({ policy: shellPolicy({ remembered: 'allow' }) })
    expect(world.check(tab, 'openExternal')).toBe(false)
    await world.request(tab, 'openExternal', { requestingUrl: `${SITE}/page`, externalURL: 'mailto:a@b.example' })
    expect(world.policy!.lookup).not.toHaveBeenCalledWith(SITE, 'openExternal')
    expect(world.policy!.ask).toHaveBeenCalledWith(SITE, 'openExternal', 'tab-a', 'mailto:')
  })

  it('is refused when the question itself fails, with the reason in the journal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const policy = { ...shellPolicy(), ask: vi.fn(async () => Promise.reject(new Error('the panel is gone'))) }
    expect(await installed({ policy }).request(tab, 'geolocation')).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('permission prompt failed'), expect.any(Error))
  })
})

describe('sharing the screen', () => {
  it('is refused while it is turned off in the settings, before anything remembered is read and without a question', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const world = installed({ policy: shellPolicy({ screenShare: false, remembered: 'allow' }) })
    expect(await world.request(tab, 'display-capture')).toBe(false)
    expect(world.policy!.lookup).not.toHaveBeenCalled()
    expect(world.policy!.ask).not.toHaveBeenCalled()
    expect(world.page.noteCapture).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('turned off in the settings'))
  })

  it('is refused without a click or a key in the tab just before, whatever was remembered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const world = installed({ gesture: false, policy: shellPolicy({ remembered: 'allow' }) })
    expect(await world.request(tab, 'display-capture')).toBe(false)
    expect(world.policy!.lookup).not.toHaveBeenCalled()
    expect(world.policy!.ask).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no click or key in the tab'))
  })

  it('is refused to a web contents that is no tab (a popup, a panel): only a tab can have had the click', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const world = installed()
    expect(await world.request({ id: 500, opener: null }, 'display-capture')).toBe(false)
    expect(world.page.takeShareGesture).not.toHaveBeenCalled()
    expect(world.policy!.ask).not.toHaveBeenCalled()
  })

  it('goes to the question when the setting allows it and a click explains it, and the tab is then kept awake', async () => {
    const world = installed()
    expect(await world.request(tab, 'display-capture')).toBe(true)
    expect(world.page.takeShareGesture).toHaveBeenCalledTimes(1)
    expect(world.policy!.ask).toHaveBeenCalledWith(SITE, 'display-capture', 'tab-a', undefined)
    expect(world.page.noteCapture).toHaveBeenCalledTimes(1)
  })
})

describe('the check of a device permission', () => {
  it('is the hardware service’s answer in a profile, and always no in a private context (no profile to keep a device for)', () => {
    const world = installed({ policy: shellPolicy({ remembered: 'allow' }) })
    expect(world.check(tab, 'hid')).toBe(true)
    expect(world.hardwareAsked).toHaveBeenCalledWith(expect.objectContaining({ permission: 'hid', origin: SITE, contentsKnown: true, isMainFrame: true }))
    expect(installed({ hardware: false }).check(tab, 'hid')).toBe(false)
    const privateWindow = installed({ privateContext: true })
    expect(privateWindow.check(tab, 'hid')).toBe(false)
    expect(privateWindow.hardwareAsked).not.toHaveBeenCalled()
  })
})

describe('an answer given to a tab without « Se souvenir »', () => {
  /** A window that remembers nothing and answers `answer` to what it is asked. */
  const forgetful = (answer = true) => ({ ...shellPolicy(), lookup: vi.fn((): 'allow' | 'deny' | undefined => undefined), ask: vi.fn(async () => answer) })
  /** Another tab of the same session, and a tab whose end the test decides. */
  const otherTab = { id: 42, opener: null, isDestroyed: () => false, once: () => undefined }

  it('is what the checks of that tab read from then on: the site was allowed, and reads that it was', async () => {
    const world = installed({ policy: forgetful() })
    expect(world.check(tab, 'notifications')).toBe(false)
    expect(await world.request(tab, 'notifications')).toBe(true)
    expect(world.check(tab, 'notifications')).toBe(true)
    // The yes holds: the site is not asked about a second time in this tab.
    expect(await world.request(tab, 'notifications')).toBe(true)
    expect(world.policy!.ask).toHaveBeenCalledTimes(1)
  })

  it('gives nothing to another site, to another tab, nor to another permission', async () => {
    const world = installed({ policy: forgetful() })
    await world.request(tab, 'notifications')
    expect(world.check(tab, 'notifications', { requestingUrl: 'https://other.example/page', isMainFrame: true })).toBe(false)
    expect(world.check(otherTab, 'notifications')).toBe(false)
    expect(world.check(tab, 'geolocation')).toBe(false)
  })

  it('answers a check that names no tab (a frame of the site elsewhere, a worker) while a tab of the session holds the yes', async () => {
    const world = installed({ policy: forgetful() })
    expect(world.check(null, 'notifications')).toBe(false)
    await world.request(tab, 'notifications')
    expect(world.check(null, 'notifications')).toBe(true)
  })

  it('is a refusal the tab reads too, and the user is asked again when the page asks again', async () => {
    const world = installed({ policy: forgetful(false) })
    expect(await world.request(tab, 'notifications')).toBe(false)
    expect(world.check(tab, 'notifications')).toBe(false)
    expect(world.undecided(tab, 'notifications')).toBe(false)
    expect(await world.request(tab, 'notifications')).toBe(false)
    expect(world.policy!.ask).toHaveBeenCalledTimes(2)
  })

  it('goes with the page of the tab', async () => {
    const world = installed({ policy: forgetful() })
    let gone: (() => void) | undefined
    const closing = { id: 43, opener: null, isDestroyed: () => false, once: (name: string, listener: () => void) => void (name === 'destroyed' && (gone = listener)) }
    await world.request(closing, 'notifications')
    expect(world.check(closing, 'notifications')).toBe(true)
    gone!()
    expect(world.check(closing, 'notifications')).toBe(false)
    expect(world.check(null, 'notifications')).toBe(false)
  })

  it('is not held when the user had it remembered: the state answers, and what the user changes there counts at once', async () => {
    const kept: { answer: 'allow' | 'deny' | undefined } = { answer: undefined }
    const policy = { ...shellPolicy(), lookup: vi.fn(() => kept.answer), ask: vi.fn(async () => ((kept.answer = 'allow'), true)) }
    const world = installed({ policy })
    expect(await world.request(tab, 'notifications')).toBe(true)
    expect(world.check(tab, 'notifications')).toBe(true)
    // The user takes the answer back in the settings: nothing of it stays with the tab.
    kept.answer = undefined
    expect(world.check(tab, 'notifications')).toBe(false)
  })

  it('is never held for opening another application, which is asked each time', async () => {
    const world = installed({ policy: forgetful() })
    expect(await world.request(tab, 'openExternal', { requestingUrl: `${SITE}/page`, externalURL: 'mailto:a@b.example' })).toBe(true)
    expect(await world.request(tab, 'openExternal', { requestingUrl: `${SITE}/page`, externalURL: 'mailto:a@b.example' })).toBe(true)
    expect(world.policy!.ask).toHaveBeenCalledTimes(2)
    expect(world.check(tab, 'openExternal')).toBe(false)
  })

  it('is never held in a private context: the tab reads nothing of the yes it was given, and is asked again', async () => {
    const world = installed({ policy: forgetful(), privateContext: true })
    expect(await world.request(tab, 'notifications')).toBe(true)
    expect(world.check(tab, 'notifications')).toBe(false)
    expect(world.check(null, 'notifications')).toBe(false)
    expect(world.undecided(tab, 'notifications')).toBe(true)
    expect(await world.request(tab, 'notifications')).toBe(true)
    expect(world.policy!.ask).toHaveBeenCalledTimes(2)
    // And were an answer held for one of its tabs, by whatever way, no check of the private context would read it.
    const answers = world.engine['tabAnswers'] as InstanceType<typeof TabAnswers>
    answers.note(tab.id, world.ses, SITE, 'notifications', 'allow')
    expect(world.check(tab, 'notifications')).toBe(false)
    expect(world.check(null, 'notifications')).toBe(false)
    expect(world.undecided(tab, 'notifications')).toBe(true)
  })
})

describe('what a page is told of a permission nobody answered', () => {
  const forgetful = () => ({ ...shellPolicy(), lookup: vi.fn((): 'allow' | 'deny' | undefined => undefined) })

  it('is that nobody answered, for a site that was never asked; and that somebody did, once the tab was answered', async () => {
    const world = installed({ policy: forgetful() })
    expect(world.undecided(tab, 'notifications')).toBe(true)
    expect(world.undecided(tab, 'camera')).toBe(true)
    await world.request(tab, 'notifications')
    expect(world.undecided(tab, 'notifications')).toBe(false)
    // The answer was for the notifications of this site, in this tab.
    expect(world.undecided(tab, 'geolocation')).toBe(true)
    expect(world.undecided({ ...tab, id: 42 }, 'notifications')).toBe(true)
  })

  it('is that somebody answered when the user had an answer remembered, a refusal as well as an agreement', () => {
    expect(installed({ policy: shellPolicy({ remembered: 'deny' }) }).undecided(tab, 'notifications')).toBe(false)
    expect(installed({ policy: shellPolicy({ remembered: 'allow' }) }).undecided(tab, 'notifications')).toBe(false)
  })

  it('is no for everything that is not the main frame of a web page asking about a permission the user is asked for', () => {
    const world = installed({ policy: forgetful() })
    expect(world.undecided(tab, 'openExternal')).toBe(false)
    expect(world.undecided(tab, 'hid')).toBe(false)
    expect(world.undecided(tab, { name: 'notifications' })).toBe(false)
    expect(world.undecided(tab, 'notifications', { frame: 'inner' })).toBe(false)
    expect(world.undecided(tab, 'notifications', { url: 'file:///Users/me/page.html' })).toBe(false)
    expect(world.undecided(tab, 'notifications', { url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html' })).toBe(false)
    // While no window answers the questions of the session, a request is refused: the page is not told to ask.
    expect(installed({ policy: null }).undecided(tab, 'notifications')).toBe(false)
  })

  it('is no for the page of a sign-in flow or of a hidden view, which may ask for nothing', () => {
    const world = installed({ policy: forgetful() })
    unmark = markHiddenContents(hidden.id)
    expect(world.undecided(hidden, 'notifications')).toBe(false)
  })

  it('is no for a session the engine did not set up', () => {
    const world = installed({ policy: forgetful() })
    const mainFrame = { url: `${SITE}/page` }
    const event: Record<string, unknown> = { sender: { ...tab, session: {}, mainFrame }, senderFrame: mainFrame }
    methods['permissionUndecided']!.call(world.engine, event, 'notifications')
    expect(event['returnValue']).toBe(false)
  })

  it('answers no, with the reason in the journal, when the question itself fails: the page is waiting and is always answered', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const world = installed({ policy: { ...forgetful(), lookup: () => { throw new Error('state unreadable') } } })
    expect(world.undecided(tab, 'notifications')).toBe(false)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot tell a page whether a permission was answered'), 'state unreadable')
  })
})

describe('a page that asks for a file or a folder (File System Access)', () => {
  const details = { requestingUrl: `${SITE}/page`, filePath: '/Users/moi/Documents', isDirectory: true, fileAccessType: 'writable' }

  it('is asked with the folder and the mode in the question', async () => {
    const world = installed()
    expect(await world.request(tab, 'fileSystem', details)).toBe(true)
    expect(world.policy!.ask).toHaveBeenCalledExactlyOnceWith(SITE, 'fileSystem', 'tab-a', frenchSpaces('modifier le dossier « /Users/moi/Documents » et tout ce qu’il contient'))
  })

  it('is asked again for another file: a yes given to the tab does not carry over', async () => {
    const world = installed()
    await world.request(tab, 'fileSystem', details)
    await world.request(tab, 'fileSystem', { requestingUrl: `${SITE}/page`, filePath: '/Users/moi/Bureau/cles.txt', isDirectory: false, fileAccessType: 'readable' })
    expect(world.policy!.ask).toHaveBeenCalledTimes(2)
    expect(world.policy!.ask).toHaveBeenLastCalledWith(SITE, 'fileSystem', 'tab-a', frenchSpaces('lire le fichier « /Users/moi/Bureau/cles.txt »'))
  })

  it('is asked even when an older state holds a remembered yes for the site', async () => {
    const world = installed({ policy: shellPolicy({ remembered: 'allow' }) })
    await world.request(tab, 'fileSystem', details)
    expect(world.policy!.ask).toHaveBeenCalledTimes(1)
    expect(world.policy!.lookup).not.toHaveBeenCalled()
  })
})

describe('a page that asks for what the engine names in its own way', () => {
  it('is given the screen kept on and its storage kept without a question, by the request as by the check', async () => {
    const world = installed()
    for (const permission of ['screen-wake-lock', 'persistent-storage', 'background-sync']) {
      expect(await world.request(tab, permission), permission).toBe(true)
      expect(world.check(tab, permission), permission).toBe(true)
    }
    expect(world.policy!.ask).not.toHaveBeenCalled()
  })

  it('is refused what nothing here can give it without a question, and the log says which permission', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const world = installed({ policy: shellPolicy({ remembered: 'allow' }) })
    expect(await world.request(tab, 'vr')).toBe(false)
    expect(world.check(tab, 'vr')).toBe(false)
    expect(world.policy!.ask).not.toHaveBeenCalled()
    expect(world.policy!.lookup).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledExactlyOnceWith('[engine] refused "vr" without a question: no page is offered it')
  })

  it('is asked in words for the cookies of a site embedded in another', async () => {
    const world = installed()
    expect(await world.request(tab, 'storage-access')).toBe(true)
    expect(world.policy!.ask).toHaveBeenCalledExactlyOnceWith(SITE, 'storage-access', 'tab-a', undefined)
  })
})

describe('the question behind a link of a page to another application', () => {
  /** The web contents of the tab as the page of the link knows it: at an address, in the session whose handlers were installed. */
  // The engine knows the page of a tab by its web contents itself: the tab's own object is given its address, another page is a copy.
  const contents = (world: ReturnType<typeof installed>, url = `${SITE}/join`, over?: Record<string, unknown>) =>
    over ? { ...tab, session: world.ses, getURL: () => url, ...over } : Object.assign(tab, { session: world.ses, getURL: () => url })
  const ask = (world: ReturnType<typeof installed>, wc: unknown, scheme: string, clicked?: boolean, asker?: unknown): Promise<boolean> =>
    methods['askAppLink']!.call(world.engine, wc, scheme, ...(clicked === undefined ? [] : [clicked]), ...(asker === undefined ? [] : [asker])) as Promise<boolean>
  /** A window that keeps these answers (`origin permission` → answer) and answers yes to what it is asked. */
  const keeping = (answers: Record<string, 'allow' | 'deny'>) => ({ ...shellPolicy(), lookup: vi.fn((origin: string, permission: string) => answers[`${origin} ${permission}`]) })

  it('is the question of openExternal, in the panel of the tab, under the site of the page and with the scheme', async () => {
    const world = installed()
    expect(await ask(world, contents(world), 'zoommtg:')).toBe(true)
    expect(world.policy!.ask).toHaveBeenCalledExactlyOnceWith(SITE, 'openExternal', 'tab-a', 'zoommtg:')
  })

  it('is asked each time: a yes an older state kept for openExternal, or one kept for another scheme or another site, opens nothing by itself', async () => {
    const policy = keeping({ [`${SITE} openExternal`]: 'allow', [`${SITE} openExternal:slack:`]: 'allow', ['https://other.example openExternal:zoommtg:']: 'allow' })
    const world = installed({ policy })
    await ask(world, contents(world), 'zoommtg:', true)
    await ask(world, contents(world), 'zoommtg:', true)
    expect(policy.ask).toHaveBeenCalledTimes(2)
    // The only answer ever read is the one of this site for this scheme.
    for (const call of policy.lookup.mock.calls) expect(call).toEqual([SITE, 'openExternal:zoommtg:'])
  })

  // « Toujours ouvrir les liens de ce type depuis ce site ».
  it('offers to keep the answer, under a name that carries the scheme, only for a link a click explains', async () => {
    const world = installed()
    await ask(world, contents(world), 'zoommtg:', true)
    expect(world.policy!.ask).toHaveBeenLastCalledWith(SITE, 'openExternal:zoommtg:', 'tab-a', 'zoommtg:')
    // No click (a page that sends to its application as it loads): the question nobody keeps.
    await ask(world, contents(world), 'zoommtg:', false)
    expect(world.policy!.ask).toHaveBeenLastCalledWith(SITE, 'openExternal', 'tab-a', 'zoommtg:')
    await ask(world, contents(world), 'zoommtg:')
    expect(world.policy!.ask).toHaveBeenLastCalledWith(SITE, 'openExternal', 'tab-a', 'zoommtg:')
  })

  it('is not asked once the user chose to always open the links of this type from this site, with or without a click', async () => {
    const policy = keeping({ [`${SITE} openExternal:zoommtg:`]: 'allow' })
    const world = installed({ policy })
    expect(await ask(world, contents(world), 'zoommtg:', true)).toBe(true)
    expect(await ask(world, contents(world), 'zoommtg:', false)).toBe(true)
    expect(policy.ask).not.toHaveBeenCalled()
    // Another type of link from the same site is still asked about.
    await ask(world, contents(world), 'slack:', true)
    expect(policy.ask).toHaveBeenCalledExactlyOnceWith(SITE, 'openExternal:slack:', 'tab-a', 'slack:')
  })

  it('is not asked, and opens nothing, once the user blocked the links of this type for the site (the site panel), and the log says so', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const policy = keeping({ [`${SITE} openExternal:zoommtg:`]: 'deny' })
    const world = installed({ policy })
    expect(await ask(world, contents(world), 'zoommtg:', true)).toBe(false)
    expect(policy.ask).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledExactlyOnceWith('[engine] a zoommtg: link was refused without a question: the user blocked the links of this type for the site')
  })

  // Guard: nothing of a private tab is kept, and nothing kept elsewhere answers for it.
  it('never offers to keep the answer in a private context, and reads no kept answer there', async () => {
    const policy = keeping({ [`${SITE} openExternal:zoommtg:`]: 'allow' })
    const world = installed({ policy, privateContext: true })
    expect(await ask(world, contents(world), 'zoommtg:', true)).toBe(true)
    expect(policy.lookup).not.toHaveBeenCalled()
    expect(policy.ask).toHaveBeenCalledExactlyOnceWith(SITE, 'openExternal', 'tab-a', 'zoommtg:')
  })

  it('keeps nothing and reads nothing for a scheme that never leaves the browser, whatever a state file holds', async () => {
    const policy = keeping({ [`${SITE} openExternal:file:`]: 'allow' })
    const world = installed({ policy })
    await ask(world, contents(world), 'file:', true)
    expect(policy.lookup).not.toHaveBeenCalled()
    expect(policy.ask).toHaveBeenCalledExactlyOnceWith(SITE, 'openExternal', 'tab-a', 'file:')
  })

  // An advertisement in a frame of a site where the user chose « Toujours ouvrir les liens de ce type depuis ce site ».
  it('is the plain question under the site of a frame of another site that asks, and no answer kept for either site answers it', async () => {
    const policy = keeping({ [`${SITE} openExternal:zoommtg:`]: 'allow', ['https://ads.example openExternal:zoommtg:']: 'allow' })
    const world = installed({ policy })
    expect(await ask(world, contents(world), 'zoommtg:', true, { kind: 'frame', origin: 'https://ads.example' })).toBe(true)
    expect(policy.lookup).not.toHaveBeenCalled()
    expect(policy.ask).toHaveBeenCalledExactlyOnceWith('https://ads.example', 'openExternal', 'tab-a', 'zoommtg:')
    // A mail link of such a frame: the same plain question.
    await ask(world, contents(world), 'mailto:', true, { kind: 'frame', origin: 'https://ads.example' })
    expect(policy.ask).toHaveBeenLastCalledWith('https://ads.example', 'openExternal', 'tab-a', 'mailto:')
  })

  it('is the plain question under the site of the page when nobody that asks can be named, and reads no kept answer', async () => {
    const policy = keeping({ [`${SITE} openExternal:zoommtg:`]: 'allow' })
    const world = installed({ policy })
    await ask(world, contents(world), 'zoommtg:', true, { kind: 'unsure' })
    expect(policy.lookup).not.toHaveBeenCalled()
    expect(policy.ask).toHaveBeenCalledExactlyOnceWith(SITE, 'openExternal', 'tab-a', 'zoommtg:')
    // The page itself, named as such, keeps its kept answer.
    expect(await ask(world, contents(world), 'zoommtg:', true, { kind: 'page' })).toBe(true)
    expect(policy.ask).toHaveBeenCalledTimes(1)
  })

  it('gives the answer of the user, a no as a no', async () => {
    const policy = { ...shellPolicy(), ask: vi.fn(async () => false) }
    const world = installed({ policy })
    expect(await ask(world, contents(world), 'slack:')).toBe(false)
  })

  it('is not asked for a page without a web origin, for a sign-in flow, for a page that is gone, or while no window answers', async () => {
    const world = installed()
    expect(await ask(world, contents(world, 'file:///Users/x/page.html'), 'zoommtg:')).toBe(false)
    expect(await ask(world, contents(world, 'about:blank'), 'zoommtg:')).toBe(false)
    expect(await ask(world, contents(world, `${SITE}/join`, { isDestroyed: () => true }), 'zoommtg:')).toBe(false)
    unmark = markHiddenContents(hidden.id)
    expect(await ask(world, contents(world, `${SITE}/join`, { id: hidden.id }), 'zoommtg:')).toBe(false)
    expect(world.policy!.ask).not.toHaveBeenCalled()
    const nobody = installed({ policy: null })
    expect(await ask(nobody, contents(nobody), 'zoommtg:')).toBe(false)
    // A session whose handlers were never installed has nobody to ask either.
    expect(await ask(world, contents(world, `${SITE}/join`, { session: {} }), 'zoommtg:')).toBe(false)
  })
})

// A server asked a page for a client certificate and got none (shell/certificates.ts): the engine finds the page of the web contents, and the
// page tells the shell, which shows the notice in its window.
describe('the refusal of a client certificate', () => {
  const refused = (engine: unknown, contents: unknown, site = 'intranet.example'): boolean => methods['clientCertificateRefused']!.call(engine, contents, site) as boolean

  it('is told to the page of the web contents that asked, with the site', () => {
    const world = installed()
    const told = vi.fn(() => true)
    Object.assign(world.page, { clientCertificateRefused: told })
    expect(refused(world.engine, tab)).toBe(true)
    expect(told).toHaveBeenCalledExactlyOnceWith('intranet.example')
  })

  it('is told to nobody for contents that are not a page of a tab, or for no contents at all: the caller then writes it in the journal', () => {
    const world = installed()
    const told = vi.fn(() => true)
    Object.assign(world.page, { clientCertificateRefused: told })
    for (const contents of [hidden, null, undefined, {}, 'tab']) expect(refused(world.engine, contents), String(contents)).toBe(false)
    expect(told).not.toHaveBeenCalled()
  })
})
