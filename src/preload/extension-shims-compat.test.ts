// What the shims add to chrome.* for extensions written for the extension platform, found by running 29 popular ones: the members of chrome.tabs the library leaves out, the answers of
// chrome.extension, contextMenus.update, and an icon drawn with setIcon. The function the preload injects is run for real, against a made-up `chrome`, in its two passes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const contextBridge = { exposeInMainWorld: vi.fn(), executeInMainWorld: vi.fn() }
const ipcRenderer = { invoke: vi.fn(), on: vi.fn() }
vi.mock('electron', () => ({ contextBridge, ipcRenderer }))

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const proc = process as unknown as { type?: string; contextIsolated?: boolean }
const before = { type: proc.type, isolated: proc.contextIsolated }
const g = globalThis as Record<string, any>

/** The function the preload hands to the main world, with its arguments. */
async function injected(): Promise<() => void> {
  vi.resetModules()
  g['__luciumBridged'] = undefined
  contextBridge.executeInMainWorld.mockReset()
  contextBridge.executeInMainWorld.mockImplementation((script: { args?: unknown[] }) => (script.args === undefined ? true : undefined))
  proc.type = 'service-worker'
  proc.contextIsolated = true
  await import('./extension-shims')
  const call = contextBridge.executeInMainWorld.mock.calls.map(([script]) => script).find((script) => script.args !== undefined)
  return () => call.func(...call.args)
}

const tab = (id: number, over: Record<string, unknown> = {}) => ({ id, windowId: 1, index: id - 1, active: false, url: `https://site${id}.example/`, ...over })

/** The library's chrome.tabs / windows / scripting / action, as far as the shims call them. */
function library(manifest: Record<string, unknown>, open: Array<ReturnType<typeof tab>> = [tab(1, { active: true }), tab(2), tab(3)]) {
  const tabs = {
    query: vi.fn(async (q: Record<string, unknown>) => open.filter((t) => (q['active'] === undefined || t.active === q['active']) && (q['windowId'] === undefined || t.windowId === q['windowId']))),
    get: vi.fn(async (id: number) => {
      const found = open.find((t) => t.id === id)
      if (!found) throw new Error(`No tab with id: ${id}.`)
      return found
    }),
    create: vi.fn(async (props: Record<string, unknown>) => ({ id: 99, ...props })),
    update: vi.fn(async (id: number, props: Record<string, unknown>) => ({ id, ...props }))
  }
  const windows = { get: vi.fn(async (id: number, options: unknown) => ({ id, options })) }
  const scripting = { executeScript: vi.fn(async (_injection: unknown): Promise<unknown[]> => [{ result: 'FR-fr ' }]) }
  const action = { setIcon: vi.fn(async (_details: unknown) => undefined) }
  const extension = { isAllowedIncognitoAccess: vi.fn(), isAllowedFileSchemeAccess: vi.fn() }
  const contextMenus = { update: vi.fn(), create: vi.fn() }
  const onConnect = { addListener: vi.fn() }
  const chrome: Record<string, any> = { runtime: { id: ID, getManifest: () => manifest, onConnect }, tabs, windows, scripting, action, extension, contextMenus, storage: {} }
  const bridge = { call: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined), onEvent: vi.fn() }
  g['chrome'] = chrome
  g['__luciumShim'] = bridge
  return { chrome, bridge, tabs, windows, scripting, action, extension, contextMenus, onConnect }
}

/** Runs the shims the way Electron does: before the library's script (chrome open), then after it (chrome frozen). */
function runBothPasses(run: () => void, chrome: Record<string, any>): void {
  run()
  Object.freeze(chrome)
  run()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  proc.type = before.type
  proc.contextIsolated = before.isolated
  delete g['chrome']
  delete g['__luciumShim']
  delete g['OffscreenCanvas']
  delete g['FileReader']
  for (const name of ['document', 'Document', 'ClipboardEvent', 'DataTransfer', 'getSelection', 'location', 'fetch', '__luciumCopyInstalled', '__luciumManifest', '__luciumDevToolsSpared']) delete g[name]
  vi.restoreAllMocks()
})

describe('the name `browser` in an extension', () => {
  afterEach(() => {
    delete g['browser']
  })

  // The engine makes an object of `browser` of its own before the library adds its APIs to `chrome`: uBlock Origin Lite reads `browser.commands`, which
  // that object lacks, and its worker never starts.
  it('answers with chrome itself, so that what the library added is there too, where the engine made a browser of its own', async () => {
    const run = await injected()
    const lib = library({ manifest_version: 3, permissions: [] })
    g['browser'] = { runtime: lib.chrome.runtime }
    lib.chrome['commands'] = { onCommand: { addListener: vi.fn() } }
    runBothPasses(run, lib.chrome)
    expect(g['browser']).toBe(lib.chrome)
    expect(g['browser'].commands.onCommand.addListener).toBeTypeOf('function')
  })

  it('is left undefined where the engine has none: an extension that looks for it to tell a Firefox wraps chrome itself', async () => {
    const run = await injected()
    const lib = library({ manifest_version: 3, permissions: [] })
    runBothPasses(run, lib.chrome)
    expect(g['browser']).toBeUndefined()
  })
})

