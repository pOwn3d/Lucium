// Test support (nothing of the application imports it): a stand-in for `this` when a method of the class Browser runs without Electron. The test
// gives the fields and the methods that matter to it; anything else it touches is a recorder: reading a member gives a recorder of that path
// (`this.overlay.webContents`), calling one writes the path and the arguments in `calls`, in order, and answers `undefined` (so a guard such as
// `wc.isDestroyed()` reads as false and `this.isPrivate()` as a normal window).

import { Channel } from '@shared/ipc'
import { defaultSettings, type Settings } from '@shared/model'
import { createInitialState } from '@shared/sidebar'

export interface Call {
  readonly name: string
  readonly args: readonly unknown[]
}

export interface FakeBrowser {
  /** The object to run the method on (`Browser.prototype.x.call(fake.self, …)`). */
  readonly self: Record<string, unknown>
  /** What the method called that the test did not give, in order. */
  readonly calls: Call[]
  /** The names of the calls only, in order. */
  names(): string[]
}

const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then'

function recorder(path: string, calls: Call[]): unknown {
  return new Proxy(function () {}, {
    get: (_target, prop) => (inert(prop) ? undefined : recorder(`${path}.${String(prop)}`, calls)),
    apply: (_target, _this, args: unknown[]) => {
      calls.push({ name: path, args })
      return undefined
    }
  })
}

export function fakeBrowser(own: Record<string, unknown> = {}): FakeBrowser {
  const calls: Call[] = []
  const self = new Proxy(own, {
    get: (target, prop) => (prop in target ? target[prop as string] : inert(prop) ? undefined : recorder(String(prop), calls)),
    set: (target, prop, value) => {
      target[prop as string] = value
      return true
    }
  })
  return { self, calls, names: () => calls.map((call) => call.name) }
}

/** A window with no panel open, no Eraser mode under way, and these settings: what `openOverlay` reads before it shows a panel. */
export function overlayHost(settings: Partial<Settings> = {}, own: Record<string, unknown> = {}): FakeBrowser {
  const state = { ...createInitialState({ now: 0, newId: () => 'x' }), settings: { ...defaultSettings(), ...settings } }
  return fakeBrowser({ zapping: false, overlayRequest: null, littleBarOpener: null, store: { get: () => state }, ...own })
}

/** Whether the stand-in sent this panel to the layer of the window. */
export function showedPanel(fake: FakeBrowser, panel: string): boolean {
  return fake.calls.some((call) => call.name === 'overlay.webContents.send' && call.args[0] === Channel.showOverlay && (call.args[1] as { panel?: string } | undefined)?.panel === panel)
}

/** The methods of a class, private and protected ones included, to run on a stand-in. */
export function methodsOf(prototype: object): Record<string, (this: unknown, ...args: unknown[]) => unknown> {
  return prototype as Record<string, (this: unknown, ...args: unknown[]) => unknown>
}
