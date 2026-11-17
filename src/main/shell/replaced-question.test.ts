// A question on screen that the user has not answered (a permission, a login a server asks for, the review of an extension, a passphrase) is not
// lost when another panel opens over it: it shows again when that panel closes, and whoever asked gets an answer. The real `openOverlay` and
// `closeOverlay` of the shell run on a stand-in for the window (browser-fake.test-support.ts).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION_ARM_MS } from '@shared/permissions'
import type { OverlayRequest } from '@shared/ipc'
import { methodsOf, overlayHost, showedPanel, type FakeBrowser } from './browser-fake.test-support'

vi.mock('electron', () => new Proxy({}, { get: () => ({}) }))
const { Browser } = await import('./browser')
const shell = methodsOf(Browser.prototype)

const REAL = ['openOverlay', 'closeOverlay', 'setAsideQuestion', 'askPermission', 'putPermission', 'answerPermission', 'answerPermissionFromPanel', 'askAuth', 'putAuth', 'answerAuth', 'askExtensionReview', 'answerExtensionReview', 'askPassphrase', 'answerPassphrase', 'askLeave', 'answerLeave', 'whenOnScreen', 'waitsOffScreen', 'parkOffScreenQuestions'] as const

function windowWithQuestions(): { fake: FakeBrowser; call: <T>(name: string, ...args: unknown[]) => T; shown: () => OverlayRequest | null } {
  const fake = overlayHost(
    {},
    {
      ownerOf: () => undefined,
      visibleIds: () => [],
      offScreenQuestions: new Map(),
      permissionQueue: [],
      permissionAnswers: new Map(),
      permissionPages: new Map(),
      permissionCounter: 0,
      authQueue: [],
      authAnswers: new Map(),
      authCounter: 0,
      dialogQueue: [],
      dialogAnswers: new Map(),
      reviewQueue: [],
      reviewAnswers: new Map(),
      reviewCounter: 0,
      passphraseQueue: [],
      passphraseAnswers: new Map(),
      passphraseCounter: 0,
      leaveAnswers: new Map(),
      leaveCounter: 0,
      pendingSplit: null,
      ...Object.fromEntries(REAL.map((name) => [name, shell[name]]))
    }
  )
  const call = <T>(name: string, ...args: unknown[]): T => shell[name]!.call(fake.self, ...args) as T
  return { fake, call, shown: () => fake.self['overlayRequest'] as OverlayRequest | null }
}

const idOf = (request: OverlayRequest | null): string => (request as { request: { id: string } }).request.id