describe('chrome.tabs: what the library leaves out', () => {
  const setup = async (open?: Array<ReturnType<typeof tab>>) => {
    const run = await injected()
    const lib = library({ manifest_version: 3, permissions: ['tabs', 'scripting'] }, open)
    runBothPasses(run, lib.chrome)
    return lib
  }

  it('getSelected answers the tab on screen, in the current window or in the one asked for', async () => {
    const { chrome, tabs } = await setup()
    expect(await chrome.tabs.getSelected()).toMatchObject({ id: 1 })
    expect(tabs.query).toHaveBeenLastCalledWith({ active: true, currentWindow: true })
    await chrome.tabs.getSelected(7)
    expect(tabs.query).toHaveBeenLastCalledWith({ active: true, windowId: 7 })
  })

  it('duplicate opens a copy of the address right after the tab, in front, and says why when the address is not readable', async () => {
    const { chrome, tabs } = await setup([tab(1, { active: true, index: 4, windowId: 3 }), tab(2, { url: undefined })])
    expect(await chrome.tabs.duplicate(1)).toMatchObject({ url: 'https://site1.example/', windowId: 3, index: 5, active: true })
    expect(tabs.create).toHaveBeenCalledWith({ url: 'https://site1.example/', windowId: 3, index: 5, active: true })
    await expect(chrome.tabs.duplicate(2)).rejects.toThrow('its address is not available')
    expect(tabs.create).toHaveBeenCalledTimes(1)
  })

  it('works with a callback too, and reports a failure through runtime.lastError as the API does', async () => {
    const { chrome } = await setup()
    const answer = await new Promise((resolve) => chrome.tabs.duplicate(1, resolve))
    expect(answer).toMatchObject({ id: 99 })
    const failure = await new Promise((resolve) => {
      chrome.tabs.duplicate(404, () => resolve(chrome.runtime.lastError))
    })
    expect(failure).toEqual({ message: 'No tab with id: 404.' })
  })

  it('move changes nothing, says so, and hands the tabs back as they are', async () => {
    const { chrome, tabs } = await setup()
    expect(await chrome.tabs.move(2, { index: 0 })).toMatchObject({ id: 2, index: 1 })
    expect(await chrome.tabs.move([1, 3], { index: 0 })).toEqual([expect.objectContaining({ id: 1 }), expect.objectContaining({ id: 3 })])
    expect(tabs.update).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('does not reorder'))
  })

  it('highlight shows the first tab asked for (a position in the window) and answers with the window', async () => {
    const { chrome, tabs, windows } = await setup()
    expect(await chrome.tabs.highlight({ tabs: [2, 0], windowId: 1 })).toEqual({ id: 1, options: { populate: true } })
    expect(tabs.update).toHaveBeenCalledWith(3, { active: true })
    expect(windows.get).toHaveBeenCalledWith(1, { populate: true })
    await expect(chrome.tabs.highlight({ tabs: 9 })).rejects.toThrow('No tab at index: 9.')
  })

  it('detectLanguage reads the language the page declares, and says "und" as the API does when it cannot', async () => {
    const { chrome, scripting } = await setup()
    expect(await chrome.tabs.detectLanguage(2)).toBe('fr-fr')
    expect(scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ target: { tabId: 2 } }))
    expect(await chrome.tabs.detectLanguage()).toBe('fr-fr')
    expect(scripting.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ target: { tabId: 1 } }))
    scripting.executeScript.mockResolvedValueOnce([{ result: '' }])
    expect(await chrome.tabs.detectLanguage(2)).toBe('und')
    scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page.'))
    expect(await chrome.tabs.detectLanguage(2)).toBe('und')
  })

  it('leaves alone what the library already has', async () => {
    const run = await injected()
    const lib = library({ manifest_version: 3, permissions: ['tabs'] })
    const own = vi.fn()
    lib.chrome['tabs'].duplicate = own
    runBothPasses(run, lib.chrome)
    expect(lib.chrome['tabs'].duplicate).toBe(own)
  })
})

describe('chrome.extension', () => {
  it('says no to private windows and file: pages, as a browser with neither does, in both forms of the call', async () => {
    const run = await injected()
    const { chrome } = library({ manifest_version: 3, permissions: [] })
    runBothPasses(run, chrome)
    expect(await chrome.extension.isAllowedIncognitoAccess()).toBe(false)
    expect(await new Promise((resolve) => chrome.extension.isAllowedFileSchemeAccess(resolve))).toBe(false)
  })
})

