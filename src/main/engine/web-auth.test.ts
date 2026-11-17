// chrome.identity.launchWebAuthFlow as the engine runs it (web-auth.ts), over a window that is an event emitter: the page of the flow is marked for
// as long as it lives (the engine then refuses it permissions and downloads, see permission-guards.test.ts), it is never left to load anything but a
// web page, it opens no window, it does not write its own title, and an extension cannot run flows in a loop. The rules alone are in
// shared/web-auth.test.ts and shared/chrome-compat.test.ts; nothing ran these lines before.

import type { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_ERRORS } from '@shared/chrome-compat'

interface FakeAuthWindow extends EventEmitter {
  options: { show: boolean; webPreferences: Record<string, unknown> }
  webContents: EventEmitter & { id: number; loaded: string[]; reloads: number; openHandler?: () => { action: string } }
  destroyed: boolean
  title: string
}

/** The windows the flows made, in order. */
const windows = vi.hoisted(() => [] as FakeAuthWindow[])

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  let nextId = 900
  class BrowserWindow extends EventEmitter {
    destroyed = false
    title = ''
    webContents = Object.assign(new EventEmitter(), {
      id: ++nextId,
      loaded: [] as string[],
      reloads: 0,
      reload() {
        this.reloads++
      },
      openHandler: undefined as undefined | (() => { action: string }),
      setWindowOpenHandler(handler: () => { action: string }) {
        this.openHandler = handler
      },
      loadURL(url: string) {
        this.loaded.push(url)
        return Promise.resolve()
      }
    })
    constructor(readonly options: FakeAuthWindow['options']) {
      super()
      windows.push(this as unknown as FakeAuthWindow)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
    close(): void {
      this.emit('closed')
    }
    setTitle(title: string): void {
      this.title = title
    }
  }
  return { BrowserWindow }
})

const { isAuthContents, runWebAuthFlow } = await import('./web-auth')

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const session = { name: 'the session of the profile' }
type Request = Parameters<typeof runWebAuthFlow>[1]
const request = (over: Partial<Request> = {}): Request => ({ url: 'https://accounts.example/authorize', extensionId: EXT, interactive: true, timeoutMs: 5_000, abortOnLoad: false, ...over })

/** A flow under way, its window, and a navigation of its page (answers whether the window stopped it). */
function flow(over: Partial<Request> = {}) {
  const outcome = runWebAuthFlow(session as never, request(over)).then(
    (url) => ({ url }),
    (error: Error) => ({ error: error.message })
  )
  const win = windows.at(-1)!
  const navigate = (event: 'will-navigate' | 'will-redirect', url: string): boolean => {
    const e = { preventDefault: vi.fn() }
    win.webContents.emit(event, e, url)
    return e.preventDefault.mock.calls.length > 0
  }
  return { outcome, win, navigate }
}

afterEach(() => {
  // Every flow of a test is ended: the limit counts the flows that run, for the whole file.
  for (const win of windows) win.emit('closed')
  windows.length = 0
  vi.useRealTimers()
})

