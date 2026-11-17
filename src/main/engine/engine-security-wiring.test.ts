// The engine's side of the extension security rules: what it tells the rules of the library (`libraryRules`, the guard of restrictLibraryApis in
// ece-router.ts, tested there) and which input it takes for a gesture of the user (user-input.ts). Run on a stand-in of the engine: the class reaches
// Electron only when a method runs, and the constructor runs over a stand-in of Electron (engine-constructed.test-support.ts). The engine checks replay
// them in Electron (smoke-extensions.ts, smoke-webstore.ts).

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { LibraryGuard } from './ece-router'
import { constructEngine, defaultSession, emitApp, world } from './engine-constructed.test-support'
import { watchUserInput } from './user-input'

const holder = { defaultSession }
vi.mock('electron', async () => (await import('./engine-constructed.test-support')).engineElectron())
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined, handleCRXProtocol: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))

const { ElectronEngine } = await import('./electron-engine')
const engineMethods = ElectronEngine.prototype as unknown as Record<string, (this: unknown, ...args: unknown[]) => unknown>
const rules = engineMethods['libraryRules']!.call({}, 'p') as LibraryGuard

describe('the wiring of the extension security rules in the engine', () => {
  it('asks `restrictLibraryApis` to tell the interface from an extension by the session of the sender: the default one is the interface\'s', () => {
    expect(rules.fromInterface({ session: holder.defaultSession })).toBe(true)
    // An extension page or worker is in the session of its profile; a sender that says nothing of its session is not the interface either.
    expect(rules.fromInterface({ session: { name: 'the session of a profile' } })).toBe(false)
    expect(rules.fromInterface({})).toBe(false)
    expect(rules.fromInterface(null)).toBe(false)
    expect(rules.fromInterface(undefined)).toBe(false)
  })

  it('gives the router no trace to write while the log of the extensions is off (LUCIUM_EXT_LOG)', () => {
    expect(process.env['LUCIUM_EXT_LOG']).not.toBe('1')
    expect('trace' in rules).toBe(false)
  })

  it('does not take for a gesture of the user the input a debugger sends to a page', () => {
    const wc = Object.assign(new EventEmitter(), { debugger: { attached: false, isAttached(): boolean {
      return this.attached
    } } })
    const noted = vi.fn()
    watchUserInput(wc, noted)
    wc.emit('input-event', {}, { type: 'mouseDown' })
    wc.emit('input-event', {}, { type: 'mouseMove' })
    expect(noted).toHaveBeenCalledTimes(1)
    wc.debugger.attached = true
    wc.emit('input-event', {}, { type: 'mouseDown' })
    wc.emit('input-event', {}, { type: 'keyDown' })
    expect(noted).toHaveBeenCalledTimes(1)
  })

  // The engine is constructed as main() constructs it: its constructor is what listens to the web contents of the application (Electron's list and event).
  describe('the engine, constructed', () => {
    /** A web contents with the input events of one, and a debugger that is attached or not. */
    const contents = (attached = false) => Object.assign(new EventEmitter(), { debugger: { isAttached: () => attached } })

    it('notes the last gesture of a web contents that was born after it, and of one that existed before it', async () => {
      const before = contents()
      world.existing = [before]
      const engine = await constructEngine()
      const lastGesture = (): number => (engine as unknown as { lastUserInput: number }).lastUserInput
      expect(lastGesture()).toBe(0)
      vi.useFakeTimers({ now: 5_000 })
      try {
        before.emit('input-event', {}, { type: 'mouseDown' })
        expect(lastGesture()).toBe(5_000)
        vi.setSystemTime(9_000)
        const born = contents()
        emitApp('web-contents-created', born)
        born.emit('input-event', {}, { type: 'keyDown' })
        expect(lastGesture()).toBe(9_000)
        // The input a debugger sends is not a gesture of the user, on a web contents of either kind.
        vi.setSystemTime(12_000)
        const driven = contents(true)
        emitApp('web-contents-created', driven)
        driven.emit('input-event', {}, { type: 'mouseDown' })
        expect(lastGesture()).toBe(9_000)
      } finally {
        vi.useRealTimers()
        world.existing = []
      }
    })
  })
})
