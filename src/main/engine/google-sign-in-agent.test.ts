import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GoogleSignInIdentity } from '@shared/google-sign-in'
import { MAX_TAKEN_OVER, SignInAgents, type SignInContents } from './google-sign-in-agent'

const PAGE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
const ELECTRON = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Lucium/1.1.0 Chrome/156.0.8078.48 Electron/45.2.1 Safari/537.36'
const identity: GoogleSignInIdentity = { agent: ELECTRON, pageAgent: PAGE }
const SIGN_IN = 'https://accounts.google.com/AccountChooser/signinchooser?continue=https://mail.google.com/mail/'
const GMAIL = 'https://mail.google.com/mail/u/0/'

/**
 * A web contents as far as the sign-in identity reads it: the events it emits, the user agent it was given and DURING WHICH EVENT (Chromium reloads a tab whose user agent changes
 * while a navigation loads, except during `did-start-navigation`: `setDuring` says where a call was made), the redirects that were cancelled, the loads it was asked for, and failures on demand.
 */
class FakeContents extends EventEmitter implements SignInContents {
  readonly session = { name: 'session of the tab' }
  userAgents: string[] = []
  setDuring: Array<string | null> = []
  prevented = 0
  loaded: string[] = []
  destroyed = false
  setFails = false
  loadFails: unknown = null
  loadThrows: unknown = null
  private emitting: string | null = null
  constructor(readonly id: number) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  setUserAgent(agent: string): void {
    if (this.setFails) throw new Error('refused')
    this.userAgents.push(agent)
    this.setDuring.push(this.emitting)
  }
  loadURL(url: string): Promise<void> {
    this.loaded.push(url)
    if (this.loadThrows !== null) throw this.loadThrows
    return this.loadFails === null ? Promise.resolve() : Promise.reject(this.loadFails)
  }
  /** What Electron emits for a main-frame navigation: the details are the first argument, whichever the event, with `preventDefault` that counts. */
  go(event: string, url: string, extra: Record<string, unknown> = {}): void {
    this.emitting = event
    try {
      this.emit(event, { url, isMainFrame: true, isSameDocument: false, preventDefault: () => void this.prevented++, ...extra })
    } finally {
      this.emitting = null
    }
  }
}

const watched = (id = 1, agents: SignInAgents = new SignInAgents(identity)) => {
  const contents = new FakeContents(id)
  agents.watch(contents)
  return { contents, agents }
}

/** Past the `setImmediate` a redirect that is taken over is sent on in. */
const moment = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A tab that is on a page of the web (`did-start-navigation` to it), or on the sign-in host, whose last main-frame request is a GET. */
function tabOn(url: string, id = 1) {
  const both = watched(id)
  both.contents.go('did-start-navigation', url)
  both.agents.noteRequest(id, 'GET')
  return both
}

afterEach(() => vi.restoreAllMocks())

