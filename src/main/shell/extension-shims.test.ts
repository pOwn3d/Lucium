import { beforeEach, describe, expect, it, vi } from 'vitest'
import { panelProfile } from '@shared/sidepanel'

// The window that has the focus, for the tests that need one (none by default).
const focus = vi.hoisted(() => ({ window: null as { id: number; getParentWindow?: () => { id: number } | null } | null }))

// The shims are written against Electron's main process; what they need of it here is a place for the data folder and a quit event.
vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent/lucium-test', once: () => {}, on: () => {} },
  BrowserWindow: { getFocusedWindow: () => focus.window }
}))

// The real lookup of the registry, watched: what it is asked for, and under which switch, is what these tests read.
vi.mock('./native-messaging-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./native-messaging-registry')>()
  return { ...actual, registeredManifests: vi.fn(actual.registeredManifests) }
})

const { ExtensionShims } = await import('./extension-shims')
const { registeredManifests } = await import('./native-messaging-registry')

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

interface Rig {
  shims: InstanceType<typeof ExtensionShims>
  engine: Record<string, any>
  browser: Record<string, any>
  page: Record<string, any>
  goneListener: () => (gone: { context?: string; extensionId?: string; profileId?: string }) => void
  held: { acquired: number; released: number }
  emitted: Array<{ extensionId: string; api: string; event: string; args: unknown[] }>
  setState(patch: Record<string, unknown>): void
  download(info: Record<string, unknown>, profileId?: string): void
  attachArgs: { allowUrl?: (url: string) => boolean; onEvent?: (m: string, p: unknown) => void; onDetach?: (r: string) => void }
}

function rig(): Rig {
  const held = { acquired: 0, released: 0 }
  const emitted: Rig['emitted'] = []
  let onGone: (gone: { context?: string; extensionId?: string; profileId?: string }) => void = () => {}
  let onDownload: (info: any, source: string | undefined, profileId: string) => void = () => {}
  const attachArgs: Rig['attachArgs'] = {}
  const behaviour = { throwOnAttach: false }
  const page = {
    isDebugAttached: vi.fn(() => false),
    debugAttach: vi.fn((_version: string, onEvent: (m: string, p: unknown) => void, onDetach: (r: string) => void, allowUrl: (url: string) => boolean) => {
      if (behaviour.throwOnAttach) throw new Error('Cannot attach to this target.')
      Object.assign(attachArgs, { onEvent, onDetach, allowUrl })
    }),
    debugDetach: vi.fn(),
    debugSend: vi.fn(async () => ({ ok: true })),
    pasteIntoFocus: vi.fn()
  }
  const state: Record<string, any> = {
    settings: { chromeNativeHosts: false },
    sidePanelBehavior: {},
    activeSpaceId: 'sp-default',
    spaces: [
      { id: 'sp-default', profileId: 'default' },
      { id: 'sp-work', profileId: 'work' }
    ],
    tabs: [
      { id: 'page-1', spaceId: 'sp-default' },
      { id: 'page-2', spaceId: 'sp-work' }
    ],
    activeTabBySpace: { 'sp-default': 'page-1', 'sp-work': 'page-2' }
  }
  const engine = {
    setTabFactsProvider: () => {},
    onTabClosed: () => {},
    onDownload: (listener: typeof onDownload) => void (onDownload = listener),
    onContextGone: (listener: typeof onGone) => void (onGone = listener),
    pageIdOfTabNumber: (n: number) => (n === 7 || n === 8 ? `page-${n === 7 ? 1 : 2}` : undefined),
    profileOfTab: (n: number) => (n === 7 ? 'default' : n === 8 ? 'work' : undefined),
    tabNumberOf: (pageId: string) => (pageId === 'page-1' ? 7 : pageId === 'page-2' ? 8 : undefined),
    tabUrl: vi.fn((n: number) => (n === 7 ? 'https://shop.example/cart' : undefined)),
    listExtensions: () => [{ id: EXT }, { id: OTHER }],
    emitShimEvent: (extensionId: string, api: string, event: string, args: unknown[]) => void emitted.push({ extensionId, api, event, args }),
    holdWorker: () => {
      held.acquired++
      return () => void held.released++
    },
    notifyTabChanged: () => {},
    windowOfTab: () => 1,
    mayCaptureTab: vi.fn(() => false),
    mayReadTab: vi.fn(() => false),
    updateContextMenuItem: vi.fn(),
    mayActOnTab: vi.fn(() => true),
    writeClipboard: vi.fn(async () => undefined),
    clipboardSettled: vi.fn(async () => undefined)
  }
  // The panel is docked by the Browser of the window the request names; the main one and that one share the spy.
  const openSidePanel = vi.fn()
  // The profile of the space of the tab a panel opens for (the tab on screen when none is named), as Browser.profileForPanel answers it.
  const profileForPanel = (tabKey?: string): string | null => {
    const tab = tabKey ? state.tabs.find((t: any) => t.id === tabKey) : state.tabs.find((t: any) => t.id === state.activeTabBySpace[state.activeSpaceId])
    return panelProfile(state as never, tab, false)
  }
  const target = { openSidePanel, profileForPanel, activeTabFor: vi.fn((profileId: string) => (profileId === 'default' ? { id: 'page-1', url: 'https://shop.example/cart' } : null)), captureActiveFor: vi.fn(async (profileId: string) => (profileId === 'default' ? Buffer.from('png') : null)) }
  const browser = {
    pageFor: () => page,
    listTabTargets: () => [],
    dispatch: () => {},
    openSidePanel,
    browserOfWindow: () => target,
    windowId: () => 1,
    target
  }
  const store = { get: () => state }
  const shims = new ExtensionShims(browser as never, engine as never, store as never)
  return {
    shims,
    engine,
    browser,
    page,
    goneListener: () => onGone,
    held,
    emitted,
    setState: (patch: Record<string, unknown>) => void Object.assign(state, patch),
    download: (info: Record<string, unknown>, profileId = 'default') => onDownload(info, undefined, profileId),
    attachArgs
  } as unknown as Rig
}

