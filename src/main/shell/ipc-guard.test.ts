// The door of the main process, run for real (`registerIpc` of a window over a fake Electron): who may speak, what the interface may dispatch, and
// what is left open while the application is locked. The rules themselves are tested alone (shared/ipc-policy.test.ts, shared/lock.test.ts,
// ipc-scope.test.ts); here it is their use by every handler that is held, so that taking a guard off one of them fails a unit test and not only an
// engine check.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Channel, InternalChannel } from '@shared/ipc'
import { OPEN_WHILE_LOCKED } from '@shared/lock'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser } from './browser-fake.test-support'
import { invokeFrom, ipcHost, sendFrom, senderOf } from './ipc-fake.test-support'

/** Every call made on Electron (`dialog.showOpenDialog`, `net.fetch`, `new ShareMenu`…), `ipcMain` aside: none may happen behind a closed door. */
const electronCalls = vi.hoisted(() => [] as string[])
vi.mock('electron', async () => {
  const { fakeElectron } = await import('./ipc-fake.test-support')
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const recorder = (path: string): unknown =>
    new Proxy(function () {}, {
      get: (_target, prop) => (inert(prop) ? undefined : recorder(`${path}.${String(prop)}`)),
      apply: () => (electronCalls.push(path), recorder(`${path}()`)),
      construct: () => (electronCalls.push(`new ${path}`), recorder(`${path}()`) as object)
    })
  const base = fakeElectron() as { ipcMain: unknown }
  const ipcMain = base.ipcMain
  return new Proxy({ ipcMain } as Record<string, unknown>, { has: (_target, prop) => !inert(prop), get: (target, prop: string) => (prop in target ? target[prop] : inert(prop) ? undefined : recorder(prop)) })
})

const { registerIpc } = await import('./ipc')
const { setLockService } = await import('../lock-service')

/** The id of the web contents of the window's interface, the only one the window trusts. */
const UI = 1
/** A page that got hold of `ipcRenderer` and is no surface of ours. */
const STRANGER = 99
/** A word that is in the state the window holds and nowhere else: an answer that carries it has read what the lock hides. */
const SECRET = 'canary-of-the-locked-state'

const initial = createInitialState({ now: 0, newId: () => 'x' })
const state = {
  ...initial,
  // A second space, for the request that moves a tab to another one.
  spaces: [...initial.spaces, { ...initial.spaces[0]!, id: 'other-space', name: 'Autre' }],
  tabs: [{ id: 'tab-1', spaceId: initial.spaces[0]!.id, url: `https://${SECRET}.example/`, title: SECRET, pinned: false, createdAt: 1, lastActiveAt: 1 }],
  settings: { ...initial.settings, extensionPaths: ['/known/extension'] }
}
const store = { get: () => state, subscribe: () => () => {}, root: () => store, dispatch: () => {} } as never

/** The lock of the application: on or off as the test says, and how many times a handler asked it. */
const lock = { locked: false, asked: 0 }
const browser = fakeBrowser({
  snapshot: () => ({ state: { ...state, tabs: [] }, runtime: { tabs: {} }, extensions: [] }),
  navigationHistory: () => [],
  isPrivate: () => false
})
const lockService = fakeBrowser({
  isAppLocked: () => (lock.asked++, lock.locked),
  lockedSpaces: () => [],
  view: () => undefined
})
setLockService(lockService.self as never)
// Once: the fake Electron keeps the first listener of a channel, which is the single real one `scopedIpc` registers.
registerIpc(browser.self as never, store, {} as never, new Set([UI]))

/** What a message did: the calls on the window's browser and on Electron. */
function effects(): string[] {
  return [...browser.names(), ...electronCalls]
}

/** A message on a channel, by `on` or by `handle` as the channel was registered, with the answer of a request. */
async function message(from: number, channel: string, ...args: unknown[]): Promise<unknown> {
  if (ipcHost.handle.has(channel)) return await invokeFrom(from, channel, ...args)
  return sendFrom(from, channel, ...args)
}

/** The channels of the interface: those of the Extensions page in a tab (`lucium-ui:`) are the page's, judged by the main process on every message (internal-page-ipc.test.ts). */
const channels = (): string[] => [...new Set([...ipcHost.on.keys(), ...ipcHost.handle.keys()])].filter((channel) => !channel.startsWith('lucium-ui:')).sort()
const pageChannels = (): string[] => [...new Set([...ipcHost.on.keys(), ...ipcHost.handle.keys()])].filter((channel) => channel.startsWith('lucium-ui:')).sort()

