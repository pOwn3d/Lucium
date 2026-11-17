// The main-process side of the runtime of a script injected into a tab the user lent with a click (lent-tabs.ts): the page is asked to take it and answers, the calls of the script are read
// again (who sends, whose world it is, whether the tab is still lent), a message of the worker is handed to the script as data, and what is kept of a tab goes with its document. On a
// stand-in of the host and of the tab; the same in a real Electron: `smokeProbesExt` (the active-tab-scripting-probe).

import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { Channel } from '@shared/ipc-channels'
import { CONTEXT_INVALIDATED, LENT_BUDGET_CHARACTERS, LENT_CALL_MAX, LENT_PAYLOAD_MAX, LENT_RUNTIME_KEY, NO_RECEIVER, PORT_CLOSED, SCRIPT_WORLDS_FROM, senderOfScript, TOO_LONG } from '@shared/lent-tab-runtime'
import { LentAsks } from './lent-asks'
import { LentTabs, type LentTabsHost } from './lent-tabs'

const EXT = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'
const WORLD = SCRIPT_WORLDS_FROM + 2
const URL_OF_TAB = 'https://site.example/page'
const settle = (ms = 3): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A tab, its page's main frame (which keeps what it was sent), and what was run in the isolated worlds of it. */
function setup(options: { permissions?: string[]; manifest?: unknown; run?: (code: string) => unknown } = {}) {
  const sent: Array<{ channel: string; args: unknown[] }> = []
  const ran: Array<{ world: number; code: string }> = []
  const emitter = new EventEmitter()
  const mainFrame = { url: URL_OF_TAB, send: vi.fn((channel: string, ...args: unknown[]) => void sent.push({ channel, args })) }
  const wc = {
    id: 7,
    mainFrame,
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: vi.fn(async (world: number, scripts: Array<{ code: string }>) => {
      ran.push({ world, code: scripts[0]!.code })
      return options.run ? options.run(scripts[0]!.code) : undefined
    }),
    on: (event: string, listener: (...args: any[]) => void) => emitter.on(event, listener),
    once: (event: string, listener: (...args: any[]) => void) => emitter.once(event, listener)
  }
  /** The tabs the extension holds now (the loan, read again at each call), by tab and extension. */
  const lent = new Set<string>([`7:${EXT}`])
  const host = {
    contents: vi.fn((tab: number) => (tab === 7 ? wc : undefined)),
    lentProfile: vi.fn((extensionId: string, tab: number) => (lent.has(`${tab}:${extensionId}`) ? 'default' : undefined)),
    extensionOfWorld: vi.fn((world: number) => (world === WORLD ? EXT : undefined)),
    worldOf: vi.fn(() => WORLD),
    details: vi.fn((_profile: string, extensionId: string) => (extensionId === EXT ? { permissions: new Set(options.permissions ?? ['activeTab', 'scripting', 'storage']), manifest: options.manifest ?? { manifest_version: 3, name: 'Probe' } } : undefined)),
    askWorker: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, value: 'pong' })),
    mayAsk: vi.fn((..._args: unknown[]) => true),
    dropAsks: vi.fn(),
    warn: vi.fn()
  } satisfies LentTabsHost
  const lents = new LentTabs(host, 40, 80)
  /** What the page says: the main frame of the tab, or another sender. */
  const fromTab = { sender: { id: 7, mainFrame }, senderFrame: mainFrame }
  const nonceOfLast = (): string => sent.filter((each) => each.channel === Channel.lentTabAttach).at(-1)!.args[0] as string
  /** The page takes the runtime. */
  const accept = async (): Promise<boolean> => {
    const asked = lents.ensure(7, EXT, 'default')
    await settle(1)
    lents.attachedBy(fromTab, nonceOfLast(), true, undefined)
    return asked
  }
  /** The token the page of the last request was given, which its calls carry. */
  const tokenOfLast = (): string => ((sent.filter((each) => each.channel === Channel.lentTabAttach).at(-1)!.args[2] as { token: string }).token)
  /** The page takes the runtime, and the token of its calls is what comes back. */
  const attach = async (): Promise<string> => {
    await accept()
    return tokenOfLast()
  }
  /** The main frame has gone to a new document (committed), as opposed to a navigation that only starts. */
  const navigate = (): boolean => emitter.emit('did-navigate')
  return { lents, host, wc, mainFrame, sent, ran, lent, fromTab, nonceOfLast, accept, attach, tokenOfLast, navigate, emitter }
}