const call = (r: Rig, api: string, method: string, args: unknown[], over: Partial<{ extensionId: string; profileId: string; context: string }> = {}) =>
  r.shims.handle({ extensionId: EXT, profileId: 'default', context: 'worker:1', api, method, args, ...over })

describe('chrome.debugger: where it may attach', () => {
  it('asks the page to allow only web pages, the blank page and the pages of the extension itself', async () => {
    const r = rig()
    await call(r, 'debugger', 'attach', [{ tabId: 7 }, '1.3'])
    const allow = r.attachArgs.allowUrl!
    expect(allow('https://shop.example/')).toBe(true)
    expect(allow('about:blank')).toBe(true)
    expect(allow(`chrome-extension://${EXT}/panel.html`)).toBe(true)
    expect(allow('file:///Users/me/.ssh/id_rsa')).toBe(false)
    expect(allow(`chrome-extension://${OTHER}/panel.html`)).toBe(false)
    expect(allow('chrome-error://chromewebdata/')).toBe(false)
    // The page of the Chrome Web Store is the one place a debugger could press "install" with.
    expect(allow('https://chromewebstore.google.com/detail/outil/abcdefghijklmnopabcdefghijklmnop')).toBe(false)
  })

  it('does not leave a tab "already attached" after an attach the page refused', async () => {
    const r = rig()
    r.page.debugAttach.mockImplementationOnce(() => {
      throw new Error('Cannot attach to this target.')
    })
    await expect(call(r, 'debugger', 'attach', [{ tabId: 7 }, '1.3'])).rejects.toThrow('Cannot attach to this target.')
    await expect(call(r, 'debugger', 'attach', [{ tabId: 7 }, '1.3'])).resolves.toBeUndefined()
    await expect(call(r, 'debugger', 'attach', [{ tabId: 7 }, '1.3'])).rejects.toThrow('Another debugger is already attached')
  })

  it('forgets the session when the page lets the extension go, and tells it', async () => {
    const r = rig()
    await call(r, 'debugger', 'attach', [{ tabId: 7 }, '1.3'])
    r.attachArgs.onDetach!('target_closed')
    expect(r.emitted.at(-1)).toMatchObject({ api: 'debugger', event: 'onDetach' })
    await expect(call(r, 'debugger', 'sendCommand', [{ tabId: 7 }, 'Runtime.evaluate', {}])).rejects.toThrow('not attached')
    await expect(call(r, 'debugger', 'attach', [{ tabId: 7 }, '1.3'])).resolves.toBeUndefined()
  })
})