describe('the window of an authorization flow', () => {
  it('is made in the session of the profile with the sandbox on, the page isolated and no Node, and is hidden for a flow without interaction', () => {
    expect(flow().win.options).toMatchObject({ show: true, webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    expect(flow({ interactive: false, extensionId: OTHER }).win.options.show).toBe(false)
  })

  it('marks its page for as long as the flow runs, and takes the mark off when it ends', async () => {
    const { outcome, win, navigate } = flow()
    expect(isAuthContents(win.webContents as never)).toBe(true)
    navigate('will-redirect', `https://${EXT}.chromiumapp.org/cb?code=1`)
    await outcome
    expect(isAuthContents(win.webContents as never)).toBe(false)
    expect(win.destroyed).toBe(true)
  })

  it('opens no window, whatever the page asks', () => {
    expect(flow().win.webContents.openHandler!()).toEqual({ action: 'deny' })
  })

  it('does not let the page write the title: it says the host the page is on, the only thing that tells the user where they are', () => {
    const { win } = flow()
    const event = { preventDefault: vi.fn() }
    win.emit('page-title-updated', event, 'Your bank')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    win.webContents.emit('did-navigate', {}, 'https://login.other.example/step2')
    expect(win.title).toContain('login.other.example')
  })
})

describe('what the page of an authorization flow may do to the user', () => {
  it('can have its dialogs silenced after the first, and plays no sound without a gesture, seen or hidden', () => {
    for (const win of [flow().win, flow({ interactive: false, extensionId: OTHER }).win]) {
      expect(win.options.webPreferences).toMatchObject({ safeDialogs: true, autoplayPolicy: 'document-user-activation-required' })
      expect(typeof win.options.webPreferences.safeDialogsMessage).toBe('string')
    }
  })

  /** A key pressed in the window: whether it was kept from the menu of the application. */
  const press = (win: FakeAuthWindow, key: string, over: Record<string, unknown> = {}): boolean => {
    const event = { preventDefault: vi.fn() }
    const command = process.platform === 'darwin' ? { meta: true, control: false } : { meta: false, control: true }
    win.webContents.emit('before-input-event', event, { type: 'keyDown', key, alt: false, shift: false, ...command, ...over })
    return event.preventDefault.mock.calls.length > 0
  }

  it('closes on the close shortcut, which never reaches the menu (it would archive the tab behind)', async () => {
    const { outcome, win } = flow()
    expect(press(win, 'w')).toBe(true)
    expect(await outcome).toEqual({ error: AUTH_ERRORS.userRejected })
    expect(win.destroyed).toBe(true)
  })

  it('reloads its own page on the reload shortcut, and keeps the other commands of the menu from it', () => {
    const { win } = flow()
    expect(press(win, 'r')).toBe(true)
    expect(win.webContents.reloads).toBe(1)
    expect(press(win, 't')).toBe(true)
    expect(press(win, 'l')).toBe(true)
    expect(win.webContents.reloads).toBe(1)
  })

  it('leaves the page its keys, and the system its editing commands', () => {
    const { win } = flow()
    expect(press(win, 'w', { meta: false, control: false })).toBe(false)
    expect(press(win, 'c')).toBe(false)
    expect(press(win, 'v')).toBe(false)
  })

  it('is not held open by a page that asks to confirm leaving it', () => {
    const { win } = flow()
    const event = { preventDefault: vi.fn() }
    win.webContents.emit('will-prevent-unload', event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })
})

describe('where an authorization flow may go', () => {
  it('ends with the address of the extension’s own redirect, which the window never loads', async () => {
    const { outcome, win, navigate } = flow()
    expect(navigate('will-navigate', 'https://accounts.example/consent')).toBe(false)
    expect(navigate('will-redirect', `https://${EXT}.chromiumapp.org/cb?code=1`)).toBe(true)
    expect(await outcome).toEqual({ url: `https://${EXT}.chromiumapp.org/cb?code=1` })
    expect(win.webContents.loaded).toEqual(['https://accounts.example/authorize'])
  })

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>1</script>', `chrome-extension://${EXT}/page.html`, 'lucium://settings'])('stops a navigation to %s and fails: an authorization page is a web page', async (url) => {
    for (const event of ['will-navigate', 'will-redirect'] as const) {
      const { outcome, navigate, win } = flow()
      expect(navigate(event, url), event).toBe(true)
      expect(await outcome).toEqual({ error: AUTH_ERRORS.pageLoadFailed })
      expect(win.destroyed).toBe(true)
    }
  })

  it('does not take the redirect of another extension, nor one over http, for the end of this flow', async () => {
    const { outcome, navigate, win } = flow()
    expect(navigate('will-redirect', `https://${OTHER}.chromiumapp.org/cb?code=1`)).toBe(false)
    expect(navigate('will-redirect', `http://${EXT}.chromiumapp.org/cb?code=1`)).toBe(false)
    win.emit('closed')
    expect(await outcome).toEqual({ error: AUTH_ERRORS.userRejected })
  })

  it('refuses to start on an address that is not a web page, and makes no window for it', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', `chrome-extension://${EXT}/page.html`, 'not an address']) {
      await expect(runWebAuthFlow(session as never, request({ url }))).rejects.toThrow(AUTH_ERRORS.invalidUrl)
    }
    expect(windows).toHaveLength(0)
  })
})

describe('how many authorization flows run', () => {
  it('one per extension: a second one is refused while the first runs, and allowed once it has ended', async () => {
    const first = flow()
    await expect(runWebAuthFlow(session as never, request())).rejects.toThrow(AUTH_ERRORS.alreadyRunning)
    await expect(runWebAuthFlow(session as never, request({ interactive: false }))).rejects.toThrow(AUTH_ERRORS.pageLoadFailed)
    expect(windows).toHaveLength(1)
    first.win.emit('closed')
    expect(await first.outcome).toEqual({ error: AUTH_ERRORS.userRejected })
    expect(flow().win).not.toBe(first.win)
    expect(windows).toHaveLength(2)
  })

  it('a flow without interaction gives up after its delay, and frees its place', async () => {
    vi.useFakeTimers()
    const { outcome, win } = flow({ interactive: false, timeoutMs: 2_000 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await outcome).toEqual({ error: AUTH_ERRORS.pageLoadTimedOut })
    expect(win.destroyed).toBe(true)
    expect(isAuthContents(win.webContents as never)).toBe(false)
  })
})