/** The text the main process hands to a script, as that world runs it: a runtime that keeps what it is given. */
function handedTo(code: string, answer: unknown = { ok: true, value: 'x' }): { texts: string[]; result: unknown } {
  const texts: string[] = []
  const sandbox: Record<string, unknown> = { [LENT_RUNTIME_KEY]: { deliver: (text: string) => (texts.push(text), Promise.resolve(JSON.stringify(answer))) } }
  return { texts, result: vm.runInNewContext(code, sandbox) }
}

describe('the page of a tab that is asked to take the runtime of an extension', () => {
  it('is sent the world of the extension, what the extension is, and the permissions it holds, on the main frame of the tab; it is taken when the page says so', async () => {
    const { lents, sent, accept, host } = setup({ manifest: { manifest_version: 3, name: 'Probe', permissions: ['activeTab'] } })
    expect(await accept()).toBe(true)
    expect(sent).toEqual([{ channel: Channel.lentTabAttach, args: [expect.any(String), WORLD, { extensionId: EXT, manifest: { manifest_version: 3, name: 'Probe', permissions: ['activeTab'] }, permissions: ['activeTab', 'scripting', 'storage'], token: expect.stringMatching(/^[0-9a-f-]{36}$/) }] }])
    expect(host.warn).not.toHaveBeenCalled()
    expect(lents).toBeDefined()
  })

  it('is not taken when the page says it could not, and the reason is in the journal', async () => {
    const { lents, nonceOfLast, fromTab, host } = setup()
    const asked = lents.ensure(7, EXT, 'default')
    await settle(1)
    lents.attachedBy(fromTab, nonceOfLast(), false, 'no such world')
    expect(await asked).toBe(false)
    expect(host.warn).toHaveBeenCalledWith(expect.stringContaining('no such world'))
  })

  it('is not waited for again, and no more is sent, once it has been silent: the page has no preload (it was loaded before the extension)', async () => {
    const { lents, sent, host, navigate } = setup()
    expect(await lents.ensure(7, EXT, 'default')).toBe(false)
    expect(host.warn).toHaveBeenCalledWith(expect.stringContaining('did not answer'))
    expect(sent).toHaveLength(1)
    expect(await lents.ensure(7, EXT, 'default')).toBe(false)
    expect(sent).toHaveLength(1)
    // A new document may carry the preload: it is asked again.
    navigate()
    expect(await lents.ensure(7, EXT, 'default')).toBe(false)
    expect(sent).toHaveLength(2)
  })

  it('does not take the answer of any other sender: another tab, a frame of the page, an answer to another request, or a request that was never made', async () => {
    const { lents, nonceOfLast, wc, mainFrame, host } = setup()
    const asked = lents.ensure(7, EXT, 'default')
    await settle(1)
    const nonce = nonceOfLast()
    lents.attachedBy({ sender: { id: 8, mainFrame }, senderFrame: mainFrame }, nonce, true, undefined)
    lents.attachedBy({ sender: { id: 7, mainFrame }, senderFrame: { url: 'https://ads.example/' } }, nonce, true, undefined)
    lents.attachedBy({ sender: { id: 7, mainFrame }, senderFrame: mainFrame }, 'another nonce', true, undefined)
    lents.attachedBy({ sender: { id: 7, mainFrame }, senderFrame: mainFrame }, 7, true, undefined)
    lents.attachedBy({ sender: { id: 7, mainFrame }, senderFrame: null }, nonce, true, undefined)
    expect(await asked).toBe(false)
    expect(host.warn).toHaveBeenCalledWith(expect.stringContaining('did not answer'))
    expect(wc.id).toBe(7)
  })

  it('is not asked at all for a tab that is gone or an extension that is not loaded in the profile', async () => {
    const { lents, sent, host } = setup()
    host.details.mockReturnValueOnce(undefined)
    expect(await lents.ensure(7, EXT, 'default')).toBe(false)
    expect(await lents.ensure(8, EXT, 'default')).toBe(false)
    expect(sent).toEqual([])
  })

  it('is handed an empty manifest, and the journal says so, when the manifest is too long to hand over', async () => {
    const { lents, sent, nonceOfLast, fromTab, host } = setup({ manifest: { name: 'x'.repeat(300_000) } })
    const asked = lents.ensure(7, EXT, 'default')
    await settle(1)
    lents.attachedBy(fromTab, nonceOfLast(), true, undefined)
    expect(await asked).toBe(true)
    expect((sent[0]!.args[2] as { manifest: unknown }).manifest).toEqual({})
    expect(host.warn).toHaveBeenCalledWith(expect.stringContaining('too long'))
  })

  it('is told in the journal when the page cannot even be written to', async () => {
    const { lents, mainFrame, host } = setup()
    mainFrame.send.mockImplementationOnce(() => {
      throw new Error('Render frame was disposed')
    })
    expect(await lents.ensure(7, EXT, 'default')).toBe(false)
    expect(host.warn).toHaveBeenCalledWith(expect.stringContaining('could not be asked'), expect.any(Error))
  })
})