describe('a question on screen when another panel opens over it', () => {
  it('a permission comes back when the panel closes, and its answer reaches the page', async () => {
    const w = windowWithQuestions()
    const answer = w.call<Promise<boolean>>('askPermission', 'https://visio.example', 'media')
    expect(w.shown()?.panel).toBe('permission')
    const id = idOf(w.shown())
    w.call('openOverlay', { panel: 'commandbar' })
    expect(w.shown()?.panel).toBe('commandbar')
    w.call('closeOverlay')
    // The same question, not a new one.
    expect(w.shown()?.panel).toBe('permission')
    expect(idOf(w.shown())).toBe(id)
    w.call('answerPermission', id, true, false)
    expect(await answer).toBe(true)
  })

  it('a login a server asks for comes back as well: the page is not left waiting, and its next logins are asked', async () => {
    const w = windowWithQuestions()
    const request = { id: 'auth-1', host: 'intranet.example', realm: 'Zone', isProxy: false }
    const answer = w.call<Promise<unknown>>('askAuth', request, 'page-1')
    expect(w.shown()?.panel).toBe('auth')
    w.call('openOverlay', { panel: 'downloads' })
    w.call('closeOverlay')
    expect(w.shown()?.panel).toBe('auth')
    w.call('answerAuth', 'auth-1', { username: 'u', password: 'p' })
    expect(await answer).toEqual({ username: 'u', password: 'p' })
  })

  it('the review of an extension and a passphrase come back, each in its turn', async () => {
    const w = windowWithQuestions()
    const phrase = w.call<Promise<string | null>>('askPassphrase', 'Titre', 'Message')
    expect(w.shown()?.panel).toBe('passphrase')
    w.call('openOverlay', { panel: 'commandbar' })
    const review = w.call<Promise<boolean>>('askExtensionReview', { profileId: 'default', mode: 'install', extensionId: 'a'.repeat(32), review: {} })
    w.call('closeOverlay')
    // The review goes first (the order of `closeOverlay`), the passphrase after it: neither is lost.
    expect(w.shown()?.panel).toBe('extreview')
    w.call('answerExtensionReview', idOf(w.shown()), false)
    expect(await review).toBe(false)
    expect(w.shown()?.panel).toBe('passphrase')
    w.call('answerPassphrase', idOf(w.shown()), 'secret')
    expect(await phrase).toBe('secret')
  })

  it('« Quitter ce site ? » is answered as staying: it has no line to wait in', async () => {
    const w = windowWithQuestions()
    const answer = w.call<Promise<boolean>>('askLeave', 'page-1', 'site.example')
    expect(w.shown()?.panel).toBe('leave')
    w.call('openOverlay', { panel: 'commandbar' })
    expect(await answer).toBe(false)
    w.call('closeOverlay')
    expect(w.shown()).toBeNull()
  })

  it('a question whose page went while it waited behind the panel is not shown again', async () => {
    const w = windowWithQuestions()
    const answer = w.call<Promise<unknown>>('askAuth', { id: 'auth-1', host: 'intranet.example', realm: 'Zone', isProxy: false }, 'page-1')
    w.call('openOverlay', { panel: 'commandbar' })
    w.call('answerAuth', 'auth-1', null)
    expect(await answer).toBeNull()
    w.call('closeOverlay')
    expect(w.shown()).toBeNull()
    expect(showedPanel(w.fake, 'auth')).toBe(true)
  })
})

describe('« Autoriser » clicked as the bubble appears', () => {
  afterEach(() => vi.useRealTimers())

  it('is not an answer: the question stays on screen, and the same click counts once the bubble has been there long enough to be seen', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const w = windowWithQuestions()
    let answered: boolean | null = null
    void w.call<Promise<boolean>>('askPermission', 'https://visio.example', 'media').then((allow) => (answered = allow))
    const id = idOf(w.shown())
    vi.setSystemTime(1_000_000 + PERMISSION_ARM_MS - 1)
    w.call('answerPermissionFromPanel', id, true, true)
    await Promise.resolve()
    expect(answered).toBeNull()
    expect(w.shown()?.panel).toBe('permission')
    vi.setSystemTime(1_000_000 + PERMISSION_ARM_MS)
    w.call('answerPermissionFromPanel', id, true, false)
    await Promise.resolve()
    expect(answered).toBe(true)
    expect(w.shown()).toBeNull()
  })

  it('a refusal is taken at once', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const w = windowWithQuestions()
    const answer = w.call<Promise<boolean>>('askPermission', 'https://visio.example', 'media')
    w.call('answerPermissionFromPanel', idOf(w.shown()), false, false)
    expect(await answer).toBe(false)
  })

  it('the delay starts again when the question comes back after another panel', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const w = windowWithQuestions()
    let answered: boolean | null = null
    void w.call<Promise<boolean>>('askPermission', 'https://visio.example', 'media').then((allow) => (answered = allow))
    const id = idOf(w.shown())
    vi.setSystemTime(1_010_000)
    w.call('openOverlay', { panel: 'commandbar' })
    w.call('closeOverlay')
    w.call('answerPermissionFromPanel', id, true, false)
    await Promise.resolve()
    expect(answered).toBeNull()
  })

  it('the answer the interface sends goes through that delay, and nothing else answers for it', () => {
    const source = readFileSync(fileURLToPath(new URL('./ipc.ts', import.meta.url)), 'utf8')
    const handler = source.slice(source.indexOf('(Channel.answerPermission,'))
    expect(handler.slice(0, 200)).toContain('browser.answerPermissionFromPanel(id, allow === true, remember === true)')
  })
})