describe('chrome.debugger: what it may send', () => {
  it('sends the commands that drive a page', async () => {
    const r = rig()
    await call(r, 'debugger', 'attach', [{ tabId: 7 }, '1.3'])
    await expect(call(r, 'debugger', 'sendCommand', [{ tabId: 7 }, 'Runtime.evaluate', { expression: '1' }])).resolves.toEqual({ ok: true })
    await expect(call(r, 'debugger', 'sendCommand', [{ tabId: 7 }, 'Page.navigate', { url: 'https://example.com/' }])).resolves.toEqual({ ok: true })
    expect(r.page.debugSend).toHaveBeenCalledTimes(2)
  })

  it('refuses a navigation to a local file, the Target and Browser domains and a download to a path, without sending them', async () => {
    const r = rig()
    await call(r, 'debugger', 'attach', [{ tabId: 7 }, '1.3'])
    for (const [method, params] of [
      ['Page.navigate', { url: 'file:///etc/passwd' }],
      ['Target.createTarget', { url: 'file:///etc/passwd' }],
      ['Browser.close', {}],
      ['Storage.getCookies', {}],
      ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }],
      ['DOM.setFileInputFiles', { files: ['/etc/passwd'], objectId: 'x' }]
    ] as const) {
      await expect(call(r, 'debugger', 'sendCommand', [{ tabId: 7 }, method, params]), method).rejects.toThrow('Not allowed')
    }
    expect(r.page.debugSend).not.toHaveBeenCalled()
  })

  it('does not tell the extension about the page of another extension that a web page embeds, and refuses to run code in it', async () => {
    const r = rig()
    await call(r, 'debugger', 'attach', [{ tabId: 7 }, '1.3'])
    r.emitted.length = 0
    r.attachArgs.onEvent!('Runtime.executionContextCreated', { context: { id: 4, origin: `chrome-extension://${OTHER}`, name: '', uniqueId: 'u4' } })
    r.attachArgs.onEvent!('Runtime.executionContextCreated', { context: { id: 5, origin: 'https://shop.example', name: '', uniqueId: 'u5' } })
    expect(r.emitted.map((e) => (e.args[2] as { context: { id: number } }).context.id)).toEqual([5])
    await expect(call(r, 'debugger', 'sendCommand', [{ tabId: 7 }, 'Runtime.evaluate', { expression: 'chrome.runtime.id', contextId: 4 }])).rejects.toThrow('Not allowed')
    // A context the page never reported is not named either; one it reported is.
    await expect(call(r, 'debugger', 'sendCommand', [{ tabId: 7 }, 'Runtime.evaluate', { expression: '1', contextId: 99 }])).rejects.toThrow('Not allowed')
    await expect(call(r, 'debugger', 'sendCommand', [{ tabId: 7 }, 'Runtime.evaluate', { expression: '1', contextId: 5 }])).resolves.toEqual({ ok: true })
  })

  it('lets the extension name the world it just created, which the page never reported', async () => {
    const r = rig()
    await call(r, 'debugger', 'attach', [{ tabId: 7 }, '1.3'])
    r.page.debugSend.mockResolvedValueOnce({ executionContextId: 12 } as never)
    await call(r, 'debugger', 'sendCommand', [{ tabId: 7 }, 'Page.createIsolatedWorld', { frameId: 'f' }])
    await expect(call(r, 'debugger', 'sendCommand', [{ tabId: 7 }, 'Runtime.evaluate', { expression: '1', contextId: 12 }])).resolves.toEqual({ ok: true })
    await expect(call(r, 'debugger', 'sendCommand', [{ tabId: 7 }, 'Page.createIsolatedWorld', { frameId: 'f', grantUniveralAccess: true }])).rejects.toThrow('Not allowed')
  })
})