describe('a call of the script of a lent tab', () => {
  const send = (message: unknown) => JSON.stringify({ message })

  it('is a message for the worker of the extension whose world it is: asked of the worker with the tab, the page and the message; what the worker says goes back as JSON', async () => {
    const { lents, fromTab, host, attach } = setup()
    const token = await attach()
    host.askWorker.mockResolvedValue({ ok: true, value: { pong: 1 } })
    expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'send', send({ type: 'ping' })))).toEqual({ ok: true, value: { pong: 1 } })
    expect(host.askWorker).toHaveBeenCalledExactlyOnceWith('default', EXT, 7, 'message', { tabId: 7, sender: senderOfScript(EXT, URL_OF_TAB), message: { type: 'ping' } }, send({ type: 'ping' }).length)
  })

  it('is a call of the storage of the extension, with the area, the method and the argument', async () => {
    const { lents, fromTab, host, attach } = setup()
    const token = await attach()
    host.askWorker.mockResolvedValue({ ok: true, value: { k: 'v' } })
    const text = JSON.stringify({ area: 'sync', method: 'get', args: ['k'] })
    expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'storage', text))).toEqual({ ok: true, value: { k: 'v' } })
    expect(host.askWorker).toHaveBeenCalledExactlyOnceWith('default', EXT, 7, 'storage', { area: 'sync', method: 'get', args: ['k'] }, text.length)
  })

  it('is the extension of the world and no other, whatever the call says', async () => {
    const { lents, fromTab, host, attach } = setup()
    const token = await attach()
    await lents.call(fromTab, WORLD, token, 'send', JSON.stringify({ message: 1, extensionId: OTHER, extension: OTHER, id: OTHER }))
    expect(host.askWorker.mock.calls[0]!.slice(0, 3)).toEqual(['default', EXT, 7])
  })

  it('is refused for a world that belongs to no extension, from a frame that is not the main frame of the tab, and once the tab is no longer lent to the extension: the script is told its context is gone', async () => {
    const { lents, fromTab, mainFrame, host, lent, attach } = setup()
    const token = await attach()
    for (const world of [0, 999, SCRIPT_WORLDS_FROM, WORLD + 1, SCRIPT_WORLDS_FROM + 4096, '4300002', undefined]) await expect(lents.call(fromTab, world, token, 'send', send(1)), String(world)).rejects.toThrow(CONTEXT_INVALIDATED)
    await expect(lents.call({ sender: { id: 7, mainFrame }, senderFrame: { url: URL_OF_TAB } }, WORLD, token, 'send', send(1))).rejects.toThrow(CONTEXT_INVALIDATED)
    await expect(lents.call({ sender: { id: 7, mainFrame }, senderFrame: null }, WORLD, token, 'send', send(1))).rejects.toThrow(CONTEXT_INVALIDATED)
    lent.delete(`7:${EXT}`)
    await expect(lents.call(fromTab, WORLD, token, 'send', send(1))).rejects.toThrow(CONTEXT_INVALIDATED)
    // The tab is the one that sends (a tab the extension was not lent is no one it speaks for).
    await expect(lents.call({ sender: { id: 8, mainFrame }, senderFrame: mainFrame }, WORLD, token, 'send', send(1))).rejects.toThrow(CONTEXT_INVALIDATED)
    expect(host.askWorker).not.toHaveBeenCalled()
  })

  it('is heard only with the token this document was given with the bridge: the right world with another token, none, or the token of another tab or of the document before, is refused', async () => {
    const { lents, fromTab, host, attach, navigate } = setup()
    const token = await attach()
    expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'send', send(1)))).toEqual({ ok: true, value: 'pong' })
    for (const wrong of [undefined, null, '', 'guess', `${token}x`, token.slice(1), 7, { token }, [token]]) await expect(lents.call(fromTab, WORLD, wrong, 'send', send(1)), String(wrong)).rejects.toThrow(CONTEXT_INVALIDATED)
    expect(host.askWorker).toHaveBeenCalledOnce()
    // A new document is another preload with another token: the one of the document before opens nothing.
    navigate()
    await expect(lents.call(fromTab, WORLD, token, 'send', send(1))).rejects.toThrow(CONTEXT_INVALIDATED)
    const next = await attach()
    expect(next).not.toBe(token)
    await expect(lents.call(fromTab, WORLD, token, 'send', send(1))).rejects.toThrow(CONTEXT_INVALIDATED)
    expect(JSON.parse(await lents.call(fromTab, WORLD, next, 'send', send(1)))).toEqual({ ok: true, value: 'pong' })
  })

  // The cost of reading a call is what a script that sends many could take from the main process: nothing that is refused is read.
  it('refuses a call longer than a call may be as it is, before anything of it is parsed or asked: five million brackets never reach JSON.parse', async () => {
    const { lents, fromTab, host, attach } = setup()
    const token = await attach()
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const answers: string[] = []
      for (const payload of ['['.repeat(5 * 1024 * 1024), '{"message":"' + 'x'.repeat(LENT_CALL_MAX) + '"}']) answers.push(await lents.call(fromTab, WORLD, token, 'send', payload))
      expect(parse).not.toHaveBeenCalled()
      for (const answer of answers) expect(JSON.parse(answer)).toEqual({ ok: false, error: TOO_LONG })
      expect(host.mayAsk).not.toHaveBeenCalled()
      expect(host.askWorker).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('refuses an operation the bridge does not offer before its text is parsed', async () => {
    const { lents, fromTab, host, attach } = setup()
    const token = await attach()
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const answer = await lents.call(fromTab, WORLD, token, 'x'.repeat(1e6), JSON.stringify({ message: 1 }))
      expect(parse).not.toHaveBeenCalled()
      expect(JSON.parse(answer)).toEqual({ ok: false, error: expect.stringContaining('not offered') })
      expect(host.mayAsk).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('refuses a call for want of room before it is parsed: what would not be kept is not read', async () => {
    const { lents, fromTab, host, attach } = setup()
    const token = await attach()
    host.mayAsk.mockReturnValue(false)
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const text = JSON.stringify({ message: 'x'.repeat(LENT_CALL_MAX - 100) })
      const answer = await lents.call(fromTab, WORLD, token, 'send', text)
      expect(parse).not.toHaveBeenCalled()
      expect(JSON.parse(answer)).toEqual({ ok: false, error: PORT_CLOSED })
      expect(host.mayAsk).toHaveBeenCalledWith('default', EXT, text.length)
      expect(host.askWorker).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('refuses what is not a text, and an answer of the worker that is longer than is handed over, which it will not copy to the page', async () => {
    const { lents, fromTab, host, attach } = setup()
    const token = await attach()
    for (const payload of [{ message: 1 }, undefined, null, 5, ['x']]) expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'send', payload as unknown as string)), String(payload)).toEqual({ ok: false, error: 'The call carries no text.' })
    host.askWorker.mockResolvedValue({ ok: true, value: 'x'.repeat(LENT_PAYLOAD_MAX + 1) })
    expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'send', JSON.stringify({ message: 1 })))).toEqual({ ok: false, error: TOO_LONG })
    // The one at the limit goes back.
    host.askWorker.mockResolvedValue({ ok: true, value: 'x'.repeat(LENT_PAYLOAD_MAX - 100) })
    expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'send', JSON.stringify({ message: 1 }))).ok).toBe(true)
  })

  it('has the same token each time the runtime is asked for again in a document (the page keeps the one it was first given)', async () => {
    const { attach } = setup()
    const first = await attach()
    expect(await attach()).toBe(first)
  })

  it('answers with the words of the problem, and asks nothing of the worker, for a call it does not take', async () => {
    const { lents, fromTab, host, attach } = setup()
    const token = await attach()
    for (const [op, payload] of [['connect', send(1)], ['storage', JSON.stringify({ area: 'session', method: 'get', args: [] })], ['send', '{nope'], ['send', undefined], ['send', '{}'], ['storage', JSON.stringify({ area: 'local', method: 'getKeys', args: [] })]] as const) {
      expect(JSON.parse(await lents.call(fromTab, WORLD, token, op, payload)), `${op} ${String(payload)}`).toEqual({ ok: false, error: expect.any(String) })
    }
    expect(host.askWorker).not.toHaveBeenCalled()
  })

  it('refuses the storage to an extension that did not declare it, whatever its script does', async () => {
    const { lents, fromTab, host, attach } = setup({ permissions: ['activeTab', 'scripting'] })
    const token = await attach()
    expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'storage', JSON.stringify({ area: 'local', method: 'get', args: [] })))).toEqual({ ok: false, error: 'The extension has no permission to use chrome.storage.' })
    expect(host.askWorker).not.toHaveBeenCalled()
    // A message needs none.
    await lents.call(fromTab, WORLD, token, 'send', send(1))
    expect(host.askWorker).toHaveBeenCalledOnce()
  })

  it('is answered with an error when the worker does not start or says something that is not an answer', async () => {
    const { lents, fromTab, host, attach } = setup()
    const token = await attach()
    host.askWorker.mockRejectedValueOnce(new Error('The worker of the extension did not start'))
    expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'send', send(1)))).toEqual({ ok: false, error: 'The worker of the extension did not start' })
    host.askWorker.mockResolvedValueOnce('garbage')
    expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'send', send(1)))).toEqual({ ok: false, error: 'The extension gave no answer.' })
    host.askWorker.mockResolvedValueOnce(undefined)
    expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'send', send(1)))).toEqual({ ok: false, error: 'The extension gave no answer.' })
  })
})

