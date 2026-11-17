// What the person allowed an extension to capture of the sound of a tab goes with the extension: the window of the shell (the real methods of Browser, over a real state and the real
// reducer) listens to the engine, which says when an extension left a profile or is no longer the one that was chosen (engine/extension-net-calls.test.ts has the engine's side).

import { describe, expect, it, vi } from 'vitest'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import type { SidebarState } from '@shared/model'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', async () => (await import('../engine/engine-constructed.test-support')).engineElectron())
// `Browser.start` runs on a stand-in: the blocking service and the shims of the extensions are inert, as their own tests run them.
vi.mock('../blocking', () => ({ blockingService: () => ({ subscribe: () => () => {} }) }))
vi.mock('./extension-shims', () => ({ ExtensionShims: class {} }))
vi.mock('electron-chrome-extensions', () => ({ ElectronChromeExtensions: { fromSession: () => undefined, handleCRXProtocol: () => undefined } }))
vi.mock('electron-chrome-web-store', () => ({}))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const ctx = { now: 1, newId: () => 'x' }
const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)

/** A window of the shell where the person allowed B and C in `default`, and B in `work`; `forgotten` is what the engine calls when an extension left. */
function windowWith() {
  let state: SidebarState = createInitialState(ctx)
  const dispatch = (action: Action): void => void (state = reduce(state, action, ctx))
  for (const [profileId, extensionId] of [['default', B], ['default', C], ['work', B]] as const) dispatch({ type: 'extension/set-tab-capture', profileId, extensionId, allowed: true })
  const actions: Action[] = []
  const fake = fakeBrowser({
    store: { get: () => state, subscribe: () => () => undefined, root: () => ({ get: () => state }) },
    dispatch: (action: Action) => (actions.push(action), dispatch(action)),
    isPrivate: () => false,
    isSecondary: () => false,
    gates: { gate: () => undefined },
    group: new Set(),
    forgetTabCaptureConsent: (profileId: string, extensionId: string) => shell['forgetTabCaptureConsent']!.call(fake.self, profileId, extensionId)
  })
  shell['start']!.call(fake.self)
  const registered = fake.calls.filter((call) => call.name === 'engine.onExtensionForgotten')
  return {
    registered,
    forgotten: (profileId: string, extensionId: string) => (registered[0]!.args[0] as (profileId: string, extensionId: string) => void)(profileId, extensionId),
    allowed: (profileId: string) => state.settings.profiles[profileId]?.tabCaptureExtensions,
    actions
  }
}

describe('what the person allowed an extension to capture', () => {
  it('is asked of the engine to be told, once: the engine says when an extension left or changed', () => {
    expect(windowWith().registered).toHaveLength(1)
  })

  it('goes with the extension, in the profile it left, and with no other extension and no other profile', () => {
    const world = windowWith()
    world.forgotten('default', B)
    expect(world.allowed('default')).toEqual([C])
    expect(world.allowed('work')).toEqual([B])
  })

  it('goes in the profile that is named, whichever it is', () => {
    const world = windowWith()
    world.forgotten('work', B)
    expect(world.allowed('work')).toBeUndefined()
    expect(world.allowed('default')).toEqual([B, C])
  })

  it('is gone for good when the last one goes: nothing of the profile is left that says so', () => {
    const world = windowWith()
    world.forgotten('default', B)
    world.forgotten('default', C)
    expect(world.allowed('default')).toBeUndefined()
  })

  it('is left as it was, and nothing is dispatched, for an extension that was not allowed, and for a profile that has no such choice', () => {
    const world = windowWith()
    world.actions.length = 0
    world.forgotten('default', A)
    world.forgotten('other', B)
    expect(world.actions).toEqual([])
    expect(world.allowed('default')).toEqual([B, C])
  })

  it('is forgotten once: telling it again changes nothing more', () => {
    const world = windowWith()
    world.forgotten('default', B)
    expect(world.allowed('default')).not.toContain(B)
    world.forgotten('default', B)
    expect(world.allowed('default')).toEqual([C])
  })
})
