import { describe, expect, it, vi } from 'vitest'
import { zapStopScript } from '@shared/boost'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The shell reaches Electron only when a method runs: the Eraser runs here on a stand-in (browser-fake.test-support.ts).
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

/** A page whose scripts are kept: the Eraser's own stays pending, as it does while the user picks. */
function erasing() {
  const scripts: string[] = []
  let finish: (picked: unknown) => void = () => undefined
  const page = { evaluate: (script: string) => (scripts.push(script), scripts.length === 1 ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(undefined)) }
  const state = createInitialState({ now: 0, newId: () => 'x' })
  const fake = fakeBrowser({ zapping: null, overlayRequest: null, activePage: () => page, store: { get: () => state } })
  return { fake, scripts, finish: (picked: unknown) => finish(picked) }
}

describe('the function that ends the Eraser from outside the page', () => {
  it('is ended by the name this use was started with, and that name is drawn again for the next use', async () => {
    const names: string[] = []
    for (let use = 0; use < 2; use++) {
      const { fake, scripts, finish } = erasing()
      const over = shell['startZap']!.call(fake.self, 'journal.example', 'b1') as Promise<void>
      const name = /const STOP = '(_[0-9a-f]{24})'/.exec(scripts[0]!)?.[1]
      expect(name, scripts[0]!.slice(0, 80)).toBeDefined()
      names.push(name!)
      shell['endZap']!.call(fake.self)
      expect(scripts[1]).toBe(zapStopScript(name!))
      finish([])
      await over
      expect(fake.self['zapping']).toBeNull()
      // Nothing the page is given names the application.
      for (const script of scripts) expect(script).not.toMatch(/lucium/i)
    }
    expect(names[0]).not.toBe(names[1])
  })

  it('has nothing to end when the Eraser is not on', () => {
    const { fake, scripts } = erasing()
    shell['endZap']!.call(fake.self)
    expect(scripts).toEqual([])
  })
})
