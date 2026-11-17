// What `Browser.start` sets up for a window depends on its kind: the main window holds the engine hooks and the services of the application, a
// private window and a second window over the same tabs do not. `start` runs here on a stand-in (browser-fake.test-support.ts): the engine, the
// window and the views are recorders, the gates are counted.

import { describe, expect, it, vi } from 'vitest'
import { createInitialState } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

// The shell reaches Electron only when a method runs. The blocking service and the shims of the extensions are made from Electron's paths and
// events: here they are inert, as their own tests run them (blocking/service.test.ts, extension-shims*.test.ts).
vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
vi.mock('../blocking', () => ({ blockingService: () => ({ subscribe: () => () => {} }) }))
vi.mock('./extension-shims', () => ({ ExtensionShims: class {} }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

type Kind = 'main' | 'private' | 'secondary'

function start(kind: Kind) {
  const gates: string[] = []
  const state = createInitialState({ now: 0, newId: () => 'x' })
  const fake = fakeBrowser({
    isPrivate: () => kind === 'private',
    isSecondary: () => kind === 'secondary',
    gates: { gate: (id: string) => void gates.push(id) },
    store: { get: () => state, subscribe: () => () => {} },
    group: new Set()
  })
  shell['start']!.call(fake.self)
  return { gates, engine: (name: string) => fake.calls.filter((call) => call.name === `engine.${name}`).length }
}

describe('the download listener of a window', () => {
  it('is registered once with its engine, by the main window and by a private window: a second one doubled every publication of a download', () => {
    expect(start('main').engine('onDownload')).toBe(1)
    expect(start('private').engine('onDownload')).toBe(1)
  })

  it('is not registered by a second window over the same tabs: the main window keeps the downloads of the group', () => {
    expect(start('secondary').engine('onDownload')).toBe(0)
  })
})

describe('the live folders', () => {
  // A private window has a store of its own and is never read: the gate is made by the main window only.
  it('are gated by the main window only, never by a private or a second window', () => {
    expect(start('main').gates).toContain('live-folders')
    expect(start('private').gates).not.toContain('live-folders')
    expect(start('secondary').gates).not.toContain('live-folders')
  })
})