beforeEach(() => {
  lock.locked = false
  lock.asked = 0
  browser.calls.length = 0
  lockService.calls.length = 0
  electronCalls.length = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('the door of a window: what the interface may dispatch', () => {
  it('passes an action of the interface on to the browser', async () => {
    const action = { type: 'tab/select', id: 'tab-1' }
    await invokeFrom(UI, Channel.dispatch, action)
    expect(browser.calls).toEqual([{ name: 'dispatchFromInterface', args: [action] }])
  })

  it.each([
    ['an action only the main process sends', { type: 'state/restore', state: {} }],
    ['the restore of a copy', { type: 'backup/restore', copy: {} }],
    ['an extension path the user never chose', { type: 'settings/update', patch: { extensionPaths: ['/known/extension', '/tmp/evil'] } }],
    ['a setting of the lock', { type: 'settings/update', patch: { lockEnabled: false } }],
    ['a tab allowed to show the page of an extension', { type: 'tab/open', url: 'chrome-extension://abc/page.html', allowExtensionPages: true }],
    ['what is not an action', 'state/restore']
  ])('refuses %s, and says so in the journal', async (_name, action) => {
    await invokeFrom(UI, Channel.dispatch, action)
    expect(effects()).toEqual([])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('an action the interface may not dispatch was refused'), expect.anything())
  })
})

describe('the door of a window: who may speak', () => {
  it('registers the channels of the interface (the list below is not empty by accident)', () => {
    expect(channels().length).toBeGreaterThan(100)
    for (const channel of [Channel.dispatch, Channel.openOverlay, Channel.suggest, Channel.searchHistory, Channel.exportData, Channel.lockConfigure, Channel.lockUnlock]) expect(channels()).toContain(channel)
  })

  it('answers nothing to a page that is not a surface of the window, on any channel', async () => {
    for (const channel of channels()) {
      expect(await message(STRANGER, channel, { type: 'tab/select', id: 'tab-1' }), channel).toBeUndefined()
      expect(effects(), channel).toEqual([])
    }
    expect(lock.asked).toBe(0)
  })

  it('answers nothing to a frame inside the interface, on any channel', async () => {
    for (const channel of channels()) {
      const event = { ...senderOf(UI), senderFrame: {} }
      const listener = ipcHost.handle.get(channel) ?? ipcHost.on.get(channel)!
      expect(await listener(event, { type: 'tab/select', id: 'tab-1' }), channel).toBeUndefined()
      expect(effects(), channel).toEqual([])
    }
    expect(lock.asked).toBe(0)
  })
})

describe('the door of a window: the channels of the Extensions page', () => {
  it('are registered, and none of them answers the interface of the window or a page that is no tab showing the Extensions page', async () => {
    expect(pageChannels()).toEqual(Object.values(InternalChannel).filter((channel) => channel !== InternalChannel.snapshot).sort())
    for (const channel of pageChannels()) {
      for (const from of [UI, STRANGER]) {
        expect(await message(from, channel, { type: 'tab/select', id: 'tab-1' }), `${channel} from ${from}`).toBeUndefined()
        // The only thing the window is asked is whether the sender is a tab of its own that shows the page: it is not.
        expect(effects().filter((name) => name !== 'internalPageTab'), channel).toEqual([])
      }
    }
    expect(lock.asked).toBe(0)
  })

  it('are no channel of the interface, and the interface has none of theirs', () => {
    for (const channel of pageChannels()) expect(Object.values(Channel) as string[], channel).not.toContain(channel)
    for (const channel of channels()) expect(channel.startsWith('lucium-ui:'), channel).toBe(false)
  })
})

describe('the door of a window while the application is locked', () => {
  /** What the interface would plausibly send on a channel: an action, then an id and a flag (enough for the handlers that check their arguments first). */
  const ARGS = [{ type: 'tab/select', id: 'tab-1', panel: 'commandbar', kind: 'tab' }, 'tab-1', true]
  /** The channels whose handler looks at its argument before the guard, with the argument that takes it to the guard. */
  const OWN_ARGS: Readonly<Record<string, unknown[]>> = {
    // Closing the resource panel is never refused (resource-ipc.ts): only the opening is the guard's.
    [Channel.resourcePanel]: [true]
  }

  it('keeps open the snapshot, the unlocking and the closing of a panel, and nothing else', () => {
    expect([...OPEN_WHILE_LOCKED].sort()).toEqual([Channel.closeOverlay, Channel.getSnapshot, Channel.lockUnlock].sort())
  })

  it('still answers the three channels left open', async () => {
    lock.locked = true
    await invokeFrom(UI, Channel.getSnapshot)
    sendFrom(UI, Channel.closeOverlay)
    await invokeFrom(UI, Channel.lockUnlock, { target: { scope: 'app' }, phrase: 'x' })
    expect(browser.names()).toEqual(['closeOverlay'])
    expect(lockService.calls).toEqual([{ name: 'unlock', args: [{ target: { scope: 'app' }, phrase: 'x' }] }])
    expect(lock.asked).toBe(3)
  })

  it('every other channel asks the lock before anything else, does nothing, and answers nothing of the state', async () => {
    lock.locked = true
    const closed = channels().filter((channel) => !OPEN_WHILE_LOCKED.has(channel))
    const unasked: string[] = []
    const acted: Record<string, string[]> = {}
    const leaked: string[] = []
    for (const channel of closed) {
      lock.asked = 0
      browser.calls.length = 0
      electronCalls.length = 0
      // A handler may refuse by an error: its message is then what the interface is answered.
      const answer = await message(UI, channel, ...(OWN_ARGS[channel] ?? ARGS)).catch((error: unknown) => String(error))
      // The lock was asked: the handler went through the guard of the window. A handler that answers without it is open to a locked interface.
      if (lock.asked === 0) unasked.push(channel)
      if (effects().length > 0) acted[channel] = effects()
      if (JSON.stringify(answer ?? null).includes(SECRET)) leaked.push(channel)
    }
    expect(unasked, 'channels that did not ask the lock').toEqual([])
    // Changing the lock is one of them: nothing reached the lock service but the question « is the application locked? ».
    expect(lockService.calls).toEqual([])
    expect(acted, 'channels that did something while locked').toEqual({})
    expect(leaked, 'channels that answered something of the state').toEqual([])
  })

  it('the same messages do reach the browser once it is unlocked (the check above is not empty)', async () => {
    for (const [channel, args, call] of [
      [Channel.dispatch, [{ type: 'tab/select', id: 'tab-1' }], 'dispatchFromInterface'],
      [Channel.openOverlay, [{ panel: 'commandbar', mode: 'new', initial: '' }], 'openOverlay'],
      [Channel.searchHistory, ['x'], 'searchHistory'],
      [Channel.forgetHistory, ['https://a.example/'], 'forgetHistory'],
      [Channel.nav, ['back'], 'nav']
    ] as const) {
      lock.locked = true
      await message(UI, channel, ...args)
      expect(effects(), channel).toEqual([])
      lock.locked = false
      await message(UI, channel, ...args)
      expect(browser.names(), channel).toContain(call)
      browser.calls.length = 0
    }
  })

  it('hands the browser the profile the history panel names, and nothing that is not a text', async () => {
    lock.locked = false
    const argsOf = (name: string): readonly unknown[] | undefined => browser.calls.find((call) => call.name === name)?.args
    await message(UI, Channel.forgetHistory, 'https://a.example/', 'work')
    expect(argsOf('forgetHistory')).toEqual(['https://a.example/', 'work', false])
    await message(UI, Channel.searchHistory, 'x', 5, 'work')
    expect(argsOf('searchHistory')).toEqual(['x', 5, 'work'])
    browser.calls.length = 0
    await message(UI, Channel.forgetHistory, 'https://a.example/', { id: 'work' })
    expect(argsOf('forgetHistory')).toEqual(['https://a.example/', undefined, false])
    browser.calls.length = 0
    // The way back is asked for by `true` and by nothing else.
    await message(UI, Channel.forgetHistory, 'https://a.example/', 'work', true)
    expect(argsOf('forgetHistory')).toEqual(['https://a.example/', 'work', true])
    browser.calls.length = 0
    for (const undoable of ['true', 1, {}]) {
      await message(UI, Channel.forgetHistory, 'https://a.example/', 'work', undoable)
      expect(argsOf('forgetHistory'), JSON.stringify(undoable)).toEqual(['https://a.example/', 'work', false])
      browser.calls.length = 0
    }
  })

  it('puts a page back in the history only for a web address and a profile id, and only from the interface', async () => {
    lock.locked = false
    await message(UI, Channel.putBackHistory, 'https://a.example/', 'work')
    expect(browser.calls.find((call) => call.name === 'putBackHistory')?.args).toEqual(['https://a.example/', 'work'])
    browser.calls.length = 0
    // What is not the address of a web page, an address too long to be one of the history, no profile, or what is not a profile id: refused, said in the journal.
    const refused = [['file:///etc/passwd', 'work'], ['javascript:alert(1)', 'work'], [`https://a.example/${'x'.repeat(5000)}`, 'work'], [{ url: 'https://a.example/' }, 'work'], ['https://a.example/'], ['https://a.example/', { id: 'work' }], ['https://a.example/', '../work'], ['https://a.example/', '__proto__']]
    for (const args of refused) {
      vi.mocked(console.warn).mockClear()
      expect(await message(UI, Channel.putBackHistory, ...args), JSON.stringify(args).slice(0, 80)).toBe(false)
      expect(browser.names(), JSON.stringify(args).slice(0, 80)).not.toContain('putBackHistory')
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('a request to put a page back in the history was refused'))
    }
    // A page that is no surface of ours gets no answer and reaches nothing.
    expect(await message(STRANGER, Channel.putBackHistory, 'https://a.example/', 'work')).not.toBe(true)
    expect(browser.names()).not.toContain('putBackHistory')
    // Nor does the interface while the application is locked.
    lock.locked = true
    expect(await message(UI, Channel.putBackHistory, 'https://a.example/', 'work')).toBe(false)
    expect(browser.names()).not.toContain('putBackHistory')
    lock.locked = false
  })

  it('forgets a day of the history only between the bounds of one day, in a profile that is named', async () => {
    lock.locked = false
    const DAY = 86_400_000
    const from = new Date(2026, 9, 28).getTime()
    await message(UI, Channel.forgetHistoryDay, from, from + DAY, 'work')
    expect(browser.calls.find((call) => call.name === 'forgetHistoryDay')?.args).toEqual([from, from + DAY, 'work'])
    browser.calls.length = 0
    // A span wider than a day (it would empty the history), what is not a moment, no profile: refused, said in the journal.
    for (const args of [[0, Number.MAX_SAFE_INTEGER, 'work'], [from, from + 40 * DAY, 'work'], [from, from, 'work'], [String(from), from + DAY, 'work'], [from, null, 'work'], [from, from + DAY], [from, from + DAY, { id: 'work' }]]) {
      vi.mocked(console.warn).mockClear()
      expect(await message(UI, Channel.forgetHistoryDay, ...args), JSON.stringify(args)).toBe(0)
      expect(browser.names(), JSON.stringify(args)).not.toContain('forgetHistoryDay')
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('a request to forget a day of the history was refused'))
    }
  })
})