describe('native ports and the context that opened them', () => {
  beforeEach(() => vi.useRealTimers())

  const connect = (r: Rig, portId: string, over: Partial<{ extensionId: string; profileId: string; context: string }> = {}) => call(r, 'nativeMessaging', 'connect', ['com.example.host', portId], over)

  it('looks in the registry for the hosts of Chrome only when the user allowed them (the switch of their folders)', async () => {
    const r = rig()
    vi.mocked(registeredManifests).mockClear()
    await connect(r, 'p1')
    await vi.waitFor(() => expect(registeredManifests).toHaveBeenCalledTimes(1))
    expect(vi.mocked(registeredManifests).mock.calls[0]![1]).toBe(false)
    r.setState({ settings: { chromeNativeHosts: true } })
    await connect(r, 'p2')
    await vi.waitFor(() => expect(registeredManifests).toHaveBeenCalledTimes(2))
    expect(vi.mocked(registeredManifests).mock.calls[1]![1]).toBe(true)
    expect(vi.mocked(registeredManifests).mock.calls[1]![0]).toBe('com.example.host')
  })

  it('closes the ports of a page or worker that is gone, and lets the worker they held go', async () => {
    const r = rig()
    await connect(r, 'p1', { context: 'frame:12' })
    await connect(r, 'p2', { context: 'frame:12' })
    await connect(r, 'p3', { context: 'frame:99' })
    expect(r.held).toEqual({ acquired: 1, released: 0 })
    r.goneListener()({ context: 'frame:12' })
    expect(r.held).toEqual({ acquired: 1, released: 0 })
    r.goneListener()({ context: 'frame:99' })
    expect(r.held).toEqual({ acquired: 1, released: 1 })
  })

  it('closes every port of an extension that was unloaded, in its profile only', async () => {
    const r = rig()
    await connect(r, 'p1', { context: 'worker:1' })
    await connect(r, 'p2', { context: 'worker:2', profileId: 'work' })
    r.goneListener()({ extensionId: EXT, profileId: 'default' })
    expect(r.held.released).toBe(1)
    r.goneListener()({ extensionId: EXT, profileId: 'work' })
    expect(r.held.released).toBe(2)
  })

  it('leaves the ports of other contexts and other extensions alone', async () => {
    const r = rig()
    await connect(r, 'p1', { context: 'worker:1' })
    r.goneListener()({ context: 'worker:2' })
    r.goneListener()({ extensionId: OTHER })
    expect(r.held.released).toBe(0)
  })
})

describe('chrome.sidePanel.open', () => {
  it('opens for the active tab only when that tab is in the profile of the extension', async () => {
    const r = rig()
    await call(r, 'sidePanel', 'open', [{ windowId: 1 }])
    expect(r.browser.openSidePanel).toHaveBeenCalledTimes(1)
    r.browser.openSidePanel.mockClear()
    // The user is in a space of the default profile: the extension of the "work" profile has no active tab there to open a panel for.
    await expect(call(r, 'sidePanel', 'open', [{ windowId: 1 }], { profileId: 'work' })).rejects.toThrow('no active tab in the profile of this extension')
    r.setState({ activeSpaceId: 'sp-work' })
    await expect(call(r, 'sidePanel', 'open', [{ windowId: 1 }])).rejects.toThrow('no active tab in the profile of this extension')
    expect(r.browser.openSidePanel).not.toHaveBeenCalled()
    await call(r, 'sidePanel', 'open', [{ windowId: 1 }], { profileId: 'work' })
    expect(r.browser.openSidePanel).toHaveBeenCalledTimes(1)
  })

  it('is refused over a private tab, with a reason of its own, although the tab is in a space of the profile of the extension', async () => {
    const r = rig()
    r.setState({ tabs: [{ id: 'page-1', spaceId: 'sp-default', private: true }, { id: 'page-2', spaceId: 'sp-work' }] })
    await expect(call(r, 'sidePanel', 'open', [{ windowId: 1 }])).rejects.toThrow('A side panel does not open over a private tab or in a private window.')
    expect(r.browser.openSidePanel).not.toHaveBeenCalled()
  })
})

