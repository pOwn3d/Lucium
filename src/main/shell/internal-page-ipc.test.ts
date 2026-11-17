// The channels of the Extensions page in a tab, with the sender judged at every message: a frame, an origin, a state and a window that are the page's, or nothing happens.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { InternalChannel } from '@shared/ipc'
import type { UiSnapshot } from '@shared/ipc'
import { defaultSettings } from '@shared/model-defaults'
import type { ExtensionsReply, ExtensionsRequest } from '@shared/extension-page'
import { registerInternalPageIpc, senderFacts, type InternalPageHost, type InternalTabFacts } from './internal-page-ipc'
import type { ScopedIpc } from './ipc-scope'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const PAGE = 'lucium-ui://extensions/'

interface FakeFrame {
  origin: unknown
  url: unknown
  parent: unknown
}

/** A message as Electron delivers it: from a frame of a web contents. */
function message(change: { frame?: Partial<FakeFrame> | null; topFrame?: boolean; id?: number } = {}) {
  const top: FakeFrame = { origin: 'lucium-ui://extensions', url: PAGE, parent: null }
  const frame = change.frame === null ? null : { ...top, ...change.frame }
  const sender = { id: change.id ?? 7, mainFrame: change.topFrame === false ? { other: true } : frame }
  return { sender, senderFrame: frame }
}

const goodTab: InternalTabFacts = { url: PAGE, private: false, container: false, profileSession: true }

function setup(over: Partial<{ tab: InternalTabFacts | null; isPrivate: boolean; locked: boolean }> = {}) {
  const handlers = new Map<string, (event: ReturnType<typeof message>, ...args: unknown[]) => unknown>()
  const ipc: ScopedIpc = {
    on: (channel, listener) => void handlers.set(channel, listener as never),
    handle: (channel, listener) => void handlers.set(channel, listener as never)
  }
  const settings = { ...defaultSettings(), webStoreInstall: true }
  const snapshot = { state: { settings }, extensions: [{ id: ID, name: 'Extension', version: '1', profileId: 'default', source: 'store', enabled: true }], platform: 'darwin', runtime: { tabs: {} } } as unknown as UiSnapshot
  const calls: Array<[string, ...unknown[]]> = []
  const host: InternalPageHost = {
    tabOf: (id) => (id === 7 ? (over.tab === undefined ? goodTab : over.tab) : null),
    isPrivate: () => over.isPrivate === true,
    snapshot: () => snapshot,
    appLocked: () => over.locked === true,
    openSettings: (pane, anchor) => void calls.push(['settings', pane, anchor]),
    openWebStore: () => void calls.push(['store']),
    updates: (target) => void calls.push(['updates', target]),
    openFiles: (urls, refused) => void calls.push(['files', urls, refused]),
    asking: (sender) => void calls.push(['asking', (sender as { id: number } | null)?.id])
  }
  const handled: ExtensionsRequest[] = []
  const service = { handle: vi.fn(async (request: ExtensionsRequest): Promise<ExtensionsReply> => (handled.push(request), { ok: true })) }
  registerInternalPageIpc(ipc, host, service)
  const send = (channel: string, event: ReturnType<typeof message>, ...args: unknown[]) => handlers.get(channel)!(event, ...args)
  return { handlers, send, calls, handled, service }
}

let warn: MockInstance<(...args: unknown[]) => void>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined) as unknown as MockInstance<(...args: unknown[]) => void>
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('the channels of the Extensions page', () => {
  it('are the six it answers, all of its own and none of them a channel of the interface', () => {
    const { handlers } = setup()
    expect([...handlers.keys()].sort()).toEqual(['lucium-ui:extension-updates', 'lucium-ui:extensions-page', 'lucium-ui:get-snapshot', 'lucium-ui:open-local-files', 'lucium-ui:open-settings', 'lucium-ui:open-web-store'])
    for (const channel of handlers.keys()) expect(channel).toMatch(/^lucium-ui:/)
    expect(Object.values(InternalChannel)).toContain('lucium-ui:snapshot')
  })

  it('answer the page: the reduced snapshot, the extensions request, Settings, the Web Store, the updates, the dropped files', async () => {
    const t = setup()
    const snapshot = (await t.send(InternalChannel.getSnapshot, message())) as UiSnapshot
    expect(snapshot.extensions.map((e) => e.id)).toEqual([ID])
    expect(snapshot.state.tabs).toEqual([])
    expect(snapshot.runtime).toEqual({ tabs: {}, canGoBack: false, canGoForward: false })
    expect(await t.send(InternalChannel.extensionsPage, message(), { op: 'details' })).toEqual({ ok: true })
    expect(t.handled).toEqual([{ op: 'details' }])
    t.send(InternalChannel.openSettings, message(), { pane: 'tools', anchor: 'extensions' })
    t.send(InternalChannel.openWebStore, message())
    t.send(InternalChannel.extensionUpdates, message())
    t.send(InternalChannel.extensionUpdates, message(), { profileId: 'default', extensionId: ID })
    t.send(InternalChannel.openLocalFiles, message(), ['/Users/jane/a.pdf', '/Users/jane/b.exe'])
    expect(t.calls).toEqual([
      ['asking', 7],
      ['settings', 'tools', 'extensions'],
      ['store'],
      ['updates', undefined],
      ['updates', { profileId: 'default', extensionId: ID }],
      ['files', ['file:///Users/jane/a.pdf'], 1]
    ])
  })

  it('tell nothing of the application while it is locked, and ask nothing of the service', async () => {
    const t = setup({ locked: true })
    expect(await t.send(InternalChannel.getSnapshot, message())).toBeNull()
    expect(await t.send(InternalChannel.extensionsPage, message(), { op: 'details' })).toMatchObject({ ok: false })
    expect(t.service.handle).not.toHaveBeenCalled()
  })
})

