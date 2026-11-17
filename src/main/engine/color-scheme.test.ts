// The appearance asked of the web pages (engine/color-scheme.ts): a protocol session on the page while a scheme is asked, none the rest of the time, never in the
// way of the user's input, an extension's session or a capture. The debugger of the page is a stand-in that records what it is told.

import { describe, expect, it, vi } from 'vitest'
import { ColorSchemeEmulation, ColorSchemePages, emulationCommand, holdsEmulation, type EmulationDebugger } from './color-scheme'
import { watchUserInput } from './user-input'

class FakeDebugger implements EmulationDebugger {
  attached = false
  attaches = 0
  detaches = 0
  commands: Array<{ method: string; params: unknown }> = []
  failAttach: Error | null = null
  failCommand: Error | null = null
  private readonly listeners = new Set<(event: unknown, reason: string) => void>()
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    if (this.attached) throw new Error('Another debugger is already attached to the target.')
    if (this.failAttach) throw this.failAttach
    this.attached = true
    this.attaches++
  }
  detach(): void {
    this.attached = false
    this.detaches++
  }
  async sendCommand(method: string, params?: object): Promise<unknown> {
    this.commands.push({ method, params })
    if (this.failCommand) throw this.failCommand
    return {}
  }
  on(_event: 'detach', listener: (event: unknown, reason: string) => void): unknown {
    this.listeners.add(listener)
    return this
  }
  removeListener(_event: 'detach', listener: (event: unknown, reason: string) => void): unknown {
    this.listeners.delete(listener)
    return this
  }
  /** Someone else detached the session (DevTools opened, the page crashed). */
  detachedByOthers(): void {
    this.attached = false
    for (const listener of [...this.listeners]) listener({}, 'replaced with devtools')
  }
  get listening(): number {
    return this.listeners.size
  }
}

function emulation(over: { alive?: () => boolean } = {}) {
  const dbg = new FakeDebugger()
  const owner = {}
  const warn = vi.fn<(what: string, error: unknown) => void>()
  const scheme = new ColorSchemeEmulation({ debugger: dbg, owner, alive: over.alive ?? (() => true), warn })
  return { dbg, owner, warn, scheme }
}
const asked = (dbg: FakeDebugger) => dbg.commands.map((command) => command.params)
const dark = { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }
const light = { features: [{ name: 'prefers-color-scheme', value: 'light' }] }

describe('the command that gives a page its colour scheme', () => {
  it('is the media emulation of prefers-color-scheme, and gives it back with no feature', () => {
    expect(emulationCommand('dark')).toEqual({ method: 'Emulation.setEmulatedMedia', params: dark })
    expect(emulationCommand('light').params).toEqual(light)
    expect(emulationCommand(null).params).toEqual({ features: [] })
  })
})

describe('a page while the scheme is not asked', () => {
  // THE GUARD of the cost: with the setting on Automatique, no session is ever attached to any page.
  it('is never touched: no session attached, nothing sent, nothing listened to', () => {
    const { dbg, scheme } = emulation()
    scheme.set(null)
    scheme.refresh()
    scheme.stepAside()
    expect(dbg.attaches).toBe(0)
    expect(dbg.detaches).toBe(0)
    expect(dbg.commands).toEqual([])
    expect(dbg.listening).toBe(0)
  })
})

describe('a page that is asked for a scheme', () => {
  it('gets one session and the scheme', () => {
    const { dbg, scheme } = emulation()
    scheme.set('dark')
    expect(dbg.attaches).toBe(1)
    expect(dbg.commands).toEqual([{ method: 'Emulation.setEmulatedMedia', params: dark }])
  })

  it('is asked again on another scheme, and at each new document, through the session it already has', () => {
    const { dbg, scheme } = emulation()
    scheme.set('dark')
    scheme.set('light')
    scheme.refresh()
    expect(dbg.attaches).toBe(1)
    expect(asked(dbg)).toEqual([dark, light, light])
  })

  it('is given back its own when nothing is asked: the session goes', () => {
    const { dbg, scheme } = emulation()
    scheme.set('dark')
    scheme.set(null)
    expect(dbg.attached).toBe(false)
    expect(dbg.detaches).toBe(1)
    expect(dbg.listening).toBe(0)
    // And nothing more is sent to it afterwards.
    scheme.refresh()
    expect(dbg.attaches).toBe(1)
  })

  // THE GUARD of the others' sessions: an extension's, a capture's or a freeze's session is not ours to take, nor to disturb.
  it('does not take a session that someone else holds, and tries again at the next document', () => {
    const { dbg, warn, scheme } = emulation()
    dbg.attached = true
    scheme.set('dark')
    expect(dbg.attaches).toBe(0)
    expect(dbg.commands).toEqual([])
    // Not an error: nothing is logged, the page is simply not free yet.
    expect(warn).not.toHaveBeenCalled()
    expect(holdsEmulation(dbg)).toBe(false)
    dbg.attached = false
    scheme.refresh()
    expect(dbg.attaches).toBe(1)
    expect(asked(dbg)).toEqual([dark])
  })

  it('never detaches a session it does not hold', () => {
    const { dbg, scheme } = emulation()
    dbg.attached = true
    scheme.set('dark')
    scheme.set(null)
    scheme.stepAside()
    expect(dbg.detaches).toBe(0)
    expect(dbg.attached).toBe(true)
  })

  it('leaves the page to an extension that attaches, and comes back when its session has ended', () => {
    const { dbg, scheme } = emulation()
    scheme.set('dark')
    scheme.stepAside()
    expect(dbg.attached).toBe(false)
    // The extension's own session.
    dbg.attach()
    scheme.refresh()
    expect(dbg.attaches).toBe(2)
    expect(dbg.commands).toHaveLength(1)
    dbg.attached = false
    scheme.refresh()
    expect(dbg.attaches).toBe(3)
    expect(asked(dbg)).toEqual([dark, dark])
  })

  it('forgets a session that others detached, and takes the page back at the next document, not before', () => {
    const { dbg, scheme } = emulation()
    scheme.set('dark')
    dbg.detachedByOthers()
    expect(dbg.attaches).toBe(1)
    expect(dbg.listening).toBe(0)
    scheme.refresh()
    expect(dbg.attaches).toBe(2)
  })
})