describe('the runtime of a tab that is not lent', () => {
  it('is not given: a tab the extension does not hold is sent nothing and the script is told nothing, whether it was never lent or left its site', async () => {
    const { lents, sent, lent, host } = setup()
    lent.delete(`7:${EXT}`)
    expect(await lents.ensure(7, EXT, 'default')).toBe(false)
    expect(sent).toEqual([])
    // Another profile than the tab's is the same: not the extension's tab.
    lent.add(`7:${EXT}`)
    expect(await lents.ensure(7, EXT, 'another-profile')).toBe(false)
    expect(sent).toEqual([])
    expect(host.warn).not.toHaveBeenCalled()
  })

  it('is not recorded when the tab leaves its site while the page answers: the answer finds the loan gone', async () => {
    const { lents, nonceOfLast, fromTab, lent, ran } = setup({ run: (code) => handedTo(code).result })
    const asked = lents.ensure(7, EXT, 'default')
    await settle(1)
    lent.delete(`7:${EXT}`)
    lents.attachedBy(fromTab, nonceOfLast(), true, undefined)
    expect(await asked).toBe(false)
    lent.add(`7:${EXT}`)
    await expect(lents.toTab('default', EXT, 7, 1, `chrome-extension://${EXT}/x.js`, undefined)).rejects.toThrow(NO_RECEIVER)
    expect(ran).toEqual([])
  })
})