describe('the tabs on the sign-in pages of Google', () => {
  it('a tab that starts a navigation to the sign-in host gets Electron’s own user agent before the request, and is known as being on it', () => {
    const { contents, agents } = watched()
    expect(agents.has(1)).toBe(false)
    contents.go('did-start-navigation', 'https://accounts.google.com/v3/signin/identifier')
    expect(contents.userAgents).toEqual([ELECTRON])
    expect(agents.has(1)).toBe(true)
  })

  it('a tab that leaves the hosts gets the own user agent of the pages back, once, and is no longer known as being on them', () => {
    const { contents, agents } = tabOn('https://accounts.google.com/')
    contents.go('did-start-navigation', 'https://accounts.google.com/v3/signin/identifier')
    contents.go('did-start-navigation', GMAIL)
    contents.go('did-start-navigation', 'https://site.example/')
    expect(contents.userAgents).toEqual([ELECTRON, PAGE])
    expect(agents.has(1)).toBe(false)
  })

  it('the user agent of a tab is set from did-start-navigation and from nowhere else: Chromium reloads a tab whose user agent changes during any other event, and the navigation under way is lost', () => {
    const { contents, agents } = tabOn('https://site.example/')
    // Coming in: the events that follow the start of a navigation never set it, whether the redirect is taken over or not.
    contents.go('will-navigate', 'https://accounts.google.com/')
    contents.go('will-redirect', 'https://accounts.google.com/')
    contents.go('did-redirect-navigation', 'https://accounts.google.com/')
    expect(contents.userAgents).toEqual([])
    expect(agents.has(1)).toBe(false)
    // Going out, from a tab that is in.
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    for (const event of ['will-navigate', 'will-redirect', 'did-redirect-navigation']) contents.go(event, 'https://site.example/')
    expect(contents.userAgents).toEqual([ELECTRON])
    expect(agents.has(1)).toBe(true)
    // Every call there was came from did-start-navigation.
    expect(contents.setDuring).toEqual(['did-start-navigation'])
    contents.go('did-start-navigation', 'https://site.example/')
    expect(contents.setDuring).toEqual(['did-start-navigation', 'did-start-navigation'])
  })

  it('a tab that was never on the hosts is never given anything: not for the other Google hosts, not for any site', () => {
    const { contents, agents } = watched()
    for (const url of ['https://mail.google.com/', 'https://accounts.google.com.example/', 'https://site.example/', 'about:blank']) {
      contents.go('did-start-navigation', url)
      contents.go('did-redirect-navigation', url)
    }
    expect(contents.userAgents).toEqual([])
    expect(agents.has(1)).toBe(false)
  })

  it('looks at the main frame and at a new document only: a frame of the page, and a move inside the same document, change nothing', () => {
    const { contents, agents } = watched()
    contents.go('did-start-navigation', 'https://accounts.google.com/gsi/iframe/select', { isMainFrame: false })
    contents.go('did-start-navigation', 'https://accounts.google.com/v3/signin#step', { isSameDocument: true })
    expect(contents.userAgents).toEqual([])
    expect(agents.has(1)).toBe(false)
    // The same events inside a tab that is on the host do not take it off, either.
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    contents.go('did-start-navigation', 'https://site.example/frame', { isMainFrame: false })
    contents.go('did-start-navigation', 'https://site.example/#a', { isSameDocument: true })
    expect(contents.userAgents).toEqual([ELECTRON])
    expect(agents.has(1)).toBe(true)
  })

  it('ignores an event that does not carry what it should, even in a tab that is on the host: it is not taken off it', () => {
    const { contents, agents } = watched()
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    contents.emit('did-start-navigation', undefined as never)
    contents.emit('did-start-navigation', {})
    contents.emit('did-start-navigation', { url: 42, isMainFrame: true })
    contents.emit('did-start-navigation', { isMainFrame: true })
    contents.emit('did-start-navigation', { url: 'https://site.example/', isMainFrame: 'yes' })
    expect(contents.userAgents).toEqual([ELECTRON])
    expect(agents.has(1)).toBe(true)
  })

  it('ignores an event that does not carry what it should, and a tab that is gone', () => {
    const { contents, agents } = watched()
    contents.emit('did-start-navigation', undefined as never)
    contents.emit('did-start-navigation', {})
    contents.emit('did-start-navigation', { url: 42, isMainFrame: true })
    contents.emit('did-start-navigation', { url: 'https://accounts.google.com/', isMainFrame: 'yes' })
    contents.destroyed = true
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    expect(contents.userAgents).toEqual([])
    expect(agents.has(1)).toBe(false)
  })

  it('every tab has its own state: one on the host does not carry another onto it, nor bring it back', () => {
    const agents = new SignInAgents(identity)
    const a = watched(1, agents).contents
    const b = watched(2, agents).contents
    a.go('did-start-navigation', 'https://accounts.google.com/')
    b.go('did-start-navigation', 'https://site.example/')
    expect(agents.has(1)).toBe(true)
    expect(agents.has(2)).toBe(false)
    expect(b.userAgents).toEqual([])
    b.go('did-start-navigation', 'https://accounts.youtube.com/accounts/SetSID')
    a.go('did-start-navigation', 'https://site.example/')
    expect(a.userAgents).toEqual([ELECTRON, PAGE])
    expect(b.userAgents).toEqual([ELECTRON])
    expect(agents.has(1)).toBe(false)
    expect(agents.has(2)).toBe(true)
  })

  it('forgets a tab that is destroyed, and an unknown id is not on the host', () => {
    const { contents, agents } = watched()
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    expect(agents.has(1)).toBe(true)
    contents.emit('destroyed')
    expect(agents.has(1)).toBe(false)
    expect(agents.has(undefined)).toBe(false)
    expect(agents.has(99)).toBe(false)
  })

  it('a user agent that cannot be set is said in the log, the tab is not taken for one that has it, and the next navigation tries again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { contents, agents } = watched()
    contents.setFails = true
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('tab 1')
    expect(warn.mock.calls[0]![1]).toBe('refused')
    expect(agents.has(1)).toBe(false)
    contents.setFails = false
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    expect(contents.userAgents).toEqual([ELECTRON])
    expect(agents.has(1)).toBe(true)
  })

  it('a user agent that cannot be given back is said too, and the tab stays known as being on the host so that the next navigation tries again', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { contents, agents } = watched()
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    contents.setFails = true
    contents.go('did-start-navigation', 'https://site.example/')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(agents.has(1)).toBe(true)
    contents.setFails = false
    contents.go('did-start-navigation', 'https://site.example/')
    expect(contents.userAgents).toEqual([ELECTRON, PAGE])
    expect(agents.has(1)).toBe(false)
  })

  it('tells the session of the tab to the engine each time the tab goes onto the hosts, and for nothing else', () => {
    const entered: unknown[] = []
    const agents = new SignInAgents(identity, (session) => entered.push(session))
    const { contents } = watched(1, agents)
    // Nothing for the other sites, nor for a frame, nor for a tab that is on the host already.
    contents.go('did-start-navigation', 'https://site.example/')
    contents.go('did-start-navigation', 'https://accounts.google.com/gsi/iframe/select', { isMainFrame: false })
    expect(entered).toEqual([])
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    contents.go('did-start-navigation', 'https://accounts.google.com/v3/signin/identifier')
    expect(entered).toEqual([contents.session])
    // Leaving tells nothing; coming back tells again.
    contents.go('did-start-navigation', 'https://mail.google.com/')
    expect(entered).toHaveLength(1)
    contents.go('did-start-navigation', 'https://accounts.youtube.com/accounts/SetSID')
    expect(entered).toEqual([contents.session, contents.session])
  })

  it('does not tell the engine of a tab whose user agent could not be set', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const entered: unknown[] = []
    const { contents } = watched(1, new SignInAgents(identity, (session) => entered.push(session)))
    contents.setFails = true
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    expect(entered).toEqual([])
  })

  it('an engine that cannot widen what it watches is said in the log, and the tab keeps the user agent it was given', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const agents = new SignInAgents(identity, () => {
      throw new Error('hook refused')
    })
    const { contents } = watched(1, agents)
    contents.go('did-start-navigation', 'https://accounts.google.com/')
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]![0])).toContain('tab 1')
    expect(error.mock.calls[0]![1]).toBe('hook refused')
    expect(contents.userAgents).toEqual([ELECTRON])
    expect(agents.has(1)).toBe(true)
  })

  it('writes nothing in the log of a tab that comes and goes, redirects taken over included: no address, no account', async () => {
    const logs = [vi.spyOn(console, 'info'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((spy) => spy.mockImplementation(() => undefined))
    const { contents, agents } = watched()
    // Navigations that change nothing first (a site, the same host twice), then the way in and the way out, then a redirect in and a redirect out.
    contents.go('did-start-navigation', 'https://site.example/first')
    agents.noteRequest(1, 'GET')
    contents.go('did-start-navigation', 'https://accounts.google.com/v3/signin/identifier?email=someone%40example.org')
    contents.go('did-start-navigation', 'https://accounts.google.com/v3/signin/identifier?email=someone%40example.org')
    contents.go('did-start-navigation', 'https://site.example/private?token=secret')
    contents.go('will-redirect', 'https://accounts.google.com/v3/signin/identifier?email=someone%40example.org')
    await moment()
    contents.go('did-start-navigation', 'https://accounts.google.com/v3/signin/identifier?email=someone%40example.org')
    contents.go('will-redirect', 'https://site.example/private?token=secret')
    await moment()
    expect(contents.prevented).toBe(2)
    for (const spy of logs) expect(spy).not.toHaveBeenCalled()
  })
})

