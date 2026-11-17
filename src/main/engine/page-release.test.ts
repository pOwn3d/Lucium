// A page out of sight that asks to confirm leaving it is not destroyed by a sleep without a question: the real ElectronPage over a
// fake web contents (electron-page.test-support.ts), and the watcher of typed text run on a fake document, frames of the same site included.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePage, settle } from './electron-page.test-support'

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