describe('chrome.contextMenus.update', () => {
  it('is handed to the main process, for an extension that has the permission', async () => {
    const run = await injected()
    const { chrome, bridge } = library({ manifest_version: 3, permissions: ['contextMenus'] })
    runBothPasses(run, chrome)
    bridge.call.mockResolvedValueOnce(undefined)
    await chrome.contextMenus.update('save', { title: 'Saved' })
    expect(bridge.call).toHaveBeenCalledWith(ID, 'contextMenus', 'update', ['save', { title: 'Saved' }])
  })

  it('hands the refusal of the main process (no such item) to the extension, without the prefix of the IPC layer', async () => {
    const run = await injected()
    const { chrome, bridge } = library({ manifest_version: 3, permissions: ['contextMenus'] })
    runBothPasses(run, chrome)
    bridge.call.mockRejectedValueOnce(new Error("Error invoking remote method 'lucium-shim': Error: Cannot find menu item with id nope"))
    await expect(chrome.contextMenus.update('nope', {})).rejects.toThrow(/^Cannot find menu item with id nope$/)
  })

  it('is not touched for an extension without the permission: it has no chrome.contextMenus of its own to change', async () => {
    const run = await injected()
    const { chrome, contextMenus } = library({ manifest_version: 3, permissions: ['tabs'] })
    const libraryUpdate = contextMenus.update
    runBothPasses(run, chrome)
    expect(chrome.contextMenus.update).toBe(libraryUpdate)
  })
})

describe('chrome.action.setIcon with an image', () => {
  /** What a service worker has to draw: OffscreenCanvas and FileReader. The picture is a PNG of as many bytes as it is wide. */
  const draw = () => {
    g['OffscreenCanvas'] = class {
      constructor(public width: number) {}
      getContext() {
        return { putImageData: vi.fn() }
      }
      async convertToBlob() {
        return { size: this.width }
      }
    }
    g['FileReader'] = class {
      result: unknown
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL(blob: { size: number }) {
        this.result = `data:image/png;base64,${'A'.repeat(blob.size)}`
        queueMicrotask(() => this.onload?.())
      }
    }
  }
  const image = (width: number) => ({ width, height: width, data: new Uint8ClampedArray(width * width * 4) })

  const setup = async () => {
    draw()
    const run = await injected()
    const lib = library({ manifest_version: 3, permissions: [], action: {} })
    const original = lib.action.setIcon
    runBothPasses(run, lib.chrome)
    return { ...lib, original }
  }

  it('hands the library the pictures as data URLs in `path`, the one field it lets through, and the tab with them', async () => {
    const { chrome, original } = await setup()
    await chrome.action.setIcon({ imageData: { 16: image(16), 32: image(32) }, tabId: 5 })
    expect(original).toHaveBeenCalledWith({ tabId: 5, path: { 16: `data:image/png;base64,${'A'.repeat(16)}`, 32: `data:image/png;base64,${'A'.repeat(32)}` } })
  })

  it('takes a single picture as well as a set of sizes', async () => {
    const { chrome, original } = await setup()
    await chrome.action.setIcon({ imageData: image(19) })
    expect(original).toHaveBeenCalledWith({ path: { 19: `data:image/png;base64,${'A'.repeat(19)}` } })
  })

  it('passes a path of the extension\'s own files through as it was, in either form of the call', async () => {
    const { chrome, original } = await setup()
    await chrome.action.setIcon({ path: { 16: 'icon16.png' } })
    expect(original).toHaveBeenCalledWith({ path: { 16: 'icon16.png' } })
    await new Promise((resolve) => chrome.action.setIcon({ path: 'icon.png' }, resolve))
    expect(original).toHaveBeenLastCalledWith({ path: 'icon.png' })
  })

  it('fails the call, not the extension, when the picture cannot be drawn', async () => {
    const { chrome, original } = await setup()
    g['OffscreenCanvas'] = class {
      getContext() {
        throw new Error('no context')
      }
    }
    await expect(chrome.action.setIcon({ imageData: image(16) })).rejects.toThrow('no context')
    expect(original).not.toHaveBeenCalled()
  })
})