describe('chrome.tabs.captureVisibleTab', () => {
  it('captures the active tab only when the extension may: all sites, or the tab handed over', async () => {
    const r = rig()
    await expect(call(r, 'tabs', 'captureVisibleTab', [])).rejects.toThrow("Either the '<all_urls>' or 'activeTab' permission is required.")
    expect(r.browser.target.captureActiveFor).not.toHaveBeenCalled()
    expect(r.engine.mayCaptureTab).toHaveBeenCalledWith(EXT, 7)
    r.engine.mayCaptureTab.mockReturnValue(true)
    await expect(call(r, 'tabs', 'captureVisibleTab', [])).resolves.toMatch(/^data:image\/png;base64,/)
  })

  it('says there is no tab to capture when the window shows none of the profile', async () => {
    const r = rig()
    await expect(call(r, 'tabs', 'captureVisibleTab', [], { profileId: 'work' })).rejects.toThrow('no tab of this profile is visible')
  })
})

describe('the window an extension means when it names none', () => {
  /** Two windows of the application (1 and 5); the popup of an icon of window 5 is a window of its own (99) that hangs from it and has the focus while the extension works. */
  function twoWindows() {
    const r = rig()
    const shotOf = (name: string) => ({ activeTabFor: () => ({ id: 'page-1', url: 'https://shop.example/cart' }), captureActiveFor: vi.fn(async () => Buffer.from(name)) })
    const windows: Record<number, ReturnType<typeof shotOf>> = { 1: shotOf('first window'), 5: shotOf('window of the popup') }
    r.browser.browserOfWindow = (id: number) => windows[id]
    r.engine.mayCaptureTab.mockReturnValue(true)
    return { r, windows }
  }
  const captured = async (r: Rig): Promise<string> => Buffer.from(((await call(r, 'tabs', 'captureVisibleTab', [])) as string).split(',')[1]!, 'base64').toString()

  it('is the window a popup hangs from when the popup has the focus, not the first window', async () => {
    const { r } = twoWindows()
    focus.window = { id: 99, getParentWindow: () => ({ id: 5 }) }
    try {
      await expect(captured(r)).resolves.toBe('window of the popup')
    } finally {
      focus.window = null
    }
  })

  it('is the window that has the focus when it is one of the application, and the first window when none is', async () => {
    const { r } = twoWindows()
    focus.window = { id: 5, getParentWindow: () => null }
    try {
      await expect(captured(r)).resolves.toBe('window of the popup')
      focus.window = null
      await expect(captured(r)).resolves.toBe('first window')
    } finally {
      focus.window = null
    }
  })
})

