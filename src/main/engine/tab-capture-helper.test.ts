// The helper page of a capture of the sound of a tab (tab-capture-helper.ts), over a stand-in of the window: what it is made as (hidden, sandboxed, the one preload that gives it
// a function to send sound, in the session it is given, loaded from its fixed address with the secret of the engine's load), what it can be made to do (nothing: it never
// navigates, never opens a window), what it runs (one fixed script, no parameter) and how it goes. The engine of the captures that decides when it is made and destroyed is in tab-capture.test.ts.

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CAPTURE_HELPER_URL } from '@shared/capture-helper-page'
import { HELPER_SCRIPT } from '@shared/tab-capture-pcm'

interface Options {
  show?: boolean
  webPreferences?: Record<string, unknown>
}

class FakeContents extends EventEmitter {
  readonly id = 77
  executed: Array<[string, boolean]> = []
  opener: ((details: unknown) => { action: string }) | undefined
  result: unknown = 'the answer'
  failWith: Error | undefined
  setWindowOpenHandler(handle: (details: unknown) => { action: string }): void {
    this.opener = handle
  }
  executeJavaScript(code: string, userGesture: boolean): Promise<unknown> {
    this.executed.push([code, userGesture])
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(this.result)
  }
}

class FakeWindow extends EventEmitter {
  static made: FakeWindow[] = []
  /** What the next window made is given: a load that fails, a load a test holds back. */
  static nextLoadFails: Error | undefined
  static nextLoadDelay: Promise<void> | undefined
  readonly webContents = new FakeContents()
  destroyed = false
  destroyCalls = 0
  loaded: string[] = []
  loadOptions: unknown[] = []
  readonly loadFails = FakeWindow.nextLoadFails
  readonly loadDelay = FakeWindow.nextLoadDelay
  constructor(readonly options: Options) {
    super()
    FakeWindow.nextLoadFails = undefined
    FakeWindow.nextLoadDelay = undefined
    FakeWindow.made.push(this)
  }
  async loadURL(url: string, options?: unknown): Promise<void> {
    this.loaded.push(url)
    this.loadOptions.push(options)
    await this.loadDelay
    if (this.loadFails) throw this.loadFails
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyCalls++
    this.destroyed = true
    // Electron tells the window is closed when it is destroyed, as it does for one the person closed.
    this.emit('closed')
  }
}

vi.mock('electron', () => ({ BrowserWindow: FakeWindow }))

const { captureHelperPreloadPath, openCaptureHelper } = await import('./tab-capture-helper')

const session = { name: 'the session of the profile' }
const LOAD_HEADER = 'x-lucium-page-load: 0f1e2d3c4b5a69788796a5b4c3d2e1f0'

function open() {
  const gone = vi.fn()
  const warn = vi.fn()
  const helper = openCaptureHelper(session as never, { gone, warn }, LOAD_HEADER)
  const window = FakeWindow.made.at(-1)!
  return { helper, window, contents: window.webContents, gone, warn }
}

afterEach(() => {
  FakeWindow.made.length = 0
})

describe('the helper page: what it is made as', () => {
  it('is a window that is never shown, in the session it is given, with the web contents it names', () => {
    const { helper, window } = open()
    expect(FakeWindow.made).toHaveLength(1)
    expect(window.options.show).toBe(false)
    expect(window.options.webPreferences?.['session']).toBe(session)
    expect(helper.contentsId).toBe(77)
  })

  it('is sandboxed and isolated, with no Node and no webview, and given the one preload that sends a chunk of sound: none of the other calls of the interface', () => {
    const { window } = open()
    const preferences = window.options.webPreferences!
    expect(preferences['sandbox']).toBe(true)
    expect(preferences['contextIsolation']).toBe(true)
    for (const off of ['nodeIntegration', 'nodeIntegrationInSubFrames', 'nodeIntegrationInWorker', 'webviewTag']) expect(preferences[off], off).toBe(false)
    expect(preferences['preload']).toBe(captureHelperPreloadPath())
    // Only the file of its own, built with the other preloads: the preload of the interface or of an extension is never this page's.
    expect(captureHelperPreloadPath('/Applications/Lucium.app/Contents/Resources/app.asar/out/main')).toBe('/Applications/Lucium.app/Contents/Resources/app.asar/out/preload/capture-helper.js')
    expect(captureHelperPreloadPath('/Users/jane/lucium/out/main')).toBe('/Users/jane/lucium/out/preload/capture-helper.js')
  })

  it('is not slowed down while nobody sees it: its timers and the reading of its sound run as if it were shown', () => {
    expect(open().window.options.webPreferences?.['backgroundThrottling']).toBe(false)
  })

  it('loads its fixed address, a secure one, with the secret of the engine\'s load, and nothing else (an about:blank window has no navigator.mediaDevices)', () => {
    const { window } = open()
    expect(window.loaded).toEqual(['lucium-ui://capture-helper/'])
    expect(CAPTURE_HELPER_URL).toBe('lucium-ui://capture-helper/')
    expect(window.loadOptions).toEqual([{ extraHeaders: LOAD_HEADER }])
  })

  it('says in the log when its page cannot be loaded, and runs nothing after it', async () => {
    const failure = new Error('the page could not be loaded')
    FakeWindow.nextLoadFails = failure
    const gone = vi.fn()
    const warn = vi.fn()
    const helper = openCaptureHelper(session as never, { gone, warn }, LOAD_HEADER)
    await expect(helper.start()).rejects.toThrow('the page could not be loaded')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not load its page'), failure)
    expect(FakeWindow.made.at(-1)!.webContents.executed).toEqual([])
  })
})