describe('the paste of a content script, in the worker of the extension', () => {
  const PORT = '__lucium-paste'
  /** The port a content script opens: who it is, where it runs, and the handler the worker puts on its messages. */
  const port = (over: Record<string, unknown> = {}) => {
    const handlers: Array<(message: unknown) => void> = []
    return { handlers, port: { name: PORT, sender: { id: ID, tab: { id: 7 }, url: 'https://example.org/' }, disconnect: vi.fn(), onMessage: { addListener: (fn: (message: unknown) => void) => void handlers.push(fn) }, ...over } }
  }
  const worker = async (permissions: string[]) => {
    const run = await injected()
    const lib = library({ manifest_version: 3, permissions })
    runBothPasses(run, lib.chrome)
    return { ...lib, listener: lib.onConnect.addListener.mock.calls[0]?.[0] as ((port: unknown) => void) | undefined }
  }

  it('asks the main process to paste into the tab the port comes from, for an extension that holds clipboardRead', async () => {
    const { listener, bridge } = await worker(['clipboardRead'])
    const p = port()
    listener!(p.port)
    p.handlers[0]!({ type: 'paste' })
    expect(bridge.call).toHaveBeenCalledWith(ID, 'clipboard', 'paste', [7])
  })

  it('hears the one kind of message it is sent, and no port of another name', async () => {
    const { listener, bridge } = await worker(['clipboardRead'])
    const p = port()
    listener!(p.port)
    for (const message of [{ type: 'copy' }, {}, null, 'paste', { type: 'paste', tabId: 99 }]) p.handlers[0]!(message)
    expect(bridge.call).toHaveBeenCalledTimes(1)
    expect(bridge.call).toHaveBeenCalledWith(ID, 'clipboard', 'paste', [7])
    const other = port({ name: 'clipboard-channel' })
    listener!(other.port)
    expect(other.handlers).toHaveLength(0)
    expect(other.port.disconnect).not.toHaveBeenCalled()
  })

  it('closes a port that is not a content script of one of its own tabs, and pastes nothing for it', async () => {
    const { listener, bridge } = await worker(['clipboardRead'])
    for (const sender of [{ id: 'ponmlkjihgfedcbaponmlkjihgfedcba', tab: { id: 7 }, url: 'https://example.org/' }, { id: ID, url: 'https://example.org/' }, { id: ID, tab: { id: 7 }, url: `chrome-extension://${ID}/popup.html` }, { id: ID, tab: {}, url: 'https://example.org/' }, undefined]) {
      const p = port({ sender })
      listener!(p.port)
      expect(p.port.disconnect, JSON.stringify(sender)).toHaveBeenCalled()
      expect(p.handlers).toHaveLength(0)
    }
    expect(bridge.call).not.toHaveBeenCalled()
  })

  it('says why when the main process refuses, and goes on', async () => {
    const { listener, bridge } = await worker(['clipboardRead'])
    bridge.call.mockRejectedValueOnce(new Error('Cannot paste into this tab: the extension needs a host permission for its address.'))
    const p = port()
    listener!(p.port)
    p.handlers[0]!({ type: 'paste' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('the paste of a content script failed'), expect.stringContaining('host permission'))
  })

  it('is not listened for without the permission, nor in a page of the extension (a port reaches every page that listens: each would paste once more)', async () => {
    expect((await worker(['storage'])).listener).toBeUndefined()
    g['document'] = {}
    expect((await worker(['clipboardRead'])).listener).toBeUndefined()
  })
})

/** The little of a document the copy command touches, with Electron's answer for the commands: false. */
function fakePage(over: { native?: (command: string) => boolean; selection?: { text: string; html?: string }; active?: Record<string, unknown> } = {}) {
  const dispatched: Array<{ type: string; clipboardData: { setData(type: string, value: string): void; getData(type: string): string }; defaultPrevented: boolean }> = []
  const natives: string[] = []
  class FakeDataTransfer {
    private readonly store = new Map<string, string>()
    setData(type: string, value: string) {
      this.store.set(type, value)
    }
    getData(type: string) {
      return this.store.get(type) ?? ''
    }
  }
  class FakeClipboardEvent {
    defaultPrevented = false
    clipboardData: FakeDataTransfer
    constructor(
      public type: string,
      init: { clipboardData: FakeDataTransfer }
    ) {
      this.clipboardData = init.clipboardData
    }
    preventDefault() {
      this.defaultPrevented = true
    }
  }
  class FakeDocument {}
  const proto = FakeDocument.prototype as Record<string, unknown>
  proto['execCommand'] = function (command: string) {
    natives.push(command)
    return over.native ? over.native(command) : false
  }
  proto['queryCommandEnabled'] = () => false
  proto['queryCommandSupported'] = () => false
  const handlers: Array<(event: any) => void> = []
  const body = { tagName: 'BODY', dispatchEvent: (event: any) => handlers.forEach((handler) => handler(event)) }
  const selection = over.selection
  g['Document'] = FakeDocument
  g['DataTransfer'] = FakeDataTransfer
  g['ClipboardEvent'] = FakeClipboardEvent
  g['document'] = Object.assign(new FakeDocument(), {
    body,
    activeElement: over.active ?? body,
    createElement: () => ({ innerHTML: '', appendChild(node: string) { this.innerHTML += node } })
  })
  g['getSelection'] = () => (selection ? { toString: () => selection.text, rangeCount: selection.html === undefined ? 0 : 1, getRangeAt: () => ({ cloneContents: () => selection.html }) } : null)
  return { doc: g['document'] as any, natives, dispatched, onCopy: (handler: (event: any) => void) => void handlers.push(handler) }
}

describe('the copy command in a page of the extension', () => {
  const page = async (permissions: string[]) => {
    const run = await injected()
    const lib = library({ manifest_version: 3, permissions })
    return { run, lib }
  }
  const started = async (permissions: string[], over: Parameters<typeof fakePage>[0] = {}) => {
    // A new page: a new world, where nothing was installed yet.
    delete g['__luciumCopyInstalled']
    const dom = fakePage(over)
    const { run, lib } = await page(permissions)
    runBothPasses(run, lib.chrome)
    return { ...dom, bridge: lib.bridge }
  }

  it('puts on the clipboard what a handler of the copy event gave, where the browser refuses the command (MerciApp\'s offscreen document)', async () => {
    const { doc, bridge, onCopy } = await started(['clipboardWrite'])
    onCopy((event) => {
      event.clipboardData.setData('text/html', '<p>nouveau</p>')
      event.clipboardData.setData('text/plain', 'nouveau')
      event.preventDefault()
    })
    expect(doc.execCommand('copy')).toBe(true)
    expect(bridge.call).toHaveBeenCalledWith(ID, 'clipboard', 'write', [{ text: 'nouveau', html: '<p>nouveau</p>' }])
  })

  it('copies the selection when no handler took the event over, a field\'s as well as the page\'s', async () => {
    const page1 = await started(['clipboardWrite'], { selection: { text: 'choisi', html: '<i>choisi</i>' } })
    expect(page1.doc.execCommand('copy')).toBe(true)
    expect(page1.bridge.call).toHaveBeenCalledWith(ID, 'clipboard', 'write', [{ text: 'choisi', html: '<i>choisi</i>' }])
    const field = { tagName: 'TEXTAREA', value: 'un texte dans un champ', selectionStart: 3, selectionEnd: 8, dispatchEvent: () => true }
    const page2 = await started(['clipboardWrite'], { active: field, selection: { text: 'ignoré' } })
    page2.doc.execCommand('copy')
    expect(page2.bridge.call).toHaveBeenCalledWith(ID, 'clipboard', 'write', [{ text: 'texte', html: '' }])
  })

  it('cuts: the same, and what was selected is deleted afterwards', async () => {
    const { doc, bridge, natives } = await started(['clipboardWrite'], { selection: { text: 'coupé', html: 'coupé' } })
    expect(doc.execCommand('cut')).toBe(true)
    expect(bridge.call).toHaveBeenCalledWith(ID, 'clipboard', 'write', [{ text: 'coupé', html: 'coupé' }])
    expect(natives).toEqual(['cut', 'delete'])
  })

  it('says it did nothing when there is nothing to copy', async () => {
    const { doc, bridge } = await started(['clipboardWrite'], { selection: { text: '' } })
    expect(doc.execCommand('copy')).toBe(false)
    expect(bridge.call).not.toHaveBeenCalled()
  })

  it('leaves the browser\'s own command alone where it is allowed (a click of the user), and every other command', async () => {
    const { doc, bridge } = await started(['clipboardWrite'], { native: (command) => command !== 'bold', selection: { text: 'x' } })
    expect(doc.execCommand('copy')).toBe(true)
    expect(bridge.call).not.toHaveBeenCalled()
    expect(doc.execCommand('bold')).toBe(false)
    expect(bridge.call).not.toHaveBeenCalled()
  })

  it('says the commands are there and enabled, and leaves the answer of the others', async () => {
    const { doc } = await started(['clipboardWrite'])
    expect(doc.queryCommandEnabled('copy')).toBe(true)
    expect(doc.queryCommandSupported('CUT')).toBe(true)
    expect(doc.queryCommandEnabled('paste')).toBe(false)
    expect(doc.queryCommandSupported('bold')).toBe(false)
  })

  it('is not set up without clipboardWrite, and only once whatever the number of passes', async () => {
    const without = await started(['clipboardRead'], { selection: { text: 'x' } })
    expect(without.doc.execCommand('copy')).toBe(false)
    expect(without.bridge.call).not.toHaveBeenCalled()
    const dom = fakePage({ selection: { text: 'y' } })
    const { run, lib } = await page(['clipboardWrite'])
    runBothPasses(run, lib.chrome)
    const installed = g['Document'].prototype.execCommand
    run()
    // Another run of the shims in the same world (a second preload) does not put a second wrapper over the first.
    expect(g['Document'].prototype.execCommand).toBe(installed)
    dom.doc.execCommand('copy')
    expect(lib.bridge.call).toHaveBeenCalledTimes(1)
  })

  it('says why when the main process cannot put it on the clipboard', async () => {
    const { doc, bridge } = await started(['clipboardWrite'], { selection: { text: 'x' } })
    bridge.call.mockRejectedValueOnce(new Error('This is too much to put on the clipboard.'))
    doc.execCommand('copy')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('the copy of an extension page failed'), 'This is too much to put on the clipboard.')
  })
})

