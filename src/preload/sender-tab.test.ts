// What an extension is told about the tab a message comes from: the real tab for a content script (the made-up one has window 0, index 0, never active), and no tab at all
// for a popup or an offscreen document, as the extension API documents.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixSenderTabs } from './sender-tab'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const POPUP = `chrome-extension://${ID}/popup.html`
const OPTIONS = `chrome-extension://${ID}/options.html`
const PAGE = 'https://example.org/'
const settle = (ms = 80): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** An event as the extension API gives it: listeners are added, removed, and called with what the browser sends. */
function fakeEvent() {
  const listeners = new Set<(...args: any[]) => unknown>()
  return {
    addListener: (l: (...args: any[]) => unknown) => void listeners.add(l),
    removeListener: (l: (...args: any[]) => unknown) => void listeners.delete(l),
    hasListener: (l: (...args: any[]) => unknown) => listeners.has(l),
    fire: (...args: unknown[]) => [...listeners].map((l) => l(...args))
  }
}

interface RealTab { id: number; windowId: number; index: number; active: boolean; highlighted: boolean; pinned?: boolean; status?: string; favIconUrl?: string; width?: number; mutedInfo?: { muted: boolean } }
const tab = (over: Partial<RealTab> & { id: number }): RealTab => ({ windowId: 1, index: 0, active: false, highlighted: false, ...over })

/** `tabs` are the real tabs `chrome.tabs.query` answers (a function so that a test can change them); `withTabs: false` is an extension that has no tabs API. */
function install(options: { tabs?: () => RealTab[]; frozen?: boolean; withTabs?: boolean } = {}) {
  const tabs = options.tabs ?? (() => [])
  const tabsApi = options.withTabs === false ? undefined : {
    query: vi.fn(async () => tabs().map((t) => ({ ...t }))),
    onCreated: fakeEvent(), onRemoved: fakeEvent(), onActivated: fakeEvent(), onHighlighted: fakeEvent(), onAttached: fakeEvent(), onDetached: fakeEvent(), onMoved: fakeEvent(), onReplaced: fakeEvent(), onUpdated: fakeEvent()
  }
  const runtime = { id: ID, onMessage: fakeEvent(), onMessageExternal: fakeEvent(), onConnect: fakeEvent(), onConnectExternal: fakeEvent() }
  const chrome = { runtime, tabs: tabsApi }
  ;(globalThis as { chrome?: unknown }).chrome = options.frozen === false ? chrome : Object.freeze(chrome)
  fixSenderTabs()
  return { runtime, tabsApi }
}

beforeEach(() => {
  delete (globalThis as { __luciumSenderFixed?: boolean }).__luciumSenderFixed
})
afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome
  vi.restoreAllMocks()
})

/** The sender a listener of the extension is handed for a message. */
function heard(runtime: ReturnType<typeof install>['runtime'], sender: unknown, event: 'onMessage' | 'onMessageExternal' = 'onMessage') {
  const seen: any[] = []
  runtime[event].addListener((_message: unknown, s: unknown) => void seen.push(s))
  runtime[event].fire({}, sender, () => {})
  return seen[0]
}

