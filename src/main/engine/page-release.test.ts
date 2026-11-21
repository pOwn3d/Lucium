// A page out of sight that asks to confirm leaving it is not destroyed by a sleep without a question: the real ElectronPage over a
// fake web contents (electron-page.test-support.ts), and the watcher of typed text run on a fake document, frames of the same site included.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePage, settle } from './electron-page.test-support'
import { SleptHistory } from '../shell/slept-history'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { RELEASE_ANSWER_MS, TRACK_INPUT } = await import('./electron-page')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the close of a page for a sleep (ElectronPage.release)', () => {
  it('asks Chromium to run the beforeunload of the page, and answers true once the page is gone; the tab is not closed with it', async () => {
    const closed = vi.fn()
    const { page, wc } = await makePage({ events: { closed } })
    const answer = page.release()
    expect(wc.close).toHaveBeenCalledWith({ waitForBeforeUnload: true })
    wc.emit('close')
    wc.destroyed = true
    wc.emit('destroyed')
    expect(await answer).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closed).not.toHaveBeenCalled()
  })

  it('keeps a page whose beforeunload cancels: the refusal stands (the close does not happen), and the answer is false', async () => {
    const { page, wc } = await makePage()
    const answer = page.release()
    const event = { preventDefault: vi.fn() }
    wc.emit('will-prevent-unload', event)
    expect(await answer).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    // The page is alive and works as before: it can be closed for good later.
    page.destroy()
    expect(wc.close).toHaveBeenLastCalledWith()
  })

  it('closes a page that answers neither way within its bound, as destroy does', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { page, wc } = await makePage()
    const answer = page.release()
    await vi.advanceTimersByTimeAsync(RELEASE_ANSWER_MS)
    expect(await answer).toBe(true)
    expect(wc.close).toHaveBeenLastCalledWith()
  })

  it('answers a second request with the first one', async () => {
    const { page, wc } = await makePage()
    const first = page.release()
    expect(page.release()).toBe(first)
    wc.emit('will-prevent-unload', { preventDefault: vi.fn() })
    expect(await first).toBe(false)
    await settle()
  })
})

const entry = (n: number) => ({ url: `https://site.example/${n}`, title: `Page ${n}` })