describe('a document of the extension made without context isolation (an offscreen one)', () => {
  /** What loads the preload there: no isolation, a `chrome.runtime` without `getManifest`, and the address of the document. */
  async function offscreen(manifest: unknown, fetchFails = false) {
    vi.resetModules()
    const dom = fakePage({ selection: { text: 'copié' } })
    g['location'] = { href: `chrome-extension://${ID}/offscreen-clipboard.html` }
    g['chrome'] = { runtime: { id: ID } }
    g['fetch'] = vi.fn(async (url: string) => {
      if (fetchFails) throw new Error('Failed to fetch')
      return { json: async () => manifest, url }
    })
    proc.type = undefined
    proc.contextIsolated = false
    ipcRenderer.invoke.mockReset()
    ipcRenderer.invoke.mockResolvedValue(undefined)
    await import('./extension-shims')
    await new Promise((resolve) => setTimeout(resolve, 0))
    return dom
  }

  it('reads the manifest by its address and gets the copy command, with a bridge that is a plain object', async () => {
    const { doc } = await offscreen({ manifest_version: 3, permissions: ['clipboardWrite', 'offscreen'] })
    expect(g['fetch']).toHaveBeenCalledWith(`chrome-extension://${ID}/manifest.json`)
    expect(doc.execCommand('copy')).toBe(true)
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('lucium-shim', ID, 'clipboard', 'write', [{ text: 'copié', html: '' }])
  })

  it('gets nothing of the other shims, nor the copy command without clipboardWrite', async () => {
    const { doc } = await offscreen({ manifest_version: 3, permissions: ['offscreen', 'sidePanel', 'tabGroups'] })
    expect(doc.execCommand('copy')).toBe(false)
    expect(ipcRenderer.invoke).not.toHaveBeenCalled()
    expect(g['chrome'].sidePanel).toBeUndefined()
    expect(g['chrome'].tabGroups).toBeUndefined()
  })

  it('says why when the manifest cannot be read, and the document goes on without the command', async () => {
    const { doc } = await offscreen({}, true)
    expect(doc.execCommand('copy')).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('its copy command is not set up'), 'Failed to fetch')
  })
})

