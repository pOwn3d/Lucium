import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEDIA_BRIDGE } from '../shared/media-player'

// The preload runs in Electron's isolated world and hands one function to the main world, where it wraps the volume of the media elements
// and the MediaSession handlers of the page. Here both worlds are plain Node, with a small page: media elements whose native volume refuses a
// value outside 0..1, a MediaSession that refuses an action it does not know, and a document with open shadow trees.

const contextBridge = { executeInMainWorld: vi.fn() }
const ipcRenderer = { send: vi.fn(), on: vi.fn(), invoke: vi.fn() }
vi.mock('electron', () => ({ contextBridge, ipcRenderer }))

/** What the element really plays at, whatever the page reads back. */
const heard = new WeakMap<object, number>()
let played: object[] = []

interface Tree {
  media: FakeMedia[]
  hosts: { shadowRoot: Tree | null }[]
}

class FakeMedia {
  constructor(level = 1) {
    heard.set(this, level)
  }
  get volume(): number {
    return heard.get(this)!
  }
  set volume(value: number) {
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new RangeError('The volume provided is outside the range [0, 1].')
    heard.set(this, value)
  }
  play(): Promise<void> {
    played.push(this)
    return Promise.resolve()
  }
}

const KNOWN_ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto']
class FakeSession {
  readonly native = new Map<string, unknown>()
  setActionHandler(action: string, handler: unknown): void {
    if (!KNOWN_ACTIONS.includes(action)) throw new TypeError(`The provided value '${action}' is not a valid enum value of type MediaSessionAction.`)
    this.native.set(action, handler)
  }
}

const tree = (media: FakeMedia[] = [], hosts: Tree['hosts'] = []): Tree => ({ media, hosts })
const queryable = (node: Tree) => ({
  querySelectorAll: (selector: string): unknown[] => (selector === 'video, audio' ? node.media : node.hosts.map((host) => ({ shadowRoot: host.shadowRoot && queryable(host.shadowRoot) })))
})

interface World {
  setFactor(factor: number): void
  run(name: string): boolean
}

let page: Tree
let session: FakeSession
let listeners: Record<string, (event: { target: unknown }) => void>
let world: World | null
let hello: Promise<unknown>

const proc = process as unknown as { contextIsolated?: boolean }
const before = { isolated: proc.contextIsolated }

/**
 * Loads the preload the way a page does: the function it hands to the main world runs here, and what it returns is what the preload keeps.
 * `isolated` is what Electron tells the preload (`process.contextIsolated`); a document without isolation is refused by `contextBridge`, in these words.
 */
async function install(options: { level?: unknown; helloFails?: boolean; noMainWorld?: boolean; isolated?: boolean } = {}): Promise<void> {
  vi.resetModules()
  proc.contextIsolated = options.isolated
  hello = options.helloFails ? Promise.reject(new Error('no shell')) : Promise.resolve(options.level ?? 1)
  ipcRenderer.invoke.mockReturnValue(hello)
  contextBridge.executeInMainWorld.mockImplementation((call: { func: (...args: unknown[]) => World | null; args: unknown[] }) => {
    if (options.isolated === false) throw new Error('contextBridge API can only be used when contextIsolation is enabled')
    if (options.noMainWorld) throw new Error('no main world')
    world = call.func(...call.args)
    return world
  })
  await import('./media-bridge')
  await hello.catch(() => undefined)
  await Promise.resolve()
}

/** What the shell sends to the page. */
const command = (value: unknown): void => {
  const listener = ipcRenderer.on.mock.calls.find((call) => call[0] === MEDIA_BRIDGE.command)?.[1] as ((event: unknown, command: unknown) => void) | undefined
  if (!listener) throw new Error('the preload listens to no command')
  listener({}, value)
}