// THE GUARD of the user's input: a session counts as a debugger on the page, and the input that reaches a page while one is attached is not the user's.
// Ours is Lucium's own and sends no input: the user's clicks keep counting; another session on the page still takes them away.
describe('the user input of a page that has the session', () => {
  /** A web contents as `watchUserInput` is given it: the page's own object (it keys our session), its debugger, and the input events it hears. */
  function webContents() {
    const { dbg, owner, scheme } = emulation()
    const heard: Array<(event: unknown, input: { type: string }) => void> = []
    const wc = Object.assign(owner, { debugger: dbg, on: (_event: 'input-event', listener: (event: unknown, input: { type: string }) => void) => void heard.push(listener) })
    const noted = vi.fn()
    watchUserInput(wc, noted)
    const click = (): void => heard[0]!({}, { type: 'mouseDown' })
    return { dbg, wc, scheme, noted, click }
  }

  it('counts while the session is ours', () => {
    const { wc, scheme, noted, click } = webContents()
    scheme.set('dark')
    expect(holdsEmulation(wc)).toBe(true)
    click()
    expect(noted).toHaveBeenCalledTimes(1)
  })

  it('does not count while another session is on the page: an extension that debugs it cannot press a button for itself', () => {
    const { dbg, wc, scheme, noted, click } = webContents()
    scheme.set('dark')
    scheme.stepAside()
    expect(holdsEmulation(wc)).toBe(false)
    dbg.attach()
    click()
    expect(noted).not.toHaveBeenCalled()
  })

  it('counts, as ever, on a page that has no session at all', () => {
    const { noted, click } = webContents()
    click()
    expect(noted).toHaveBeenCalledTimes(1)
  })
})

describe('what goes wrong is said, and the page is left as it was', () => {
  it('logs a session that cannot be attached, with what it was for, and holds nothing', () => {
    const { dbg, owner, warn, scheme } = emulation()
    dbg.failAttach = new Error('cannot attach')
    scheme.set('dark')
    expect(warn).toHaveBeenCalledWith('cannot attach the session that gives the page its colour scheme', dbg.failAttach)
    expect(holdsEmulation(owner)).toBe(false)
    expect(dbg.commands).toEqual([])
  })

  it('logs a command that fails', async () => {
    const { dbg, warn, scheme } = emulation()
    dbg.failCommand = new Error('no emulation here')
    scheme.set('dark')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('cannot give the page its colour scheme', dbg.failCommand))
  })

  it('says nothing of a command that fails because the page is gone, and sends nothing to a page that is gone', async () => {
    let alive = true
    const { dbg, warn, scheme } = emulation({ alive: () => alive })
    dbg.failCommand = new Error('target closed')
    scheme.set('dark')
    alive = false
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
    scheme.refresh()
    scheme.set('light')
    expect(dbg.commands).toHaveLength(1)
    expect(dbg.attaches).toBe(1)
  })

  it('logs a session that cannot be detached', () => {
    const { dbg, warn, scheme } = emulation()
    scheme.set('dark')
    dbg.detach = () => {
      throw new Error('detach failed')
    }
    scheme.set(null)
    expect(warn).toHaveBeenCalledWith('cannot detach the session that gave the page its colour scheme', expect.any(Error))
  })
})

describe('the pages of the application', () => {
  const made = () => {
    const calls: Array<'light' | 'dark' | null> = []
    return { calls, setColorScheme: (scheme: 'light' | 'dark' | null) => void calls.push(scheme) }
  }

  it('are all given the scheme asked, and given back their own when nothing is asked', () => {
    const pages = new ColorSchemePages<ReturnType<typeof made>>()
    const a = made()
    const b = made()
    pages.add(a)
    pages.add(b)
    pages.set('dark')
    expect([a.calls, b.calls]).toEqual([['dark'], ['dark']])
    pages.set(null)
    expect([a.calls, b.calls]).toEqual([['dark', null], ['dark', null]])
  })

  // THE GUARD of the cost and of the new pages: nothing is told to a page while nothing is asked, and a page made later reads the scheme from its first document.
  it('does not tell a page anything while nothing is asked, and tells a page made later what is asked', () => {
    const pages = new ColorSchemePages<ReturnType<typeof made>>()
    const early = made()
    pages.add(early)
    pages.set(null)
    expect(early.calls).toEqual([])
    pages.set('light')
    const late = made()
    pages.add(late)
    expect(late.calls).toEqual(['light'])
  })

  it('does nothing for a scheme that is already asked, and forgets a page that goes', () => {
    const pages = new ColorSchemePages<ReturnType<typeof made>>()
    const a = made()
    pages.add(a)
    pages.set('dark')
    pages.set('dark')
    expect(a.calls).toEqual(['dark'])
    pages.remove(a)
    pages.set('light')
    expect(a.calls).toEqual(['dark'])
    expect(pages.size).toBe(0)
  })
})