describe('a message that is not the page’s', () => {
  /** Every channel, with what it would do if it were answered. */
  async function sendAll(t: ReturnType<typeof setup>, event: ReturnType<typeof message>): Promise<unknown[]> {
    return [
      await t.send(InternalChannel.getSnapshot, event),
      await t.send(InternalChannel.extensionsPage, event, { op: 'details' }),
      await t.send(InternalChannel.openSettings, event, { pane: 'tools', anchor: 'extensions' }),
      await t.send(InternalChannel.openWebStore, event),
      await t.send(InternalChannel.extensionUpdates, event),
      await t.send(InternalChannel.openLocalFiles, event, ['/Users/jane/a.pdf'])
    ]
  }

  /** Nothing reached the window or the service, the snapshot is null, the request is refused, and the log says which channel and why. */
  async function refused(t: ReturnType<typeof setup>, event: ReturnType<typeof message>, reason: RegExp): Promise<void> {
    const [snapshot, reply] = await sendAll(t, event)
    expect(snapshot).toBeNull()
    expect(reply).toMatchObject({ ok: false })
    expect(t.calls).toEqual([])
    expect(t.service.handle).not.toHaveBeenCalled()
    const lines = warn.mock.calls.map((call) => String(call[0]))
    expect(lines.filter((line) => reason.test(line))).toHaveLength(6)
    for (const channel of ['get-snapshot', 'extensions-page', 'open-settings', 'open-web-store', 'extension-updates', 'open-local-files']) expect(lines.some((line) => line.includes(`lucium-ui:${channel} refused`))).toBe(true)
  }

  it('is refused from another origin: a web page in the tab, a prefix of the page’s, another scheme', async () => {
    for (const origin of ['https://example.org', 'lucium-ui://extensions.evil.com', 'lucium-ui://extensions@evil', 'LUCIUM-UI://EXTENSIONS', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'null', '', 'file://', undefined]) {
      warn.mockClear()
      await refused(setup(), message({ frame: { origin } }), origin === undefined ? /no sender frame/ : /is not the Extensions page/)
    }
  })

  it('is refused from a frame inside the page, and from a frame that is not the main frame of the web contents', async () => {
    await refused(setup(), message({ frame: { parent: { some: 'frame' } } }), /top frame/)
    warn.mockClear()
    await refused(setup(), message({ topFrame: false }), /top frame/)
  })

  it('is refused from a message that has no frame (it is gone)', async () => {
    await refused(setup(), message({ frame: null }), /no sender frame/)
  })

  it('is refused when the document is no address of the page, though its origin says so', async () => {
    await refused(setup(), message({ frame: { url: 'https://example.org/' } }), /not an address of the Extensions page/)
  })

  it('is refused from a web contents that is no tab of this window', async () => {
    await refused(setup(), message({ id: 99 }), /not a tab/)
  })

  it('is refused once the state says the tab has gone elsewhere', async () => {
    await refused(setup({ tab: { ...goodTab, url: 'https://example.org/' } }), message(), /no longer on the Extensions page/)
  })

  it('is refused from a private tab, from a tab in a container, from a private or guest window and from a session that is not a profile’s', async () => {
    await refused(setup({ tab: { ...goodTab, private: true } }), message(), /private tab|container/)
    warn.mockClear()
    await refused(setup({ tab: { ...goodTab, container: true } }), message(), /private tab|container/)
    warn.mockClear()
    await refused(setup({ isPrivate: true }), message(), /private or guest window/)
    warn.mockClear()
    await refused(setup({ tab: { ...goodTab, profileSession: false } }), message(), /session of a profile/)
    warn.mockClear()
    await refused(setup({ locked: true }), message(), /locked/)
  })

  it('is logged without the address of the document: the channel and the reason only', async () => {
    const t = setup()
    await t.send(InternalChannel.openWebStore, message({ frame: { origin: 'https://secret.example/?token=abc', url: 'https://secret.example/?token=abc' } }))
    expect(warn.mock.calls.flat().join(' ')).not.toContain('token=abc')
  })
})