describe('the background page of a Manifest V2 extension, made without context isolation', () => {
  type Relay = (event: unknown, api: string, name: string, args: unknown[]) => void
  /** Loads the preload in the page twice, as Electron does (before and after the library, which freezes `chrome`), and answers what the page's script reaches. */
  async function backgroundPage(path: string, manifest: Record<string, unknown>) {
    g['location'] = { href: `chrome-extension://${ID}${path}` }
    const native = { addListener: vi.fn() }
    const chrome: Record<string, any> = { runtime: { id: ID, getManifest: () => manifest }, webRequest: { onBeforeRequest: native, onHeadersReceived: native }, storage: {} }
    g['chrome'] = chrome
    g['fetch'] = vi.fn(async () => ({ json: async () => manifest }))
    proc.type = undefined
    proc.contextIsolated = false
    ipcRenderer.invoke.mockReset()
    ipcRenderer.invoke.mockResolvedValue(undefined)
    ipcRenderer.on.mockReset()
    g['__luciumBridged'] = undefined
    vi.resetModules()
    await import('./extension-shims')
    Object.freeze(chrome)
    vi.resetModules()
    await import('./extension-shims')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const relays = ipcRenderer.on.mock.calls.filter(([channel]) => channel === 'lucium-shim-event').map(([, relay]) => relay as Relay)
    const calls = (method: string): unknown[][] => ipcRenderer.invoke.mock.calls.filter((call) => call[2] === 'webRequest' && call[3] === method).map((call) => call[4] as unknown[])
    return { chrome, native, relays, calls }
  }
  const blocking = { manifest_version: 2, background: { scripts: ['background.js'], persistent: true }, permissions: ['webRequest', 'webRequestBlocking', 'http://127.0.0.1/*'] }
  afterEach(() => {
    delete g['__luciumBridged']
    delete g['__luciumSenderFixed']
  })

  // Guard: the browser never calls the listeners of the background page (the hooks of the session come first), so without the shims there its blocking
  // listeners hear nothing and answer nothing.
  it('registers its blocking listener of chrome.webRequest with the main process, not the browser, and answers the request it is asked about', async () => {
    const { chrome, native, relays, calls } = await backgroundPage('/_generated_background_page.html', blocking)
    chrome.webRequest.onBeforeRequest.addListener((details: { url: string }) => (details.url.endsWith('/cancel') ? { cancel: true } : undefined), { urls: ['http://127.0.0.1/mv2bp/*'] }, ['blocking'])
    expect(native.addListener).not.toHaveBeenCalled()
    expect(calls('listen')).toEqual([['onBeforeRequest', { urls: ['http://127.0.0.1/mv2bp/*'], types: undefined, tabId: undefined }, ['blocking'], true]])
    expect(relays.length).toBeGreaterThan(0)
    for (const relay of relays) relay({}, 'webRequest', 'onBeforeRequest', [{ url: 'http://127.0.0.1:5000/mv2bp/cancel', type: 'xmlhttprequest', tabId: 3 }, { ask: 't1' }])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(calls('answer')).toEqual([['t1', [{ cancel: true }]]])
  })

  it('is told by its address: the page the manifest names gets the shims too, and no other page of the extension does', async () => {
    const named = await backgroundPage('/bg.html', { ...blocking, background: { page: 'bg.html' } })
    named.chrome.webRequest.onBeforeRequest.addListener(() => undefined, { urls: ['<all_urls>'] }, ['blocking'])
    expect(named.calls('listen')).toHaveLength(1)
    const other = await backgroundPage('/popup.html', blocking)
    other.chrome.webRequest.onBeforeRequest.addListener(() => undefined, { urls: ['<all_urls>'] }, ['blocking'])
    expect(other.calls('listen')).toEqual([])
    expect(other.native.addListener).toHaveBeenCalled()
  })
})