describe('the tab of a content script', () => {
  it('is the real one: its window, its place, and whether it is the active one (the made-up one never is)', async () => {
    const { runtime } = install({ tabs: () => [tab({ id: 84, windowId: 1, index: 66, active: true, highlighted: true })] })
    await settle()
    const sender = heard(runtime, { id: ID, url: PAGE, frameId: 0, tab: { id: 84, windowId: 0, index: 0, active: false, highlighted: false, url: PAGE } })
    expect(sender.tab).toMatchObject({ id: 84, windowId: 1, index: 66, active: true, highlighted: true, url: PAGE })
    expect(sender.frameId).toBe(0)
    // What the browser knew and the list does not say stays.
    expect(sender.tab.url).toBe(PAGE)
  })

  it('carries what the made-up tab does not have at all: its icon, its size and whether it is muted', async () => {
    const { runtime } = install({ tabs: () => [tab({ id: 5, active: true, favIconUrl: 'https://example.org/icon.png', width: 1360, mutedInfo: { muted: false } })] })
    await settle()
    const sender = heard(runtime, { id: ID, url: PAGE, tab: { id: 5, windowId: 1, active: true } })
    expect(sender.tab).toMatchObject({ favIconUrl: 'https://example.org/icon.png', width: 1360, mutedInfo: { muted: false } })
  })

  it('is read when the listener looks at it: a tab that became the active one while the listener waited is the active one', async () => {
    let current = [tab({ id: 7, active: false })]
    const { runtime, tabsApi } = install({ tabs: () => current })
    await settle()
    const sender = heard(runtime, { id: ID, url: PAGE, tab: { id: 7, windowId: 0, active: false } })
    expect(sender.tab.active).toBe(false)
    current = [tab({ id: 7, active: true, highlighted: true })]
    tabsApi!.onActivated.fire({ tabId: 7, windowId: 1 })
    await settle()
    expect(sender.tab.active).toBe(true)
    // A copy of the tab carries the real values as well.
    expect({ ...sender.tab }).toMatchObject({ active: true, highlighted: true })
    expect(JSON.parse(JSON.stringify(sender.tab))).toMatchObject({ active: true })
  })

  it('learns of a change of tabs from the events and asks for the list again', async () => {
    let current = [tab({ id: 1, active: true }), tab({ id: 2, active: false })]
    const { runtime, tabsApi } = install({ tabs: () => current })
    await settle()
    const calls = tabsApi!.query.mock.calls.length
    current = [tab({ id: 1, active: false }), tab({ id: 2, active: true })]
    tabsApi!.onActivated.fire({ tabId: 2, windowId: 1 })
    await settle()
    expect(tabsApi!.query.mock.calls.length).toBeGreaterThan(calls)
    expect(heard(runtime, { id: ID, url: PAGE, tab: { id: 2, windowId: 0, active: false } }).tab.active).toBe(true)
  })

  it('stays as the browser gave it when the extension has no tabs API', () => {
    const { runtime } = install({ withTabs: false })
    const sender = heard(runtime, { id: ID, url: PAGE, tab: { id: 3, windowId: 0, active: false } })
    expect(sender.tab).toMatchObject({ id: 3, windowId: 0, active: false })
  })
})

describe('the sender of a popup or an offscreen document', () => {
  it('has no tab (the made-up one is not among the real tabs)', async () => {
    const { runtime } = install({ tabs: () => [tab({ id: 4, active: true })] })
    await settle()
    const sender = heard(runtime, { id: ID, url: POPUP, frameId: 0, tab: { id: 16, windowId: 0, url: POPUP } })
    expect(sender).toEqual({ id: ID, url: POPUP, frameId: 0 })
    expect('tab' in sender).toBe(false)
  })

  it('has none either before the first list of tabs has come (the made-up tab always has window id 0)', () => {
    const { runtime } = install({ tabs: () => [tab({ id: 4 })] })
    const sender = heard(runtime, { id: ID, url: POPUP, tab: { id: 16, windowId: 0 } })
    expect('tab' in sender).toBe(false)
  })

  it('keeps the tab of an extension page that is shown in a tab of the browser (it is among the real ones)', async () => {
    const { runtime } = install({ tabs: () => [tab({ id: 9, windowId: 1, index: 3, active: true })] })
    await settle()
    const sender = heard(runtime, { id: ID, url: OPTIONS, tab: { id: 9, windowId: 0, url: OPTIONS } })
    expect(sender.tab).toMatchObject({ id: 9, windowId: 1, index: 3, active: true })
  })

  it('keeps the tab of an options page that opens in a new tab and speaks at once: the list has not read that tab yet, tabs.onCreated has announced it', async () => {
    const { runtime, tabsApi } = install({ tabs: () => [tab({ id: 4, active: true })] })
    await settle()
    // The tab is created, and the page sends its first message before the list is read again (the made-up tab has window 0 until then).
    tabsApi!.onCreated.fire(tab({ id: 9, windowId: 1, index: 1 }))
    const sender = heard(runtime, { id: ID, url: OPTIONS, frameId: 0, tab: { id: 9, windowId: 0, url: OPTIONS } })
    expect(sender.tab).toMatchObject({ id: 9, url: OPTIONS })
    // Once the list has it, the real fields are there.
    await settle()
    expect(sender.tab).toMatchObject({ id: 9 })
  })

  it('still takes the made-up tab off a popup while other tabs are being created', async () => {
    const { runtime, tabsApi } = install({ tabs: () => [tab({ id: 4, active: true })] })
    await settle()
    tabsApi!.onCreated.fire(tab({ id: 9, windowId: 1 }))
    const sender = heard(runtime, { id: ID, url: POPUP, frameId: 0, tab: { id: 16, windowId: 0, url: POPUP } })
    expect('tab' in sender).toBe(false)
  })

  it('works without a tabs API: the made-up tab is still taken off', () => {
    const { runtime } = install({ withTabs: false })
    expect('tab' in heard(runtime, { id: ID, url: POPUP, tab: { id: 16, windowId: 0 } })).toBe(false)
  })
})