describe('the helper page: what it can be made to do', () => {
  it('goes nowhere: a navigation, a redirect and a navigation of a frame are all stopped', () => {
    const { contents } = open()
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
      const event = { preventDefault: vi.fn() }
      contents.emit(name, event)
      expect(event.preventDefault, name).toHaveBeenCalledTimes(1)
    }
  })

  it('opens no window, whatever it is made to try', () => {
    const { contents } = open()
    expect(contents.opener!({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
  })
})

describe('the helper page: what it runs', () => {
  it('runs the fixed script, with no parameter, as if a click had just been made, and is begun when the script says the reading has begun', async () => {
    const { helper, contents } = open()
    contents.result = true
    await helper.start()
    expect(contents.executed).toEqual([[HELPER_SCRIPT, true]])
  })

  it('runs the same text each time: nothing of the offer, the tab or the extension is written in it', async () => {
    const first = open()
    first.contents.result = true
    await first.helper.start()
    const second = open()
    second.contents.result = true
    await second.helper.start()
    expect(second.contents.executed[0]![0]).toBe(first.contents.executed[0]![0])
  })

  it('waits for its page to be loaded before it runs anything', async () => {
    let loaded!: () => void
    FakeWindow.nextLoadDelay = new Promise<void>((resolve) => void (loaded = resolve))
    const { helper, contents } = open()
    contents.result = true
    const starting = helper.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(contents.executed).toEqual([])
    loaded()
    await starting
    expect(contents.executed).toHaveLength(1)
  })

  it('is refused when the script does not say that the reading began', async () => {
    const { helper, contents } = open()
    for (const wrong of [undefined, 12, 'true', { began: true }, null, false]) {
      contents.result = wrong
      await expect(helper.start(), String(wrong)).rejects.toThrow('did not begin to read the sound')
    }
  })

  it('passes on what the page threw: the engine ends the capture', async () => {
    const { helper, contents } = open()
    contents.failWith = new Error('Permission denied')
    await expect(helper.start()).rejects.toThrow('Permission denied')
  })

  it('runs nothing once the window is destroyed', async () => {
    const { helper, window, contents } = open()
    window.destroyed = true
    await expect(helper.start()).rejects.toThrow('the helper page is gone')
    expect(contents.executed).toEqual([])
  })
})

describe('the helper page: how it goes', () => {
  it('is destroyed by `close`, once, and the capture it carried is not told it went: the engine did it', () => {
    const { helper, window, gone } = open()
    helper.close()
    helper.close()
    expect(window.destroyCalls).toBe(1)
    expect(gone).not.toHaveBeenCalled()
  })

  it('tells the engine when its window is closed by something else', () => {
    const { window, gone } = open()
    window.emit('closed')
    expect(gone).toHaveBeenCalledExactlyOnceWith(77)
  })

  it('tells the engine when its process dies, once, and not again when the window then closes', () => {
    const { window, contents, gone, helper } = open()
    contents.emit('render-process-gone')
    expect(gone).toHaveBeenCalledExactlyOnceWith(77)
    // The engine destroys the window of a page that died: that is not a second end.
    helper.close()
    window.emit('closed')
    expect(gone).toHaveBeenCalledTimes(1)
    expect(window.destroyCalls).toBe(1)
  })

  it('is left alone by a `close` when the window is already gone', () => {
    const { helper, window } = open()
    window.destroyed = true
    helper.close()
    expect(window.destroyCalls).toBe(0)
  })
})