describe('the events of the extension platform that a worker registers as it starts and that nobody defines', () => {
  const setup = async (permissions: string[], extras: Record<string, unknown> = {}) => {
    const run = await injected()
    const lib = library({ manifest_version: 3, permissions })
    Object.assign(lib.chrome, extras)
    runBothPasses(run, lib.chrome)
    return lib.chrome
  }
  const notifications = () => ({ create: vi.fn(), clear: vi.fn() })
  const management = () => ({ getSelf: vi.fn() })

  it('exist on notifications and management, take listeners and never call them', async () => {
    const chrome = await setup(['notifications'], { notifications: notifications(), management: management() })
    for (const event of [chrome.notifications.onShowSettings, chrome.notifications.onPermissionLevelChanged, chrome.management.onInstalled, chrome.management.onUninstalled, chrome.management.onEnabled, chrome.management.onDisabled]) {
      const listener = vi.fn()
      event.addListener(listener)
      expect(event.hasListener(listener)).toBe(true)
      expect(event.hasListeners()).toBe(true)
      event.removeListener(listener)
      expect(event.hasListeners()).toBe(false)
      expect(listener).not.toHaveBeenCalled()
    }
  })

  it('are not made up for an extension that has no notifications (the library does not give it the API either)', async () => {
    const chrome = await setup([], { management: management() })
    expect(chrome.notifications).toBeUndefined()
    expect(typeof chrome.management.onInstalled.addListener).toBe('function')
  })

  it('leave an event that exists alone', async () => {
    const own = { addListener: vi.fn() }
    const chrome = await setup([], { management: { ...management(), onInstalled: own } })
    expect(chrome.management.onInstalled).toBe(own)
  })

  it('say why when an event cannot be defined, and the others still are', async () => {
    const sealed = Object.freeze({ getSelf: vi.fn() })
    const chrome = await setup(['notifications'], { notifications: notifications(), management: sealed })
    expect(chrome.management.onInstalled).toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('chrome.management.onInstalled could not be defined'), expect.any(String))
    expect(typeof chrome.notifications.onShowSettings.addListener).toBe('function')
  })
})

describe('Object.defineProperty, held back while the library defines the namespaces an extension has no permission for', () => {
  const native = Object.defineProperty
  afterEach(() => {
    Object.defineProperty = native
  })

  it('keeps such a namespace out of chrome during the script of the library, and is the page\'s own again after the second pass', async () => {
    const run = await injected()
    const { chrome } = library({ manifest_version: 3, permissions: [] })
    run()
    expect(Object.defineProperty).not.toBe(native)
    Object.defineProperty(chrome, 'cookies', { value: {}, configurable: true })
    expect(chrome['cookies']).toBeUndefined()
    const other: Record<string, unknown> = {}
    Object.defineProperty(other, 'cookies', { value: 1 })
    expect(other['cookies']).toBe(1)
    Object.freeze(chrome)
    run()
    expect(Object.defineProperty).toBe(native)
  })

  it('is given back whole when the first pass ran twice: the script of the library stopped before it froze chrome', async () => {
    const run = await injected()
    const { chrome } = library({ manifest_version: 3, permissions: [] })
    run()
    run()
    Object.freeze(chrome)
    run()
    expect(Object.defineProperty).toBe(native)
  })

  it('gives itself back at the first call after the library froze chrome, when no second pass comes', async () => {
    const run = await injected()
    const { chrome } = library({ manifest_version: 3, permissions: [] })
    run()
    Object.freeze(chrome)
    const other: Record<string, unknown> = {}
    Object.defineProperty(other, 'a', { value: 1 })
    expect(other['a']).toBe(1)
    expect(Object.defineProperty).toBe(native)
  })
})

