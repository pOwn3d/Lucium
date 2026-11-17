import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DIALOG_NATIVE, PAGE_DIALOG, PROMPT_STOPPED, PROMPT_WIRE_MAX } from '../shared/page-dialog'

// The preload runs in Electron's isolated world and hands one function to the main world; here both are plain Node, with a fake `window`.
const contextBridge = { executeInMainWorld: vi.fn() }
const ipcRenderer = { sendSync: vi.fn() }
vi.mock('electron', () => ({ contextBridge, ipcRenderer }))

type Prompt = (...args: unknown[]) => string | null
interface FakeWindow {
  prompt: unknown
  alert?: unknown
  confirm?: unknown
  origin?: string
  location?: { protocol: string }
}

const globals = globalThis as unknown as { window?: FakeWindow }
const proc = process as unknown as { contextIsolated?: boolean }
const before = { isolated: proc.contextIsolated }
let nativePrompt: ReturnType<typeof vi.fn>
let fake: FakeWindow

/** Loads the preload the way a page does, then runs what it handed to the main world against the fake window. */
async function install(window: FakeWindow = fake): Promise<void> {
  vi.resetModules()
  globals.window = window
  await import('./dialog-bridge')
  const call = contextBridge.executeInMainWorld.mock.calls[0]?.[0] as { func: (...args: unknown[]) => void; args: unknown[] } | undefined
  call?.func(...(call?.args ?? []))
}

const pagePrompt = (): Prompt => fake.prompt as Prompt

