// "Traduire cette page…" on the page's right-click menu: the translation opens only when it is switched on (the panel refuses otherwise);
// when it is off, the entry opens the Outils settings where it is switched on.
// The real methods of the Browser run on a stand-in for the window: what is checked is what reaches the overlay and the Settings window.

import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/model'

// browser.ts reaches Electron only when a method runs; the import itself needs the names.
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))

const { Browser } = await import('./browser')
const methods = Browser.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>

/** The part of a window the menu entry and the overlay touch; whatever else they call does nothing. */
function windowWith(translateLocal: boolean) {
  const overlayShown: unknown[] = []
  const settingsOpened: unknown[][] = []
  const base: Record<string | symbol, unknown> = {
    store: { get: () => ({ settings: { ...defaultSettings(), translateLocal } }) },
    tooltipWindow: { hide() {} },
    zapping: false,
    overlayRequest: null,
    isPrivate: () => false,
    openOverlay: methods['openOverlay'],
    settingsOpener: (...args: unknown[]) => void settingsOpened.push(args),
    overlay: { setVisible() {}, webContents: { focus() {}, send: (_channel: string, request: unknown) => void overlayShown.push(request) } },
    publishQueue: { flush() {} }
  }
  const self = new Proxy(base, { get: (target, name) => (name in target ? target[name] : () => undefined) })
  return { self, overlayShown, settingsOpened }
}

describe('the translation entry of the page menu', () => {
  it('opens the translation panel when it is switched on', () => {
    const w = windowWith(true)
    methods['openTranslatePage']!.call(w.self)
    expect(w.overlayShown).toEqual([{ panel: 'translate' }])
    expect(w.settingsOpened).toEqual([])
  })

  it('opens the Outils settings, and not the translation panel, when it is switched off', () => {
    const w = windowWith(false)
    methods['openTranslatePage']!.call(w.self)
    expect(w.overlayShown).toEqual([])
    expect(w.settingsOpened).toEqual([['tools', undefined]])
  })

  it('refuses the translation panel itself while it is switched off, whoever asks', () => {
    const off = windowWith(false)
    methods['openOverlay']!.call(off.self, { panel: 'translate' })
    expect(off.overlayShown).toEqual([])
    const on = windowWith(true)
    methods['openOverlay']!.call(on.self, { panel: 'translate' })
    expect(on.overlayShown).toEqual([{ panel: 'translate' }])
  })
})
