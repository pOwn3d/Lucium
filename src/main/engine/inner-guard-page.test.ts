// The protection of the frames and workers of a page, as the page carries it next to the colour scheme and an extension that debugs it (the rules of
// the session are in inner-guard.test.ts and own-session.test.ts): one session for both of ours, the page left to the extension, both back afterwards,
// and a page made while the protection is on protected from its first document. The web contents are fakes (electron-page.test-support.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FINGERPRINT_LEVELS } from '@shared/fingerprint'
import type { InnerTable } from '@shared/inner-guard'
import { engineForPages, FakePageContents, makePage } from './electron-page.test-support'
import { InnerGuard, innerGuardFor } from './inner-guard'
import { holdsOwnSession, ownSessionOf, type ProtocolDebugger } from './own-session'

vi.mock('electron', async () => (await import('./electron-page.test-support')).electronStub())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined))

const TABLE: InnerTable = { current: { origin: 'https://site.example', config: { ...FINGERPRINT_LEVELS.standard, seed: 7 } }, fallback: { ...FINGERPRINT_LEVELS.standard, seed: 1000 } }

/** The guard of a page's frames and workers, made as the engine makes it. */
function guardOf(wc: FakePageContents): InnerGuard {
  const dbg = wc.debugger as unknown as ProtocolDebugger
  return innerGuardFor(wc, () => new InnerGuard({ debugger: dbg, session: ownSessionOf(wc, dbg), guardText: '(function () {})', alive: () => !wc.destroyed, warn: vi.fn() }))
}
const methods = (wc: FakePageContents): string[] => wc.debugger.commands.map((command) => command.method)

describe('a page that protects its frames and workers', () => {
  it('shares one session with the colour scheme, whichever comes first, and keeps it until both have left', async () => {
    const { page, wc } = await makePage()
    page.setColorScheme('dark')
    guardOf(wc).set(TABLE)
    expect(wc.debugger.attaches).toBe(1)
    expect(methods(wc)).toEqual(['Emulation.setEmulatedMedia', 'Target.setAutoAttach', 'Page.enable', 'Page.addScriptToEvaluateOnNewDocument'])
    // The colour scheme leaves: the session stays for the frames, and the emulation is taken back by hand since no detach does it.
    page.setColorScheme(null)
    expect(wc.debugger.attached).toBe(true)
    expect(wc.debugger.commands.at(-1)).toEqual({ method: 'Emulation.setEmulatedMedia', params: { features: [] } })
    guardOf(wc).set(null)
    expect([wc.debugger.attached, wc.debugger.detaches]).toEqual([false, 1])

    const other = await makePage()
    guardOf(other.wc).set(TABLE)
    other.page.setColorScheme('light')
    expect(other.wc.debugger.attaches).toBe(1)
    guardOf(other.wc).set(null)
    expect(other.wc.debugger.attached).toBe(true)
    other.page.setColorScheme(null)
    expect(other.wc.debugger.attached).toBe(false)
  })

  it('says so when the emulation cannot be taken back from a session that stays', async () => {
    const { page, wc } = await makePage()
    page.setColorScheme('dark')
    guardOf(wc).set(TABLE)
    wc.debugger.sendCommand = () => Promise.reject(new Error('refused'))
    page.setColorScheme(null)
    await new Promise((resolve) => setImmediate(resolve))
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('cannot give the page back its own colour scheme'), 'refused')
  })

  it('keeps counting the user\'s clicks as the user\'s: the session is ours', async () => {
    const { wc } = await makePage()
    guardOf(wc).set(TABLE)
    expect(holdsOwnSession(wc)).toBe(true)
  })

  it('leaves the page to an extension that debugs it, and is back when the extension\'s session ends', async () => {
    const { page, wc } = await makePage()
    const guard = guardOf(wc)
    guard.set(TABLE)
    const heard: string[] = []
    page.debugAttach('1.3', (method) => heard.push(method), () => undefined, () => true)
    expect([guard.on, page.isDebugAttached(), wc.debugger.attaches, wc.debugger.detaches]).toEqual([false, true, 2, 1])
    // Nothing of ours answers the targets the extension is handed.
    const before = wc.debugger.commands.length
    wc.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'W1', targetInfo: { type: 'worker' } }, '')
    expect(wc.debugger.commands).toHaveLength(before)
    expect(heard).toEqual(['Target.attachedToTarget'])
    page.debugDetach()
    expect([guard.on, page.isDebugAttached(), wc.debugger.attaches]).toEqual([true, false, 3])
  })

  it('is back as well when the extension could not attach', async () => {
    const { page, wc } = await makePage()
    const guard = guardOf(wc)
    guard.set(TABLE)
    expect(() => page.debugAttach('1.3', () => undefined, () => undefined, () => false)).toThrow('Cannot attach')
    expect(guard.on).toBe(true)
    wc.debugger.attach = () => {
      throw new Error('refused')
    }
    // The extension's own attach is refused by Electron after ours stepped aside: ours is asked to come back (it is refused too, and says so).
    const refresh = vi.spyOn(guard, 'refresh')
    expect(() => page.debugAttach('1.3', () => undefined, () => undefined, () => true)).toThrow('refused')
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('the engine, for every page it makes', () => {
  it('hands a new page to the guard of the frames and workers when it is made, before it loads anything, and not the page of an extension', async () => {
    const { engine, create } = await engineForPages({ ready: null })
    const prime = engine.primeInnerGuard
    const tab = create('t1')
    expect(prime).toHaveBeenCalledTimes(1)
    expect(prime).toHaveBeenCalledWith(tab.view.webContents)
    expect(tab.view.webContents.loadURL).not.toHaveBeenCalled()
    create('panel', undefined, true)
    expect(prime).toHaveBeenCalledTimes(1)
  })
})
