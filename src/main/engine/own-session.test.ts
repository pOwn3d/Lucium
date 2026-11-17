// The protocol session Lucium shares between its own users of a page's debugger (engine/own-session.ts): attached by the first, detached by the last,
// never taken from someone else, and not a debugger as far as the user's input goes. The debugger is a stand-in that records what it is told.

import { describe, expect, it, vi } from 'vitest'
import { ColorSchemeEmulation, emulationCommand } from './color-scheme'
import { holdsOwnSession, OwnSession, ownSessionOf, sharedDebugger } from './own-session'
import { fakeDebugger, settle } from './protocol.test-support'
import { watchUserInput } from './user-input'

describe('the protocol session shared by what Lucium keeps on a page', () => {
  it('is attached by its first user and detached by its last, once each', () => {
    const dbg = fakeDebugger()
    const session = new OwnSession(dbg)
    expect(session.acquire('a')).toBe(true)
    expect(session.acquire('b')).toBe(true)
    expect(session.acquire('a')).toBe(true)
    expect(dbg.calls).toEqual(['attach'])
    expect([session.held, session.holds('a'), session.holds('b'), session.holds('c')]).toEqual([true, true, true, false])
    expect(session.release('a')).toBe('shared')
    expect(dbg.isAttached()).toBe(true)
    expect(session.release('a')).toBe('none')
    expect(session.release('b')).toBe('detached')
    expect(dbg.calls).toEqual(['attach', 'detach'])
    expect([session.held, dbg.listeners('detach')]).toEqual([false, 0])
  })

  it('never takes a session that is someone else\'s, and never detaches it', () => {
    const dbg = fakeDebugger()
    dbg.attachForeign()
    const session = new OwnSession(dbg)
    expect(session.acquire('a')).toBe(false)
    expect(session.release('a')).toBe('none')
    expect(dbg.calls).toEqual([])
    expect(dbg.isAttached()).toBe(true)
  })

  it('passes on what Electron throws when the session cannot be attached, and holds nothing then', () => {
    const dbg = fakeDebugger()
    dbg.attachFails = new Error('target crashed')
    const session = new OwnSession(dbg)
    expect(() => session.acquire('a')).toThrow('target crashed')
    expect(session.held).toBe(false)
  })

  it('is forgotten by everyone when it is detached from outside, so the next user attaches a new one', () => {
    const dbg = fakeDebugger()
    const session = new OwnSession(dbg)
    session.acquire('a')
    session.acquire('b')
    dbg.lose()
    expect([session.held, session.holds('a'), session.release('b')]).toEqual([false, false, 'none'])
    expect(session.acquire('b')).toBe(true)
    expect(dbg.calls).toEqual(['attach', 'attach'])
  })

  it('is one per web contents, and tells whether the session on it is ours', () => {
    const dbg = fakeDebugger()
    const owner = {}
    expect(holdsOwnSession(owner)).toBe(false)
    const session = ownSessionOf(owner, dbg)
    expect(ownSessionOf(owner, dbg)).toBe(session)
    expect(holdsOwnSession(owner)).toBe(false)
    session.acquire('a')
    expect(holdsOwnSession(owner)).toBe(true)
    session.release('a')
    expect(holdsOwnSession(owner)).toBe(false)
  })

  it('does not make the user\'s clicks and keys count as a debugger\'s, while an extension\'s session still does', () => {
    const dbg = fakeDebugger()
    let hear: (event: unknown, input: { type: string }) => void = () => {}
    const wc = { debugger: dbg, on: (_event: 'input-event', listener: typeof hear) => void (hear = listener) }
    const noted = vi.fn()
    watchUserInput(wc, noted)
    ownSessionOf(wc, dbg).acquire('a')
    hear({}, { type: 'mouseDown' })
    expect(noted).toHaveBeenCalledTimes(1)
    ownSessionOf(wc, dbg).release('a')
    dbg.attachForeign()
    hear({}, { type: 'mouseDown' })
    expect(noted).toHaveBeenCalledTimes(1)
  })
})

describe('the debugger as one user of the shared session sees it', () => {
  function colourScheme() {
    const dbg = fakeDebugger()
    const owner = {}
    const session = ownSessionOf(owner, dbg)
    const givenBack = vi.fn()
    const warn = vi.fn()
    const scheme = new ColorSchemeEmulation({ debugger: sharedDebugger(session, dbg, 'color-scheme', givenBack), owner, alive: () => true, warn })
    return { dbg, session, scheme, givenBack, warn }
  }

  it('lets the colour scheme join a session the protection of the frames already holds, and leave it without detaching it: what it asked is then taken back by hand', async () => {
    const { dbg, session, scheme, givenBack, warn } = colourScheme()
    session.acquire('inner-guard')
    scheme.set('dark')
    await settle()
    expect(dbg.calls).toEqual(['attach'])
    expect(dbg.sent.map((c) => [c.method, c.params])).toEqual([[emulationCommand('dark').method, emulationCommand('dark').params]])
    scheme.set(null)
    expect(dbg.calls).toEqual(['attach'])
    expect(givenBack).toHaveBeenCalledTimes(1)
    expect(session.holds('inner-guard')).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('detaches the session when the colour scheme was alone on it, and has nothing to take back then', () => {
    const { dbg, scheme, givenBack } = colourScheme()
    scheme.set('light')
    scheme.set(null)
    expect(dbg.calls).toEqual(['attach', 'detach'])
    expect(givenBack).not.toHaveBeenCalled()
  })

  it('still leaves an extension\'s session alone: the colour scheme does not engage, and says nothing', () => {
    const { dbg, scheme, warn } = colourScheme()
    dbg.attachForeign()
    scheme.set('dark')
    expect(dbg.calls).toEqual([])
    expect(dbg.sent).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('refuses to attach over a session that is not ours', () => {
    const dbg = fakeDebugger()
    dbg.attachForeign()
    const shared = sharedDebugger(new OwnSession(dbg), dbg, 'a', () => {})
    expect(() => shared.attach()).toThrow('another protocol session is attached to the page')
  })
})