describe('a message of the extension for the script of a lent tab', () => {
  const ADDRESS = `chrome-extension://${EXT}/background.js`

  it('is handed to the script in the world of the extension, as data, with the extension as the sender; what the script answers is what comes back', async () => {
    const { lents, accept, ran } = setup({ run: (code) => handedTo(code, { ok: true, value: { heard: 1 } }).result })
    await accept()
    expect(await lents.toTab('default', EXT, 7, { type: 'mount' }, ADDRESS, undefined)).toEqual({ heard: 1 })
    expect(ran).toHaveLength(1)
    expect(ran[0]!.world).toBe(WORLD)
    expect(JSON.parse(handedTo(ran[0]!.code).texts[0]!)).toEqual({ kind: 'message', message: { type: 'mount' }, sender: { id: EXT, url: ADDRESS, origin: `chrome-extension://${EXT}` } })
  })

  it('cannot be turned into code by what it says: the message reaches the script as the text it is', async () => {
    const { lents, accept, ran } = setup({ run: (code) => handedTo(code).result })
    await accept()
    const hostile = '"); globalThis.owned = 1; (" </script>\\'
    await lents.toTab('default', EXT, 7, { hostile, [hostile]: 1 }, ADDRESS, 0)
    const { texts } = handedTo(ran[0]!.code)
    expect(JSON.parse(texts[0]!).message).toEqual({ hostile, [hostile]: 1 })
    // Run in a world of its own, the text did not run: the only thing it reached is the runtime it was handed to.
    const sandbox: Record<string, unknown> = { [LENT_RUNTIME_KEY]: { deliver: () => Promise.resolve('{"ok":true}') } }
    vm.runInNewContext(ran[0]!.code, sandbox)
    expect(sandbox['owned']).toBeUndefined()
  })

  it('says it was sent from the root of the extension when the address the shim gave is not one of the extension', async () => {
    const { lents, accept, ran } = setup({ run: (code) => handedTo(code).result })
    await accept()
    await lents.toTab('default', EXT, 7, 1, 'https://evil.example/', undefined)
    expect(JSON.parse(handedTo(ran[0]!.code).texts[0]!).sender).toEqual({ id: EXT, url: `chrome-extension://${EXT}/`, origin: `chrome-extension://${EXT}` })
  })

  it('has no receiver where no script of the extension runs: a tab it was not asked into, a frame that is not the top one, a tab no longer lent, another profile, a tab that went elsewhere', async () => {
    const { lents, accept, lent, navigate, ran, host } = setup({ run: (code) => handedTo(code).result })
    await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow(NO_RECEIVER)
    await accept()
    await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, 3)).rejects.toThrow(NO_RECEIVER)
    await expect(lents.toTab('other-profile', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow(NO_RECEIVER)
    await expect(lents.toTab('default', EXT, 8, 1, ADDRESS, undefined)).rejects.toThrow(NO_RECEIVER)
    await expect(lents.toTab('default', OTHER, 7, 1, ADDRESS, undefined)).rejects.toThrow(NO_RECEIVER)
    expect(ran).toEqual([])
    lent.delete(`7:${EXT}`)
    await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow(NO_RECEIVER)
    lent.add(`7:${EXT}`)
    await lents.toTab('default', EXT, 7, 1, ADDRESS, 0)
    expect(ran).toHaveLength(1)
    // The tab goes to another document: what was made there is gone, and nothing is handed to its empty world.
    navigate()
    await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow(NO_RECEIVER)
    expect(ran).toHaveLength(1)
    expect(host.warn).not.toHaveBeenCalled()
  })

  // A page can start a navigation that never commits (an answer 204, a download): its document, and the script injected in it, are still there, and what the extension sends it must still arrive.
  it('keeps the runtime through a navigation that only starts, one inside the document or of a frame, and loses it only when the main frame has gone to a new document', async () => {
    const { lents, navigate, emitter, ran, host, attach, fromTab } = setup({ run: (code) => handedTo(code).result })
    const token = await attach()
    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    emitter.emit('did-navigate-in-page')
    emitter.emit('did-frame-navigate')
    await lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)
    expect(ran).toHaveLength(1)
    // What its script asks of the workers, and the token of its calls, are kept too.
    expect(host.dropAsks).not.toHaveBeenCalled()
    expect(JSON.parse(await lents.call(fromTab, WORLD, token, 'send', JSON.stringify({ message: 1 })))).toEqual({ ok: true, value: 'pong' })
    lents.changed('default', EXT, 'local', { k: { newValue: 1 } })
    await settle()
    expect(ran).toHaveLength(2)
    navigate()
    await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow(NO_RECEIVER)
    expect(host.dropAsks).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('says there is no receiver when the world has no runtime any more (the script returned nothing), and what the script said when it answered an error', async () => {
    let next: unknown = undefined
    const { lents, accept } = setup({ run: () => next })
    await accept()
    await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow(NO_RECEIVER)
    next = JSON.stringify({ ok: false, error: PORT_CLOSED })
    await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow(PORT_CLOSED)
    next = JSON.stringify({ ok: true })
    expect(await lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).toBeUndefined()
  })

  it('ends with the port closed when the tab goes away under it, and with the error itself for any other failure', async () => {
    const { lents, accept, wc } = setup()
    await accept()
    wc.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('Render frame was disposed before the request completed'))
    await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow(PORT_CLOSED)
    wc.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('Script failed to execute'))
    await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow('Script failed to execute')
  })

  it('does not wait for ever for a script that never answers: the port is closed after the time it was given', async () => {
    const { lents, accept } = setup({ run: () => new Promise(() => undefined) })
    await accept()
    await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow(PORT_CLOSED)
  })

  it('does not read what the script answered when it is longer than is handed over: the answer is an error and the text is never parsed', async () => {
    const { lents, accept } = setup({ run: () => 'x'.repeat(LENT_PAYLOAD_MAX + 1) })
    await accept()
    const parse = vi.spyOn(JSON, 'parse')
    try {
      await expect(lents.toTab('default', EXT, 7, 1, ADDRESS, undefined)).rejects.toThrow(TOO_LONG)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('is refused when it is too long to hand over', async () => {
    const { lents, accept, ran } = setup({ run: (code) => handedTo(code).result })
    await accept()
    await expect(lents.toTab('default', EXT, 7, 'x'.repeat(16 * 1024 * 1024), ADDRESS, undefined)).rejects.toThrow('too long')
    expect(ran).toEqual([])
  })
})

describe('a change of the storage of the extension', () => {
  it('is told to the script of each tab where the extension has a runtime, which is still lent to it in that profile, and to no other', async () => {
    const { lents, accept, ran, lent } = setup({ run: (code) => handedTo(code).result })
    await accept()
    lents.changed('default', EXT, 'local', { k: { newValue: 1 } })
    await settle()
    expect(ran).toHaveLength(1)
    expect(JSON.parse(handedTo(ran[0]!.code).texts[0]!)).toEqual({ kind: 'changed', area: 'local', changes: { k: { newValue: 1 } } })
    lents.changed('other-profile', EXT, 'local', { k: {} })
    lents.changed('default', OTHER, 'local', { k: {} })
    lent.delete(`7:${EXT}`)
    lents.changed('default', EXT, 'local', { k: {} })
    await settle()
    expect(ran).toHaveLength(1)
  })

  it('is not told for an area a script does not have, or for changes that are not an object', async () => {
    const { lents, accept, ran } = setup({ run: (code) => handedTo(code).result })
    await accept()
    for (const area of ['session', 'managed', 'LOCAL', undefined, 5]) lents.changed('default', EXT, area, { k: {} })
    for (const changes of [null, undefined, 'text', 5]) lents.changed('default', EXT, 'local', changes)
    await settle()
    expect(ran).toEqual([])
  })

  it('is not told to a tab where the extension never had a runtime', async () => {
    const { lents, ran } = setup()
    lents.changed('default', EXT, 'local', { k: {} })
    await settle()
    expect(ran).toEqual([])
  })

  it('says in the journal when a script could not be told', async () => {
    const { lents, accept, wc, host } = setup()
    await accept()
    wc.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(new Error('Script failed to execute'))
    lents.changed('default', EXT, 'local', { k: {} })
    await settle()
    expect(host.warn).toHaveBeenCalledWith(expect.stringContaining('could not be handed'), expect.any(Error))
  })
})

describe('what is kept of a tab', () => {
  it('goes when the tab is gone: the request in flight is answered no, and nothing is handed to it any more', async () => {
    const { lents, nonceOfLast, host } = setup()
    const asked = lents.ensure(7, EXT, 'default')
    await settle(1)
    expect(nonceOfLast()).toEqual(expect.any(String))
    lents.tabGone(7)
    expect(await asked).toBe(false)
    expect(host.warn).toHaveBeenCalledWith(expect.stringContaining('the tab is gone'))
    expect(host.dropAsks).toHaveBeenCalledWith(7)
  })

  it('goes when the web contents is destroyed, and the runtime of the extension is lost with it', async () => {
    const { lents, accept, emitter, ran } = setup({ run: (code) => handedTo(code).result })
    await accept()
    emitter.emit('destroyed')
    await expect(lents.toTab('default', EXT, 7, 1, `chrome-extension://${EXT}/x.js`, undefined)).rejects.toThrow(NO_RECEIVER)
    expect(ran).toEqual([])
  })
})

describe('what a script of a tab has asked of the workers, and the tab it is in', () => {
  /** The real set of asks under a tab whose worker never answers: what is asked is kept, and counted. */
  function withRealAsks() {
    const made = setup()
    const sentToWorker: unknown[][] = []
    const asks = new LentAsks(async (...args: unknown[]) => void sentToWorker.push(args))
    made.host.askWorker.mockImplementation((profileId: unknown, extensionId: unknown, tab: unknown, op: unknown, payload: unknown, characters: unknown) => asks.ask(profileId as string, extensionId as string, tab as number, op as 'message', payload, characters as number))
    made.host.mayAsk.mockImplementation((profileId: unknown, extensionId: unknown, characters: unknown) => asks.canKeep(profileId as string, extensionId as string, characters as number))
    made.host.dropAsks.mockImplementation((tab: unknown) => asks.tabGone(tab as number))
    return { ...made, asks, sentToWorker }
  }
  const message = (n: number) => JSON.stringify({ message: { hold: n } })

  it('the 33rd that runs at once waits for a place, and what is beyond 32 running and 256 waiting is answered at once with the words of a closed port', async () => {
    const { lents, fromTab, attach, asks, sentToWorker } = withRealAsks()
    const token = await attach()
    const answers: string[] = []
    for (let i = 0; i < 32 + 256 + 3; i++) void lents.call(fromTab, WORLD, token, 'send', message(i)).then((text) => answers.push(text))
    await settle(5)
    expect(sentToWorker).toHaveLength(32)
    expect(asks.size).toBe(32 + 256)
    expect(answers.map((text) => JSON.parse(text))).toEqual([{ ok: false, error: PORT_CLOSED }, { ok: false, error: PORT_CLOSED }, { ok: false, error: PORT_CLOSED }])
  })

  it('is answered with a closed port, and the table is empty, when its tab closes', async () => {
    const { lents, fromTab, attach, asks } = withRealAsks()
    const token = await attach()
    const answers: string[] = []
    for (let i = 0; i < 40; i++) void lents.call(fromTab, WORLD, token, 'send', message(i)).then((text) => answers.push(text))
    await settle(5)
    expect(asks.size).toBe(40)
    lents.tabGone(7)
    await settle(5)
    expect(asks.size).toBe(0)
    expect(answers).toHaveLength(40)
    for (const text of answers) expect(JSON.parse(text)).toEqual({ ok: false, error: PORT_CLOSED })
  })

  it('is answered with a closed port when the tab goes to a new document, and kept when a navigation only starts and never commits', async () => {
    const { lents, fromTab, attach, asks, emitter, navigate } = withRealAsks()
    const token = await attach()
    const answers: string[] = []
    for (let i = 0; i < 5; i++) void lents.call(fromTab, WORLD, token, 'send', message(i)).then((text) => answers.push(text))
    await settle(5)
    emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await settle(5)
    expect(asks.size).toBe(5)
    expect(answers).toEqual([])
    navigate()
    await settle(5)
    expect(asks.size).toBe(0)
    expect(answers).toHaveLength(5)
  })

  it('does not hold more text than the budget of one extension: as many calls of the largest size as the budget holds, and the next is refused', async () => {
    const { lents, fromTab, attach, asks } = withRealAsks()
    const token = await attach()
    const fits = LENT_BUDGET_CHARACTERS / LENT_CALL_MAX
    const big = (n: number): string => JSON.stringify({ message: 'x'.repeat(LENT_CALL_MAX - 100) + n })
    const answers: string[] = []
    for (let i = 0; i < fits + 1; i++) void lents.call(fromTab, WORLD, token, 'send', big(i)).then((text) => answers.push(text))
    await settle(20)
    expect(asks.size).toBe(fits)
    expect(answers.map((text) => JSON.parse(text))).toEqual([{ ok: false, error: PORT_CLOSED }])
    lents.tabGone(7)
  })
})