beforeEach(() => {
  vi.useFakeTimers({ now: 10_000 })
  for (const mock of [contextBridge.executeInMainWorld, ipcRenderer.send, ipcRenderer.on, ipcRenderer.invoke]) mock.mockReset()
  played = []
  page = tree()
  session = new FakeSession()
  listeners = {}
  world = null
  // A fresh prototype each time: the bridge replaces `volume`, `play` and `setActionHandler` on it.
  class Media extends FakeMedia {}
  for (const key of ['volume', 'play'] as const) Object.defineProperty(Media.prototype, key, Object.getOwnPropertyDescriptor(FakeMedia.prototype, key)!)
  class Session extends FakeSession {}
  Object.defineProperty(Session.prototype, 'setActionHandler', Object.getOwnPropertyDescriptor(FakeSession.prototype, 'setActionHandler')!)
  session = new Session()
  vi.stubGlobal('HTMLMediaElement', Media)
  vi.stubGlobal('MediaSession', Session)
  vi.stubGlobal('navigator', { mediaSession: session })
  vi.stubGlobal('document', { ...queryable(page), querySelectorAll: (selector: string) => queryable(page).querySelectorAll(selector), addEventListener: (type: string, listener: (event: { target: unknown }) => void) => (listeners[type] = listener) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  proc.contextIsolated = before.isolated
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const element = (level = 1): FakeMedia => new (globalThis as unknown as { HTMLMediaElement: new (level?: number) => FakeMedia }).HTMLMediaElement(level)

describe('the volume of a tab', () => {
  it('scales what the page plays and leaves the page reading the level it asked for', async () => {
    await install()
    const video = element()
    page.media.push(video)
    command({ kind: 'volume', value: 0.5 })
    expect(heard.get(video)).toBe(0.5)
    expect(video.volume).toBe(1)

    video.volume = 0.8
    expect(video.volume).toBe(0.8)
    expect(heard.get(video)).toBeCloseTo(0.4)
  })

  it('reaches again, at each new level, the elements it has already scaled, even those that left the document', async () => {
    await install()
    const video = element(0.6)
    page.media.push(video)
    command({ kind: 'volume', value: 0.5 })
    page.media.length = 0
    command({ kind: 'volume', value: 0.25 })
    expect(heard.get(video)).toBeCloseTo(0.15)
    command({ kind: 'volume', value: 1 })
    expect(heard.get(video)).toBeCloseTo(0.6)
  })

  it('finds the players inside open shadow trees, at any depth, and passes a closed one', async () => {
    await install()
    const inner = element()
    const deep = element(0.5)
    page.hosts.push({ shadowRoot: tree([inner], [{ shadowRoot: tree([deep]) }, { shadowRoot: null }]) })
    command({ kind: 'volume', value: 0.5 })
    expect(heard.get(inner)).toBe(0.5)
    expect(heard.get(deep)).toBe(0.25)
  })

  it('walks the document once a second at most, and still reaches a new player when it starts to load or to play', async () => {
    await install()
    command({ kind: 'volume', value: 0.5 })
    const late = element()
    const loading = element()
    const untouched = element()
    page.media.push(late, loading, untouched)
    // The slider sends many values: the second one comes too soon for another walk.
    command({ kind: 'volume', value: 0.4 })
    expect(heard.get(late)).toBe(1)

    listeners['loadstart']!({ target: loading })
    expect(heard.get(loading)).toBe(0.4)
    listeners['loadstart']!({ target: { not: 'a media element' } })

    await late.play()
    expect(heard.get(late)).toBe(0.4)
    expect(played).toEqual([late])

    vi.advanceTimersByTime(1001)
    command({ kind: 'volume', value: 0.3 })
    expect(heard.get(untouched)).toBeCloseTo(0.3)
  })

  it('keeps the refusal of the page own setter: a level above 1 throws and changes nothing', async () => {
    await install()
    const video = element()
    page.media.push(video)
    command({ kind: 'volume', value: 0.5 })
    expect(() => {
      video.volume = 1.5
    }).toThrow(RangeError)
    expect(video.volume).toBe(1)
    expect(heard.get(video)).toBe(0.5)
  })

  it('touches nothing while the tab is at full volume', async () => {
    await install()
    const video = element()
    video.volume = 0.7
    await video.play()
    expect(heard.get(video)).toBe(0.7)
    expect(video.volume).toBe(0.7)
  })

  it('starts a new document at the level its tab already has', async () => {
    const video = element()
    page.media.push(video)
    await install({ level: 0.2 })
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(MEDIA_BRIDGE.hello)
    expect(heard.get(video)).toBe(0.2)
  })

  it('ignores a level that is not a number between 0 and 1', async () => {
    await install()
    const video = element()
    page.media.push(video)
    for (const value of [2, -1, '0.5', null, Number.NaN]) command({ kind: 'volume', value })
    command(null)
    command({ kind: 'something else' })
    expect(heard.get(video)).toBe(1)
  })

  it('says so when the level of the tab cannot be read, and leaves the page as it is', async () => {
    const video = element()
    page.media.push(video)
    await install({ helloFails: true })
    expect(console.warn).toHaveBeenCalledWith('[lucium] the level of this tab could not be read:', 'no shell')
    expect(heard.get(video)).toBe(1)
  })
})

describe('the previous and next track of a site', () => {
  it('runs the handler the site registered, as the browser would: with the session as `this` and the action', async () => {
    await install()
    const next = vi.fn()
    session.setActionHandler('nexttrack', next)
    // The site still gets its handler registered for real.
    expect(session.native.get('nexttrack')).toBe(next)
    command({ kind: 'action', name: 'nexttrack' })
    expect(next).toHaveBeenCalledTimes(1)
    expect(next.mock.contexts[0]).toBe(session)
    expect(next).toHaveBeenCalledWith({ action: 'nexttrack' })
  })

  it('runs nothing for an action the site has not registered, has taken back, or that the shell may not ask for', async () => {
    await install()
    const previous = vi.fn()
    const seek = vi.fn()
    session.setActionHandler('previoustrack', previous)
    session.setActionHandler('previoustrack', null)
    session.setActionHandler('seekto', seek)
    command({ kind: 'action', name: 'previoustrack' })
    command({ kind: 'action', name: 'nexttrack' })
    command({ kind: 'action', name: 'seekto' })
    expect(previous).not.toHaveBeenCalled()
    expect(seek).not.toHaveBeenCalled()
    expect(world!.run('nexttrack')).toBe(false)
  })

  it('does not remember an action the browser refused', async () => {
    await install()
    expect(() => session.setActionHandler('launch', vi.fn())).toThrow(TypeError)
    vi.advanceTimersByTime(200)
    expect(ipcRenderer.send).not.toHaveBeenCalled()
    expect(world!.run('launch')).toBe(false)
  })

  it('tells the shell which actions the site has, once things have settled and only when they changed', async () => {
    await install()
    for (const action of ['play', 'pause', 'previoustrack', 'nexttrack']) session.setActionHandler(action, vi.fn())
    expect(ipcRenderer.send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(ipcRenderer.send).toHaveBeenCalledTimes(1)
    expect(ipcRenderer.send).toHaveBeenCalledWith(MEDIA_BRIDGE.actions, ['play', 'pause', 'previoustrack', 'nexttrack'])

    // The same handlers set again: nothing new to say.
    session.setActionHandler('play', vi.fn())
    vi.advanceTimersByTime(100)
    expect(ipcRenderer.send).toHaveBeenCalledTimes(1)

    session.setActionHandler('nexttrack', null)
    vi.advanceTimersByTime(100)
    expect(ipcRenderer.send).toHaveBeenLastCalledWith(MEDIA_BRIDGE.actions, ['play', 'pause', 'previoustrack'])
  })

  it('says so when the handler of the site throws, and goes on listening', async () => {
    await install()
    session.setActionHandler('nexttrack', () => {
      throw new Error('the player is gone')
    })
    expect(() => command({ kind: 'action', name: 'nexttrack' })).not.toThrow()
    expect(console.warn).toHaveBeenCalledWith('[lucium] a media action of the page failed:', 'the player is gone')
  })
})

describe('a document with no main world to patch', () => {
  it('says so, listens to no command and asks for no level', async () => {
    await install({ noMainWorld: true })
    expect(console.warn).toHaveBeenCalledWith('[lucium] the media bridge could not be installed in this frame:', 'no main world')
    expect(ipcRenderer.on).not.toHaveBeenCalled()
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it('has neither volume nor handlers on a page without media elements or MediaSession, and does not throw', async () => {
    vi.stubGlobal('HTMLMediaElement', undefined)
    vi.stubGlobal('MediaSession', undefined)
    await install()
    expect(() => command({ kind: 'volume', value: 0.5 })).not.toThrow()
    expect(world!.run('nexttrack')).toBe(false)
  })
})

describe('a document without context isolation (an offscreen document of an extension)', () => {
  it('stays out: no call to contextBridge (Electron refuses it there), no line on the console, no command heard, no level asked', async () => {
    await install({ isolated: false })
    expect(contextBridge.executeInMainWorld).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(ipcRenderer.on).not.toHaveBeenCalled()
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it('keeps the bridge in a page that has isolation, a tab: the main world is reached, the commands are heard, the level is asked', async () => {
    await install({ isolated: true })
    expect(contextBridge.executeInMainWorld).toHaveBeenCalledTimes(1)
    expect(ipcRenderer.on).toHaveBeenCalledWith(MEDIA_BRIDGE.command, expect.any(Function))
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(MEDIA_BRIDGE.hello)
  })

  it('still tries where the renderer does not say (no `contextIsolated` at all): the attempt is made, as it always was', async () => {
    await install({ isolated: undefined })
    expect(contextBridge.executeInMainWorld).toHaveBeenCalledTimes(1)
  })
})