describe('the other senders', () => {
  it('are left alone: another extension (external messages) and a sender with no tab', async () => {
    const { runtime } = install({ tabs: () => [tab({ id: 4 })] })
    await settle()
    const foreign = { id: 'other', url: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/popup.html', tab: { id: 2, windowId: 0 } }
    expect(heard(runtime, foreign, 'onMessageExternal').tab).toMatchObject({ id: 2, windowId: 0 })
    expect(heard(runtime, { id: ID, url: POPUP }, 'onMessage')).toEqual({ id: ID, url: POPUP })
  })

  it('reach the listener with what it answers passed on (true keeps the channel open) and the arguments that follow', () => {
    const { runtime } = install()
    const sendResponse = vi.fn()
    runtime.onMessage.addListener((_m: unknown, _s: unknown, respond: unknown) => (respond === sendResponse ? true : false))
    expect(runtime.onMessage.fire({}, { url: POPUP, tab: { id: 16, windowId: 0 } }, sendResponse)).toEqual([true])
  })

  it('can be removed and looked for by the extension, and are not wrapped twice', () => {
    const { runtime } = install()
    const calls: unknown[] = []
    const listener = (_m: unknown, s: unknown) => void calls.push(s)
    runtime.onMessage.addListener(listener)
    runtime.onMessage.addListener(listener)
    expect(runtime.onMessage.hasListener(listener)).toBe(true)
    runtime.onMessage.fire({}, { url: POPUP, tab: { id: 16, windowId: 0 } }, () => {})
    expect(calls).toHaveLength(1)
    runtime.onMessage.removeListener(listener)
    expect(runtime.onMessage.hasListener(listener)).toBe(false)
  })

  it('let go of a listener that was removed: added again, it is wrapped anew and the old wrapper is not kept', () => {
    // An event that shows what reaches the browser: the wrapper made for each listener.
    const registered: unknown[] = []
    const listeners = new Set<unknown>()
    const onMessage = {
      addListener: (l: unknown) => void (registered.push(l), listeners.add(l)),
      removeListener: (l: unknown) => void listeners.delete(l),
      hasListener: (l: unknown) => listeners.has(l)
    }
    ;(globalThis as { chrome?: unknown }).chrome = Object.freeze({ runtime: { id: ID, onMessage, onMessageExternal: fakeEvent(), onConnect: fakeEvent(), onConnectExternal: fakeEvent() } })
    fixSenderTabs()
    const listener = () => undefined
    onMessage.addListener(listener)
    onMessage.removeListener(listener)
    expect(listeners.size).toBe(0)
    onMessage.addListener(listener)
    expect(registered).toHaveLength(2)
    expect(registered[0]).not.toBe(registered[1])
    expect(onMessage.hasListener(listener)).toBe(true)
    onMessage.removeListener(listener)
    expect(onMessage.hasListener(listener)).toBe(false)
  })
})

describe('the sender of a port', () => {
  it('has no tab when the port comes from a popup, and the real tab when it comes from a content script', async () => {
    const { runtime } = install({ tabs: () => [tab({ id: 4, index: 5, active: true })] })
    await settle()
    const ports: any[] = []
    runtime.onConnect.addListener((port: unknown) => void ports.push(port))
    runtime.onConnect.fire({ name: 'a', sender: { id: ID, url: POPUP, tab: { id: 16, windowId: 0 } } })
    runtime.onConnect.fire({ name: 'b', sender: { id: ID, url: PAGE, tab: { id: 4, windowId: 0, active: false } } })
    expect(ports[0].sender).toEqual({ id: ID, url: POPUP })
    expect(ports[1].sender.tab).toMatchObject({ id: 4, index: 5, active: true })
  })

  it('is logged with its cause when the port will not let its sender be replaced, and the listener still gets the port', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime } = install()
    const port = Object.defineProperty({ name: 'x' }, 'sender', { value: { url: POPUP, tab: { id: 16, windowId: 0 } }, configurable: false })
    const seen: unknown[] = []
    runtime.onConnect.addListener((p: unknown) => void seen.push(p))
    runtime.onConnect.fire(port)
    expect(seen[0]).toBe(port)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be corrected'), expect.anything())
  })
})