describe('a page of the extension shown by the DevTools (its devtools_page and its panels)', () => {
  // The library freezes `chrome` at the end of its preload; Chromium adds `chrome.devtools` after the preloads. Run for real: the preload, then the library's freeze, then Chromium.
  const original = Object.freeze

  /** Loads the preload in a frame whose parent is `ancestor`, the way the library and Chromium follow it. Returns `chrome` once the library has frozen it (or tried to). */
  async function inFrame(ancestors: string[]): Promise<Record<string, any>> {
    vi.resetModules()
    g['location'] = { href: `chrome-extension://${ID}/devtools.html`, ancestorOrigins: ancestors }
    const chrome: Record<string, any> = { runtime: { id: ID } }
    g['chrome'] = chrome
    g['fetch'] = vi.fn(async () => ({ json: async () => ({ manifest_version: 3, permissions: [] }) }))
    proc.type = undefined
    proc.contextIsolated = false
    ipcRenderer.invoke.mockReset()
    await import('./extension-shims')
    await new Promise((resolve) => setTimeout(resolve, 0))
    Object.freeze(chrome) // the library's script, which ends with this
    return chrome
  }

  afterEach(() => {
    Object.freeze = original
  })

  it('is left able to receive chrome.devtools: the freeze of the library does not reach `chrome`', async () => {
    const chrome = await inFrame(['devtools://devtools'])
    expect(Object.isFrozen(chrome)).toBe(false)
    chrome['devtools'] = { inspectedWindow: {} } // what Chromium does next
    expect(chrome['devtools']).toBeDefined()
  })

  it('spares that one freeze only: the next call of Object.freeze is the page\'s own again', async () => {
    await inFrame(['devtools://devtools'])
    const other = { a: 1 }
    Object.freeze(other)
    expect(Object.isFrozen(other)).toBe(true)
    expect(Object.freeze).toBe(original)
  })

  it('does it once when the preload runs a second time in the frame (it is registered before and after the library)', async () => {
    const chrome = await inFrame(['devtools://devtools'])
    vi.resetModules()
    await import('./extension-shims')
    await new Promise((resolve) => setTimeout(resolve, 0))
    // No wrapper is left behind to spare a later freeze of `chrome` for no reason.
    expect(Object.freeze).toBe(original)
    expect(Object.isFrozen(chrome)).toBe(false)
  })

  it('leaves every other page as it was: an extension page in a tab, or in an iframe of a web page, still gets its `chrome` frozen', async () => {
    expect(Object.isFrozen(await inFrame([]))).toBe(true)
    expect(Object.isFrozen(await inFrame(['https://example.com']))).toBe(true)
  })
})

describe('chrome.management.getAll', () => {
  const setup = async (permissions: string[], management: Record<string, unknown> | undefined = { getSelf: vi.fn() }) => {
    const run = await injected()
    const lib = library({ manifest_version: 3, permissions })
    if (management) lib.chrome['management'] = management
    runBothPasses(run, lib.chrome)
    return lib
  }

  it('is asked of the main process, with a promise and with a callback, for an extension that holds "management"', async () => {
    const { chrome, bridge } = await setup(['management'])
    bridge.call.mockResolvedValue([{ id: 'x' }])
    expect(await chrome.management.getAll()).toEqual([{ id: 'x' }])
    expect(bridge.call).toHaveBeenCalledWith(ID, 'management', 'getAll', [])
    const callback = vi.fn()
    chrome.management.getAll(callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith([{ id: 'x' }]))
  })

  it('does not exist for an extension without the permission', async () => {
    const { chrome } = await setup(['storage'])
    expect(chrome.management.getAll).toBeUndefined()
  })

  it('leaves a getAll that exists alone', async () => {
    const own = vi.fn()
    const { chrome } = await setup(['management'], { getAll: own })
    expect(chrome.management.getAll).toBe(own)
  })

  it('is defined with its namespace when the platform has none', async () => {
    const { chrome } = await setup(['management'], undefined)
    expect(typeof chrome.management.getAll).toBe('function')
  })
})

describe('chrome.sessions', () => {
  const setup = async (permissions: string[]) => {
    const run = await injected()
    const lib = library({ manifest_version: 3, permissions })
    runBothPasses(run, lib.chrome)
    return lib
  }

  it('is asked of the main process, with a promise and with a callback, for an extension that holds "sessions"', async () => {
    const { chrome, bridge } = await setup(['sessions'])
    bridge.call.mockResolvedValue([{ lastModified: 1 }])
    expect(await chrome.sessions.getRecentlyClosed({ maxResults: 3 })).toEqual([{ lastModified: 1 }])
    expect(bridge.call).toHaveBeenCalledWith(ID, 'sessions', 'getRecentlyClosed', [{ maxResults: 3 }])
    const callback = vi.fn()
    chrome.sessions.restore('a1', callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalled())
    expect(bridge.call).toHaveBeenCalledWith(ID, 'sessions', 'restore', ['a1'])
    expect(chrome.sessions.MAX_SESSION_RESULTS).toBe(25)
    expect(typeof chrome.sessions.onChanged.addListener).toBe('function')
  })

  it('does not exist for an extension without the permission', async () => {
    expect((await setup(['storage'])).chrome.sessions).toBeUndefined()
  })
})