describe('chrome.downloads and the table of owners', () => {
  const info = (state: string) => ({ id: 'dl-5', filename: 'a.bin', url: 'https://a.example/a.bin', path: '/tmp/a.bin', state, receivedBytes: 1, totalBytes: 1, startedAt: 1 })

  it('forgets who started a download once it has ended, and keeps saying who started it', async () => {
    const r = rig()
    r.engine.startDownload = async () => 'dl-5'
    r.download(info('progressing'))
    await call(r, 'downloads', 'download', [{ url: 'https://a.example/a.bin' }])
    const owners = (r.shims as unknown as { downloadOwners: Map<string, string> }).downloadOwners
    expect(owners.size).toBe(1)
    r.download(info('completed'))
    expect(owners.size).toBe(0)
    const found = (await call(r, 'downloads', 'search', [{}])) as Array<{ byExtensionId?: string }>
    expect(found[0]?.byExtensionId).toBe(EXT)
  })

  // chrome.downloads.search answers long after a download ended: its end is when it ended, kept until it starts again.
  it('dates the end of a download from the moment it ended, not from the question', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      vi.setSystemTime(Date.UTC(2026, 10, 12, 9, 0, 0))
      r.download(info('progressing'))
      vi.setSystemTime(Date.UTC(2026, 10, 12, 9, 5, 0))
      r.download(info('completed'))
      vi.setSystemTime(Date.UTC(2026, 10, 12, 9, 30, 0))
      // A later word about the same ended download does not move its end.
      r.download(info('completed'))
      const ended = (await call(r, 'downloads', 'search', [{}])) as Array<{ endTime?: string }>
      expect(ended[0]?.endTime).toBe('2026-11-12T09:05:00.000Z')
      // Resumed, it has no end; ended again, its end is the new one.
      r.download(info('progressing'))
      expect(((await call(r, 'downloads', 'search', [{}])) as Array<{ endTime?: string }>)[0]?.endTime).toBeUndefined()
      vi.setSystemTime(Date.UTC(2026, 10, 12, 10, 0, 0))
      r.download(info('interrupted'))
      vi.setSystemTime(Date.UTC(2026, 10, 12, 11, 0, 0))
      expect(((await call(r, 'downloads', 'search', [{}])) as Array<{ endTime?: string }>)[0]?.endTime).toBe('2026-11-12T10:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not keep the owner of a download that was over before the extension heard of its id', async () => {
    const r = rig()
    r.engine.startDownload = async () => {
      r.download(info('completed'))
      return 'dl-5'
    }
    await call(r, 'downloads', 'download', [{ url: 'https://a.example/a.bin' }])
    expect((r.shims as unknown as { downloadOwners: Map<string, string> }).downloadOwners.size).toBe(0)
  })
})

describe('chrome.contextMenus.update', () => {
  it('asks the engine to change the item of the extension that asked, in its profile, and answers nothing', async () => {
    const r = rig()
    await expect(call(r, 'contextMenus', 'update', ['save', { title: 'Saved' }], { profileId: 'work' })).resolves.toBeUndefined()
    expect(r.engine['updateContextMenuItem']).toHaveBeenCalledWith(EXT, 'work', 'save', { title: 'Saved' })
  })

  it('hands the refusal of the engine (no such item) on to the extension', async () => {
    const r = rig()
    r.engine['updateContextMenuItem'].mockImplementation(() => {
      throw new Error('Cannot find menu item with id nope')
    })
    await expect(call(r, 'contextMenus', 'update', ['nope', {}])).rejects.toThrow('Cannot find menu item with id nope')
  })

  it('serves no other method of contextMenus: the library has them', async () => {
    const r = rig()
    await expect(call(r, 'contextMenus', 'create', [{ title: 'x' }])).rejects.toThrow('chrome.contextMenus.create is not supported')
    expect(r.engine['updateContextMenuItem']).not.toHaveBeenCalled()
  })
})

describe('the clipboard of an extension', () => {
  it('pastes into the tab a content script asked for, in the profile of the extension, when a host permission of the extension covers it', async () => {
    const r = rig()
    await expect(call(r, 'clipboard', 'paste', [7])).resolves.toBeUndefined()
    expect(r.engine['mayActOnTab']).toHaveBeenCalledWith(EXT, 7)
    expect(r.page['pasteIntoFocus']).toHaveBeenCalledTimes(1)
  })

  it('waits for the copies asked for just before: a paste never reads what a copy has not finished putting there', async () => {
    const r = rig()
    const order: string[] = []
    let finish: () => void = () => undefined
    r.engine['clipboardSettled'].mockReturnValue(new Promise<void>((resolve) => void (finish = () => (order.push('copy done'), resolve()))))
    r.page['pasteIntoFocus'].mockImplementation(() => void order.push('paste'))
    const pasted = call(r, 'clipboard', 'paste', [7])
    await Promise.resolve()
    expect(r.page['pasteIntoFocus']).not.toHaveBeenCalled()
    finish()
    await pasted
    expect(order).toEqual(['copy done', 'paste'])
  })

  it('refuses a tab the extension has no host permission for, and a tab that is not in its profile, and pastes nothing', async () => {
    const r = rig()
    r.engine['mayActOnTab'].mockReturnValue(false)
    await expect(call(r, 'clipboard', 'paste', [7])).rejects.toThrow('needs a host permission')
    r.engine['mayActOnTab'].mockReturnValue(true)
    await expect(call(r, 'clipboard', 'paste', [8])).rejects.toThrow('No tab with id: 8')
    await expect(call(r, 'clipboard', 'paste', [999])).rejects.toThrow('No tab with id: 999')
    await expect(call(r, 'clipboard', 'paste', ['7'])).rejects.toThrow('No tab with id')
    await expect(call(r, 'clipboard', 'paste', [])).rejects.toThrow('No tab with id')
    expect(r.page['pasteIntoFocus']).not.toHaveBeenCalled()
  })

  it('puts text and HTML on the clipboard for a page of the extension, and only strings of a reasonable size', async () => {
    const r = rig()
    await call(r, 'clipboard', 'write', [{ text: 'texte', html: '<b>texte</b>' }])
    expect(r.engine['writeClipboard']).toHaveBeenLastCalledWith({ text: 'texte', html: '<b>texte</b>' })
    await call(r, 'clipboard', 'write', [{ text: 'seul' }])
    expect(r.engine['writeClipboard']).toHaveBeenLastCalledWith({ text: 'seul', html: '' })
    await call(r, 'clipboard', 'write', [{ text: 42, html: { x: 1 } }])
    expect(r.engine['writeClipboard']).toHaveBeenLastCalledWith({ text: '', html: '' })
    await expect(call(r, 'clipboard', 'write', [{ text: 'x'.repeat(10_000_001) }])).rejects.toThrow('too much')
    await expect(call(r, 'clipboard', 'write', [{ html: 'x'.repeat(10_000_001) }])).rejects.toThrow('too much')
    expect(r.engine['writeClipboard']).toHaveBeenCalledTimes(3)
  })

  it('answers once the text is on the clipboard, and hands on a failure to write it', async () => {
    const r = rig()
    r.engine['writeClipboard'].mockRejectedValueOnce(new Error('clipboard busy'))
    await expect(call(r, 'clipboard', 'write', [{ text: 'x' }])).rejects.toThrow('clipboard busy')
  })

  it('serves no other method: reading the clipboard is not here', async () => {
    const r = rig()
    await expect(call(r, 'clipboard', 'read', [])).rejects.toThrow('chrome.clipboard.read is not supported')
    expect(r.engine['writeClipboard']).not.toHaveBeenCalled()
    expect(r.page['pasteIntoFocus']).not.toHaveBeenCalled()
  })
})

describe('chrome.debugger.getTargets and the Extensions page', () => {
  const PAGE = `lucium-ui://extensions/?id=${'a'.repeat(32)}`

  it('lists the page with Chrome’s address and its title for an extension that may read tabs, and without either for one that may not', async () => {
    const r = rig()
    r.browser['listTabTargets'] = () => [{ tabNumber: 7, title: 'Extensions', url: PAGE }]
    r.engine['mayReadTab']!.mockReturnValue(false)
    expect(await call(r, 'debugger', 'getTargets', [])).toEqual([{ type: 'page', id: '7', tabId: 7, attached: false }])
    expect(r.engine['mayReadTab']).toHaveBeenCalledWith(EXT, 7)
    r.engine['mayReadTab']!.mockReturnValue(true)
    const told = await call(r, 'debugger', 'getTargets', [])
    expect(told).toEqual([{ type: 'page', id: '7', tabId: 7, title: 'Extensions', url: `chrome://extensions/?id=${'a'.repeat(32)}`, attached: false }])
    expect(JSON.stringify(told)).not.toContain('lucium-ui')
  })

  it('lists a page of the web as it always did, without asking whether the extension may read it', async () => {
    const r = rig()
    r.browser['listTabTargets'] = () => [{ tabNumber: 7, title: 'Shop', url: 'https://shop.example/cart' }]
    r.engine['mayReadTab']!.mockReturnValue(false)
    expect(await call(r, 'debugger', 'getTargets', [])).toEqual([{ type: 'page', id: '7', tabId: 7, title: 'Shop', url: 'https://shop.example/cart', attached: false }])
    expect(r.engine['mayReadTab']).not.toHaveBeenCalled()
  })
})