describe('the Back / Forward list of a page let go (ElectronPage.navigationEntries)', () => {
  /** A page that went through three pages and went back to the second. */
  async function pageWithHistory() {
    const made = await makePage()
    made.wc.navigationHistory.entries = [entry(1), entry(2), entry(3)]
    made.wc.navigationHistory.active = 1
    return made
  }
  /** What Electron does once the close is over: the web contents is destroyed and `view.webContents` is undefined. */
  const closed = (made: { wc: { destroyed: boolean; emit: (event: string) => boolean }; view: { webContents: unknown } }): void => {
    made.wc.destroyed = true
    made.wc.emit('destroyed')
    made.view.webContents = undefined
  }

  it('still gives its list once the close for a sleep is over: what a sleep keeps is read after it (browser-sleep.ts)', async () => {
    const made = await pageWithHistory()
    const answer = made.page.release()
    closed(made)
    expect(await answer).toBe(true)
    expect(made.page.navigationEntries()).toEqual({ entries: [entry(1), entry(2), entry(3)], index: 1 })
  })

  it('is what a sleep keeps for the next page of the tab: SleptHistory reads it from the real page after the close, as destroyPage does', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const made = await pageWithHistory()
    const answer = made.page.release()
    closed(made)
    await answer
    const slept = new SleptHistory()
    const tab = { id: 'tab-1', url: entry(2).url }
    slept.keep(tab, 'profile:default', () => made.page.navigationEntries())
    expect(warn).not.toHaveBeenCalled()
    expect(slept.take(tab, 'profile:default')).toEqual({ entries: [entry(1), entry(2), entry(3)], index: 1 })
  })

  it('gives the list the page had when its close started, not one it was changed to meanwhile', async () => {
    const made = await pageWithHistory()
    const answer = made.page.release()
    made.wc.navigationHistory.entries = [entry(9)]
    closed(made)
    await answer
    expect(made.page.navigationEntries().entries).toEqual([entry(1), entry(2), entry(3)])
  })

  it('still gives its list once destroy() has closed it', async () => {
    const made = await pageWithHistory()
    made.page.destroy()
    closed(made)
    expect(made.page.navigationEntries()).toEqual({ entries: [entry(1), entry(2), entry(3)], index: 1 })
  })

  it('still gives its list when the close is forced after the bound', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const made = await pageWithHistory()
    const answer = made.page.release()
    made.wc.navigationHistory.entries = [entry(1), entry(2), entry(3), entry(4)]
    await vi.advanceTimersByTimeAsync(RELEASE_ANSWER_MS)
    await answer
    closed(made)
    expect(made.page.navigationEntries().entries).toEqual([entry(1), entry(2), entry(3), entry(4)])
  })

  it('reads the list live again when the page refused to close: the one kept would be out of date', async () => {
    const made = await pageWithHistory()
    const answer = made.page.release()
    made.wc.emit('will-prevent-unload', { preventDefault: vi.fn() })
    expect(await answer).toBe(false)
    made.wc.navigationHistory.entries = [entry(1), entry(2), entry(3), entry(4)]
    made.wc.navigationHistory.active = 3
    expect(made.page.navigationEntries()).toEqual({ entries: [entry(1), entry(2), entry(3), entry(4)], index: 3 })
    // Gone later without a close of ours (a crash, the page closing itself): there is nothing of the refused close to give back.
    closed(made)
    expect(() => made.page.navigationEntries()).toThrow(/left no list/)
  })

  it('says so when a page that is gone left no list, instead of failing on a web contents that is not there', async () => {
    const made = await pageWithHistory()
    closed(made)
    expect(() => made.page.navigationEntries()).toThrow(/page tab-1 is gone and left no list/)
  })

  it('closes without its list when the list cannot be read, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const made = await pageWithHistory()
    made.wc.navigationHistory.getAllEntries = () => {
      throw new Error('no history')
    }
    const answer = made.page.release()
    expect(made.wc.close).toHaveBeenCalledWith({ waitForBeforeUnload: true })
    expect(warn).toHaveBeenCalledWith('[engine] the pages of page tab-1 could not be read before it closed:', 'no history')
    closed(made)
    expect(await answer).toBe(true)
    expect(() => made.page.navigationEntries()).toThrow(/left no list/)
  })
})

/** A document as the watcher sees it from its isolated world: listeners by type, an element with the focus, a window for `blur`. */
class FakeDocument {
  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  activeElement: unknown = null
  readonly defaultView = { listeners: new Map<string, Array<() => void>>(), addEventListener(type: string, fn: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]) } }
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  emit(type: string, target: unknown, isTrusted = true) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, target, isTrusted })
  }
}

const element = (tagName: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ nodeType: 1, tagName, isConnected: true, isContentEditable: false, form: null, ...over })

function watcher() {
  const document = new FakeDocument()
  const self: { __luciumUnsent?: () => boolean } = {}
  const timers: Array<() => void> = []
  new Function('self', 'document', 'setTimeout', TRACK_INPUT)(self, document, (fn: () => void) => timers.push(fn))
  return { document, unsent: () => self.__luciumUnsent!(), runTimers: () => timers.splice(0).forEach((fn) => fn()) }
}

