// A panel that closes is said to the layer that draws it: the layer then unmounts it. Without that message the closed panel stayed mounted, out
// of sight, with what it held (a password typed, a capture, a list) until the next panel opened, and what it was waiting to do (a page to
// forget once the time to take it back is over) was left to a timer in a hidden page. The real `closeOverlay` and `openOverlay` of the shell on
// a stand-in for the window; what the layer does with the message is in renderer/overlay-host.test.ts.

import { describe, expect, it, vi } from 'vitest'
import { Channel, type OverlayRequest } from '@shared/ipc'
import { methodsOf, overlayHost } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

/** A window with this panel open, and these permission questions waiting for the layer. */
function windowWith(overlayRequest: OverlayRequest | null, permissionQueue: unknown[] = []) {
  const fake = overlayHost({}, {
    overlayRequest,
    permissionQueue,
    authQueue: [],
    dialogQueue: [],
    reviewQueue: [],
    passphraseQueue: [],
    openArcGuideAfterImport: () => false,
    openOverlay: (request: OverlayRequest) => shell['openOverlay']!.call(fake.self, request)
  })
  /** What the layer was told to draw, in order. */
  const told = (): unknown[] => fake.calls.filter((call) => call.name === 'overlay.webContents.send' && call.args[0] === Channel.showOverlay).map((call) => call.args[1])
  return { fake, told, close: () => shell['closeOverlay']!.call(fake.self) }
}

describe('closing a panel', () => {
  it('tells the layer that nothing is shown any more, before the layer is taken out of the window', () => {
    const w = windowWith({ panel: 'history' })
    w.close()
    expect(w.told()).toEqual([null])
    const names = w.fake.names()
    expect(names.indexOf('overlay.webContents.send')).toBeGreaterThan(-1)
    expect(names.indexOf('overlay.webContents.send')).toBeLessThan(names.indexOf('win.contentView.removeChildView'))
    expect(w.fake.self['overlayRequest']).toBeNull()
  })

  it('tells nothing when no panel was open', () => {
    const w = windowWith(null)
    w.close()
    expect(w.told()).toEqual([])
  })

  it('tells it before the question that was waiting takes the layer: the layer never keeps the panel that closed under the next one', () => {
    const request = { id: 7, origin: 'https://a.example', permission: 'geolocation' }
    const w = windowWith({ panel: 'history' }, [request])
    w.close()
    expect(w.told()).toEqual([null, { panel: 'permission', request }])
  })
})
