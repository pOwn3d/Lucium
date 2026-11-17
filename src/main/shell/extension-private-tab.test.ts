// An extension never sees a private tab, nor captures it. A private tab of a normal window is in a space, so it has a profile, the one of the
// extensions that run there: `chrome.tabs.captureVisibleTab` and the "active tab of the window" are answered from the tab on screen, and that tab
// must be refused because it is private, not because the extension runtime happens not to know its page. The real methods of the class Browser
// (`activeTabFor`, `captureActiveFor`) on a stand-in whose page would hand over its picture if it were asked.

import { describe, expect, it, vi } from 'vitest'
import type { SidebarState } from '@shared/model'
import { PRIVATE_PROFILE_ID } from '@shared/private-window'
import { createInitialState, reduce, type Action } from '@shared/sidebar'
import { fakeBrowser, methodsOf } from './browser-fake.test-support'

vi.mock('electron', () => {
  const inert = (prop: string | symbol): boolean => typeof prop === 'symbol' || prop === 'then' || prop === '__esModule'
  const stub: unknown = new Proxy(function () {}, { get: (_t, prop) => (inert(prop) ? undefined : stub), apply: () => stub })
  return new Proxy({} as Record<string, unknown>, { get: (t, prop: string) => (prop in t ? t[prop] : inert(prop) ? undefined : stub) })
})

const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

/** A window on a space of the default profile, with an ordinary tab and a private one; `shown` says which is on screen. */
function windowShowing(shown: 'ordinary' | 'private', privateWindow = false) {
  let n = 0
  const ctx = { now: 0, newId: () => `id-${n++}` }
  let state: SidebarState = createInitialState(ctx)
  const run = (action: Action): void => void (state = reduce(state, action, ctx))
  run({ type: 'tab/open', url: 'https://ordinary.example/' })
  run({ type: 'tab/open', url: 'https://secret.example/', private: true })
  const ordinary = state.tabs.find((t) => t.private !== true)!
  const secret = state.tabs.find((t) => t.private === true)!
  run({ type: 'tab/select', id: shown === 'private' ? secret.id : ordinary.id })
  const captureViewport = vi.fn(async () => Buffer.from('picture'))
  const fake = fakeBrowser({
    store: { get: () => state },
    isPrivate: () => privateWindow,
    // The page on screen answers a capture whatever its tab is: only the rule under test stands in the way.
    activePage: () => ({ captureViewport }),
    containerKeyOf: shell['containerKeyOf'],
    tabShownTo: shell['tabShownTo']
  })
  const profileId = state.spaces[0]!.profileId
  return {
    profileId,
    ordinary,
    secret,
    captureViewport,
    activeTabFor: (profile = profileId) => shell['activeTabFor']!.call(fake.self, profile),
    captureActiveFor: (profile = profileId) => shell['captureActiveFor']!.call(fake.self, profile, 'png', 90) as Promise<Buffer | null>
  }
}

describe('what an extension is told of the tab on screen', () => {
  it('is the tab and its picture when the tab is an ordinary one of the profile of the extension (the premise)', async () => {
    const w = windowShowing('ordinary')
    expect(w.activeTabFor()).toEqual({ id: w.ordinary.id, url: 'https://ordinary.example/' })
    expect((await w.captureActiveFor())?.toString()).toBe('picture')
    expect(w.captureViewport).toHaveBeenCalledOnce()
  })

  it('is nothing when the tab on screen is private: neither its address nor its picture, and the page is not even asked', async () => {
    const w = windowShowing('private')
    expect(w.secret.spaceId).toBe(w.ordinary.spaceId)
    expect(w.activeTabFor()).toBeNull()
    expect(await w.captureActiveFor()).toBeNull()
    expect(w.captureViewport).not.toHaveBeenCalled()
  })

  it('is nothing in a private window, whatever profile asks and whatever tab is on screen', async () => {
    for (const shown of ['ordinary', 'private'] as const) {
      const w = windowShowing(shown, true)
      for (const profile of [w.profileId, PRIVATE_PROFILE_ID]) {
        expect(w.activeTabFor(profile), `${shown} ${profile}`).toBeNull()
        expect(await w.captureActiveFor(profile), `${shown} ${profile}`).toBeNull()
      }
      expect(w.captureViewport).not.toHaveBeenCalled()
    }
  })
})