describe('what the page sends is read again', () => {
  it('does not open Settings at a place that does not exist, nor for anything that is not a target', () => {
    const t = setup()
    for (const raw of [undefined, null, 'tools', 7, {}, { pane: 'nope' }, { pane: 7 }, { pane: ['tools'] }, { anchor: 'extensions' }]) t.send(InternalChannel.openSettings, message(), raw)
    expect(t.calls).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Settings at a place that does not exist'))
  })

  it('opens Settings at the place an old address names too, as it resolves it', () => {
    const t = setup()
    t.send(InternalChannel.openSettings, message(), { pane: 'advanced', anchor: 'extensions' })
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]![0]).toBe('settings')
  })

  it('does not look for the update of an extension it does not name, and says so', () => {
    const t = setup()
    for (const raw of [{ profileId: '../x', extensionId: ID }, { profileId: 'default', extensionId: 'nope' }, { extensionId: ID }, 'x', 7, []]) t.send(InternalChannel.extensionUpdates, message(), raw)
    expect(t.calls).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('update of an extension'))
  })

  it('does not run a request of the page that is none, and tells it', async () => {
    const t = setup()
    for (const raw of [null, 'details', { op: 'eval', code: '1' }, { op: 'load-unpacked', path: '/' }, { op: 'reload', profileId: '../x', extensionId: ID }]) {
      expect(await t.send(InternalChannel.extensionsPage, message(), raw), JSON.stringify(raw)).toMatchObject({ ok: false })
    }
    expect(t.service.handle).not.toHaveBeenCalled()
  })

  it('opens at most the files of a type a tab shows, and says how many it left out', () => {
    const t = setup()
    t.send(InternalChannel.openLocalFiles, message(), ['/Users/jane/a.pdf', '/Users/jane/b.dmg', 'relative.pdf', 4, '/Users/jane/c.png'])
    expect(t.calls).toEqual([['files', ['file:///Users/jane/a.pdf', 'file:///Users/jane/c.png'], 3]])
    t.calls.length = 0
    t.send(InternalChannel.openLocalFiles, message(), 'not a list')
    expect(t.calls).toEqual([['files', [], 0]])
  })
})

describe('the facts of a message', () => {
  const host = { tabOf: (id: number) => (id === 7 ? goodTab : null), isPrivate: () => false, appLocked: () => false } as unknown as InternalPageHost

  it('are read from the frame as Electron gives it', () => {
    const event = message()
    expect(senderFacts(event as never, host)).toEqual({
      frameOrigin: 'lucium-ui://extensions',
      frameUrl: PAGE,
      topFrame: true,
      tab: { url: PAGE, private: false, container: false },
      privateWindow: false,
      profileSession: true,
      appLocked: false
    })
  })

  it('say there is no frame when Electron cannot give it (the page is gone), and write why', () => {
    const gone = {
      sender: { id: 7, mainFrame: null },
      get senderFrame(): never {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    }
    const facts = senderFacts(gone as never, host)
    expect(facts.frameOrigin).toBeUndefined()
    expect(facts.topFrame).toBe(false)
    expect(warn).toHaveBeenCalledWith('[internal-page] the frame of a message is gone:', 'Render frame was disposed before WebFrameMain could be accessed')
  })

  it('say it is no top frame for a frame that has a parent, or that is not the main frame of its web contents', () => {
    expect(senderFacts(message({ frame: { parent: {} } }) as never, host).topFrame).toBe(false)
    expect(senderFacts(message({ topFrame: false }) as never, host).topFrame).toBe(false)
    expect(senderFacts(message({ frame: null }) as never, host).topFrame).toBe(false)
  })

  it('say the web contents is no tab, and no profile’s session, when the window does not know it', () => {
    const facts = senderFacts(message({ id: 3 }) as never, host)
    expect(facts.tab).toBeNull()
    expect(facts.profileSession).toBe(false)
  })
})
