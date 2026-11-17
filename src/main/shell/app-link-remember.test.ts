// « Toujours ouvrir les liens de ce type depuis ce site »: what the shell writes when the box of the question is ticked. The main process does
// not trust the panel: a yes is kept for one scheme of one site, a no is never kept by that box, and nothing is kept for a private tab or for
// the plain question of `openExternal`. The real `askPermission` and `answerPermission` run on a stand-in for the window.

import { describe, expect, it, vi } from 'vitest'
import type { OverlayRequest } from '@shared/ipc'
import { methodsOf, overlayHost } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const REAL = ['openOverlay', 'closeOverlay', 'setAsideQuestion', 'askPermission', 'putPermission', 'answerPermission', 'whenOnScreen', 'waitsOffScreen', 'parkOffScreenQuestions'] as const
const SITE = 'https://zoom.example'
const ALWAYS = 'openExternal:zoommtg:'

function windowAsking(permission: string, options: { ephemeral?: boolean; container?: string } = {}) {
  const dispatch = vi.fn()
  const fake = overlayHost(
    {},
    {
      dispatch,
      ownerOf: () => undefined,
      visibleIds: () => [],
      offScreenQuestions: new Map(),
      permissionQueue: [],
      permissionAnswers: new Map(),
      permissionPages: new Map(),
      permissionCounter: 0,
      authQueue: [],
      dialogQueue: [],
      reviewQueue: [],
      passphraseQueue: [],
      pendingSplit: null,
      ...Object.fromEntries(REAL.map((name) => [name, shell[name]]))
    }
  )
  const call = <T>(name: string, ...args: unknown[]): T => shell[name]!.call(fake.self, ...args) as T
  const answer = call<Promise<boolean>>('askPermission', SITE, permission, undefined, 'zoommtg:', options.ephemeral ?? false, options.container)
  const shown = fake.self['overlayRequest'] as Extract<OverlayRequest, { panel: 'permission' }>
  return { dispatch, answer, request: shown.request, reply: (allow: boolean, remember: boolean) => call<void>('answerPermission', shown.request.id, allow, remember) }
}

describe('the box « Toujours ouvrir les liens de ce type depuis ce site »', () => {
  it('keeps a yes for the site and the scheme, and the page gets its answer', async () => {
    const w = windowAsking(ALWAYS)
    expect(w.request).toMatchObject({ origin: SITE, permission: ALWAYS, detail: 'zoommtg:' })
    w.reply(true, true)
    expect(await w.answer).toBe(true)
    expect(w.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'permission/set', origin: SITE, permission: ALWAYS, decision: 'allow' })
  })

  it('keeps nothing when it is not ticked', async () => {
    const w = windowAsking(ALWAYS)
    w.reply(true, false)
    expect(await w.answer).toBe(true)
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  // Guard: the box says « always open »; ticked with « Refuser », it must not turn into a refusal nobody asks about again.
  it('keeps nothing when the answer is no, even ticked', async () => {
    const w = windowAsking(ALWAYS)
    w.reply(false, true)
    expect(await w.answer).toBe(false)
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  // Guard: the answer would outlive the private tab in the saved state, with the name of its site.
  it('keeps nothing for a private tab, whatever the panel sends back', async () => {
    const w = windowAsking(ALWAYS, { ephemeral: true })
    expect(w.request.ephemeral).toBe(true)
    w.reply(true, true)
    expect(await w.answer).toBe(true)
    expect(w.dispatch).not.toHaveBeenCalled()
  })

  it('keeps nothing for the plain question of openExternal (no click behind the link), nor for a scheme that never leaves', async () => {
    for (const permission of ['openExternal', 'openExternal:file:', 'openExternal:mailto:']) {
      const w = windowAsking(permission)
      w.reply(true, true)
      expect(await w.answer, permission).toBe(true)
      expect(w.dispatch, permission).not.toHaveBeenCalled()
    }
  })

  it('keeps the yes of a page of a container in that container', async () => {
    const w = windowAsking(ALWAYS, { container: 'work' })
    w.reply(true, true)
    expect(await w.answer).toBe(true)
    expect(w.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'container/permission', id: 'work', origin: SITE, permission: ALWAYS, decision: 'allow' })
  })

  // A refusal of another permission is still kept with its own box: only the links to an application keep a yes alone.
  it('leaves the other permissions as they were: a refusal ticked is kept', async () => {
    const w = windowAsking('geolocation')
    w.reply(false, true)
    expect(await w.answer).toBe(false)
    expect(w.dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'permission/set', origin: SITE, permission: 'geolocation', decision: 'deny' })
  })
})