describe('when it runs', () => {
  it('does nothing in the first pass (the libraries are not done: chrome is not frozen), and only once', () => {
    const early = install({ frozen: false })
    const sender = { url: POPUP, tab: { id: 16, windowId: 0 } }
    expect(heard(early.runtime, sender)).toBe(sender)
    const later = install()
    fixSenderTabs()
    expect('tab' in heard(later.runtime, { url: POPUP, tab: { id: 16, windowId: 0 } })).toBe(false)
  })
})

describe('the listeners of the messages, for whoever has to call them itself', () => {
  const held = (): Array<(...args: unknown[]) => unknown> => (globalThis as { __luciumMessageListeners?: () => Array<(...args: unknown[]) => unknown> }).__luciumMessageListeners!()

  afterEach(() => {
    delete (globalThis as { __luciumMessageListeners?: unknown }).__luciumMessageListeners
  })

  it('are the ones the extension holds for chrome.runtime.onMessage now: added once, gone when taken off, and no other event\'s', () => {
    const { runtime } = install()
    expect(held()).toEqual([])
    const first = () => undefined
    const second = () => undefined
    runtime.onMessage.addListener(first)
    runtime.onMessage.addListener(first)
    runtime.onMessage.addListener(second)
    runtime.onMessageExternal.addListener(() => undefined)
    runtime.onConnect.addListener(() => undefined)
    expect(held()).toHaveLength(2)
    runtime.onMessage.removeListener(first)
    expect(held()).toHaveLength(1)
  })

  it('are called with the sender corrected like any other: the real tab for a content script of the extension (the same listener the browser calls)', async () => {
    const { runtime } = install({ tabs: () => [tab({ id: 84, windowId: 1, index: 66, active: true, highlighted: true })] })
    await settle()
    const seen: any[] = []
    runtime.onMessage.addListener((_message: unknown, sender: unknown) => void seen.push(sender))
    held()[0]!({ type: 'x' }, { id: ID, url: PAGE, tab: { id: 84, windowId: 0, index: 0 } }, () => undefined)
    expect(seen[0].tab).toMatchObject({ id: 84, windowId: 1, index: 66, active: true })
    // The one the browser holds is the one it is given: calling it is what an event of the browser does.
    runtime.onMessage.fire({ type: 'x' }, { id: ID, url: PAGE, tab: { id: 84, windowId: 0, index: 0 } }, () => undefined)
    expect(seen).toHaveLength(2)
  })

  it('are not offered by a context where the extension has no such event', () => {
    ;(globalThis as { chrome?: unknown }).chrome = Object.freeze({ runtime: { id: ID } })
    fixSenderTabs()
    expect((globalThis as { __luciumMessageListeners?: unknown }).__luciumMessageListeners).toBeUndefined()
  })
})
