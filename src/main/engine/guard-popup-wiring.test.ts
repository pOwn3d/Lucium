// The page guard of a popup and of the pages that are not tabs: the engine's answer to the preload (`answerGuardPlan`) and the WebRTC policy it sets
// (`syncWebRtc`), run on a stand-in of the engine (the class reaches Electron only when a method runs). The live check of a popup (a canvas read in a
// window a protected tab opens gives the same noised answer as the tab) is made by hand.

import { describe, expect, it, vi } from 'vitest'
import { NO_PLAN, type GuardPlan } from '@shared/page-guard'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: class {} }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const PROTECTED: GuardPlan = { ...NO_PLAN, fingerprint: { seed: 7 } as unknown as GuardPlan['fingerprint'] }

function contents(name: string) {
  const mainFrame = { url: `https://${name}.example/` }
  return { name, session: {}, mainFrame, isDestroyed: () => false, setWebRTCIPHandlingPolicy: vi.fn() }
}

/** An engine that knows one tab and one popup of that tab; `plan` is what the guard of their session gives a page. */
function engineWith(plan: GuardPlan) {
  const tab = contents('tab')
  const popup = contents('popup')
  const provider = vi.fn((_request: { pageUrl: string }) => plan)
  const engine = {
    guardProviderOf: () => provider,
    popups: { ownerKeyOf: (sender: unknown) => (sender === popup ? 'tab-1' : undefined) },
    pageOfContents: (sender: unknown) => (sender === tab ? { id: 'tab-1' } : undefined),
    webRtcGuarded: new WeakSet(),
    // The frames and the workers of a page have their own test (inner-guard-wiring.test.ts).
    syncInnerGuard: () => {},
    syncWebRtc(...args: unknown[]) {
      return engineMethods['syncWebRtc']!.apply(this, args)
    }
  }
  /** The preload of `sender` asks for its plan, from its main frame unless told otherwise. */
  const ask = (sender: ReturnType<typeof contents>, frame: unknown = sender.mainFrame): unknown => {
    const event: Record<string, unknown> = { sender, senderFrame: frame }
    engineMethods['answerGuardPlan']!.call(engine, event, (frame as { url?: string } | null)?.url)
    return event['returnValue']
  }
  return { tab, popup, provider, ask }
}

describe('the page guard of a popup and of the pages that are not tabs', () => {
  it('answers the preload of a popup window as it answers a tab: the fingerprint protection and the scriptlets are not left at the door of window.open', () => {
    const { tab, popup, provider, ask } = engineWith(PROTECTED)
    expect(ask(tab)).toBe(PROTECTED)
    expect(ask(popup)).toBe(PROTECTED)
    expect(provider.mock.calls.map(([request]) => request.pageUrl)).toEqual(['https://tab.example/', 'https://popup.example/'])
  })

  it('answers the blank window a page opened to write into with what its opener gets, and sets its WebRTC policy', () => {
    const { popup, provider, ask } = engineWith(PROTECTED)
    const blank = { url: 'about:blank' }
    Object.assign(popup, { mainFrame: blank, opener: { url: 'https://tab.example/compte' } })
    expect(ask(popup, blank)).toBe(PROTECTED)
    expect(provider.mock.calls.map(([request]) => request.pageUrl)).toEqual(['https://tab.example/compte'])
    expect(popup.setWebRTCIPHandlingPolicy.mock.calls).toEqual([['default_public_interface_only']])
  })

  it('answers nothing to a blank window nobody opened', () => {
    const { popup, provider, ask } = engineWith(PROTECTED)
    const blank = { url: 'about:blank' }
    Object.assign(popup, { mainFrame: blank, opener: null })
    expect(ask(popup, blank)).toBe(NO_PLAN)
    expect(provider).not.toHaveBeenCalled()
  })

  it('still answers nothing to a web contents that is neither a tab nor a popup (the interface, an extension page, a sign-in flow)', () => {
    const { tab, provider, ask } = engineWith(PROTECTED)
    const stranger = contents('interface')
    expect(ask(stranger)).toBe(NO_PLAN)
    // A frame inside a tab is not the page either.
    expect(ask(tab, { url: 'https://frame.example/' })).toBe(NO_PLAN)
    expect(provider).not.toHaveBeenCalled()
    expect(stranger.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled()
  })

  it('gives a page that is not a tab (a popup, a preview, a mini window, an application) the WebRTC policy of a protected page, and takes it back when the document it shows is not protected', () => {
    const guarded = engineWith(PROTECTED)
    guarded.ask(guarded.popup)
    guarded.ask(guarded.popup)
    // Only what changed is set.
    expect(guarded.popup.setWebRTCIPHandlingPolicy.mock.calls).toEqual([['default_public_interface_only']])

    const open = engineWith(NO_PLAN)
    open.ask(open.popup)
    expect(open.popup.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled()
    // The same web contents goes from a protected document to one left out: Chromium's own policy again.
    const sync = engineMethods['syncWebRtc']!
    const engine = { webRtcGuarded: new WeakSet() }
    const page = contents('page')
    sync.call(engine, page, true)
    sync.call(engine, page, false)
    expect(page.setWebRTCIPHandlingPolicy.mock.calls).toEqual([['default_public_interface_only'], ['default']])
  })
})