describe('the door of a window while a space is locked', () => {
  /** The three requests that name their target by an id and act outside the reducer: a menu, the readable mode of a tab, a move to another space. */
  const requests: ReadonlyArray<readonly [string, unknown[]]> = [
    [Channel.showMenu, [{ kind: 'nav', id: 'back' }]],
    [Channel.toggleReadable, ['tab-1']],
    [Channel.moveTabsToSpace, [['tab-1'], 'other-space']]
  ]
  const hides = (hidden: boolean): void => void (browser.self['namesLockedTarget'] = () => hidden)

  it.each(requests)('%s does nothing when it names what the lock hides: the interface never saw it', async (channel, args) => {
    // The menu of a tab draws its icons, which the fake Electron does not have: what it says of them is not the subject.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    hides(true)
    await message(UI, channel, ...args)
    expect(effects()).toEqual([])
    // The same request for a tab that shows does act: the refusal above is the lock's.
    hides(false)
    await message(UI, channel, ...args)
    expect(effects().length).toBeGreaterThan(0)
  })
})

describe('the mark of a tab an extension captures the sound of', () => {
  it('stops the capture of the tab the interface names, and only a tab id', async () => {
    await message(UI, Channel.stopTabCapture, 'tab-1')
    expect(browser.calls.filter((call) => call.name === 'stopTabCapture').map((call) => call.args)).toEqual([['tab-1']])
    browser.calls.length = 0
    // What is not a tab id (a number, an object, an empty text, a text of a document) reaches nothing.
    for (const wrong of [undefined, null, 12, {}, ['tab-1'], '', 'x'.repeat(257)]) await message(UI, Channel.stopTabCapture, wrong)
    expect(browser.names()).not.toContain('stopTabCapture')
  })

  it('answers nothing to a page that is no surface of ours, nor while the application is locked', async () => {
    await message(STRANGER, Channel.stopTabCapture, 'tab-1')
    expect(browser.names()).not.toContain('stopTabCapture')
    lock.locked = true
    await message(UI, Channel.stopTabCapture, 'tab-1')
    expect(browser.names()).not.toContain('stopTabCapture')
  })
})