describe('the watcher of typed text (TRACK_INPUT)', () => {
  it('counts text typed in a field until its form is sent, and only what the user typed', () => {
    const w = watcher()
    const form = { contains: (el: unknown) => el === field }
    const field = element('INPUT', { type: 'text', value: 'brouillon', form })
    w.document.emit('input', field, false)
    expect(w.unsent()).toBe(false)
    w.document.emit('input', field)
    expect(w.unsent()).toBe(true)
    w.document.emit('submit', form)
    expect(w.unsent()).toBe(false)
  })

  it('counts a box ticked, a button chosen or an option picked in a form while it differs from what the page gave', () => {
    const w = watcher()
    const form = { contains: () => false }
    const box = element('INPUT', { type: 'checkbox', checked: true, defaultChecked: false, form })
    w.document.emit('change', box)
    expect(w.unsent()).toBe(true)
    box.checked = false
    expect(w.unsent()).toBe(false)
    const option = (selected: boolean, defaultSelected: boolean) => ({ selected, defaultSelected })
    const select = element('SELECT', { form, options: [option(false, true), option(true, false)] })
    w.document.emit('change', select)
    expect(w.unsent()).toBe(true)
    // A box outside any form (a switch of the page that saves itself) is not a draft.
    const loose = watcher()
    loose.document.emit('change', element('INPUT', { type: 'checkbox', checked: true, defaultChecked: false }))
    expect(loose.unsent()).toBe(false)
  })

  it('watches the document of a frame of the same site from the moment the focus goes into it: an editor in a frame keeps its draft', () => {
    const w = watcher()
    const inner = new FakeDocument()
    w.document.activeElement = element('IFRAME', { contentDocument: inner })
    for (const fn of w.document.defaultView.listeners.get('blur') ?? []) fn()
    w.runTimers()
    const body = element('BODY', { isContentEditable: true, textContent: 'Bonjour, voici mon message' })
    inner.emit('input', body)
    expect(w.unsent()).toBe(true)
  })

  it('leaves a frame of another site alone, without failing', () => {
    const w = watcher()
    const frame = element('IFRAME')
    Object.defineProperty(frame, 'contentDocument', {
      get() {
        throw new Error('SecurityError')
      }
    })
    w.document.activeElement = frame
    for (const fn of w.document.defaultView.listeners.get('blur') ?? []) expect(() => fn()).not.toThrow()
    expect(() => w.runTimers()).not.toThrow()
    expect(w.unsent()).toBe(false)
  })
})

describe('when the watcher of typed text is put in the page', () => {
  const watched = (wc: { executeJavaScriptInIsolatedWorld: { mock: { calls: unknown[][] } } }) =>
    wc.executeJavaScriptInIsolatedWorld.mock.calls.filter((call) => (call[1] as Array<{ code: string }>)[0]!.code.includes('__luciumUnsent'))

  it('puts nothing in a page where nothing is typed, and watches from the first key or click', async () => {
    const { wc } = await makePage()
    wc.emit('dom-ready')
    await settle()
    expect(watched(wc)).toHaveLength(0)
    wc.emit('before-input-event', {}, { type: 'keyUp', key: 'a' })
    wc.emit('before-mouse-event', {}, { type: 'mouseMove' })
    expect(watched(wc)).toHaveLength(0)
    wc.emit('before-input-event', {}, { type: 'keyDown', key: 'a', meta: false, control: false })
    expect(watched(wc)).toHaveLength(1)
    // Once is enough for this document.
    wc.emit('before-input-event', {}, { type: 'keyDown', key: 'b', meta: false, control: false })
    wc.emit('before-mouse-event', {}, { type: 'mouseDown' })
    expect(watched(wc)).toHaveLength(1)
    // A new document is not watched until something is typed in it.
    wc.emit('dom-ready')
    await settle()
    expect(watched(wc)).toHaveLength(1)
    wc.emit('before-mouse-event', {}, { type: 'mouseDown' })
    expect(watched(wc)).toHaveLength(2)
  })

  it('does not keep a listener on the page after it is gone from the document or once the watcher is in', async () => {
    const { wc } = await makePage()
    const own = { key: wc.listenerCount('before-input-event'), mouse: wc.listenerCount('before-mouse-event') }
    wc.emit('dom-ready')
    wc.emit('dom-ready')
    expect(wc.listenerCount('before-input-event')).toBe(own.key + 1)
    expect(wc.listenerCount('before-mouse-event')).toBe(own.mouse + 1)
    wc.emit('before-input-event', {}, { type: 'keyDown', key: 'a', meta: false, control: false })
    expect(wc.listenerCount('before-input-event')).toBe(own.key)
    expect(wc.listenerCount('before-mouse-event')).toBe(own.mouse)
  })
})
