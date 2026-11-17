// The traces of the main process do not write an address in full or a page title: the host is enough for a diagnosis, and a query can
// carry a token. Run on the real code: the watch of the empty tabs over the real reducer, the shell's trace of their birth (`Browser.openedBy`)
// and the engine's handler of a screen share (`installDisplayMedia`) on stand-ins (the classes reach Electron only when a method runs).

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { activeTab, createInitialState, reduce, type Action } from '@shared/sidebar'
import { BlankTabWatch } from './shell/blank-tab-watch'

const shared = vi.hoisted(() => ({ handler: null as null | ((request: unknown, callback: (streams: unknown) => void) => void) }))
vi.mock('electron', async () =>
  (await import('./engine/electron-page.test-support')).electronStub({
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    // The page that asks is a page of a site: no web contents is the helper page of a capture.
    webContents: { fromFrame: () => undefined },
    // A window whose name is the title of its page: what the trace must not write.
    desktopCapturer: { getSources: async () => [{ id: 'window:42:0', name: 'Relevé de compte de M. Dupont — Banque' }] }
  })
)
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { Browser } = await import('./shell/browser')
const { ElectronEngine } = await import('./engine/electron-engine')
const shellMethods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

const SECRET_ADDRESS = 'https://banque.example/compte/releve?token=SECRET-42'
const TITLE = 'Relevé de compte de M. Dupont'

let info: MockInstance<typeof console.info>
let warn: MockInstance<typeof console.warn>
beforeEach(() => {
  vi.useFakeTimers()
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Every line written to the log with `tag`. */
const traced = (tag: string): string[] => [...info.mock.calls, ...warn.mock.calls].map((call) => call.map(String).join(' ')).filter((line) => line.includes(tag))

describe('the traces of the main process', () => {
  it('write the host of an empty tab, never its full address or its title', () => {
    const ctx = { now: 1, newId: (() => { let next = 0; return () => `t${++next}` })() }
    let state = reduce(createInitialState(ctx), { type: 'tab/open', url: 'https://autre.example/' }, ctx)
    const dispatch = (action: Action) => {
      ctx.now += 1
      state = reduce(state, action, ctx)
    }
    const watch = new BlankTabWatch({ store: { get: () => state }, dispatch, displayed: () => false, overlayOpen: () => false, isSummary: () => false, shownElsewhere: () => new Set() })
    const shell = { store: { get: () => state } }
    // ⌘T: the shell traces the birth of the empty tab, the watch marks it.
    const action: Action = { type: 'tab/open', url: 'about:blank' }
    shellMethods['openedBy']!.call(shell, 'interface', () => watch.applyFromInterface(action, () => dispatch(action)))
    const blank = activeTab(state)!.id
    // The tab gets an address and a title the user did not type (the page has not committed yet), then the user leaves it: the watch decides about it.
    dispatch({ type: 'tab/update', id: blank, patch: { url: SECRET_ADDRESS, title: TITLE } })
    const other = state.tabs.find((tab) => tab.id !== blank)!.id
    dispatch({ type: 'tab/select', id: other })
    watch.watch(blank, other)
    vi.runAllTimers()

    const lines = traced('[blank-tab]')
    expect(lines.some((line) => line.includes('created'))).toBe(true)
    expect(lines.some((line) => line.includes('deciding') && line.includes('host=https://banque.example '))).toBe(true)
    for (const line of lines) {
      expect(line).not.toContain('SECRET')
      expect(line).not.toContain('/compte')
      expect(line).not.toContain('Dupont')
    }
    // Not covered: the reason kept when the page commits an address (`addressCommitted`) still carries that address in full; changing what the
    // trace says is a change of its own.
  })

  it('do not write the name of a window asked for a share', async () => {
    const ses = { setDisplayMediaRequestHandler: (handler: typeof shared.handler) => (shared.handler = handler) }
    const ownWindowShared = vi.fn()
    const page = { window: { isDestroyed: () => false, getMediaSourceId: () => 'window:1:0' }, ownWindowShared }
    const engine = { chooseShare: async () => 'window:42:0', pageOfFrame: () => page, askerOfDisplayRequest: engineMethods['askerOfDisplayRequest'], tabCaptures: { isHelper: () => false } }
    engineMethods['installDisplayMedia']!.call(engine, ses)
    const answered = new Promise((resolve) => shared.handler!({ frame: { url: 'https://visio.example/salle' }, userGesture: true, videoRequested: true, audioRequested: false }, resolve))
    await vi.runAllTimersAsync()
    expect(await answered).not.toBeNull()
    expect(ownWindowShared).toHaveBeenCalledWith('window:42:0')
    const lines = traced('[annotate-share]')
    expect(lines).toEqual(['[annotate-share] choix: id=window:42:0 fenetre-demandeuse=window:1:0 page=oui'])
    for (const line of [...info.mock.calls, ...warn.mock.calls].map((call) => call.map(String).join(' '))) expect(line).not.toContain('Dupont')
  })
})
