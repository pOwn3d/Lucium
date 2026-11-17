// A click lets a page share the screen once: the check uses the click up, it does not only read it. The real check of the engine
// runs on a page of the engine whose clicks are noted in a real ledger; only Electron is a stand-in (the engine reaches it when its module loads).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GestureLedger, OPEN_GESTURE_WINDOW_MS } from '@shared/external-links'

vi.mock('electron', () => new Proxy({} as Record<string, unknown>, { get: (target, name: string) => (name in target ? target[name] : {}) }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: class { static fromSession() { return undefined } }, setSessionPartitionResolver() {} }))

const { ElectronEngine, ElectronPage } = await import('./electron-engine')

const NOW = 1_000_000

/** An engine with one tab page, shown in the web contents `wc`; `click` is what a real input in the page notes. */
function engineWithPage() {
  const ledger = new GestureLedger()
  const page = Object.assign(Object.create(ElectronPage.prototype) as object, { shareGesture: ledger })
  const wc = { id: 41 }
  const engine = Object.assign(Object.create(ElectronEngine.prototype) as object, { pageByContents: new Map([[wc.id, 'tab-1']]), pages: new Map([['tab-1', page]]) })
  const mayShare = (contents: unknown): boolean => (engine as unknown as { mayShareScreen(wc: unknown): boolean }).mayShareScreen(contents)
  return { wc, mayShare, click: () => ledger.note(Date.now()) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('the screen share after a click', () => {
  it('is allowed once per click: the click is used up by the share it allows', () => {
    const { wc, mayShare, click } = engineWithPage()
    click()
    expect(mayShare(wc)).toBe(true)
    // The page asks again without a new click: not the user.
    expect(mayShare(wc)).toBe(false)
    click()
    expect(mayShare(wc)).toBe(true)
  })

  it('is refused without a click in the page', () => {
    const { wc, mayShare } = engineWithPage()
    expect(mayShare(wc)).toBe(false)
  })

  it('is refused when the click is older than the few seconds it is good for', () => {
    const { wc, mayShare, click } = engineWithPage()
    click()
    vi.setSystemTime(NOW + OPEN_GESTURE_WINDOW_MS + 1)
    expect(mayShare(wc)).toBe(false)
  })

  it('is refused for what is not a tab page of the engine (a popup, a panel, an extension page), or for no contents at all', () => {
    const { mayShare, click } = engineWithPage()
    click()
    expect(mayShare({ id: 99 })).toBe(false)
    expect(mayShare(null)).toBe(false)
  })
})