// A redirect does not announce itself with `did-start-navigation`, and the user agent cannot be changed while it is followed: the redirect that goes onto the hosts or leaves them is cancelled and
// the tab is sent where it went, by a navigation that does announce itself.
describe('a redirect of the main frame that goes onto the sign-in hosts or leaves them', () => {
  it('coming in: the redirect is cancelled, the tab is sent to its destination a moment later, and the new navigation gives it Electron’s user agent before the request', async () => {
    // « Sign in » from Gmail: the address of the sign-in is where the server redirects to.
    const { contents, agents } = tabOn('https://site.example/')
    contents.go('will-redirect', SIGN_IN)
    expect(contents.prevented).toBe(1)
    // Not from inside the event: a load is refused while a redirect is held (crbug 347742).
    expect(contents.loaded).toEqual([])
    await moment()
    expect(contents.loaded).toEqual([SIGN_IN])
    // Nothing was set by the redirect; the navigation that takes over does it when it starts.
    expect(contents.userAgents).toEqual([])
    contents.go('did-start-navigation', SIGN_IN)
    expect(contents.userAgents).toEqual([ELECTRON])
    expect(contents.setDuring).toEqual(['did-start-navigation'])
    expect(agents.has(1)).toBe(true)
  })

  it('going out: the redirect is cancelled, the tab is sent to its destination a moment later, and the new navigation gives it the user agent of the pages back', async () => {
    // After the sign-in: the server redirects to Gmail.
    const { contents, agents } = tabOn('https://accounts.google.com/v3/signin/identifier')
    expect(agents.has(1)).toBe(true)
    contents.go('will-redirect', GMAIL)
    expect(contents.prevented).toBe(1)
    expect(contents.loaded).toEqual([])
    await moment()
    expect(contents.loaded).toEqual([GMAIL])
    expect(contents.userAgents).toEqual([ELECTRON])
    contents.go('did-start-navigation', GMAIL)
    expect(contents.userAgents).toEqual([ELECTRON, PAGE])
    expect(agents.has(1)).toBe(false)
  })

  it('a redirect between two pages that are not on the hosts, or from one host to the other, is not touched', async () => {
    const out = tabOn('https://site.example/')
    out.contents.go('will-redirect', 'https://other.example/')
    out.contents.go('will-redirect', GMAIL)
    out.contents.go('will-redirect', 'https://accounts.google.com.example/')
    const inside = tabOn('https://accounts.google.com/v3/signin/identifier', 2)
    inside.contents.go('will-redirect', 'https://accounts.google.com/v3/signin/challenge/pwd')
    inside.contents.go('will-redirect', 'https://accounts.youtube.com/accounts/SetSID')
    await moment()
    for (const { contents } of [out, inside]) {
      expect(contents.prevented).toBe(0)
      expect(contents.loaded).toEqual([])
    }
  })

  it('is about the main frame and a new document: a redirect of a frame inside the page, or inside the same document, is not touched', async () => {
    const { contents } = tabOn('https://site.example/')
    contents.go('will-redirect', SIGN_IN, { isMainFrame: false })
    contents.go('will-redirect', SIGN_IN, { isSameDocument: true })
    contents.emit('will-redirect', undefined as never)
    contents.emit('will-redirect', { url: 42, isMainFrame: true, preventDefault: () => void contents.prevented++ })
    contents.emit('will-redirect', { isMainFrame: true, preventDefault: () => void contents.prevented++ })
    await moment()
    expect(contents.prevented).toBe(0)
    expect(contents.loaded).toEqual([])
  })

  it('a redirect that cannot be cancelled is not taken over, and does not count', async () => {
    const { contents } = tabOn('https://site.example/')
    contents.go('will-redirect', SIGN_IN, { preventDefault: undefined })
    contents.go('will-redirect', SIGN_IN, { preventDefault: 'no' })
    await moment()
    expect(contents.loaded).toEqual([])
    // All the room there is is still there: it takes over the redirects that can be, up to the limit.
    for (let i = 0; i < MAX_TAKEN_OVER; i++) contents.go('will-redirect', SIGN_IN)
    expect(contents.prevented).toBe(MAX_TAKEN_OVER)
    await moment()
  })

  it('a redirect that follows a POST is left alone, as a redirect of a request the engine did not tell of: a 307 or a 308 keeps the method, and Electron does not say which it is', async () => {
    const agents = new SignInAgents(identity)
    const posted = watched(1, agents).contents
    posted.go('did-start-navigation', 'https://site.example/form')
    agents.noteRequest(1, 'POST')
    posted.go('will-redirect', SIGN_IN)
    const unknown = watched(2, agents).contents
    unknown.go('did-start-navigation', 'https://site.example/form')
    unknown.go('will-redirect', SIGN_IN)
    await moment()
    for (const contents of [posted, unknown]) {
      expect(contents.prevented).toBe(0)
      expect(contents.loaded).toEqual([])
      expect(contents.userAgents).toEqual([])
    }
  })

  it('it is the method of the request that is redirected that counts: a POST that was answered by a redirect to a GET, which is redirected in turn, is taken over; a GET that went to a POST is not', async () => {
    const agents = new SignInAgents(identity)
    const { contents } = watched(1, agents)
    contents.go('did-start-navigation', 'https://site.example/form')
    agents.noteRequest(1, 'POST')
    agents.noteRequest(1, 'GET')
    contents.go('will-redirect', SIGN_IN)
    expect(contents.prevented).toBe(1)
    contents.go('did-navigate', SIGN_IN)
    agents.noteRequest(1, 'GET')
    agents.noteRequest(1, 'POST')
    contents.go('will-redirect', SIGN_IN)
    await moment()
    expect(contents.prevented).toBe(1)
    expect(contents.loaded).toEqual([SIGN_IN])
  })

  it('remembers the method of the tabs it follows only: a request of a tab it was not given, and of a tab that is gone, is forgotten', async () => {
    const agents = new SignInAgents(identity)
    // The request is told of before the tab is given: nothing is kept for it.
    agents.noteRequest(1, 'GET')
    agents.noteRequest(undefined, 'GET')
    const late = watched(1, agents).contents
    late.go('did-start-navigation', 'https://site.example/')
    late.go('will-redirect', SIGN_IN)
    // And a tab that is destroyed keeps nothing, before or after, even for an id that comes again.
    const gone = watched(2, agents).contents
    gone.go('did-start-navigation', 'https://site.example/')
    agents.noteRequest(2, 'GET')
    gone.emit('destroyed')
    agents.noteRequest(2, 'GET')
    const again = watched(2, agents).contents
    again.go('did-start-navigation', 'https://site.example/')
    again.go('will-redirect', SIGN_IN)
    await moment()
    expect(late.prevented).toBe(0)
    expect(again.prevented).toBe(0)
  })

  it('the count of the redirects taken over is forgotten with the tab', async () => {
    const agents = new SignInAgents(identity)
    const first = watched(1, agents).contents
    first.go('did-start-navigation', 'https://site.example/')
    agents.noteRequest(1, 'GET')
    for (let i = 0; i < MAX_TAKEN_OVER; i++) first.go('will-redirect', SIGN_IN)
    first.emit('destroyed')
    const next = watched(1, agents).contents
    next.go('did-start-navigation', 'https://site.example/')
    agents.noteRequest(1, 'GET')
    next.go('will-redirect', SIGN_IN)
    await moment()
    expect(next.prevented).toBe(1)
  })

  it('does not send a tab on once the tab is gone', async () => {
    const { contents } = tabOn('https://site.example/')
    contents.go('will-redirect', SIGN_IN)
    contents.destroyed = true
    await moment()
    expect(contents.loaded).toEqual([])
  })

  it('a navigation that takes over does not start another one: its own redirects are left alone once the tab is as they ask', async () => {
    const { contents, agents } = tabOn('https://site.example/')
    contents.go('will-redirect', SIGN_IN)
    await moment()
    // The new navigation starts, the tab gets the user agent; the redirects that stay on the hosts change nothing.
    contents.go('did-start-navigation', SIGN_IN)
    agents.noteRequest(1, 'GET')
    contents.go('will-redirect', 'https://accounts.google.com/v3/signin/identifier')
    contents.go('will-redirect', SIGN_IN)
    contents.go('will-redirect', 'https://accounts.youtube.com/accounts/SetSID')
    await moment()
    expect(contents.prevented).toBe(1)
    expect(contents.loaded).toEqual([SIGN_IN])
  })

  it('a tab that cannot be given the user agent does not relaunch for ever: after the limit the redirect is left to Chromium, and a navigation that commits starts the count again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { contents, agents } = tabOn('https://site.example/')
    contents.setFails = true
    for (let i = 0; i < MAX_TAKEN_OVER + 3; i++) {
      // Each new navigation starts, cannot set the agent, and is redirected to the host again: the tab never gets there.
      contents.go('did-start-navigation', SIGN_IN)
      agents.noteRequest(1, 'GET')
      contents.go('will-redirect', SIGN_IN)
      await moment()
    }
    expect(contents.prevented).toBe(MAX_TAKEN_OVER)
    expect(contents.loaded).toHaveLength(MAX_TAKEN_OVER)
    expect(warn.mock.calls.filter(([message]) => String(message).includes('redirects in a row'))).toHaveLength(3)
    // A navigation commits: the chain is over, the next redirect is taken over again.
    contents.emit('did-navigate')
    contents.go('will-redirect', SIGN_IN)
    expect(contents.prevented).toBe(MAX_TAKEN_OVER + 1)
    await moment()
  })

  it('the navigation that takes over, when it fails, is said in the log with the tab and the code of the failure, and no address', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { contents } = tabOn('https://site.example/')
    contents.loadFails = Object.assign(new Error(`ERR_NAME_NOT_RESOLVED (-105) loading '${SIGN_IN}&email=someone%40example.org'`), { code: 'ERR_NAME_NOT_RESOLVED' })
    contents.go('will-redirect', SIGN_IN)
    await moment()
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]![0])
    expect(line).toContain('tab 1')
    expect(line).toContain('ERR_NAME_NOT_RESOLVED')
    expect(line).not.toContain('google.com')
    expect(line).not.toContain('someone')
    expect(warn.mock.calls[0]).toHaveLength(1)
  })

  it('a load that cannot even be started is said too, with no code to give', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { contents } = tabOn('https://site.example/')
    contents.loadThrows = new TypeError(`Invalid URL: ${SIGN_IN}`)
    contents.go('will-redirect', SIGN_IN)
    await moment()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('tab 1')
    expect(String(warn.mock.calls[0]![0])).toContain('unknown')
    expect(String(warn.mock.calls[0]![0])).not.toContain('google.com')
  })

  it('a navigation that takes over and is replaced by another one (the next redirect of the chain, the user) is not a fault: an information, not a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { contents } = tabOn('https://site.example/')
    contents.loadFails = Object.assign(new Error(`ERR_ABORTED (-3) loading '${SIGN_IN}'`), { code: 'ERR_ABORTED' })
    contents.go('will-redirect', SIGN_IN)
    await moment()
    expect(warn).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0]![0])).toContain('tab 1')
    expect(String(info.mock.calls[0]![0])).not.toContain('google.com')
  })
})