beforeEach(() => {
  contextBridge.executeInMainWorld.mockReset()
  ipcRenderer.sendSync.mockReset()
  // Electron's own prompt(), which answers null: what a frame without the bridge has.
  nativePrompt = vi.fn(function prompt() {
    return null
  })
  fake = page({ prompt: nativePrompt })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  proc.contextIsolated = before.isolated
  delete globals.window
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A window of a page of the web: its address, and the functions it is given. */
function page(own: Partial<FakeWindow> & { prompt: unknown }, origin = 'https://site.example', protocol = 'https:'): FakeWindow {
  return { origin, location: { protocol }, ...own }
}

describe('the dialog bridge', () => {
  it('replaces prompt() in the main world, once, with the function the page will call', async () => {
    await install()
    expect(contextBridge.executeInMainWorld).toHaveBeenCalledTimes(1)
    expect(pagePrompt()).not.toBe(nativePrompt)
    expect(typeof fake.prompt).toBe('function')
  })

  it('looks like prompt() to the page: same name and length, and the page can still assign to it', async () => {
    function prompt() {
      return null
    }
    fake = page({ prompt })
    await install()
    const replaced = pagePrompt()
    expect(replaced.name).toBe('prompt')
    expect(replaced.length).toBe(0)
    // A plain property of the window: the page replaces it the way it replaces any other.
    fake.prompt = () => 'the page’s own'
    expect(pagePrompt()('x')).toBe('the page’s own')
  })

  it('asks the main process with the text of the call and gives back what the user answered', async () => {
    await install()
    ipcRenderer.sendSync.mockReturnValue('mon secret')
    expect(pagePrompt()('Mot de passe maître pour https://x ?', 'défaut')).toBe('mon secret')
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(PAGE_DIALOG.prompt, { message: 'Mot de passe maître pour https://x ?', defaultValue: 'défaut' })
    // An empty answer is an answer: it is not a cancel.
    ipcRenderer.sendSync.mockReturnValue('')
    expect(pagePrompt()('Vide ?')).toBe('')
  })

  it('stops asking the main process once it says the user stopped the page: a page that calls prompt() in a loop then sends nothing', async () => {
    await install()
    ipcRenderer.sendSync.mockReturnValueOnce('une réponse').mockReturnValueOnce(PROMPT_STOPPED)
    expect(pagePrompt()('?')).toBe('une réponse')
    expect(pagePrompt()('?')).toBeNull()
    for (let i = 0; i < 100; i++) expect(pagePrompt()('?')).toBeNull()
    expect(ipcRenderer.sendSync).toHaveBeenCalledTimes(2)
    // A new document (the preload runs again) asks again; an answer that only looks like it (typed text, another object) does not stop anything.
    contextBridge.executeInMainWorld.mockReset()
    ipcRenderer.sendSync.mockReset()
    fake = page({ prompt: nativePrompt })
    await install()
    ipcRenderer.sendSync.mockReturnValueOnce('{"stopped":true}').mockReturnValueOnce({ stopped: 'true' }).mockReturnValueOnce('encore')
    expect(pagePrompt()('?')).toBe('{"stopped":true}')
    expect(pagePrompt()('?')).toBeNull()
    expect(pagePrompt()('?')).toBe('encore')
  })

  it('gives null for a cancel, and for anything the main process answers that is not text', async () => {
    await install()
    for (const reply of [null, undefined, 3, true, {}, ['a']]) {
      ipcRenderer.sendSync.mockReturnValueOnce(reply)
      expect(pagePrompt()('?')).toBeNull()
    }
  })

  it('converts the arguments as prompt() does: missing is empty, anything else is text', async () => {
    await install()
    ipcRenderer.sendSync.mockReturnValue(null)
    const sent = () => ipcRenderer.sendSync.mock.calls.at(-1)?.[1]
    pagePrompt()()
    expect(sent()).toEqual({ message: '', defaultValue: '' })
    pagePrompt()(undefined, undefined)
    expect(sent()).toEqual({ message: '', defaultValue: '' })
    pagePrompt()(null, null)
    expect(sent()).toEqual({ message: 'null', defaultValue: 'null' })
    pagePrompt()(12, false)
    expect(sent()).toEqual({ message: '12', defaultValue: 'false' })
    pagePrompt()({ toString: () => 'objet' }, ['a', 'b'])
    expect(sent()).toEqual({ message: 'objet', defaultValue: 'a,b' })
  })

  it('throws like prompt() does for what cannot be text, without asking anyone', async () => {
    await install()
    expect(() => pagePrompt()(Symbol('s'))).toThrow(TypeError)
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled()
  })

  it('does not send a message of any size', async () => {
    await install()
    ipcRenderer.sendSync.mockReturnValue(null)
    pagePrompt()('m'.repeat(PROMPT_WIRE_MAX * 3), 'd'.repeat(PROMPT_WIRE_MAX * 3))
    const payload = ipcRenderer.sendSync.mock.calls[0]?.[1] as { message: string; defaultValue: string }
    expect(payload.message).toHaveLength(PROMPT_WIRE_MAX)
    expect(payload.defaultValue).toHaveLength(PROMPT_WIRE_MAX)
  })

  it('gives null, and says in the console why, when the main process cannot be reached', async () => {
    await install()
    ipcRenderer.sendSync.mockImplementation(() => {
      throw new Error('Object has been destroyed')
    })
    expect(pagePrompt()('?')).toBeNull()
    expect(console.warn).toHaveBeenCalledWith('[lucium] prompt() could not reach the browser:', 'Object has been destroyed')
  })

  it('leaves a call on anything but the window to the native function', async () => {
    await install()
    const other = {}
    pagePrompt().call(other, 'x')
    expect(nativePrompt).toHaveBeenCalledTimes(1)
    expect(nativePrompt.mock.contexts[0]).toBe(other)
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled()
    // A detached prompt() (no receiver) is the window's, as the native one is.
    ipcRenderer.sendSync.mockReturnValue('ok')
    const detached = pagePrompt()
    expect(detached.call(undefined, 'x')).toBe('ok')
    expect(detached.call(null, 'x')).toBe('ok')
    expect(detached.call(fake, 'x')).toBe('ok')
  })

  it('cannot be steered by a page that replaces Reflect.apply afterwards', async () => {
    await install()
    const realApply = Reflect.apply
    Reflect.apply = () => 'hijacked'
    try {
      pagePrompt().call({}, 'x')
      expect(nativePrompt).toHaveBeenCalledTimes(1)
      ipcRenderer.sendSync.mockReturnValue('ok')
      expect(pagePrompt()('x')).toBe('ok')
    } finally {
      Reflect.apply = realApply
    }
  })

  it('exposes nothing to the page: the only thing it gets is the replaced function', async () => {
    const before = Object.keys(fake)
    await install()
    expect(Object.keys(fake)).toEqual(before)
    expect(Object.keys(globals)).not.toContain('ipcRenderer')
  })

  it('leaves the window alone when it has no prompt()', async () => {
    fake = page({ prompt: undefined })
    await install()
    expect(fake.prompt).toBeUndefined()
  })

  it('says in the console, and changes nothing, when the main world cannot be reached', async () => {
    contextBridge.executeInMainWorld.mockImplementation(() => {
      throw new Error('no main world')
    })
    vi.resetModules()
    globals.window = fake
    await import('./dialog-bridge')
    expect(fake.prompt).toBe(nativePrompt)
    expect(console.warn).toHaveBeenCalledWith('[lucium] the dialog bridge could not be installed in this frame:', 'no main world')
  })
})

describe('the dialog bridge, for alert() and confirm()', () => {
  let nativeAlert: ReturnType<typeof vi.fn>
  let nativeConfirm: ReturnType<typeof vi.fn>
  type Call = (...args: unknown[]) => unknown
  const pageAlert = (): Call => fake.alert as Call
  const pageConfirm = (): Call => fake.confirm as Call

  beforeEach(() => {
    // Electron's own functions: the native sheet, whose answer here is "Cancel".
    nativeAlert = vi.fn(function alert() {
      return undefined
    })
    nativeConfirm = vi.fn(function confirm() {
      return false
    })
    fake = page({ prompt: nativePrompt, alert: nativeAlert, confirm: nativeConfirm })
  })

  it('replaces both, looking like the native ones (same name and length)', async () => {
    function alert(): void {}
    function confirm(): boolean {
      return false
    }
    fake = page({ prompt: nativePrompt, alert, confirm })
    await install()
    expect(fake.alert).not.toBe(alert)
    expect(fake.confirm).not.toBe(confirm)
    expect([pageAlert().name, pageAlert().length, pageConfirm().name, pageConfirm().length]).toEqual(['alert', 0, 'confirm', 0])
  })

  it('sends each call on its own channel, and never to the native function', async () => {
    await install()
    expect(pageAlert()).not.toBe(nativeAlert)
    expect(pageConfirm()).not.toBe(nativeConfirm)
    ipcRenderer.sendSync.mockReturnValue(null)
    pageAlert()('Enregistré.')
    pageConfirm()('Supprimer ce fichier ?')
    expect(ipcRenderer.sendSync.mock.calls).toEqual([
      [PAGE_DIALOG.alert, { message: 'Enregistré.' }],
      [PAGE_DIALOG.confirm, { message: 'Supprimer ce fichier ?' }]
    ])
    expect(nativeAlert).not.toHaveBeenCalled()
    expect(nativeConfirm).not.toHaveBeenCalled()
  })

  it('confirm() returns true for OK only, false for a cancel or anything else; alert() returns nothing whatever the reply', async () => {
    await install()
    ipcRenderer.sendSync.mockReturnValueOnce(true)
    expect(pageConfirm()('?')).toBe(true)
    for (const reply of [false, null, undefined, 'true', 1, {}]) {
      ipcRenderer.sendSync.mockReturnValueOnce(reply)
      expect(pageConfirm()('?'), String(reply)).toBe(false)
    }
    for (const reply of [true, false, null, 'x']) {
      ipcRenderer.sendSync.mockReturnValueOnce(reply)
      expect(pageAlert()('!')).toBeUndefined()
    }
  })

  it('converts the arguments as the native functions do: alert() with none is empty, alert(undefined) is "undefined", confirm(undefined) is empty', async () => {
    await install()
    ipcRenderer.sendSync.mockReturnValue(null)
    const sent = () => ipcRenderer.sendSync.mock.calls.at(-1)?.[1]
    pageAlert()()
    expect(sent()).toEqual({ message: '' })
    pageAlert()(undefined)
    expect(sent()).toEqual({ message: 'undefined' })
    pageAlert()(null)
    expect(sent()).toEqual({ message: 'null' })
    pageConfirm()()
    expect(sent()).toEqual({ message: '' })
    pageConfirm()(undefined)
    expect(sent()).toEqual({ message: '' })
    pageConfirm()({ toString: () => 'objet' })
    expect(sent()).toEqual({ message: 'objet' })
    const before = ipcRenderer.sendSync.mock.calls.length
    expect(() => pageAlert()(Symbol('s'))).toThrow(TypeError)
    expect(() => pageConfirm()(Symbol('s'))).toThrow(TypeError)
    expect(ipcRenderer.sendSync.mock.calls.length).toBe(before)
  })

  it('hands the call to the native function when the main process says Lucium has no box for this page (a popup, a preview)', async () => {
    await install()
    ipcRenderer.sendSync.mockReturnValue(DIALOG_NATIVE)
    nativeConfirm.mockReturnValueOnce(true)
    expect(pageConfirm()('Continuer ?')).toBe(true)
    expect(nativeConfirm).toHaveBeenCalledWith('Continuer ?')
    expect(pageAlert()('Bonjour')).toBeUndefined()
    expect(nativeAlert).toHaveBeenCalledWith('Bonjour')
    // prompt() has nothing to hand back to: Electron shows no box for it, the page gets null.
    expect(pagePrompt()('?')).toBeNull()
    expect(nativePrompt).not.toHaveBeenCalled()
  })

  it('stops the three functions together once the user stopped the page from one of them', async () => {
    await install()
    ipcRenderer.sendSync.mockReturnValueOnce(PROMPT_STOPPED)
    expect(pageAlert()('1')).toBeUndefined()
    expect(pageConfirm()('2')).toBe(false)
    expect(pagePrompt()('3')).toBeNull()
    expect(ipcRenderer.sendSync).toHaveBeenCalledTimes(1)
    expect(nativeAlert).not.toHaveBeenCalled()
    expect(nativeConfirm).not.toHaveBeenCalled()
  })

  it('gives the page its native function, and says in the console why, when the main process cannot be reached', async () => {
    await install()
    ipcRenderer.sendSync.mockImplementation(() => {
      throw new Error('Object has been destroyed')
    })
    expect(pageConfirm()('?')).toBe(false)
    expect(nativeConfirm).toHaveBeenCalledWith('?')
    expect(console.warn).toHaveBeenCalledWith('[lucium] confirm() could not reach the browser:', 'Object has been destroyed')
  })

  it('leaves alert() and confirm() to Chromium in a sandboxed page of the web (opaque origin), and still bridges prompt()', async () => {
    fake = page({ prompt: nativePrompt, alert: nativeAlert, confirm: nativeConfirm }, 'null', 'https:')
    await install()
    expect(fake.alert).toBe(nativeAlert)
    expect(fake.confirm).toBe(nativeConfirm)
    expect(pagePrompt()).not.toBe(nativePrompt)
  })

  it('replaces them in a local file, whose origin Chromium also calls opaque', async () => {
    fake = page({ prompt: nativePrompt, alert: nativeAlert, confirm: nativeConfirm }, 'null', 'file:')
    await install()
    expect(fake.alert).not.toBe(nativeAlert)
    expect(fake.confirm).not.toBe(nativeConfirm)
  })

  it('leaves a call on anything but the window to the native function', async () => {
    await install()
    const other = {}
    pageConfirm().call(other, 'x')
    expect(nativeConfirm.mock.contexts[0]).toBe(other)
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled()
  })
})

describe('the dialog bridge, while the page is being left', () => {
  /** An event of the page, as the browser makes it: `isTrusted` is its own, the type is read from the prototype. */
  class FakeEvent {
    readonly #type: string
    declare readonly isTrusted: boolean
    constructor(type: string, trusted: boolean) {
      this.#type = type
      Object.defineProperty(this, 'isTrusted', { value: trusted, enumerable: true })
    }
    get type(): string {
      return this.#type
    }
  }
  let current: FakeEvent | undefined
  type Call = (...args: unknown[]) => unknown

  beforeEach(() => {
    vi.stubGlobal('Event', FakeEvent)
    current = undefined
    fake = page({ prompt: nativePrompt, alert: vi.fn(), confirm: vi.fn() })
    // `window.event`: the event whose handler is running, read through its own getter.
    Object.defineProperty(fake, 'event', { get: () => current, configurable: true, enumerable: false })
    ipcRenderer.sendSync.mockReturnValue(true)
  })

  it('returns at once, without a box, from the handler of beforeunload, pagehide or unload, as Chromium does', async () => {
    await install()
    for (const type of ['beforeunload', 'pagehide', 'unload']) {
      current = new FakeEvent(type, true)
      expect((fake.alert as Call)('au revoir'), type).toBeUndefined()
      expect((fake.confirm as Call)('vraiment ?'), type).toBe(false)
      expect(pagePrompt()('?'), type).toBeNull()
    }
    expect(ipcRenderer.sendSync).not.toHaveBeenCalled()
  })

  it('asks as usual from any other event, and from an event the page made itself', async () => {
    await install()
    current = new FakeEvent('click', true)
    expect((fake.confirm as Call)('?')).toBe(true)
    current = new FakeEvent('beforeunload', false)
    expect((fake.confirm as Call)('?')).toBe(true)
    current = undefined
    expect((fake.confirm as Call)('?')).toBe(true)
    expect(ipcRenderer.sendSync).toHaveBeenCalledTimes(3)
  })

  it('cannot be fooled by a page that replaces window.event or the type of the events afterwards', async () => {
    await install()
    Object.defineProperty(fake, 'event', { get: () => new FakeEvent('unload', true), configurable: true })
    Object.defineProperty(FakeEvent.prototype, 'type', { get: () => 'unload', configurable: true })
    current = new FakeEvent('click', true)
    expect((fake.confirm as Call)('?')).toBe(true)
    expect(ipcRenderer.sendSync).toHaveBeenCalledTimes(1)
  })
})

describe('the function handed to the main world', () => {
  it('is self-contained: alone in a fresh realm, it replaces the three functions and asks through what it was given', async () => {
    await install()
    const call = contextBridge.executeInMainWorld.mock.calls[0]?.[0] as { func: (...args: unknown[]) => void; args: unknown[] }
    const asked: unknown[][] = []
    const realm = vm.createContext({
      ask: (...args: unknown[]) => (asked.push(args), args[0] === 'confirm' ? true : args[0] === 'prompt' ? 'réponse' : undefined),
      kinds: ['alert', 'confirm', 'prompt']
    })
    vm.runInContext(
      `var window = globalThis; var Event = class Event { get type() { return '' } };
       window.alert = function alert() { return 'native' }; window.confirm = function confirm() { return 'native' }; window.prompt = function prompt() { return 'native' };
       (${call.func.toString()})(ask, kinds)`,
      realm
    )
    // Copied out of the other realm, so that the comparison is of the values only.
    expect([...(vm.runInContext(`[alert('a'), confirm('b'), prompt('c', 'd'), alert.name, confirm.length]`, realm) as unknown[])]).toEqual([undefined, true, 'réponse', 'alert', 0])
    expect(asked).toEqual([
      ['alert', 'a', ''],
      ['confirm', 'b', ''],
      ['prompt', 'c', 'd']
    ])
  })
})

describe('a document without context isolation (an offscreen document of an extension)', () => {
  // Electron refuses `contextBridge` there, in these words: the preload used to say so on the console of the page, one line for each bridge.
  const refuse = (): void => {
    contextBridge.executeInMainWorld.mockImplementation(() => {
      throw new Error('contextBridge API can only be used when contextIsolation is enabled')
    })
  }

  it('stays out: no call to contextBridge, no line on the console, and the page keeps the functions it has', async () => {
    proc.contextIsolated = false
    refuse()
    await install()
    expect(contextBridge.executeInMainWorld).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(pagePrompt()).toBe(nativePrompt)
  })

  it('keeps the bridge in a page that has isolation, a tab', async () => {
    proc.contextIsolated = true
    await install()
    expect(contextBridge.executeInMainWorld).toHaveBeenCalledTimes(1)
    expect(pagePrompt()).not.toBe(nativePrompt)
  })

  it('still tries where the renderer does not say (no `contextIsolated` at all), and says why when Electron refuses', async () => {
    proc.contextIsolated = undefined
    refuse()
    await install()
    expect(contextBridge.executeInMainWorld).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith('[lucium] the dialog bridge could not be installed in this frame:', 'contextBridge API can only be used when contextIsolation is enabled')
  })
})
